//! DO-01 · Lo que la Main sube tiene que caber en el SQLite del Durable Object, que es donde se
//! aplica: 100 parámetros y 100 KB por sentencia (`apps/cloud-worker-licensing/test/sondaSqliteDo.test.ts`).
//!
//! Una lista de tamaño variable (las líneas que se cobran, las mesas de una zona, los asignados a
//! una tarea) va en UN parámetro, un array JSON, y no en uno por elemento. Aquí se hace cada
//! operación con 120 elementos sobre SQLite real y se mira lo que ha quedado en el outbox, que es
//! exactamente lo que sube.

use std::path::PathBuf;
use std::sync::Arc;

use tpv_application::ports::mesas::MesasRepository;
use tpv_application::ports::sync::SyncRepository;
use tpv_application::ports::tareas::TareasRepository;
use tpv_contracts::mesas::{RoomPoly, SalonInput, TableInput};
use tpv_contracts::sync::SqlStatement;
use tpv_domain::mesas::CobroDetalles;
use tpv_domain::pago::MetodoPago;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::mesas::SqliteMesasRepository;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::tareas::SqliteTareasRepository;

/// Los límites del SQLite del DO.
const MAX_PARAMETROS: usize = 100;
const MAX_BYTES_SQL: usize = 100_000;

const N: usize = 120;

async fn base(nombre: &str) -> (Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("limites-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (db, dir)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf) {
    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Estado de partida: por `raw()`, que no deja nada en el outbox.
async fn sembrar(db: &Arc<Db>, sql: &str) {
    let w = db.write().await;
    w.raw().execute_batch(sql).await.unwrap();
}

async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    filas.next().await.unwrap().expect("una fila").get::<i64>(0).unwrap()
}

async fn textos(db: &Arc<Db>, sql: &str) -> Vec<String> {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let mut out = Vec::new();
    while let Some(f) = filas.next().await.unwrap() {
        out.push(f.get::<String>(0).unwrap());
    }
    out
}

/// Todo lo que hay pendiente de subir, sentencia a sentencia.
async fn lo_que_sube(db: &Arc<Db>) -> Vec<SqlStatement> {
    SqliteSyncRepository::new(db.clone())
        .outbox_pending(500)
        .await
        .unwrap()
        .into_iter()
        .flat_map(|op| op.statements)
        .collect()
}

/// Ninguna sentencia pasa de lo que admite la nube. Devuelve cuántas se han mirado.
fn cabe_en_la_nube(sentencias: &[SqlStatement]) -> usize {
    assert!(!sentencias.is_empty(), "la operación tiene que haber dejado algo en el outbox");
    for s in sentencias {
        assert!(
            s.args.len() <= MAX_PARAMETROS,
            "{} parámetros en una sentencia que sube a la nube (máximo {MAX_PARAMETROS}): {}",
            s.args.len(),
            s.sql
        );
        assert!(s.sql.len() <= MAX_BYTES_SQL, "sentencia de {} bytes", s.sql.len());
    }
    sentencias.len()
}

/// Los números del 1 al `N`, como filas `(i)`: para sembrar con un solo `INSERT … SELECT`.
fn del_1_al_n() -> String {
    format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {N})")
}

#[tokio::test]
async fn cobrar_una_mesa_de_120_lineas_sube_en_sentencias_que_la_nube_admite() {
    let (db, dir) = base("cobro").await;
    sembrar(
        &db,
        &format!(
            "UPDATE Business_Settings SET CIF = 'B12345674', Razon_Social = 'Bar de Pruebas SL' WHERE ID = 1;
             INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');
             INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
               VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);
             INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 300);
             INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado)
               VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');
             {} INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
               SELECT 'detalle-' || substr('000' || i, -3), 'comanda-1', 'prod-1', 1, 300 FROM n;",
            del_1_al_n()
        ),
    )
    .await;

    let ids = textos(&db, "SELECT ID_Detalle FROM Detalle_Comanda ORDER BY ID_Detalle;").await;
    assert_eq!(ids.len(), N);
    SqliteMesasRepository::new(db.clone())
        .cobrar_detalles(CobroDetalles {
            id_comanda: "comanda-1".into(),
            metodo: MetodoPago::Tarjeta,
            tipo: "TOTAL".into(),
            detalle_ids: ids,
            id_usuario: None,
            destinatario: None,
        })
        .await
        .expect("el cobro entra");

    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Pago_Detalles;").await, N as i64);
    assert_eq!(numero(&db, "SELECT Importe_Total FROM Pagos;").await, 300 * N as i64);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Comandas WHERE Estado = 'Pagada';").await, 1);

    let sube = lo_que_sube(&db).await;
    cabe_en_la_nube(&sube);
    // La sentencia que enlaza las líneas con el pago: tres parámetros, con la lista en el tercero.
    let enlace = sube
        .iter()
        .find(|s| s.sql.contains("INTO Pago_Detalles"))
        .expect("el enlace de las líneas con el pago sube");
    assert_eq!(enlace.args.len(), 3);
    let lista: Vec<String> = serde_json::from_str(enlace.args[2].as_str().unwrap()).unwrap();
    assert_eq!(lista.len(), N);

    cerrar(db, dir).await;
}

fn mesa(id: String, nombre: String) -> TableInput {
    TableInput { id, name: nombre, x: 0, y: 0, width: 80, height: 80, radius: None, seats: 4, shape: "rect".into() }
}

fn zona(id: String, nombre: &str, mesas: Vec<TableInput>) -> SalonInput {
    SalonInput {
        id,
        name: nombre.into(),
        room: RoomPoly { kind: "poly".into(), points: vec![0.0, 0.0, 10.0, 0.0, 10.0, 10.0] },
        tables: mesas,
    }
}

#[tokio::test]
async fn guardar_un_plano_con_una_zona_de_120_mesas_sube_en_sentencias_que_la_nube_admite() {
    let (db, dir) = base("plano").await;
    let repo = SqliteMesasRepository::new(db.clone());

    // El plano nace con 120 zonas de una mesa y una zona de 120 mesas: las dos listas (las zonas
    // conservadas y las mesas conservadas de una zona) pasan de 98.
    let mut plano: Vec<SalonInput> = (1..=N)
        .map(|i| zona(format!("nueva-{i}"), &format!("Zona {i}"), vec![mesa(format!("m-{i}"), "1".into())]))
        .collect();
    plano.push(zona(
        "nueva-grande".into(),
        "Terraza",
        (1..=N).map(|i| mesa(format!("t-{i}"), format!("T{i}"))).collect(),
    ));
    repo.save_layout(plano).await.expect("el plano nuevo se guarda");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, N as i64 + 1);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 2 * N as i64);
    sembrar(&db, "DELETE FROM _Sync_Outbox;").await;

    // Se vuelve a guardar tal cual, ahora con los ids de la base: todo se conserva.
    let leer_plano = |quitar_mesa: Option<String>, quitar_zona: Option<String>| {
        let db = db.clone();
        async move {
            let mut zonas = Vec::new();
            for id_zona in textos(&db, "SELECT ID_Zona FROM Zonas ORDER BY Nombre_Zona;").await {
                if quitar_zona.as_deref() == Some(id_zona.as_str()) {
                    continue;
                }
                let nombre =
                    textos(&db, &format!("SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = '{id_zona}';")).await;
                let mut mesas = Vec::new();
                for id_mesa in
                    textos(&db, &format!("SELECT ID_Mesa FROM Mesas WHERE ID_Zona = '{id_zona}' ORDER BY Numero_Mesa;"))
                        .await
                {
                    if quitar_mesa.as_deref() == Some(id_mesa.as_str()) {
                        continue;
                    }
                    let numero =
                        textos(&db, &format!("SELECT Numero_Mesa FROM Mesas WHERE ID_Mesa = '{id_mesa}';")).await;
                    mesas.push(mesa(format!("db-mesa-{id_mesa}"), numero[0].clone()));
                }
                zonas.push(zona(format!("db-zona-{id_zona}"), &nombre[0], mesas));
            }
            zonas
        }
    };

    repo.save_layout(leer_plano(None, None).await).await.expect("el mismo plano se guarda");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE Archivada_En IS NULL;").await, N as i64 + 1);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas WHERE Archivada_En IS NULL;").await, 2 * N as i64);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE Nombre_Zona LIKE '__tmp_zona_%';").await, 0);
    cabe_en_la_nube(&lo_que_sube(&db).await);
    sembrar(&db, "DELETE FROM _Sync_Outbox;").await;

    // Y la lista sigue decidiendo lo mismo: lo que no viene en el plano se quita, y sólo eso.
    let terraza = textos(&db, "SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = 'Terraza';").await.remove(0);
    let una_mesa =
        textos(&db, &format!("SELECT ID_Mesa FROM Mesas WHERE ID_Zona = '{terraza}' AND Numero_Mesa = 'T7';"))
            .await
            .remove(0);
    let una_zona = textos(&db, "SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = 'Zona 7';").await.remove(0);
    repo.save_layout(leer_plano(Some(una_mesa.clone()), Some(una_zona.clone())).await)
        .await
        .expect("el plano sin una mesa y sin una zona se guarda");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, N as i64);
    assert_eq!(numero(&db, &format!("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = '{una_zona}';")).await, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 2 * N as i64 - 2);
    assert_eq!(numero(&db, &format!("SELECT COUNT(*) FROM Mesas WHERE ID_Mesa = '{una_mesa}';")).await, 0);
    assert_eq!(numero(&db, &format!("SELECT COUNT(*) FROM Mesas WHERE ID_Zona = '{terraza}';")).await, N as i64 - 1);
    cabe_en_la_nube(&lo_que_sube(&db).await);

    cerrar(db, dir).await;
}

#[tokio::test]
async fn asignar_una_tarea_a_120_trabajadores_sube_en_sentencias_que_la_nube_admite() {
    let (db, dir) = base("tarea").await;
    sembrar(
        &db,
        &format!(
            "INSERT INTO Roles (ID_Rol, Nombre_Rol) VALUES ('rol-1', 'RolDePrueba');
             {n} INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
               SELECT 'user-' || i, 'rol-1', 'u' || i || '@x.com', 'h', 'Persona ' || i FROM n;
             {n} INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) SELECT 'trab-' || i, 'user-' || i FROM n;
             INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('user-fuera', 'rol-1', 'f@x.com', 'h', 'Fuera');
             INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('trab-fuera', 'user-fuera');
             INSERT INTO Tareas (ID_Tarea, Titulo, Fecha_Creacion) VALUES ('tarea-1', 'Inventario', '2026-01-01 00:00:00');
             INSERT INTO Tarea_Asignaciones (ID_Tarea, ID_Trabajador, Asignada_At, Estado)
               VALUES ('tarea-1', 'trab-fuera', '2026-01-01 00:00:00', 'PENDIENTE');",
            n = del_1_al_n()
        ),
    )
    .await;

    let ids: Vec<String> = (1..=N).map(|i| format!("trab-{i}")).collect();
    SqliteTareasRepository::new(db.clone()).set_asignaciones("tarea-1", ids).await.expect("se asigna");

    // El conjunto queda sustituido: los 120 dentro y el que no venía en la lista, fuera.
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Tarea_Asignaciones WHERE ID_Tarea = 'tarea-1';").await, N as i64);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Tarea_Asignaciones WHERE ID_Trabajador = 'trab-fuera';").await, 0);
    cabe_en_la_nube(&lo_que_sube(&db).await);

    cerrar(db, dir).await;
}
