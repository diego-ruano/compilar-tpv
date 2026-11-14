//! SYNC-31 · Un ticket borrado desde la Handy con su cobro en camino, de punta a punta: el cobro de
//! verdad (`SqliteVentaRapidaRepository`), el repositorio de sync real y una nube que es otra base
//! SQLite con el esquema del negocio (`comun::nube_de_contraste`).
//!
//! La Main cobra el ticket y, antes de que el cobro entre en la nube, una Handy lo borra: allí no hay
//! ningún cobro y se borra; aquí la condición del borrado se vuelve a evaluar y no borra nada
//! (AUD-14). El cobro choca después con la clave foránea de `Pagos.ID_Comanda`, la nube lo rechaza y
//! la Main lo aparta. Lo que viene detrás tiene que devolver a la nube el ticket entero y no dejar
//! ninguna cuarentena: la reparación inmediata manda en una operación la comanda, sus líneas, su
//! cobro y lo que cuelga de él.

mod comun;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas};
use tpv_application::ports::sync::{ContrasteLocal, SyncRepository};
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::sync::{ResultadoVerificacion, SqlStatement, SyncChange};
use tpv_domain::dinero::Dinero;
use tpv_domain::venta_rapida::CobroFraccionado;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::venta_rapida::SqliteVentaRapidaRepository;

const PAGO: &str = "0192f7a4-3b1c-7d2e-8f00-123456789abc";

/// Lo que hay en las dos bases antes de cobrar: un bar con NIF (sin él no se cobra), una caña con
/// su lote y un ticket de barra abierto con una línea de tres cañas.
const TICKET_ABIERTO: &str = "
    UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL' WHERE ID = 1;
    INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');
    INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cana', 'cat', 'Caña', 200);
    INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
         VALUES ('lote', 'cana', 'L1', 10, '2027-01-15 10:00:00');
    INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
         VALUES ('ticket', 'BARRA', '2027-01-15 12:00:00', 'Abierta');
    INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
         VALUES ('linea', 'ticket', 'cana', 3, 200);
";

/// Lo que difunde el `TenantHub` al borrar `ticket` desde la Handy (AUD-14).
fn borrado_de_la_handy() -> Vec<SqlStatement> {
    let sin_cobros = "NOT EXISTS (SELECT 1 FROM Pagos WHERE ID_Comanda = ?1) \
        AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas v JOIN Detalle_Comanda dc \
        ON dc.ID_Detalle = v.ID_Detalle WHERE dc.ID_Comanda = ?1)";
    vec![
        SqlStatement { sql: format!("DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1 AND {sin_cobros};"), args: vec![json!("ticket")] },
        SqlStatement { sql: format!("DELETE FROM Comandas WHERE ID_Comanda = ?1 AND {sin_cobros};"), args: vec![json!("ticket")] },
    ]
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join("tpv_tests").join(format!("sync31-{nombre}-{}-{marca}", std::process::id()));
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

/// El ticket cobrado en las dos bases y la Handy que lo borra en la nube con el cobro en camino:
/// la Main recibe el borrado (no borra nada) y la nube rechaza el cobro. Devuelve el cobro.
async fn el_cobro_rechazado(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf, NubeDeContraste, String) {
    let (repo, db, dir) = base(nombre).await;
    sembrar(&db, TICKET_ABIERTO).await;
    let nube = NubeDeContraste::nueva(nombre).await;
    nube.sembrar(TICKET_ABIERTO).await;

    SqliteVentaRapidaRepository::new(db.clone())
        .cobrar_fraccionado(CobroFraccionado {
            id_pago: PAGO.into(),
            id_comanda: "ticket".into(),
            metodo: tpv_domain::pago::MetodoPago::Efectivo,
            importe_total: Dinero::CERO,
            id_usuario_cobrador: None,
            id_trabajador_cobrador: None,
            detalles: vec!["linea".into()],
            destinatario: None,
        })
        .await
        .unwrap();
    let cobro = repo.outbox_pending(10).await.unwrap();
    assert_eq!(cobro.len(), 1, "el cobro, sin subir");
    let cobro = cobro.into_iter().next().unwrap();

    // La Handy borra el ticket: en la nube no hay cobro y se borra entero; aquí no se borra nada.
    nube.aplicar(&borrado_de_la_handy()).await;
    assert_eq!(numero(&nube.db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'ticket';").await, 0);
    repo.apply_changes(vec![SyncChange { op_id: "op-handy".into(), seq: 1, statements: borrado_de_la_handy() }]).await.unwrap();
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Comandas WHERE ID_Comanda = 'ticket';").await, 1);
    *nube.hasta_seq.lock().unwrap() = 1;
    *nube.ultimo_ajeno.lock().unwrap() = 1;

    // Y el cobro llega a la nube: su pago apunta a una comanda que ya no está.
    let e = intentar(&nube, &cobro.statements).await.unwrap_err();
    assert!(e.contains("FOREIGN KEY"), "{e}");
    (repo, db, dir, nube, cobro.op_id)
}

/// Lo del ticket en una base, tabla a tabla: lo que tiene que tener la nube igual que la Main.
const DEL_TICKET: [&str; 8] = [
    "SELECT * FROM Comandas WHERE ID_Comanda = 'ticket';",
    "SELECT * FROM Detalle_Comanda WHERE ID_Comanda = 'ticket' ORDER BY ID_Detalle;",
    "SELECT * FROM Pagos WHERE ID_Comanda = 'ticket' ORDER BY ID_Pago;",
    "SELECT * FROM Pago_Detalles ORDER BY ID_Pago, ID_Detalle;",
    "SELECT * FROM Lote_Consumos ORDER BY ID_Pago, ID_Detalle;",
    "SELECT * FROM Movimientos_Caja ORDER BY ID_Movimiento;",
    "SELECT * FROM Registros_Facturacion ORDER BY Orden;",
    "SELECT * FROM Lotes_Producto ORDER BY ID_Lote;",
];

async fn el_ticket_como_en_la_main(db: &Arc<Db>, nube: &NubeDeContraste) {
    for sql in DEL_TICKET {
        let aqui = filas(db, sql).await;
        assert!(!aqui.is_empty(), "{sql}");
        assert_eq!(filas(&nube.db, sql).await, aqui, "{sql}");
    }
}

async fn pasada(repo: &SqliteSyncRepository, nube: &NubeDeContraste) -> ResultadoVerificacion {
    let marca = repo.contraste_marca().await.unwrap();
    let resumen = nube.resumen_para(marca.checkpoint).await;
    match repo.contrastar_con_la_nube(resumen, marca, &Paginas(nube), true).await.unwrap() {
        ContrasteLocal::Hecho(r) => r,
        ContrasteLocal::SeHaMovido => panic!("se tenía que comparar"),
    }
}

// ── La reparación inmediata ───────────────────────────────────────────────────

#[tokio::test]
async fn la_reparacion_del_cobro_rechazado_devuelve_el_ticket_entero_y_no_deja_cuarentenas() {
    let (repo, db, dir, nube, cobro) = el_cobro_rechazado("inmediata").await;

    let fallo = repo.outbox_mark_failed(&cobro, "FOREIGN KEY constraint failed", true).await.unwrap();
    assert!(fallo.apartada && fallo.reparadas > 0, "{fallo:?}");

    // UNA operación con el ticket entero, por estado y padres primero.
    let pendientes = repo.outbox_pending(10).await.unwrap();
    assert_eq!(pendientes.len(), 1, "una sola reparación");
    let reparacion = &pendientes[0];
    assert_eq!(reparacion.command_name, "main_reparacion");
    let tablas: Vec<String> = reparacion
        .statements
        .iter()
        .map(|s| {
            assert!(s.sql.starts_with("INSERT INTO \"") && s.sql.contains("ON CONFLICT"), "{}", s.sql);
            s.sql["INSERT INTO \"".len()..].split('"').next().unwrap().to_string()
        })
        .collect();
    let primera = |t: &str| tablas.iter().position(|x| x == t).unwrap_or_else(|| panic!("falta {t}: {tablas:?}"));
    let ultima = |t: &str| tablas.iter().rposition(|x| x == t).unwrap();
    for (padre, hija) in [
        ("Comandas", "Detalle_Comanda"),
        ("Comandas", "Pagos"),
        ("Detalle_Comanda", "Pago_Detalles"),
        ("Pagos", "Pago_Detalles"),
        ("Pagos", "Lote_Consumos"),
        ("Lotes_Producto", "Lote_Consumos"),
        ("Pagos", "Movimientos_Caja"),
        ("Pagos", "Registros_Facturacion"),
    ] {
        assert!(ultima(padre) < primera(hija), "{padre} antes que {hija}: {tablas:?}");
    }

    // La nube la aplica y tiene el ticket como la Main: la comanda, su línea, el cobro y lo que
    // cuelga de él, y el stock que consumió.
    intentar(&nube, &reparacion.statements).await.unwrap();
    el_ticket_como_en_la_main(&db, &nube).await;

    // Al confirmarse, la reparación retira el cobro apartado: no queda ninguna cuarentena.
    repo.outbox_confirmar_lote(&[(reparacion.op_id.clone(), 2)]).await.unwrap();
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);
    assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 0);

    // Y el contraste no encuentra nada que reparar.
    *nube.hasta_seq.lock().unwrap() = 2;
    let r = pasada(&repo, &nube).await;
    assert_eq!(r.descuadres, vec![], "{r:?}");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));

    cerrar(db, dir, nube).await;
}

// ── El contraste, si la reparación inmediata tampoco entra ───────────────────

#[tokio::test]
async fn si_la_reparacion_inmediata_tampoco_entra_el_contraste_sube_el_ticket_y_retira_las_dos_cuarentenas() {
    let (repo, db, dir, nube, cobro) = el_cobro_rechazado("contraste").await;
    repo.outbox_mark_failed(&cobro, "FOREIGN KEY constraint failed", true).await.unwrap();
    // La nube tampoco acepta la reparación (por lo que sea) y se aparta; una reparación no se repara.
    let inmediata = repo.outbox_pending(10).await.unwrap().remove(0);
    let fallo = repo.outbox_mark_failed(&inmediata.op_id, "rechazada", true).await.unwrap();
    assert!(fallo.apartada && fallo.reparadas == 0, "{fallo:?}");
    assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 2);

    // El contraste encuentra lo que falta arriba y lo sube, enlazado a las dos apartadas.
    let r = pasada(&repo, &nube).await;
    assert!(r.reparadas > 0 && !r.aplazado, "{r:?}");
    let plan = repo.outbox_pending(100).await.unwrap();
    let (ultima, antes) = plan.split_last().unwrap();
    let enlace = numero_o_texto(&db, &format!("SELECT Repara_Op_Id FROM _Sync_Outbox WHERE Op_Id = '{}';", ultima.op_id)).await;
    let enlazadas: Vec<String> = serde_json::from_str(&enlace).unwrap();
    assert_eq!(enlazadas, vec![cobro.clone(), inmediata.op_id.clone()]);
    assert!(antes.iter().all(|op| op.command_name == "main_reparacion"));

    // La nube aplica el plan; al confirmarse la última, no queda ninguna cuarentena.
    for (i, op) in plan.iter().enumerate() {
        intentar(&nube, &op.statements).await.unwrap();
        repo.outbox_confirmar_lote(&[(op.op_id.clone(), 2 + i as i64)]).await.unwrap();
    }
    el_ticket_como_en_la_main(&db, &nube).await;
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);

    // Y la pasada siguiente cuadra.
    *nube.hasta_seq.lock().unwrap() = 1 + plan.len() as i64;
    let r = pasada(&repo, &nube).await;
    assert_eq!(r.descuadres, vec![], "{r:?}");

    cerrar(db, dir, nube).await;
}

#[tokio::test]
async fn un_plan_que_no_toca_lo_apartado_no_lo_retira() {
    // La cuarentena del cobro se queda si el contraste sólo repara otra cosa: aquí, la nube ya
    // tiene el ticket (lo subió otro camino) y sólo difiere el nombre de una categoría.
    let (repo, db, dir, nube, cobro) = el_cobro_rechazado("ajeno").await;
    repo.outbox_mark_failed(&cobro, "FOREIGN KEY constraint failed", true).await.unwrap();
    let inmediata = repo.outbox_pending(10).await.unwrap().remove(0);
    repo.outbox_mark_failed(&inmediata.op_id, "rechazada", true).await.unwrap();
    intentar(&nube, &inmediata.statements).await.unwrap();
    assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 2);
    nube.sembrar("UPDATE Categorias_Producto SET Nombre = 'Refrescos' WHERE ID_Categoria = 'cat';").await;

    let r = pasada(&repo, &nube).await;
    assert_eq!(r.reparadas, 1, "{r:?}");
    let plan = repo.outbox_pending(10).await.unwrap();
    assert_eq!(plan.len(), 1);
    let enlace = numero_o_texto(&db, &format!("SELECT COALESCE(Repara_Op_Id, 'NULL') FROM _Sync_Outbox WHERE Op_Id = '{}';", plan[0].op_id)).await;
    assert_eq!(enlace, "NULL", "no repara nada de lo que escribió el cobro");
    repo.outbox_confirmar_lote(&[(plan[0].op_id.clone(), 3)]).await.unwrap();
    assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 2);

    cerrar(db, dir, nube).await;
}

async fn numero_o_texto(db: &Arc<Db>, sql: &str) -> String {
    filas(db, sql).await.into_iter().next().expect("una fila")
}

#[tokio::test]
async fn una_operacion_que_no_cuelga_de_ninguna_comanda_se_repara_como_siempre() {
    // Lo que no lleva a una comanda no arrastra nada: sólo las filas que tocaba.
    let (repo, db, dir) = base("sin-comanda").await;
    sembrar(&db, TICKET_ABIERTO).await;
    {
        let w = db.write().await;
        use tpv_infra_sqlite::db::Writer;
        w.execute("UPDATE Productos SET Precio_Venta = 250 WHERE ID_Producto = ?1;", vec![Value::Text("cana".into())])
            .await
            .unwrap();
    }
    let op = repo.outbox_pending(10).await.unwrap().remove(0);
    repo.outbox_mark_failed(&op.op_id, "rechazada", true).await.unwrap();
    let reparacion = repo.outbox_pending(10).await.unwrap().remove(0);
    assert_eq!(reparacion.statements.len(), 1, "{:?}", reparacion.statements);
    assert!(reparacion.statements[0].sql.starts_with("INSERT INTO \"Productos\""));
    assert!(reparacion.statements[0].args.contains(&json!(250)));

    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}
