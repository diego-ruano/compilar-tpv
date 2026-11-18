//! SYN-INC-07 · Dos altas de la misma clienta (el mismo correo) a la vez, una en la Main y otra en
//! una Handy, de punta a punta: los repositorios SQLite reales y una nube que es otra base con el
//! esquema del negocio (`comun::nube_de_contraste`), que aplica lo que sube como el DO.
//!
//! La Main da de alta a Ana con su correo, le apunta una reserva y le cobra un ticket; antes de que
//! nada de eso suba, una Handy da de alta a Ana con el mismo correo. Arriba el alta de la Main choca
//! con el índice del correo y lo que cuelga de ella con su foránea: todo se aparta, con sus
//! reparaciones. Aquí el alta de la Handy choca con la ficha de la Main y acaba en cuarentena, y con
//! ella el contraste no repara nada. La salida de esa cuarentena funde la ficha de aquí en la de la
//! nube: al final hay una sola Ana, con lo suyo, en las dos bases, sin nada apartado y con el
//! contraste reparando otra vez.

mod comun;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas};
use tpv_application::ports::clientes::ClientesRepository;
use tpv_application::ports::sync::{ContrasteLocal, SyncRepository};
use tpv_contracts::sync::{SqlStatement, SyncChange};
use tpv_domain::clientes::NuevoCliente;
use tpv_infra_sqlite::clientes::SqliteClientesRepository;
use tpv_infra_sqlite::db::{Db, Writer};
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

/// La ficha de la Main y la de la Handy. UUIDv7, como las de verdad.
const ANA_MAIN: &str = "0193a5f0-0000-7000-8000-00000000000a";
const ANA_HANDY: &str = "0193a5f0-0000-7000-8000-00000000000b";

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join("tpv_tests").join(format!("fusion-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
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

async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    filas.next().await.unwrap().expect("una fila").get::<i64>(0).unwrap()
}

/// Las filas de una consulta, cada una como texto, para comparar las dos bases.
async fn filas(db: &Arc<Db>, sql: &str) -> Vec<String> {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.unwrap() {
        let mut columnas = Vec::new();
        let mut i = 0;
        while let Ok(v) = f.get_value(i) {
            columnas.push(match v {
                Value::Null => "NULL".to_string(),
                Value::Integer(n) => n.to_string(),
                Value::Real(x) => x.to_string(),
                Value::Text(t) => t,
                Value::Blob(_) => "blob".into(),
            });
            i += 1;
        }
        salida.push(columnas.join("|"));
    }
    salida
}

fn argumento(v: &JsonValue) -> Value {
    match v {
        JsonValue::String(s) => Value::Text(s.clone()),
        JsonValue::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap())),
        JsonValue::Bool(b) => Value::Integer(i64::from(*b)),
        _ => Value::Null,
    }
}

/// La nube intenta aplicar una operación de la Main como el DO: entera o nada, con las foráneas
/// mirándose al confirmar. `Err` con el error de SQLite si no entra.
async fn intentar(nube: &NubeDeContraste, sentencias: &[SqlStatement]) -> Result<(), String> {
    let w = nube.db.write().await;
    let conn = w.raw();
    conn.execute_batch("PRAGMA defer_foreign_keys = ON; BEGIN;").await.unwrap();
    for s in sentencias {
        if let Err(e) = conn.execute(&s.sql, s.args.iter().map(argumento).collect::<Vec<_>>()).await {
            conn.execute_batch("ROLLBACK;").await.unwrap();
            return Err(e.to_string());
        }
    }
    if let Err(e) = conn.execute_batch("COMMIT;").await {
        conn.execute_batch("ROLLBACK;").await.unwrap();
        return Err(e.to_string());
    }
    Ok(())
}

/// Sube el outbox como el motor de réplica: lo que entra se confirma con su `Seq` (el log de la nube
/// avanza) y lo que la nube rechaza se aparta como permanente, con su reparación inmediata detrás.
/// Devuelve lo que se ha rechazado, por orden.
async fn subir(repo: &SqliteSyncRepository, nube: &NubeDeContraste) -> Vec<String> {
    let mut rechazos = Vec::new();
    for _ in 0..50 {
        let Some(op) = repo.outbox_pending(1).await.unwrap().into_iter().next() else { return rechazos };
        match intentar(nube, &op.statements).await {
            Ok(()) => {
                let seq = {
                    let mut s = nube.hasta_seq.lock().unwrap();
                    *s += 1;
                    *s
                };
                repo.outbox_confirmar_lote(&[(op.op_id.clone(), seq)]).await.unwrap();
            }
            Err(e) => {
                rechazos.push(e.clone());
                repo.outbox_mark_failed(&op.op_id, &e, true).await.unwrap();
            }
        }
    }
    panic!("el outbox no se vacía");
}

/// Aplica un cambio de la nube hasta que entra o pasa a cuarentena, como el motor de réplica.
async fn bajar(repo: &SqliteSyncRepository, ch: &SyncChange) {
    for _ in 0..10 {
        repo.apply_changes(vec![ch.clone()]).await.unwrap();
        if repo.get_checkpoint().await.unwrap() >= ch.seq {
            return;
        }
    }
    panic!("{} ni entra ni pasa a cuarentena", ch.op_id);
}

async fn pasada(repo: &SqliteSyncRepository, nube: &NubeDeContraste) -> ContrasteLocal {
    let marca = repo.contraste_marca().await.unwrap();
    let resumen = nube.resumen_para(marca.checkpoint).await;
    repo.contrastar_con_la_nube(resumen, marca, &Paginas(nube), true).await.unwrap()
}

async fn apartadas(db: &Arc<Db>) -> i64 {
    numero(db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 1;").await
}

async fn en_cuarentena(db: &Arc<Db>) -> i64 {
    numero(db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;").await
}

/// El alta de Ana desde una Handy, tal como la difunde el `TenantHub`.
fn alta_de_la_handy() -> Vec<SqlStatement> {
    vec![SqlStatement {
        sql: "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas, Created_At) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
              ON CONFLICT(ID_Cliente) DO UPDATE SET Nombre = excluded.Nombre, Telefono = excluded.Telefono, \
              Email = excluded.Email, Notas = excluded.Notas;"
            .into(),
        args: vec![
            json!(ANA_HANDY),
            json!("Ana García"),
            json!("600111222"),
            json!("ANA@correo.es"),
            JsonValue::Null,
            json!("2027-01-15 09:00:00"),
        ],
    }]
}

/// Lo que la Main hace con su Ana antes de que nada suba: el alta (por el repositorio de verdad),
/// una reserva y el cobro de un ticket que se le acredita. Tres operaciones en el outbox.
async fn la_main_da_de_alta_a_ana(db: &Arc<Db>) {
    SqliteClientesRepository::new(db.clone())
        .create(NuevoCliente {
            id: Some(ANA_MAIN.into()),
            nombre: "Ana".into(),
            email: Some("ana@correo.es".into()),
            telefono: None,
            notas: Some("Alérgica al marisco".into()),
        })
        .await
        .unwrap();
    let w = db.write().await;
    w.execute(
        "INSERT INTO Reservas (ID_Reserva, ID_Cliente, Dia_YMD, Hora, Turno, Comensales, Estado, Created_At, Origen) \
         VALUES (?1, ?2, '2027-01-20', '21:00', 'CENA', 2, 'PROXIMA', '2027-01-15 10:00:00', 'TPV');",
        vec![Value::Text("reserva-ana".into()), Value::Text(ANA_MAIN.into())],
    )
    .await
    .unwrap();
    w.transaccion(async {
        w.execute(
            "INSERT INTO Comandas (ID_Comanda, Canal, ID_Cliente, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado) \
             VALUES ('ticket-ana', 'BARRA', ?1, '2027-01-15 13:00:00', '2027-01-15 13:30:00', 2500, 'Pagada');",
            vec![Value::Text(ANA_MAIN.into())],
        )
        .await
        .unwrap();
        w.execute(
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) \
             VALUES ('pago-ana', 'ticket-ana', '2027-01-15 13:30:00', 'Efectivo', 2500, 'TOTAL');",
            (),
        )
        .await
        .unwrap();
        w.execute(
            "UPDATE Clientes SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2 WHERE ID_Cliente = ?1;",
            vec![Value::Text(ANA_MAIN.into()), Value::Integer(2500)],
        )
        .await
        .unwrap();
        Ok(())
    })
    .await
    .unwrap();
}

/// La Main con su Ana y lo que cuelga de ella apartado de la subida, y el alta de la Handy en
/// cuarentena; la nube con la Ana de la Handy (`Seq` 1).
async fn las_dos_anas(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf, NubeDeContraste) {
    let (repo, db, dir) = base(nombre).await;
    let nube = NubeDeContraste::nueva(nombre).await;

    la_main_da_de_alta_a_ana(&db).await;
    nube.aplicar(&alta_de_la_handy()).await;
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;

    // Arriba: el alta choca con el correo, y la reserva y el cobro con la foránea. Cada una se
    // aparta con su reparación inmediata, que tampoco entra.
    let rechazos = subir(&repo, &nube).await;
    assert_eq!(rechazos.len(), 6, "{rechazos:?}");
    // El alta y lo que reparan con la ficha de aquí dentro chocan con el correo; la reserva y el
    // cobro, con la foránea.
    assert!(rechazos[0].contains("ux_clientes_email"), "{rechazos:?}");
    assert!(rechazos.iter().all(|e| e.contains("ux_clientes_email") || e.contains("FOREIGN KEY")), "{rechazos:?}");
    assert_eq!(apartadas(&db).await, 6);

    // Aquí: el alta de la Handy choca con la ficha de la Main y acaba en cuarentena.
    bajar(&repo, &SyncChange { op_id: "op-handy".into(), seq: 1, statements: alta_de_la_handy() }).await;
    assert_eq!(en_cuarentena(&db).await, 1);
    (repo, db, dir, nube)
}

/// Lo de Ana en una base: lo que tiene que quedar igual arriba y aquí.
const DE_ANA: [&str; 4] = [
    "SELECT ID_Cliente, Nombre, Telefono, Email, Notas, Total_Gastado, Created_At FROM Clientes ORDER BY ID_Cliente;",
    "SELECT ID_Reserva, ID_Cliente FROM Reservas ORDER BY ID_Reserva;",
    "SELECT ID_Comanda, ID_Cliente, Estado FROM Comandas ORDER BY ID_Comanda;",
    "SELECT ID_Pago, ID_Comanda, Importe_Total FROM Pagos ORDER BY ID_Pago;",
];

// ── La fusión ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn dos_altas_del_mismo_correo_acaban_en_una_ficha_con_todo_lo_suyo_y_el_contraste_vuelve_a_reparar() {
    let (repo, db, dir, nube) = las_dos_anas("completa").await;

    // La pasada del contraste: la cuarentena no entra (el correo), y la ficha de aquí se funde en la
    // de la nube. Eso sube, así que la pasada se deja sin comparar.
    assert!(matches!(pasada(&repo, &nube).await, ContrasteLocal::SeHaMovido));
    assert_eq!(
        filas(&db, DE_ANA[0]).await,
        vec![format!("{ANA_HANDY}|Ana García|600111222|ANA@correo.es|Alérgica al marisco|2500|2027-01-15 09:00:00")],
        "una sola Ana: la de la nube, con su nombre, su teléfono y su correo, la nota de la de aquí y el gasto re-derivado"
    );
    assert_eq!(filas(&db, DE_ANA[1]).await, vec![format!("reserva-ana|{ANA_HANDY}")]);
    assert_eq!(filas(&db, DE_ANA[2]).await, vec![format!("ticket-ana|{ANA_HANDY}|Pagada")]);
    // Lo que sólo escribía la ficha de aquí (su alta y su reparación) se ha retirado; la reserva y el
    // cobro esperan a su reparación, que sube delante de la fusión.
    assert_eq!(apartadas(&db).await, 4);
    let sube = repo.outbox_pending(10).await.unwrap();
    assert_eq!(sube.len(), 2, "{sube:?}");
    assert_eq!(sube[0].command_name, "main_reparacion");
    assert!(sube[1].statements.iter().any(|s| s.sql.starts_with("DELETE FROM \"Clientes\"")), "{:?}", sube[1].statements);
    assert_eq!(en_cuarentena(&db).await, 1, "sale en la pasada siguiente");

    // Sube todo: la reparación (la reserva y el ticket, ya con la ficha de la nube) y la fusión.
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0, "la reparación retira lo que reparaba");
    assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 0);
    for sql in DE_ANA {
        assert_eq!(filas(&nube.db, sql).await, filas(&db, sql).await, "{sql}");
    }

    // La pasada siguiente: la cuarentena sale (lo de la nube ya cabe) y, sin cuarentenas, el
    // contraste compara y no encuentra nada que reparar.
    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert_eq!(r.descuadres, vec![], "{r:?}");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    assert_eq!(repo.outbox_pending(10).await.unwrap().len(), 0);

    // Y otra pasada no funde nada más: todo está como debe.
    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes;").await, 1);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn si_la_reparacion_de_lo_que_colgaba_tampoco_entra_lo_sube_el_contraste() {
    // La reparación de la reserva y el cobro no entra (por lo que sea): se queda apartada con lo que
    // reparaba, la fusión sube igual, y el contraste de la pasada siguiente sube lo que falta y lo
    // retira todo.
    let (repo, db, dir, nube) = las_dos_anas("contraste").await;
    assert!(matches!(pasada(&repo, &nube).await, ContrasteLocal::SeHaMovido));
    let reparacion = repo.outbox_pending(1).await.unwrap().remove(0);
    repo.outbox_mark_failed(&reparacion.op_id, "rechazada", true).await.unwrap();
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new(), "la fusión entra");
    assert_eq!(apartadas(&db).await, 5);

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert!(r.reparadas > 0 && !r.aplazado, "{r:?}");
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0, "el plan del contraste retira lo apartado");
    for sql in DE_ANA {
        assert_eq!(filas(&nube.db, sql).await, filas(&db, sql).await, "{sql}");
    }

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn una_ficha_de_aqui_que_no_esta_apartada_no_se_funde() {
    // Con todo subido, una ficha de aquí con el correo de una de la nube que nada apartado explica no
    // se toca: la cuarentena se queda (y a la semana se avisa).
    let (repo, db, dir) = base("sin-apartar").await;
    let nube = NubeDeContraste::nueva("sin-apartar").await;
    sembrar(&db, &format!("INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('{ANA_MAIN}', 'Ana', 'ana@correo.es');")).await;
    nube.aplicar(&alta_de_la_handy()).await;
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;
    bajar(&repo, &SyncChange { op_id: "op-handy".into(), seq: 1, statements: alta_de_la_handy() }).await;
    assert_eq!(en_cuarentena(&db).await, 1);

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert!(r.aplazado, "{r:?}");
    assert_eq!(en_cuarentena(&db).await, 1);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes;").await, 1);
    assert_eq!(filas(&db, "SELECT ID_Cliente FROM Clientes;").await, vec![ANA_MAIN.to_string()]);
    assert_eq!(repo.outbox_pending(10).await.unwrap().len(), 0, "no sube nada");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn si_la_ficha_de_la_nube_ya_no_tiene_ese_correo_no_se_funde_y_la_de_aqui_sube() {
    // Después del alta, la Handy le cambia el correo a su Ana: el alta sigue en cuarentena aquí, pero
    // lo que se trae de la nube ya no choca. La cuarentena sale sin fundir nada y el contraste sube la
    // Ana de aquí, que ya cabe arriba.
    let (repo, db, dir, nube) = las_dos_anas("otro-correo").await;
    nube.sembrar(&format!("UPDATE Clientes SET Email = 'ana.garcia@correo.es' WHERE ID_Cliente = '{ANA_HANDY}';")).await;

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert!(r.reparadas > 0, "{r:?}");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes;").await, 2, "dos clientas distintas");
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0);
    for sql in DE_ANA {
        assert_eq!(filas(&nube.db, sql).await, filas(&db, sql).await, "{sql}");
    }

    cerrar(db, dir, nube).await;
}

// ── Proveedores ───────────────────────────────────────────────────────────────

const PROV_MAIN: &str = "0193a5f0-0000-7000-8000-0000000000a1";
const PROV_HANDY: &str = "0193a5f0-0000-7000-8000-0000000000b1";

#[tokio::test]
async fn un_proveedor_dado_de_alta_dos_veces_con_el_mismo_cif_se_funde_con_sus_productos_y_pedidos() {
    let (repo, db, dir) = base("proveedor").await;
    let nube = NubeDeContraste::nueva("proveedor").await;
    let catalogo = "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');";
    sembrar(&db, catalogo).await;
    nube.sembrar(catalogo).await;

    // La Main: el proveedor, un producto suyo y un pedido. Tres operaciones.
    {
        let w = db.write().await;
        w.execute(
            "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Telefono, Email, CIF) VALUES (?1, 'Bebidas Sur', '955000111', NULL, 'B11111111');",
            vec![Value::Text(PROV_MAIN.into())],
        )
        .await
        .unwrap();
        w.execute(
            "INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta) VALUES ('cana', 'cat', ?1, 'Caña', 200);",
            vec![Value::Text(PROV_MAIN.into())],
        )
        .await
        .unwrap();
        w.execute(
            "INSERT INTO Pedidos_Proveedor (ID_Pedido, ID_Proveedor, Estado, Fecha_Creacion) VALUES ('pedido', ?1, 'borrador', '2027-01-15 10:00:00');",
            vec![Value::Text(PROV_MAIN.into())],
        )
        .await
        .unwrap();
    }
    // Una Handy, el mismo CIF y un correo.
    let alta = vec![SqlStatement {
        sql: "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Contacto, Email, CIF) VALUES (?1, ?2, ?3, ?4, ?5);".into(),
        args: vec![json!(PROV_HANDY), json!("Bebidas del Sur SL"), json!("Luis"), json!("pedidos@bebidassur.es"), json!("B11111111")],
    }];
    nube.aplicar(&alta).await;
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;
    let rechazos = subir(&repo, &nube).await;
    assert!(rechazos[0].contains("UNIQUE"), "{rechazos:?}");
    bajar(&repo, &SyncChange { op_id: "op-handy".into(), seq: 1, statements: alta }).await;
    assert_eq!(en_cuarentena(&db).await, 1);

    assert!(matches!(pasada(&repo, &nube).await, ContrasteLocal::SeHaMovido));
    assert_eq!(
        filas(&db, "SELECT ID_Proveedor, Nombre_Empresa, Contacto, Telefono, Email, CIF FROM Proveedores;").await,
        vec![format!("{PROV_HANDY}|Bebidas del Sur SL|Luis|955000111|pedidos@bebidassur.es|B11111111")]
    );
    assert_eq!(filas(&db, "SELECT ID_Proveedor FROM Productos;").await, vec![PROV_HANDY.to_string()]);
    assert_eq!(filas(&db, "SELECT ID_Proveedor FROM Pedidos_Proveedor;").await, vec![PROV_HANDY.to_string()]);
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0);

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert_eq!(r.descuadres, vec![], "{r:?}");
    for sql in [
        "SELECT * FROM Proveedores ORDER BY ID_Proveedor;",
        "SELECT ID_Producto, ID_Proveedor FROM Productos ORDER BY ID_Producto;",
        "SELECT ID_Pedido, ID_Proveedor FROM Pedidos_Proveedor ORDER BY ID_Pedido;",
    ] {
        assert_eq!(filas(&nube.db, sql).await, filas(&db, sql).await, "{sql}");
    }

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn si_la_ficha_de_la_nube_ya_no_esta_no_se_funde_nada_y_la_de_aqui_sube() {
    // La Handy da de alta al proveedor con el CIF de uno de la Main y después lo borra: el alta sigue
    // en cuarentena aquí, pero la nube ya no lo tiene. La cuarentena sale sin traer nada, no se funde
    // nada, y el contraste sube el de la Main, que ya cabe arriba.
    let (repo, db, dir) = base("proveedor-borrado").await;
    let nube = NubeDeContraste::nueva("proveedor-borrado").await;
    {
        let w = db.write().await;
        w.execute(
            "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, CIF) VALUES (?1, 'Bebidas Sur', 'B11111111');",
            vec![Value::Text(PROV_MAIN.into())],
        )
        .await
        .unwrap();
    }
    let alta = vec![SqlStatement {
        sql: "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, CIF) VALUES (?1, ?2, ?3);".into(),
        args: vec![json!(PROV_HANDY), json!("Bebidas del Sur SL"), json!("B11111111")],
    }];
    nube.aplicar(&alta).await;
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;
    assert_eq!(subir(&repo, &nube).await.len(), 2, "el alta y su reparación");
    bajar(&repo, &SyncChange { op_id: "op-handy".into(), seq: 1, statements: alta }).await;
    nube.sembrar(&format!("DELETE FROM Proveedores WHERE ID_Proveedor = '{PROV_HANDY}';")).await;

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert!(r.reparadas > 0, "{r:?}");
    assert_eq!(filas(&db, "SELECT ID_Proveedor FROM Proveedores;").await, vec![PROV_MAIN.to_string()]);
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0);
    let sql = "SELECT * FROM Proveedores ORDER BY ID_Proveedor;";
    assert_eq!(filas(&nube.db, sql).await, filas(&db, sql).await);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn si_la_handy_le_pone_el_correo_a_una_ficha_que_ya_estaba_aqui_tambien_se_funde_y_converge() {
    // La Ana de la Handy ya estaba en las dos bases, sin correo. La Main da de alta a otra Ana con su
    // correo y, a la vez, la Handy le pone ese correo a la suya: aquí ese cambio choca y acaba en
    // cuarentena. La fusión rellena la de aquí sin tocar lo que ya tenía y, en la pasada siguiente,
    // la cuarentena trae lo de la nube y las dos bases quedan iguales.
    let (repo, db, dir) = base("ya-estaba").await;
    let nube = NubeDeContraste::nueva("ya-estaba").await;
    let ana_handy = format!(
        "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Created_At) VALUES ('{ANA_HANDY}', 'Ana García', '600111222', '2027-01-01 09:00:00');"
    );
    sembrar(&db, &ana_handy).await;
    nube.sembrar(&ana_handy).await;

    SqliteClientesRepository::new(db.clone())
        .create(NuevoCliente {
            id: Some(ANA_MAIN.into()),
            nombre: "Ana".into(),
            email: Some("ana@correo.es".into()),
            telefono: None,
            notas: Some("Alérgica al marisco".into()),
        })
        .await
        .unwrap();
    let correo = vec![SqlStatement {
        sql: "UPDATE Clientes SET Email = ?2 WHERE ID_Cliente = ?1;".into(),
        args: vec![json!(ANA_HANDY), json!("ANA@correo.es")],
    }];
    nube.aplicar(&correo).await;
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;
    assert_eq!(subir(&repo, &nube).await.len(), 2, "el alta y su reparación");
    bajar(&repo, &SyncChange { op_id: "op-handy".into(), seq: 1, statements: correo }).await;
    assert_eq!(en_cuarentena(&db).await, 1);

    assert!(matches!(pasada(&repo, &nube).await, ContrasteLocal::SeHaMovido));
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes;").await, 1);
    assert_eq!(subir(&repo, &nube).await, Vec::<String>::new());
    assert_eq!(apartadas(&db).await, 0);

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("se tenía que comparar") };
    assert_eq!(en_cuarentena(&db).await, 0);
    assert_eq!(r.descuadres, vec![], "{r:?}");
    assert_eq!(
        filas(&db, DE_ANA[0]).await,
        vec![format!("{ANA_HANDY}|Ana García|600111222|ANA@correo.es|Alérgica al marisco|0|2027-01-01 09:00:00")]
    );
    assert_eq!(filas(&nube.db, DE_ANA[0]).await, filas(&db, DE_ANA[0]).await);

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn una_ficha_de_aqui_con_un_valor_que_no_se_replica_no_se_funde() {
    // Las notas de la Ana de aquí son un blob (no lo escribe la aplicación, pero puede estar): al
    // replicarse llegaría arriba como NULL y se perdería con la ficha. No se funde, y la cuarentena
    // se queda.
    let (repo, db, dir, nube) = las_dos_anas("blob").await;
    sembrar(&db, &format!("UPDATE Clientes SET Notas = x'00ff' WHERE ID_Cliente = '{ANA_MAIN}';")).await;

    let ContrasteLocal::Hecho(r) = pasada(&repo, &nube).await else { panic!("no se ha fundido nada: se compara") };
    assert!(r.aplazado, "{r:?}");
    assert_eq!(en_cuarentena(&db).await, 1);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes;").await, 1, "la de aquí sigue ahí");
    assert_eq!(filas(&db, "SELECT ID_Cliente, Notas FROM Clientes;").await, vec![format!("{ANA_MAIN}|blob")]);
    assert_eq!(repo.outbox_pending(10).await.unwrap().len(), 0, "no sube nada");

    cerrar(db, dir, nube).await;
}
