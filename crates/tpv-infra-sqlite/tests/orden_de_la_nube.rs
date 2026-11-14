//! SYNC-29 · El orden de la nube manda, de punta a punta: el repositorio de sync real, los
//! repositorios de negocio de verdad y una nube que es otra base SQLite con el esquema del negocio y
//! contesta `/v1/sync/verificar/*` como el worker (`comun::nube_de_contraste`).
//!
//! La Main cancela una reserva porque lo pide el cliente y, antes de que la cancelación suba, una
//! Handy la sienta. En la nube la cancelación va detrás (llegó después): la reserva queda cancelada,
//! que es lo que ve la agenda de la web. Aquí el cambio de la Handy se aplicó encima: la reserva queda
//! sentada, y el eco de la cancelación se descarta porque ya está aplicada. La Main tiene que acabar
//! como la nube en cuanto lo suyo está subido, y el contraste diario no puede volver a subirla viva.

mod comun;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas};
use tpv_application::error::AppResult;
use tpv_application::ports::reservas::ReservasRepository;
use tpv_application::ports::sync::{
    ContrasteLocal, Convergencia, PaginasDelContraste, PedidoDeClaves, PedidoDeFilas, PedidoPorClave, SyncRepository,
};
use tpv_contracts::sync::{ClavesPagina, FilasDeCubos, FilasPorClave, ResultadoVerificacion, SqlStatement, SyncChange};
use tpv_infra_sqlite::db::{Db, Writer};
use tpv_infra_sqlite::ejecutor::Value;
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

/// La carrera: lo que la Main escribe (`escribe`) queda por subir, la Handy escribe lo suyo en la nube
/// (`Seq` 41) y la Main lo aplica encima; después sube lo de la Main (`Seq` 42) y su eco vuelve. El
/// log de la nube y el checkpoint acaban en 42.
async fn la_carrera(repo: &SqliteSyncRepository, db: &Arc<Db>, nube: &NubeDeContraste, de_la_handy: Vec<SqlStatement>) {
    let propia = repo.outbox_pending(10).await.unwrap();
    assert_eq!(propia.len(), 1, "lo de la Main, por subir");
    let propia = propia.into_iter().next().unwrap();

    nube.aplicar(&de_la_handy).await;
    repo.apply_changes(vec![SyncChange { op_id: "op-handy".into(), seq: 41, statements: de_la_handy }]).await.unwrap();

    nube.aplicar(&propia.statements).await;
    repo.outbox_confirmar_lote(&[(propia.op_id.clone(), 42)]).await.unwrap();
    repo.apply_changes(vec![SyncChange { op_id: propia.op_id.clone(), seq: 42, statements: propia.statements }]).await.unwrap();
    assert_eq!(repo.get_checkpoint().await.unwrap(), 42);
    let _ = db;
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
    la_carrera(&repo, &db, &nube, la_handy_la_sienta()).await;

    // Lo que dejaba SYNC-29: aquí sentada, en la nube cancelada.
    assert_eq!(estado(&db).await, "ACTIVA");
    assert_eq!(estado(&nube.db).await, "CANCELADA");
    assert_eq!(marcas(&db).await, "1", "la fila que tocó la Handy, apuntada al aplicarla");

    // El contraste no la sube viva: la trae la convergencia.
    let r = pasada(&repo, &nube).await;
    assert_eq!((r.reparadas, r.aplazado), (0, true), "{r:?}");
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());

    // Con todo subido y la bajada al día, se trae de la nube como está.
    let (escritas, quedan) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
    assert_eq!((escritas.len(), quedan), (1, false));
    assert!(escritas[0].sql.starts_with("INSERT INTO \"Reservas\"") && escritas[0].sql.contains("ON CONFLICT"), "{}", escritas[0].sql);
    assert_eq!(estado(&db).await, "CANCELADA");
    assert_eq!(marcas(&db).await, "0");
    // Sólo aquí: ni el outbox ni el checkpoint se mueven.
    assert!(repo.outbox_pending(10).await.unwrap().is_empty());
    assert_eq!(repo.get_checkpoint().await.unwrap(), 42);

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
    la_carrera(&repo, &db, &nube, la_handy_la_edita()).await;
    assert_eq!(estado(&db).await, "PROXIMA");
    assert_eq!(estado(&nube.db).await, "-");

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
    la_carrera(&repo, &db, &nube, la_handy_la_sienta()).await;

    // La nube tiene algo que esta Main todavía no ha aplicado.
    *nube.hasta_seq.lock().unwrap() = 43;
    assert!(matches!(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap(), Convergencia::Aplazada));
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "1".to_string()));

    // Hay algo de aquí por subir: ni se pide.
    *nube.hasta_seq.lock().unwrap() = 42;
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
    la_carrera(&repo, &db, &nube, la_handy_la_sienta()).await;

    let paginas = EscribeAlPedir { nube: &nube, db: db.clone() };
    assert!(matches!(repo.converger_con_la_nube(&paginas).await.unwrap(), Convergencia::Aplazada));
    assert_eq!((estado(&db).await, marcas(&db).await), ("ACTIVA".to_string(), "1".to_string()));

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn lo_que_la_main_escribio_y_la_nube_no_acepto_no_se_pisa() {
    let (repo, db, dir, nube) = base("apartada").await;
    assert!(SqliteReservasRepository::new(db.clone()).cancelar("r1").await.unwrap());
    la_carrera(&repo, &db, &nube, la_handy_la_sienta()).await;
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
async fn lo_cobrado_no_se_borra_desde_la_nube_y_lo_que_no_entra_se_deja_a_los_cinco_intentos() {
    // Una comanda que la nube no tiene y aquí tiene un cobro: borrarla aquí se llevaría el cobro
    // por la cascada de `Pagos.ID_Comanda`. No se hace, y a la quinta vuelta se deja.
    let (repo, db, dir, nube) = base("cobro").await;
    sembrar(
        &db,
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'BARRA', '2026-11-14 12:00:00', 'Pagada');
         INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
              VALUES ('p1', 'c1', '2026-11-14 12:10:00', 'Efectivo', 500, 'TOTAL');
         INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) VALUES ('Comandas', '[\"c1\"]', 40, 1);",
    )
    .await;

    for vuelta in 1..=5 {
        let (escritas, _) = hecha(repo.converger_con_la_nube(&Paginas(&nube)).await.unwrap());
        assert!(escritas.is_empty(), "vuelta {vuelta}");
        assert_eq!(texto(&db, "SELECT COUNT(*) FROM Pagos WHERE ID_Pago = 'p1';").await, "1", "vuelta {vuelta}");
    }
    assert_eq!(texto(&db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'c1';").await, "1");
    assert_eq!(marcas(&db).await, "0");

    cerrar(db, dir, nube).await;
}
