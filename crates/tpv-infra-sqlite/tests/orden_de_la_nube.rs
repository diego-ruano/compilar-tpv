//! SYNC-29 · El orden de la nube manda, de punta a punta: el repositorio de sync real, los
//! repositorios de negocio de verdad y una nube que es otra base SQLite con el esquema del negocio y
//! contesta `/v1/sync/verificar/*` como el worker (`comun::nube_de_contraste`).
//!
//! La Main cancela una reserva porque lo pide el cliente y, antes de que la cancelación suba, una
//! Handy la sienta. En la nube la cancelación va detrás (llegó después): la reserva queda cancelada,
//! que es lo que ve la agenda de la web. Aquí el cambio de la Handy se aplicó encima: la reserva queda
//! sentada, y el eco de la cancelación se descarta porque ya está aplicada. La Main tiene que acabar
//! como la nube en cuanto lo suyo está subido, y el contraste diario no puede volver a subirla viva.
//!
//! SYNC-37: y lo mismo cuando lo que se cruza es un valor único. La Main se cambia los nombres de
//! dos zonas mientras una Handy guarda el plano de antes: aquí queda `A/B` y en la nube `B/A`, y
//! traer cualquiera de las dos choca con la otra si no se aparca antes su nombre.

mod comun;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas};
use tpv_application::error::AppResult;
use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::reservas::ReservasRepository;
use tpv_application::ports::sync::{
    ContrasteLocal, Convergencia, PaginasDelContraste, PedidoDeClaves, PedidoDeFilas, PedidoPorClave, SyncRepository,
};
use tpv_contracts::mesas::{RoomPoly, SalonInput, TableInput};
use tpv_contracts::sync::{ClavesPagina, FilasDeCubos, FilasPorClave, ResultadoVerificacion, SqlStatement, SyncChange};
use tpv_infra_sqlite::db::{Db, Writer};
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::mesas::SqliteMesasRepository;
use tpv_infra_sqlite::reservas::SqliteReservasRepository;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

/// Lo que hay en las dos bases: una mesa y una reserva por llegar.
const NEGOCIO: &str = "
    INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');
    INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
         VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80);
    INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado, Origen)
         VALUES ('r1', 'm1', '2026-11-20', '21:00', 'CENA', 4, 'Cumpleaños', 'PROXIMA', 'TPV');
";

fn sentencia(sql: &str, args: Vec<JsonValue>) -> SqlStatement {
    SqlStatement { sql: sql.into(), args }
}

/// La Handy sienta la reserva (`PUT /v1/mesas/reservas/:id/estado`, `mesas.commands.ts`).
fn la_handy_la_sienta() -> Vec<SqlStatement> {
    vec![sentencia("UPDATE Reservas SET Estado = ?2 WHERE ID_Reserva = ?1;", vec![json!("r1"), json!("ACTIVA")])]
}

/// La Handy guarda la reserva con lo que tenía en pantalla (`saveReserva`, `reservas.commands.ts`),
/// ya con la hora de la Handy fijada por el DO.
fn la_handy_la_edita() -> Vec<SqlStatement> {
    vec![sentencia(
        "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado, Duracion_Min, Created_At) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROXIMA', ?9, '2026-11-14 12:00:00') \
         ON CONFLICT(ID_Reserva) DO UPDATE SET ID_Cliente = excluded.ID_Cliente, ID_Mesa = excluded.ID_Mesa, \
           Dia_YMD = excluded.Dia_YMD, Hora = excluded.Hora, Turno = excluded.Turno, Comensales = excluded.Comensales, \
           Nota = excluded.Nota, Duracion_Min = excluded.Duracion_Min;",
        vec![json!("r1"), JsonValue::Null, json!("m1"), json!("2026-11-20"), json!("21:00"), json!("CENA"), json!(6), json!("Cumpleaños, 6"), JsonValue::Null],
    )]
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf, NubeDeContraste) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join("tpv_tests").join(format!("sync29-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 40 WHERE Id = 1;").await;
    let nube = NubeDeContraste::nueva(nombre).await;
    nube.sembrar(NEGOCIO).await;
    *nube.hasta_seq.lock().unwrap() = 40;
    *nube.ultimo_ajeno.lock().unwrap() = 40;
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir, nube)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf, nube: NubeDeContraste) {
    nube.cerrar().await;
    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn sembrar(db: &Arc<Db>, sql: &str) {
    let w = db.write().await;
    w.raw().execute_batch(sql).await.unwrap();
}

async fn texto(db: &Arc<Db>, sql: &str) -> String {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    match filas.next().await.unwrap() {
        Some(f) => match f.get_value(0).unwrap() {
            Value::Text(t) => t,
            Value::Integer(n) => n.to_string(),
            Value::Null => "NULL".into(),
            otro => format!("{otro:?}"),
        },
        None => "-".into(),
    }
}

async fn estado(db: &Arc<Db>) -> String {
    texto(db, "SELECT Estado FROM Reservas WHERE ID_Reserva = 'r1';").await
}

async fn marcas(db: &Arc<Db>) -> String {
    texto(db, "SELECT COUNT(*) FROM _Sync_Por_Contrastar;").await
}

/// Una escritura de negocio de aquí, por el outbox.
async fn escribir_aqui(db: &Arc<Db>, nombre_zona: &str) {
    let w = db.write().await;
    w.execute("UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = 'z1';", vec![Value::Text(nombre_zona.into())]).await.unwrap();
}

/// La carrera: lo de la Main queda por subir, la Handy escribe lo suyo en la nube (`Seq` 41) y la
/// Main lo aplica encima; después sube lo de la Main (`Seq` 42) y llega su acuse. El log de la nube
/// acaba en 42. En vivo la nube no le devuelve a la Main lo suyo, así que el checkpoint se queda en
/// 41; `con_eco` es una reconexión, cuyo catch-up sí lo trae, y lo deja en 42.
async fn la_carrera(repo: &SqliteSyncRepository, nube: &NubeDeContraste, de_la_handy: Vec<SqlStatement>, con_eco: bool) {
    let propia = repo.outbox_pending(10).await.unwrap();
    assert_eq!(propia.len(), 1, "lo de la Main, por subir");
    let propia = propia.into_iter().next().unwrap();

    nube.aplicar(&de_la_handy).await;
    repo.apply_changes(vec![SyncChange { op_id: "op-handy".into(), seq: 41, statements: de_la_handy }]).await.unwrap();

    nube.aplicar(&propia.statements).await;
    repo.outbox_confirmar_lote(&[(propia.op_id.clone(), 42)]).await.unwrap();
    if con_eco {
        repo.apply_changes(vec![SyncChange { op_id: propia.op_id.clone(), seq: 42, statements: propia.statements }]).await.unwrap();
    }
    assert_eq!(repo.get_checkpoint().await.unwrap(), if con_eco { 42 } else { 41 });
    *nube.hasta_seq.lock().unwrap() = 42;
    *nube.ultimo_ajeno.lock().unwrap() = 41;
}

async fn pasada(repo: &SqliteSyncRepository, nube: &NubeDeContraste) -> ResultadoVerificacion {
    let marca = repo.contraste_marca().await.unwrap();
    let resumen = nube.resumen_para(marca.checkpoint).await;
    match repo.contrastar_con_la_nube(resumen, marca, &Paginas(nube), true).await.unwrap() {
        ContrasteLocal::Hecho(r) => r,
        ContrasteLocal::SeHaMovido => panic!("se tenía que comparar"),
    }
}

fn hecha(c: Convergencia) -> (Vec<SqlStatement>, bool) {
    match c {
        Convergencia::Hecha { escritas, quedan } => (escritas, quedan),
        otra => panic!("se tenía que traer: {otra:?}"),
    }
}

// ── La reserva ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn la_cancelacion_de_la_main_se_queda_aunque_una_handy_la_sentara_a_la_vez() {
    let (repo, db, dir, nube) = base("cancelada").await;
    assert!(SqliteReservasRepository::new(db.clone()).cancelar("r1").await.unwrap());
    la_carrera(&repo, &nube, la_handy_la_sienta(), false).await;

    // Lo que dejaba SYNC-29: aquí sentada, en la nube cancelada.
    assert_eq!(estado(&db).await, "ACTIVA");
    assert_eq!(estado(&nube.db).await, "CANCELADA");
    assert_eq!(marcas(&db).await, "1", "la fila que tocó la Handy, apuntada al aplicarla");

    // El contraste no la sube viva: la trae la convergencia.
    let r = pasada(&repo, &nube).await;
    assert_eq!((r.reparadas, r.aplazado), (0, true), "{r:?}");
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());

    // Con todo subido y la bajada al día, se trae de la nube como está.
    let antes = repo.contraste_marca().await.unwrap();
    let (escritas, quedan) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!((escritas.len(), quedan), (1, false));
    assert!(escritas[0].sql.starts_with("INSERT INTO \"Reservas\"") && escritas[0].sql.contains("ON CONFLICT"), "{}", escritas[0].sql);
    assert_eq!(estado(&db).await, "CANCELADA");
    assert_eq!(marcas(&db).await, "0");
    // Lo que escribe la convergencia mueve la marca del contraste aunque no pase por el outbox ni
    // mueva el checkpoint: una pasada que hubiera visto la fila como estaba antes ya no repara nada
    // con lo que vio (Codex).
    let despues = repo.contraste_marca().await.unwrap();
    assert_eq!((despues.checkpoint, despues.escrituras, despues.pendientes), (antes.checkpoint, antes.escrituras, antes.pendientes));
    assert_ne!(despues, antes);
    // Sólo aquí: ni el outbox ni el checkpoint se mueven.
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());
    assert_eq!(repo.get_checkpoint().await.unwrap(), 41);

    // Y las dos bases cuadran.
    let r = pasada(&repo, &nube).await;
    assert_eq!(r.descuadres, vec![], "{r:?}");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    // Sin marcas, otra vuelta no pide nada.
    let pedidas = nube.rutas_pedidas().len();
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Nada));
    assert_eq!(nube.rutas_pedidas().len(), pedidas);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn una_reserva_que_la_main_borro_y_una_handy_edito_a_la_vez_se_queda_borrada() {
    // Aquí el borrado fue delante y la edición de la Handy la volvió a crear; en la nube, la
    // edición fue delante y el borrado detrás.
    let (repo, db, dir, nube) = base("borrada").await;
    assert!(SqliteReservasRepository::new(db.clone()).eliminar("r1").await.unwrap());
    la_carrera(&repo, &nube, la_handy_la_edita(), true).await;
    assert_eq!(estado(&db).await, "PROXIMA");
    assert_eq!(estado(&nube.db).await, "-");

    // El contraste no la vuelve a subir: aquí está y arriba no, pero la nube la borró después y la
    // trae la convergencia.
    let r = pasada(&repo, &nube).await;
    assert_eq!((r.reparadas, r.aplazado), (0, true), "{r:?}");
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 1);
    assert!(escritas[0].sql.starts_with("DELETE FROM \"Reservas\""), "{}", escritas[0].sql);
    assert_eq!(estado(&db).await, "-");
    assert_eq!(pasada(&repo, &nube).await.descuadres, vec![]);

    cerrar(db, dir, nube).await;
}

// ── Cuándo se marca ───────────────────────────────────────────────────────────

#[tokio::test]
async fn sin_nada_de_aqui_por_ordenar_en_esas_tablas_no_se_marca_nada() {
    let (repo, db, dir, nube) = base("sin-carrera").await;
    // Sin nada en el outbox.
    repo.apply_changes(vec![SyncChange { op_id: "op-41".into(), seq: 41, statements: la_handy_la_sienta() }]).await.unwrap();
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "0".to_string()));
    // Con algo por subir, pero en otra tabla.
    escribir_aqui(&db, "Terraza cubierta").await;
    repo.apply_changes(vec![SyncChange {
        op_id: "op-42".into(),
        seq: 42,
        statements: vec![sentencia("UPDATE Reservas SET Nota = ?2 WHERE ID_Reserva = ?1;", vec![json!("r1"), json!("Tarta")])],
    }])
    .await
    .unwrap();
    assert_eq!(marcas(&db).await, "0");
    // Y nada que traer: no se pide nada a la nube.
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Nada));
    assert!(nube.rutas_pedidas().is_empty());

    cerrar(db, dir, nube).await;
}

// ── Cuándo no se trae ─────────────────────────────────────────────────────────

#[tokio::test]
async fn si_la_nube_va_por_delante_o_hay_algo_por_subir_se_deja_para_luego_sin_tocar_nada() {
    let (repo, db, dir, nube) = base("aplazada").await;
    assert!(SqliteReservasRepository::new(db.clone()).cancelar("r1").await.unwrap());
    la_carrera(&repo, &nube, la_handy_la_sienta(), false).await;

    // La nube tiene algo que esta Main todavía no ha aplicado.
    *nube.hasta_seq.lock().unwrap() = 43;
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Aplazada));
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "1".to_string()));

    // La bajada está detenida en un cambio que no ha entrado: ni se pide.
    *nube.hasta_seq.lock().unwrap() = 42;
    sembrar(&db, "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-43', 43, '[]', 1, 0, 1, 1);").await;
    let pedidas = nube.rutas_pedidas().len();
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Aplazada));
    assert_eq!(nube.rutas_pedidas().len(), pedidas);
    sembrar(&db, "DELETE FROM _Sync_Failed;").await;

    // Hay algo de aquí por subir: ni se pide.
    escribir_aqui(&db, "Terraza cubierta").await;
    let pedidas = nube.rutas_pedidas().len();
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Aplazada));
    assert_eq!(nube.rutas_pedidas().len(), pedidas);
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "1".to_string()));

    cerrar(db, dir, nube).await;
}

/// La nube del contraste, que mientras contesta deja aquí una escritura de negocio: la de alguien que
/// cobra mientras la Main pide las filas.
struct EscribeAlPedir<'a> {
    nube: &'a NubeDeContraste,
    db: Arc<Db>,
}

#[async_trait]
impl PaginasDelContraste for EscribeAlPedir<'_> {
    async fn filas(&self, p: PedidoDeFilas) -> AppResult<FilasDeCubos> {
        Paginas(self.nube).filas(p).await
    }
    async fn por_clave(&self, p: PedidoPorClave) -> AppResult<FilasPorClave> {
        escribir_aqui(&self.db, "Terraza cubierta").await;
        Paginas(self.nube).por_clave(p).await
    }
    async fn claves(&self, p: PedidoDeClaves) -> AppResult<ClavesPagina> {
        Paginas(self.nube).claves(p).await
    }
}

#[tokio::test]
async fn una_escritura_de_aqui_mientras_se_pide_a_la_nube_deja_la_vuelta_sin_escribir_nada() {
    let (repo, db, dir, nube) = base("escritura-en-medio").await;
    assert!(SqliteReservasRepository::new(db.clone()).cancelar("r1").await.unwrap());
    la_carrera(&repo, &nube, la_handy_la_sienta(), false).await;

    let paginas = EscribeAlPedir { nube: &nube, db: db.clone() };
    assert!(matches!(repo.converger_con_la_nube(&paginas).await.unwrap(), Convergencia::Aplazada));
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "1".to_string()));

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_que_la_main_escribio_y_la_nube_no_acepto_no_se_pisa() {
    let (repo, db, dir, nube) = base("apartada").await;
    assert!(SqliteReservasRepository::new(db.clone()).cancelar("r1").await.unwrap());
    la_carrera(&repo, &nube, la_handy_la_sienta(), false).await;
    // Una escritura de aquí sobre esa reserva que la nube rechazó, apartada.
    let apartada = serde_json::to_string(&[sentencia("UPDATE Reservas SET Nota = ?2 WHERE ID_Reserva = ?1;", vec![json!("r1"), json!("Alergia")])]).unwrap();
    sembrar(
        &db,
        &format!("INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) VALUES ('rechazada', 'main_op', '{apartada}', 1, 1);"),
    )
    .await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert!(escritas.is_empty());
    assert_eq!(estado(&db).await, "ACTIVA", "no se trae");
    assert_eq!(marcas(&db).await, "0", "y se deja: lo que quede distinto lo verá el contraste");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_cobrado_no_se_borra_desde_la_nube_y_a_los_cinco_intentos_se_deja_al_contraste() {
    // Una comanda que la nube no tiene y aquí tiene un cobro: borrarla aquí se llevaría el cobro
    // por la cascada de `Pagos.ID_Comanda`. No se hace, y a la quinta vuelta se deja: lo de aquí es
    // lo bueno, y lo sube el contraste. Hasta entonces no ha cambiado nada, y la vuelta se aplaza.
    let (repo, db, dir, nube) = base("cobro").await;
    sembrar(
        &db,
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'BARRA', '2026-11-14 12:00:00', 'Pagada');
         INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
              VALUES ('p1', 'c1', '2026-11-14 12:10:00', 'Efectivo', 500, 'TOTAL');
         INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) VALUES ('Comandas', '[\"c1\"]', 40, 1);",
    )
    .await;

    for vuelta in 1..=4 {
        let c = repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap();
        assert!(matches!(c, Convergencia::Aplazada), "vuelta {vuelta}: {c:?}");
        assert_eq!(texto(&db, "SELECT COUNT(*) FROM Pagos WHERE ID_Pago = 'p1';").await, "1", "vuelta {vuelta}");
        assert_eq!(marcas(&db).await, "1");
    }
    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert!(escritas.is_empty());
    assert_eq!(texto(&db, "SELECT COUNT(*) FROM Pagos WHERE ID_Pago = 'p1';").await, "1");
    assert_eq!(texto(&db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'c1';").await, "1");
    assert_eq!(marcas(&db).await, "0");

    cerrar(db, dir, nube).await;
}

// ── Un valor único que se cruzan dos filas (SYNC-37) ──────────────────────────

/// Dos zonas más, en las dos bases.
const ZONAS: &str = "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z2', 'Salón'), ('z3', 'Barra');";

/// Las zonas, por su clave: `z1=Terraza z2=Salón …`.
async fn zonas(db: &Arc<Db>) -> String {
    texto(db, "SELECT group_concat(ID_Zona || '=' || Nombre_Zona, ' ') FROM (SELECT * FROM Zonas ORDER BY ID_Zona);").await
}

/// Lo aparcado que se haya quedado en una base (`aparcar::valor_temporal` empieza por `\u{1}`).
async fn aparcadas(db: &Arc<Db>) -> String {
    texto(
        db,
        "SELECT (SELECT COUNT(*) FROM Zonas WHERE instr(Nombre_Zona, char(1)) > 0)
              + (SELECT COUNT(*) FROM Productos WHERE instr(Nombre, char(1)) > 0);",
    )
    .await
}

/// Apunta filas para traerlas de la nube, como si las hubiera tocado un cambio en carrera.
async fn apuntar(db: &Arc<Db>, tabla: &str, claves: &[&str]) {
    for (i, k) in claves.iter().enumerate() {
        sembrar(
            db,
            &format!("INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) VALUES ('{tabla}', '[\"{k}\"]', 40, {});", i + 1),
        )
        .await;
    }
}

fn zona(id: &str, nombre: &str, mesas: Vec<TableInput>) -> SalonInput {
    SalonInput { id: format!("db-zona-{id}"), name: nombre.into(), room: RoomPoly { kind: "poly".into(), points: vec![] }, tables: mesas }
}

fn mesa(id: &str, numero: &str) -> TableInput {
    TableInput { id: format!("db-mesa-{id}"), name: numero.into(), x: 0, y: 0, width: 80, height: 80, radius: None, seats: 4, shape: "rect".into() }
}

/// La Handy guarda el plano que tenía en pantalla, el de antes (`saveLayout`, `mesas.commands.ts`):
/// aparca los nombres de las zonas y los vuelve a poner, con la hora de la Handy ya fijada por el DO.
fn la_handy_guarda_el_plano_de_antes() -> Vec<SqlStatement> {
    let mut sentencias = vec![sentencia(
        "UPDATE Zonas SET Nombre_Zona = '__tmp_zona_' || ID_Zona WHERE ID_Zona IN (SELECT value FROM json_each(?1));",
        vec![json!("[\"z1\",\"z2\",\"z3\"]")],
    )];
    for (id, nombre) in [("z1", "Terraza"), ("z2", "Salón"), ("z3", "Barra")] {
        sentencias.push(sentencia(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At) VALUES (?1, ?2, ?3, '2026-11-15 12:00:00') \
             ON CONFLICT(ID_Zona) DO UPDATE SET Nombre_Zona = excluded.Nombre_Zona, Room_Points = excluded.Room_Points, \
               Updated_At = excluded.Updated_At;",
            vec![json!(id), json!(nombre), json!("[]")],
        ));
    }
    sentencias
}

#[tokio::test]
async fn dos_zonas_que_la_main_se_cambia_de_nombre_mientras_una_handy_guarda_el_plano_acaban_como_la_nube() {
    let (repo, db, dir, nube) = base("intercambio").await;
    sembrar(&db, ZONAS).await;
    nube.sembrar(ZONAS).await;
    // La Main se cambia los nombres de la terraza y el salón, con su plano de verdad.
    SqliteMesasRepository::new(db.clone())
        .save_layout(vec![zona("z1", "Salón", vec![mesa("m1", "1")]), zona("z2", "Terraza", vec![]), zona("z3", "Barra", vec![])])
        .await
        .unwrap();
    la_carrera(&repo, &nube, la_handy_guarda_el_plano_de_antes(), false).await;

    // Lo que dejaba SYNC-37: aquí el plano de la Handy, arriba el de la Main, y las tres zonas
    // que tocó la Handy, apuntadas.
    assert_eq!(zonas(&db).await, "z1=Terraza z2=Salón z3=Barra");
    assert_eq!(zonas(&nube.db).await, "z1=Salón z2=Terraza z3=Barra");
    assert_eq!(marcas(&db).await, "3");
    let mesa_antes = texto(&db, "SELECT json_array(ID_Zona, Numero_Mesa, Updated_At) FROM Mesas WHERE ID_Mesa = 'm1';").await;

    // El contraste no las toca: las trae la convergencia, las tres de una vez. Las dos que se
    // cruzan aparcan antes su nombre; la barra sólo cambia su hora.
    let r = pasada(&repo, &nube).await;
    assert_eq!((r.reparadas, r.aplazado), (0, true), "{r:?}");
    let (escritas, quedan) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!((escritas.len(), quedan), (3, false));
    assert!(escritas.iter().all(|s| s.sql.starts_with("INSERT INTO \"Zonas\"")), "{escritas:?}");
    assert_eq!(zonas(&db).await, "z1=Salón z2=Terraza z3=Barra");
    assert_eq!(marcas(&db).await, "0");
    // Nada aparcado se queda, lo que no estaba apuntado sigue igual, y nada sube.
    assert_eq!(aparcadas(&db).await, "0");
    assert_eq!(texto(&db, "SELECT json_array(ID_Zona, Numero_Mesa, Updated_At) FROM Mesas WHERE ID_Mesa = 'm1';").await, mesa_antes);
    assert_eq!(estado(&db).await, "PROXIMA");
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());

    // Y las dos bases cuadran, también en la hora de cada zona.
    let r = pasada(&repo, &nube).await;
    assert_eq!(r.descuadres, vec![], "{r:?}");
    assert_eq!((r.reparadas, r.aplazado), (0, false));

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn tres_zonas_que_rotan_el_nombre_tambien_se_traen_aunque_otra_fila_no_entre() {
    let (repo, db, dir, nube) = base("rotacion").await;
    sembrar(&db, ZONAS).await;
    nube.sembrar(ZONAS).await;
    // Arriba, Terraza → Salón → Barra → Terraza; y una mesa en un patio que aquí no está.
    nube.sembrar(
        "UPDATE Zonas SET Nombre_Zona = '_' || ID_Zona;
         UPDATE Zonas SET Nombre_Zona = CASE ID_Zona WHEN 'z1' THEN 'Salón' WHEN 'z2' THEN 'Barra' ELSE 'Terraza' END;
         INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Patio');
         INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
              VALUES ('m9', 'z9', '9', 2, 0, 0, 'rect', 80, 80);",
    )
    .await;
    apuntar(&db, "Zonas", &["z1", "z2", "z3"]).await;
    apuntar(&db, "Mesas", &["m9"]).await;

    // La mesa no entra (su zona no se trae) y deshace la vuelta entera; las zonas se vuelven a
    // intentar juntas, aparcando sus nombres, y entran. La mesa se queda apuntada.
    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 3);
    assert_eq!(zonas(&db).await, "z1=Salón z2=Barra z3=Terraza");
    assert_eq!(aparcadas(&db).await, "0");
    assert_eq!(texto(&db, "SELECT Tabla || ' ' || Clave_Json || ' ' || Intentos FROM _Sync_Por_Contrastar;").await, "Mesas [\"m9\"] 1");
    assert_eq!(texto(&db, "SELECT COUNT(*) FROM Mesas WHERE ID_Mesa = 'm9';").await, "0");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn dos_mesas_que_se_cambian_el_numero_entran_aunque_otra_de_su_tabla_no_entre() {
    // Arriba, la 1 y la 2 de la terraza se han cambiado el número, y hay una mesa en un patio que
    // aquí no está. Las tres son de la misma tabla: juntas no entran (la del patio no tiene zona), y
    // una a una tampoco las cruzadas. Juntas las dos que sólo chocan con el índice, sí.
    let (repo, db, dir, nube) = base("mesas-cruzadas").await;
    let otra_mesa = "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                          VALUES ('m2', 'z1', '2', 2, 0, 0, 'rect', 80, 80);";
    sembrar(&db, otra_mesa).await;
    nube.sembrar(otra_mesa).await;
    nube.sembrar(
        "UPDATE Mesas SET Numero_Mesa = '_' || ID_Mesa;
         UPDATE Mesas SET Numero_Mesa = CASE ID_Mesa WHEN 'm1' THEN '2' ELSE '1' END;
         INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Patio');
         INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
              VALUES ('m9', 'z9', '9', 2, 0, 0, 'rect', 80, 80);",
    )
    .await;
    apuntar(&db, "Mesas", &["m1", "m9", "m2"]).await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 2);
    let mesas = "SELECT group_concat(ID_Mesa || '=' || Numero_Mesa, ' ') FROM (SELECT * FROM Mesas ORDER BY ID_Mesa);";
    assert_eq!(texto(&db, mesas).await, "m1=2 m2=1");
    assert_eq!(texto(&db, "SELECT Tabla || ' ' || Clave_Json || ' ' || Intentos FROM _Sync_Por_Contrastar;").await, "Mesas [\"m9\"] 1");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn un_intercambio_entra_aunque_otra_fila_de_su_tabla_choque_con_algo_que_no_se_trae() {
    // Codex: arriba la terraza y el salón se han cambiado el nombre, y la barra se llama Cocina, que
    // aquí es el nombre de una zona que no está apuntada. La barra no entra; el intercambio, sí.
    let (repo, db, dir, nube) = base("intercambio-y-otra").await;
    let zonas_y_cocina = format!("{ZONAS} INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z4', 'Cocina');");
    sembrar(&db, &zonas_y_cocina).await;
    nube.sembrar(&zonas_y_cocina).await;
    nube.sembrar(
        "UPDATE Zonas SET Nombre_Zona = '_' || ID_Zona;
         UPDATE Zonas SET Nombre_Zona = CASE ID_Zona WHEN 'z1' THEN 'Salón' WHEN 'z2' THEN 'Terraza' WHEN 'z3' THEN 'Cocina' ELSE 'Almacén' END;",
    )
    .await;
    apuntar(&db, "Zonas", &["z1", "z2", "z3"]).await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 2);
    assert_eq!(zonas(&db).await, "z1=Salón z2=Terraza z3=Barra z4=Cocina");
    assert_eq!(aparcadas(&db).await, "0");
    assert_eq!(texto(&db, "SELECT Tabla || ' ' || Clave_Json || ' ' || Intentos FROM _Sync_Por_Contrastar;").await, "Zonas [\"z3\"] 1");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn un_intercambio_entra_aunque_otra_fila_de_su_tabla_rompa_una_foranea_al_confirmar() {
    // Codex: arriba dos trabajadores se han cambiado el DNI; otro se ha quedado con el DNI de un
    // cuarto y con un usuario que aquí no está, y el cuarto con el DNI del tercero. Solas chocan las
    // cuatro con el índice; juntas entran todas las sentencias, pero la foránea del tercero sólo
    // saltaría al confirmar. Se busca antes, y el intercambio de los dos primeros entra.
    let (repo, db, dir, nube) = base("dni-cruzados").await;
    let plantilla = "
        INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
             SELECT 'u' || i, '00000000-0000-7000-8000-000000000002', 'u' || i || '@bar.test', 'x', 'U' || i
               FROM (SELECT 1 AS i UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4);
        INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario, DNI) VALUES ('t1', 'u1', 'A'), ('t2', 'u2', 'B'), ('t3', 'u3', 'C'), ('t4', 'u4', 'D');
    ";
    sembrar(&db, plantilla).await;
    nube.sembrar(plantilla).await;
    nube.sembrar(
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
              VALUES ('u9', '00000000-0000-7000-8000-000000000002', 'u9@bar.test', 'x', 'U9');
         UPDATE Trabajadores SET DNI = NULL;
         UPDATE Trabajadores SET DNI = CASE ID_Trabajador WHEN 't1' THEN 'B' WHEN 't2' THEN 'A' WHEN 't3' THEN 'D' ELSE 'C' END;
         UPDATE Trabajadores SET ID_Usuario = 'u9' WHERE ID_Trabajador = 't3';",
    )
    .await;
    apuntar(&db, "Trabajadores", &["t1", "t2", "t3", "t4"]).await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 2);
    let trabajadores = "SELECT group_concat(ID_Trabajador || '=' || ID_Usuario || '/' || DNI, ' ') FROM (SELECT * FROM Trabajadores ORDER BY ID_Trabajador);";
    assert_eq!(texto(&db, trabajadores).await, "t1=u1/B t2=u2/A t3=u3/C t4=u4/D");
    assert_eq!(texto(&db, "SELECT group_concat(Clave_Json, ' ') FROM (SELECT Clave_Json FROM _Sync_Por_Contrastar ORDER BY Clave_Json);").await, "[\"t3\"] [\"t4\"]");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn las_marcas_de_una_tabla_no_se_parten_entre_vueltas() {
    // Codex: mil zonas apuntadas, cada una cruzada con la que está quinientas más allá. Partidas en
    // vueltas de quinientas no se encontrarían nunca: cada mitad fallaría sin la otra, una y otra
    // vez. Las de una tabla van juntas.
    let (repo, db, dir, nube) = base("mil-cruzadas").await;
    let mil = "WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < 999)
               INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT printf('z-%04d', i), printf('Zona %04d', i) FROM s;";
    sembrar(&db, mil).await;
    nube.sembrar(mil).await;
    nube.sembrar(
        "UPDATE Zonas SET Nombre_Zona = '_' || ID_Zona WHERE ID_Zona LIKE 'z-%';
         UPDATE Zonas SET Nombre_Zona = printf('Zona %04d', (CAST(substr(ID_Zona, 3) AS INTEGER) + 500) % 1000) WHERE ID_Zona LIKE 'z-%';",
    )
    .await;
    sembrar(
        &db,
        "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms)
         SELECT 'Zonas', json_array(ID_Zona), 40, 1 FROM Zonas WHERE ID_Zona LIKE 'z-%';",
    )
    .await;

    let (escritas, quedan) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!((escritas.len(), quedan), (1000, false));
    assert_eq!(marcas(&db).await, "0");
    let cruzadas = "SELECT COUNT(*) FROM Zonas WHERE Nombre_Zona = printf('Zona %04d', (CAST(substr(ID_Zona, 3) AS INTEGER) + 500) % 1000);";
    assert_eq!(texto(&db, cruzadas).await, "1000");
    assert_eq!(aparcadas(&db).await, "0");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn en_un_indice_parcial_tambien_se_cruza_lo_que_entra_y_sale_de_el() {
    // `Productos(Nombre) WHERE Archivado_En IS NULL`: arriba, la caña y el tercio se han cambiado el
    // nombre, y de las dos claras se ha archivado la que estaba a la venta y se ha vuelto a poner la
    // archivada. La caña archivada no se ha tocado: comparte nombre con una a la venta, y no choca.
    let productos = "
        INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Cervezas');
        INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Archivado_En) VALUES
            ('p1', 'cat-1', 'Caña', 250, NULL), ('p2', 'cat-1', 'Tercio', 320, NULL),
            ('p3', 'cat-1', 'Clara', 280, NULL), ('p4', 'cat-1', 'Clara', 300, '2026-11-01 10:00:00'),
            ('p5', 'cat-1', 'Caña', 200, '2026-10-01 10:00:00');
    ";
    let (repo, db, dir, nube) = base("parcial").await;
    sembrar(&db, productos).await;
    nube.sembrar(productos).await;
    nube.sembrar(
        "UPDATE Productos SET Nombre = '_' || ID_Producto WHERE ID_Producto IN ('p1', 'p2');
         UPDATE Productos SET Nombre = 'Tercio' WHERE ID_Producto = 'p1';
         UPDATE Productos SET Nombre = 'Caña' WHERE ID_Producto = 'p2';
         UPDATE Productos SET Archivado_En = '2026-11-14 09:00:00' WHERE ID_Producto = 'p3';
         UPDATE Productos SET Archivado_En = NULL WHERE ID_Producto = 'p4';",
    )
    .await;
    // La que se desarchiva, antes que la que se archiva: escrita sola, chocaría.
    apuntar(&db, "Productos", &["p4", "p3", "p2", "p1"]).await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 4);
    let productos = "SELECT group_concat(ID_Producto || '=' || Nombre || (CASE WHEN Archivado_En IS NULL THEN '' ELSE '*' END), ' ') \
                     FROM (SELECT * FROM Productos ORDER BY ID_Producto);";
    assert_eq!(texto(&db, productos).await, "p1=Tercio p2=Caña p3=Clara* p4=Clara p5=Caña*");
    assert_eq!(texto(&db, productos).await, texto(&nube.db, productos).await);
    assert_eq!((marcas(&db).await, aparcadas(&db).await), ("0".to_string(), "0".to_string()));

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn dos_comandas_abiertas_que_se_cambian_la_mesa_se_traen_aparcando_la_mesa() {
    // SYNC-38: arriba las comandas abiertas de la 1 y la 2 se han cambiado de mesa. El índice de una
    // comanda abierta por mesa no se sabía aparcar (la mesa sale en un CHECK): ahora se aparca en
    // texto, y sólo si tiene mesa. Un ticket de barra, sin mesa, no se toca.
    let (repo, db, dir, nube) = base("comandas-cruzadas").await;
    let comandas = "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                         VALUES ('m2', 'z1', '2', 2, 0, 0, 'rect', 80, 80);
                    INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado) VALUES
                         ('c1', 'm1', 'MESA', '2026-11-15 12:00:00', 'Abierta'),
                         ('c2', 'm2', 'MESA', '2026-11-15 12:05:00', 'Abierta'),
                         ('c3', NULL, 'BARRA', '2026-11-15 12:10:00', 'Abierta');";
    sembrar(&db, comandas).await;
    nube.sembrar(comandas).await;
    nube.sembrar(
        "UPDATE Comandas SET Canal = 'BARRA', ID_Mesa = NULL WHERE ID_Comanda = 'c1';
         UPDATE Comandas SET ID_Mesa = 'm1' WHERE ID_Comanda = 'c2';
         UPDATE Comandas SET Canal = 'MESA', ID_Mesa = 'm2' WHERE ID_Comanda = 'c1';
         UPDATE Comandas SET Fecha_Hora_Apertura = '2026-11-15 12:11:00' WHERE ID_Comanda = 'c3';",
    )
    .await;
    apuntar(&db, "Comandas", &["c1", "c2", "c3"]).await;

    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 3);
    let de_las_comandas = "SELECT group_concat(ID_Comanda || '=' || COALESCE(ID_Mesa, '-'), ' ') FROM (SELECT * FROM Comandas ORDER BY ID_Comanda);";
    assert_eq!(texto(&db, de_las_comandas).await, "c1=m2 c2=m1 c3=-");
    assert_eq!(texto(&db, "SELECT COUNT(*) FROM Comandas WHERE instr(ID_Mesa, char(1)) > 0;").await, "0");
    assert_eq!(marcas(&db).await, "0");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn una_fila_que_sigue_sin_entrar_conserva_su_marca_y_se_reintenta_sin_prisa() {
    // Arriba el salón se llama Comedor y la terraza Salón, pero aquí sólo está apuntada la terraza:
    // traerla choca con el salón de aquí, que no se trae.
    let (repo, db, dir, nube) = base("atascada").await;
    sembrar(&db, ZONAS).await;
    nube.sembrar(ZONAS).await;
    nube.sembrar("UPDATE Zonas SET Nombre_Zona = 'Comedor' WHERE ID_Zona = 'z2'; UPDATE Zonas SET Nombre_Zona = 'Salón' WHERE ID_Zona = 'z1';")
        .await;
    apuntar(&db, "Zonas", &["z1"]).await;

    // No entra, y no se deja: cada vuelta se aplaza (el motor espera cada vez el doble) sin dejar
    // nada aparcado.
    for vuelta in 1..=6 {
        let c = repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap();
        assert!(matches!(c, Convergencia::Aplazada), "vuelta {vuelta}: {c:?}");
        assert_eq!(zonas(&db).await, "z1=Terraza z2=Salón z3=Barra", "vuelta {vuelta}");
        assert_eq!(aparcadas(&db).await, "0");
    }
    assert_eq!(texto(&db, "SELECT Intentos FROM _Sync_Por_Contrastar WHERE Tabla = 'Zonas' AND Clave_Json = '[\"z1\"]';").await, "6");
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());

    // Cuando un cambio de la nube apunta también el salón, entran las dos.
    apuntar(&db, "Zonas", &["z2"]).await;
    let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!(escritas.len(), 2);
    assert_eq!(zonas(&db).await, "z1=Salón z2=Comedor z3=Barra");
    assert_eq!(marcas(&db).await, "0");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn el_contraste_sube_dos_nombres_cruzados_en_una_operacion_que_la_nube_puede_aplicar() {
    // Sin nada apuntado (lo que quede distinto por otro camino): aquí `z1=Salón z2=Terraza`, arriba
    // al revés. La reparación sube lo de aquí, y la nube, que comprueba el índice sentencia a
    // sentencia, sólo la puede aplicar si los nombres van aparcados antes.
    let (repo, db, dir, nube) = base("contraste-cruzado").await;
    sembrar(&db, ZONAS).await;
    nube.sembrar(ZONAS).await;
    sembrar(
        &db,
        "UPDATE Zonas SET Nombre_Zona = '_' || ID_Zona WHERE ID_Zona IN ('z1', 'z2');
         UPDATE Zonas SET Nombre_Zona = 'Salón' WHERE ID_Zona = 'z1';
         UPDATE Zonas SET Nombre_Zona = 'Terraza' WHERE ID_Zona = 'z2';",
    )
    .await;

    let r = pasada(&repo, &nube).await;
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (2, 0, false), "{r:?}");
    let ops = repo.outbox_pending(10).await.unwrap();
    assert_eq!(ops.len(), 1, "las dos en la misma operación");
    let sql: Vec<&str> = ops[0].statements.iter().map(|s| s.sql.as_str()).collect();
    assert_eq!(sql.len(), 4, "{sql:?}");
    assert!(sql[..2].iter().all(|s| s.starts_with("UPDATE \"Zonas\" SET \"Nombre_Zona\" = CASE WHEN")), "{sql:?}");
    assert!(sql[2..].iter().all(|s| s.starts_with("INSERT INTO \"Zonas\"")), "{sql:?}");

    // La nube la aplica en una transacción, como el DO, y queda como aquí, sin nada aparcado.
    nube.aplicar(&ops[0].statements).await;
    repo.outbox_confirmar_lote(&[(ops[0].op_id.clone(), 41)]).await.unwrap();
    assert_eq!(zonas(&nube.db).await, "z1=Salón z2=Terraza z3=Barra");
    assert_eq!(aparcadas(&nube.db).await, "0");
    *nube.hasta_seq.lock().unwrap() = 41;
    assert_eq!(pasada(&repo, &nube).await.descuadres, vec![]);

    cerrar(db, dir, nube).await;
}
