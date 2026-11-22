//! El contraste diario con la nube (`use_cases::sync::verificar_contra_la_nube`, el cuerpo del job
//! `verificar_nube`), de punta a punta: la nube simulada (`comun::nube_de_contraste`, que contesta
//! `/v1/sync/verificar/*` como el worker sobre una base SQLite propia) y el repositorio SQLite real.
//!
//! El contraste por resúmenes: con las dos bases iguales no baja ni una fila; con un valor
//! distinto, una fila que falta arriba y una que sobra, las encuentra, las repara, y tras aplicar la
//! reparación en la nube la pasada siguiente cuadra. Fuera de la ventana, las claves por páginas.
//! Y las guardas: no se toca nada con algo por subir, con un fallo de bajada, con el histórico a
//! medias, con la reparación apagada o si una de las dos bases se mueve a mitad de la pasada.
//!
//! VERIF-01 · Una Main recién recuperada de la nube tiene la ventana de la fase 1 y el checkpoint
//! en el `Seq` de esa foto: por el marcapáginas está al día, y le falta todo el histórico que la
//! fase 2 todavía no ha bajado. El contraste no puede leer eso como «la nube tiene filas de más».
//!
//! VERIF-02 · El horario: lo que hace cada vuelta del job (`use_cases::verificacion_nube`) con la
//! regla de `tpv_domain::verificacion_nube`, el estado en `_Verificacion_Nube` y el contraste de
//! verdad. La hora la pone el test.

mod comun;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::TimeZone;
use serde_json::{json, Value as JsonValue};

use comun::nube_de_contraste::{NubeDeContraste, Paginas, DESDE};
use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::sync::{ContrasteLocal, SyncRepository};
use tpv_application::ports::verificacion_nube::{IntentoVerificacion, VerificacionNubeRepository};
use tpv_application::use_cases::sync::{self as uc_sync, Contraste};
use tpv_application::use_cases::verificacion_nube::{self as uc_verificacion, Momento, Vuelta};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    PairCreateResult,
};
use tpv_contracts::sync::{DescuadreTabla, ResultadoVerificacion, SqlStatement};
use tpv_domain::verificacion_nube::Espera;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::verificacion_nube::SqliteVerificacionNube;

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La nube: el contraste lo contesta `NubeDeContraste`; el resto de rutas, respuestas preparadas.
struct Nube {
    contraste: NubeDeContraste,
    respuestas: Mutex<HashMap<String, VecDeque<JsonValue>>>,
    peticiones: Mutex<Vec<String>>,
    /// La nube no contesta.
    caida: Mutex<bool>,
}

impl Nube {
    async fn nueva(nombre: &str) -> Nube {
        Nube {
            contraste: NubeDeContraste::nueva(nombre).await,
            respuestas: Mutex::default(),
            peticiones: Mutex::default(),
            caida: Mutex::new(false),
        }
    }

    fn responde(&self, ruta: &str, cuerpo: JsonValue) {
        self.respuestas.lock().unwrap().entry(ruta.to_string()).or_default().push_back(cuerpo);
    }

    fn pedidas(&self) -> Vec<String> {
        self.peticiones.lock().unwrap().clone()
    }

    async fn cerrar(self) {
        self.contraste.cerrar().await;
    }
}

#[async_trait]
impl PairingService for Nube {
    fn device_identity(&self) -> AppResult<DeviceIdentity> {
        unimplemented!()
    }
    fn firmar_hello(&self, _: &str, _: &str) -> AppResult<FirmaDispositivo> {
        unimplemented!()
    }
    fn firmar_emparejamiento(&self, _: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> {
        unimplemented!()
    }
    fn hora_para_firmar(&self) -> i64 {
        unimplemented!()
    }
    fn desfase_del_reloj_ms(&self) -> Option<i64> {
        unimplemented!()
    }
    fn handy_set_token(&self, _: &str, _: &str) -> AppResult<()> {
        unimplemented!()
    }
    fn handy_clear_token(&self) -> AppResult<()> {
        unimplemented!()
    }
    fn handy_get_tenant(&self) -> AppResult<Option<String>> {
        unimplemented!()
    }
    fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
        Ok(Some("negocio-de-prueba".into()))
    }
    fn tpv_server_signed_headers(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
        unimplemented!()
    }
    async fn tpv_server_post_json(&self, _mode: &str, path: &str, body: JsonValue) -> AppResult<JsonValue> {
        self.peticiones.lock().unwrap().push(path.to_string());
        if *self.caida.lock().unwrap() {
            return Err(AppError::external("la nube no contesta"));
        }
        if let Some(respuesta) = self.contraste.contestar(path, &body).await {
            return respuesta;
        }
        let siguiente = self.respuestas.lock().unwrap().get_mut(path).and_then(|cola| cola.pop_front());
        siguiente.ok_or_else(|| AppError::external(format!("respuesta no prevista para {path}")))
    }
    async fn pair_create(&self) -> AppResult<PairCreateResult> {
        unimplemented!()
    }
    async fn upload_image(&self, _: &str, _: &str, _: &str, _: Vec<u8>, _: &str) -> AppResult<ResultadoSubidaImagen> {
        unimplemented!()
    }
    async fn delete_image(&self, _: &str, _: &str) -> AppResult<()> {
        unimplemented!()
    }
    async fn download_image(&self, _: &str, _: &str) -> AppResult<Option<Vec<u8>>> {
        unimplemented!()
    }
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("contraste-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
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
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

/// Las sentencias de las reparaciones encoladas (`main_reparacion`), que es lo que sube a la nube.
async fn reparaciones(repo: &SqliteSyncRepository) -> Vec<SqlStatement> {
    repo.outbox_pending(1_000)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.command_name == "main_reparacion")
        .flat_map(|e| e.statements)
        .collect()
}

/// La reparación sube: la nube la aplica y la Main la da por enviada.
async fn subir_reparaciones(repo: &SqliteSyncRepository, nube: &Nube) {
    for op in repo.outbox_pending(1_000).await.unwrap() {
        nube.contraste.aplicar(&op.statements).await;
        repo.outbox_confirmar_lote(&[(op.op_id.clone(), 0)]).await.unwrap();
    }
}

fn descuadre(tabla: &str, faltan: i64, sobran: i64, distintas: i64) -> DescuadreTabla {
    DescuadreTabla { tabla: tabla.into(), faltan, sobran, distintas }
}

fn hecho(c: Contraste) -> ResultadoVerificacion {
    c.hecho().expect("se tenía que comparar")
}

// ── Un negocio con un poco de todo ────────────────────────────────────────────

/// Zonas, mesas, productos y 100 comandas con sus líneas y sus cobros: 60 de ayer y 40 de 2020.
/// Hay de todo lo que guarda una fila: enteros, reales (cantidades de 1,5 y de 0,333), dinero en
/// céntimos, textos con acentos y emojis, y `NULL`.
const NEGOCIO: &str = "
    INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza'), ('z2', 'Salón de la ría'), ('z3', 'Barra 😀');
    INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius)
         VALUES ('m1', 'z1', '1', 4, 10, 20, 'rect', 80, 80, NULL),
                ('m2', 'z1', '2', 2, 110, 20, 'circle', 60, 60, 30),
                ('m3', 'z2', '7', 6, 10, 200, 'rect', 120, 80, NULL);
    INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Cervezas');
    INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Minimo, IVA_Percent)
         VALUES ('p1', 'cat-1', 'Caña', 250, 1.5, 10.0), ('p2', 'cat-1', 'Tercio', 320, 0, 21);
    WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < 60)
    INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado)
         SELECT printf('c-nueva-%04d', i), 'BARRA', '2026-11-12 21:00:00', '2026-11-12 22:00:00', 1250 + i, 'Pagada' FROM serie;
    WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < 40)
    INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado)
         SELECT printf('c-vieja-%04d', i), 'BARRA', '2020-01-01 12:00:00', '2020-01-01 13:00:00', 900, 'Pagada' FROM serie;
    WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < 180)
    INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent, Notas)
         SELECT printf('d-%04d', i), printf('c-nueva-%04d', i / 3), 'p1', 'Caña de la casa',
                CASE i % 3 WHEN 0 THEN 1 WHEN 1 THEN 1.5 ELSE 0.333 END, 250, 10.0,
                CASE WHEN i % 5 = 0 THEN 'sin hielo ñ' END FROM serie;
    WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < 60)
    INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket)
         SELECT printf('pago-%04d', i), printf('c-nueva-%04d', i), '2026-11-12 22:00:00', 'Efectivo', 1250 + i, 'TOTAL',
                printf('T-%08d', i) FROM serie;
    WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < 180)
    INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) SELECT printf('pago-%04d', i / 3), printf('d-%04d', i) FROM serie;
";

/// Una Main al día con el negocio, y una nube igual: el checkpoint en 40 y el log de la nube
/// acabado en 45 (lo de encima es de la Main). El log de la nube está en su base, como en el DO: el
/// borrado de una reparación lo mira.
async fn negocio_igual(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf, Nube) {
    let (repo, db, dir) = base(nombre).await;
    sembrar(&db, NEGOCIO).await;
    sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 40 WHERE Id = 1;").await;
    let nube = Nube::nueva(nombre).await;
    nube.contraste.sembrar(NEGOCIO).await;
    nube.contraste
        .sembrar(
            "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 45)
             INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
             SELECT i, 'op-' || i, 'mesas.abrir', '[]', CASE WHEN i <= 40 THEN 'handy-1' ELSE 'main' END, 1 FROM s;",
        )
        .await;
    *nube.contraste.hasta_seq.lock().unwrap() = 45;
    *nube.contraste.ultimo_ajeno.lock().unwrap() = 40;
    (repo, db, dir, nube)
}

/// Las tres diferencias de siempre, en la nube: un valor distinto (el nombre de una zona), una fila
/// que le falta (la mesa 7) y una que le sobra (una zona que aquí no existe).
async fn tres_diferencias(nube: &Nube) {
    nube.contraste
        .sembrar(
            "UPDATE Zonas SET Nombre_Zona = 'Salón' WHERE ID_Zona = 'z2';
             DELETE FROM Mesas WHERE ID_Mesa = 'm3';
             INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Almacén');",
        )
        .await;
}

// ── El contraste por resúmenes ────────────────────────────────────────────────

#[tokio::test]
async fn con_las_dos_bases_iguales_no_baja_ni_una_fila_ni_repara_nada() {
    let (repo, db, dir, nube) = negocio_igual("iguales").await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    assert_eq!(r.descuadres, vec![], "cero falsos descuadres");
    assert_eq!((r.reparadas, r.borradas, r.filas_examinadas, r.aplazado), (0, 0, 0, false));
    assert!(r.tablas_sin_comparar.is_empty(), "{:?}", r.tablas_sin_comparar);
    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar/resumen", "/v1/sync/salud"], "sólo el resumen");
    // El resumen lleva el checkpoint de la Main, que es lo que la nube comprueba.
    assert_eq!(nube.contraste.pedidas.lock().unwrap()[0].1, json!({ "checkpoint": 40 }));
    assert!(reparaciones(&repo).await.is_empty());

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn un_valor_distinto_una_fila_que_falta_y_una_que_sobra_se_encuentran_se_reparan_y_despues_cuadra() {
    let (repo, db, dir, nube) = negocio_igual("tres").await;
    tres_diferencias(&nube).await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    let mut descuadres = r.descuadres.clone();
    descuadres.sort_by(|a, b| a.tabla.cmp(&b.tabla));
    assert_eq!(descuadres, vec![descuadre("Mesas", 1, 0, 0), descuadre("Zonas", 0, 1, 1)]);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (2, 1, false));
    // Sólo se han bajado las filas de los cubos que no cuadraban: las zonas y las mesas, que son
    // tablas de un cubo. Ni una comanda.
    assert_eq!(r.filas_examinadas, 4 + 2);
    let pedidas = nube.pedidas();
    assert_eq!(pedidas.iter().filter(|p| *p == "/v1/sync/verificar/filas").count(), 2, "{pedidas:?}");
    assert!(!pedidas.contains(&"/v1/sync/verificar/claves".to_string()), "{pedidas:?}");

    // Lo que sube: la zona con su nombre de aquí y la mesa que falta, por estado, y el borrado de
    // la que sobra, en ese orden (padres primero, borrados al final). Delante de las zonas, la que
    // sobra aparca su nombre por si lo necesita lo que sube (SYNC-38), con la condición de su borrado.
    let sube = reparaciones(&repo).await;
    assert_eq!(sube.len(), 4, "{sube:?}");
    assert!(sube[0].sql.starts_with("UPDATE \"Zonas\" SET \"Nombre_Zona\" = ?4 WHERE \"ID_Zona\" = ?1 AND EXISTS"), "{}", sube[0].sql);
    assert_eq!(sube[0].args[..3], [json!("z9"), json!(45), json!("main_reparacion")]);
    assert!(sube[1].sql.starts_with("INSERT INTO \"Zonas\"") && sube[1].sql.contains("ON CONFLICT"), "{}", sube[1].sql);
    assert!(sube[1].args.contains(&json!("Salón de la ría")));
    assert!(sube[2].sql.starts_with("INSERT INTO \"Mesas\"") && sube[2].args.contains(&json!("m3")), "{}", sube[2].sql);
    // El borrado, sólo si la nube no ha cambiado desde la foto (`hasta_seq` 45), y sólo en la nube.
    assert!(sube[3].sql.starts_with("DELETE FROM \"Zonas\" WHERE \"ID_Zona\" = ?1 AND EXISTS"), "{}", sube[3].sql);
    assert_eq!(sube[3].args, vec![json!("z9"), json!(45), json!("main_reparacion")]);
    // Esta base no se ha tocado.
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, 3);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3);

    // La nube aplica la reparación (eso escribe en su log) y la pasada siguiente cuadra.
    subir_reparaciones(&repo, &nube).await;
    *nube.contraste.hasta_seq.lock().unwrap() = 46;
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!(r.descuadres, vec![]);
    assert_eq!((r.reparadas, r.borradas, r.filas_examinadas, r.aplazado), (0, 0, 0, false));

    // El informe que va a Axiom.
    let informes = nube.contraste.informes.lock().unwrap().clone();
    assert_eq!(informes.len(), 2);
    assert_eq!(informes[0]["reparadas"], json!(2));
    assert_eq!(informes[0]["borradas"], json!(1));
    assert_eq!(informes[0]["filas_examinadas"], json!(6));
    assert_eq!(informes[0]["reparacion_apagada"], json!(false));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn en_una_tabla_grande_solo_se_baja_el_cubo_de_la_fila_distinta() {
    let (repo, db, dir, nube) = negocio_igual("cubo").await;
    // Una línea con otra cantidad: de las 180 líneas (8 cubos), sólo baja su cubo.
    nube.contraste.sembrar("UPDATE Detalle_Comanda SET Cantidad = 2 WHERE ID_Detalle = 'd-0004';").await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    assert_eq!(r.descuadres, vec![descuadre("Detalle_Comanda", 0, 0, 1)]);
    assert_eq!(r.reparadas, 1);
    assert!(r.filas_examinadas > 0 && r.filas_examinadas < 60, "{} de 180", r.filas_examinadas);
    let sube = reparaciones(&repo).await;
    assert_eq!(sube.len(), 1);
    assert!(sube[0].args.contains(&json!("d-0004")) && sube[0].args.contains(&json!(1.5)), "{:?}", sube[0].args);

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn fuera_de_la_ventana_se_recorren_las_claves_por_paginas() {
    let (repo, db, dir, nube) = negocio_igual("claves").await;
    // La ventana de las comandas deja fuera las de 2020: de ésas sólo se comparan los conteos.
    nube.contraste.ventanas.lock().unwrap().insert(
        "Comandas".into(),
        ("SELECT * FROM \"Comandas\" WHERE Fecha_Hora_Apertura >= ?1;".into(), vec![json!(DESDE)]),
    );
    *nube.contraste.claves_por_pagina.lock().unwrap() = 7;
    // A la nube le falta una vieja y le sobran dos que aquí no están.
    nube.contraste
        .sembrar(
            "DELETE FROM Comandas WHERE ID_Comanda = 'c-vieja-0013';
             INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES
               ('c-vieja-9998', 'BARRA', '2020-02-01 12:00:00', 'Pagada'),
               ('c-vieja-9999', 'BARRA', '2020-02-01 12:00:00', 'Pagada');",
        )
        .await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    assert_eq!(r.descuadres, vec![descuadre("Comandas", 1, 2, 0)]);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (1, 2, false));
    let paginas = nube.pedidas().iter().filter(|p| *p == "/v1/sync/verificar/claves").count();
    assert_eq!(paginas, 15, "101 comandas de 7 en 7");
    // Las que sobran aparcan antes su mesa por si la necesita la que sube (SYNC-38; sin mesa, no
    // aparcan nada), y se borran al final.
    let sube = reparaciones(&repo).await;
    let que: Vec<(&str, &JsonValue)> = sube.iter().map(|s| (s.sql.split(' ').next().unwrap(), &s.args[0])).collect();
    assert_eq!(
        que,
        [
            ("UPDATE", &json!("c-vieja-9998")),
            ("UPDATE", &json!("c-vieja-9999")),
            ("INSERT", &json!("c-vieja-0013")),
            ("DELETE", &json!("c-vieja-9998")),
            ("DELETE", &json!("c-vieja-9999")),
        ]
    );

    subir_reparaciones(&repo, &nube).await;
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!(r.descuadres, vec![]);

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn una_fila_igual_que_solo_cambia_de_ventana_por_su_padre_no_se_repara() {
    // La ventana de las líneas depende de su comanda, como en la de verdad. En la nube, una comanda
    // tiene otra fecha de apertura y sus tres líneas, iguales, quedan fuera de la ventana de allí y
    // dentro de la de aquí: no han venido en su cubo. Se buscan por su clave, son iguales y no se
    // reparan; la que se repara es la comanda.
    let (repo, db, dir, nube) = negocio_igual("cambia-de-ventana").await;
    nube.contraste.ventanas.lock().unwrap().extend([
        (
            "Comandas".to_string(),
            ("SELECT * FROM \"Comandas\" WHERE Fecha_Hora_Apertura >= ?1;".to_string(), vec![json!(DESDE)]),
        ),
        (
            "Detalle_Comanda".to_string(),
            (
                "SELECT * FROM \"Detalle_Comanda\" WHERE ID_Comanda IN \
                 (SELECT ID_Comanda FROM Comandas WHERE Fecha_Hora_Apertura >= ?1);"
                    .to_string(),
                vec![json!(DESDE)],
            ),
        ),
    ]);
    nube.contraste.sembrar("UPDATE Comandas SET Fecha_Hora_Apertura = '2020-01-01 12:00:00' WHERE ID_Comanda = 'c-nueva-0005';").await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    assert_eq!(r.descuadres, vec![descuadre("Comandas", 0, 0, 1)], "las líneas no son un descuadre");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (1, 0, false));
    let sube = reparaciones(&repo).await;
    assert_eq!(sube.len(), 1);
    assert!(sube[0].sql.starts_with("INSERT INTO \"Comandas\"") && sube[0].args.contains(&json!("c-nueva-0005")));
    assert!(nube.pedidas().contains(&"/v1/sync/verificar/por-clave".to_string()));

    subir_reparaciones(&repo, &nube).await;
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!((r.descuadres.len(), r.reparadas), (0, 0));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn lo_que_sobra_no_se_borra_si_la_nube_ha_cambiado_antes_de_aplicarlo() {
    // Entre la foto y el momento en que la nube aplica la reparación, una Handy escribe (aquí, en
    // el log de la nube, por encima del `hasta_seq` 45). El borrado sube igual, pero no borra
    // nada: lo nuevo podría colgar de esa fila. La pasada siguiente lo vuelve a mirar.
    let (repo, db, dir, nube) = negocio_igual("borrado-condicionado").await;
    tres_diferencias(&nube).await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!(r.borradas, 1);

    nube.contraste
        .sembrar(
            "INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
             VALUES (46, 'op-handy', 'mesas.abrir', '[]', 'handy-1', 1);",
        )
        .await;
    subir_reparaciones(&repo, &nube).await;
    let quedan = {
        let r = nube.contraste.db.read().await;
        let mut f = r.conn().query("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z9';", ()).await.unwrap();
        f.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    };
    assert_eq!(quedan, 1, "la zona que sobra sigue arriba");
    let nombre_z2 = {
        let r = nube.contraste.db.read().await;
        let mut f = r.conn().query("SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z2';", ()).await.unwrap();
        f.next().await.unwrap().unwrap().get::<String>(0).unwrap()
    };
    assert_eq!(nombre_z2, "Salón de la ría", "lo que se sube por estado se sube");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

/// Los nombres de las zonas de una base, por su clave.
async fn zonas(db: &Arc<Db>) -> Vec<String> {
    let r = db.read().await;
    let mut f = r.conn().query("SELECT ID_Zona || '=' || Nombre_Zona FROM Zonas ORDER BY ID_Zona;", ()).await.unwrap();
    let mut salida = Vec::new();
    while let Some(fila) = f.next().await.unwrap() {
        salida.push(fila.get::<String>(0).unwrap());
    }
    salida
}

/// Una zona que falta arriba con el nombre de otra que sobra: aquí se renombró la terraza y se
/// creó otra zona con su nombre, y arriba sigue la de antes (`z9`) y no la nueva (`z4`).
async fn sobra_con_el_nombre(nube: &Nube, db: &Arc<Db>) {
    sembrar(db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z4', 'Patio');").await;
    nube.contraste.sembrar("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Patio');").await;
}

#[tokio::test]
async fn una_fila_que_falta_arriba_con_el_valor_unico_de_una_que_sobra_entra_en_la_misma_operacion() {
    // SYNC-38: subida antes del borrado, la que falta chocaría con la que sobra en la nube, que
    // comprueba el índice sentencia a sentencia. La que sobra aparca antes su nombre, con la
    // condición de su borrado, y todo va en una operación.
    let (repo, db, dir, nube) = negocio_igual("sobra-con-el-nombre").await;
    sobra_con_el_nombre(&nube, &db).await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!(r.descuadres, vec![descuadre("Zonas", 1, 1, 0)]);
    assert_eq!((r.reparadas, r.borradas), (1, 1));
    let ops = repo.outbox_pending(10).await.unwrap();
    assert_eq!(ops.len(), 1, "en una operación");
    let sql: Vec<&str> = ops[0].statements.iter().map(|s| s.sql.as_str()).collect();
    assert!(sql[0].starts_with("UPDATE \"Zonas\" SET \"Nombre_Zona\""), "{sql:?}");
    assert!(sql[1].starts_with("INSERT INTO \"Zonas\""), "{sql:?}");
    assert!(sql[2].starts_with("DELETE FROM \"Zonas\""), "{sql:?}");

    // La nube la aplica en una transacción, como el DO, y queda como aquí, sin nada aparcado.
    subir_reparaciones(&repo, &nube).await;
    let en_la_nube = zonas(&nube.contraste.db).await;
    assert!(en_la_nube.contains(&"z4=Patio".to_string()) && !en_la_nube.iter().any(|z| z.starts_with("z9=")), "{en_la_nube:?}");
    assert_eq!(en_la_nube, zonas(&db).await);
    *nube.contraste.hasta_seq.lock().unwrap() = 46;
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!(r.descuadres, vec![]);

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_nube_ha_cambiado_lo_que_sobra_ni_se_aparca_ni_se_borra() {
    // SYNC-38: la misma condición que el borrado. Una Handy escribe entre la foto y la reparación:
    // no se aparca, la que falta choca con la que sobra y la operación no entra entera. Nada
    // aparcado se queda en la nube.
    let (repo, db, dir, nube) = negocio_igual("sobra-con-el-nombre-movida").await;
    sobra_con_el_nombre(&nube, &db).await;
    hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    nube.contraste
        .sembrar(
            "INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
             VALUES (46, 'op-handy', 'mesas.abrir', '[]', 'handy-1', 1);",
        )
        .await;
    let antes = zonas(&nube.contraste.db).await;

    // La nube la aplica como el DO, sentencia a sentencia en una transacción.
    let op = repo.outbox_pending(10).await.unwrap().remove(0);
    let resultados = {
        let w = nube.contraste.db.write().await;
        let conn = w.raw();
        conn.execute_batch("PRAGMA defer_foreign_keys = ON; BEGIN;").await.unwrap();
        let mut resultados = Vec::new();
        for s in &op.statements {
            let args: Vec<tpv_infra_sqlite::ejecutor::Value> = s
                .args
                .iter()
                .map(|v| match v {
                    JsonValue::String(t) => tpv_infra_sqlite::ejecutor::Value::Text(t.clone()),
                    JsonValue::Number(n) => tpv_infra_sqlite::ejecutor::Value::Integer(n.as_i64().unwrap()),
                    _ => tpv_infra_sqlite::ejecutor::Value::Null,
                })
                .collect();
            let r = conn.execute(&s.sql, args).await;
            let fallo = r.is_err();
            resultados.push(r.ok());
            if fallo {
                break;
            }
        }
        conn.execute_batch("ROLLBACK;").await.unwrap();
        resultados
    };
    assert_eq!(resultados, vec![Some(0), None], "no aparca, y la que falta choca con la que sobra");
    assert_eq!(zonas(&nube.contraste.db).await, antes);
    assert!(antes.contains(&"z9=Patio".to_string()));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn sin_ventana_se_comparan_los_conteos_y_las_claves() {
    // Un negocio cuya ventana no cabe en lo que la nube resume de una vez.
    let (repo, db, dir, nube) = negocio_igual("sin-ventana").await;
    *nube.contraste.ventana_omitida.lock().unwrap() = true;
    tres_diferencias(&nube).await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    // Lo distinto no se ve sin la ventana; lo que falta y lo que sobra, sí.
    let mut descuadres = r.descuadres.clone();
    descuadres.sort_by(|a, b| a.tabla.cmp(&b.tabla));
    assert_eq!(descuadres, vec![descuadre("Mesas", 1, 0, 0), descuadre("Zonas", 0, 1, 0)]);
    assert_eq!((r.reparadas, r.borradas, r.ventana_omitida), (1, 1, true));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_un_fallo_de_bajada_se_ve_todo_y_no_se_toca_nada() {
    // AUD-18: lo que aquí falta puede ser lo que creó el cambio que no se pudo aplicar, y lo que
    // sobra aquí, lo que borró. Ni se borra, ni se sube, ni se pisa.
    let (repo, db, dir, nube) = negocio_igual("fallo").await;
    tres_diferencias(&nube).await;
    sembrar(
        &db,
        "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
           First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-x', 38, '[]', 5, 1, 1, 1);",
    )
    .await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    assert_eq!(r.descuadres.len(), 2, "se ve y se informa: {:?}", r.descuadres);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true), "...pero no se toca");
    assert!(reparaciones(&repo).await.is_empty());

    // Resuelto el fallo, la pasada siguiente sí repara.
    sembrar(&db, "DELETE FROM _Sync_Failed;").await;
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (2, 1, false));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_la_reparacion_apagada_se_compara_y_se_informa_pero_no_se_toca_nada() {
    let (repo, db, dir, nube) = negocio_igual("apagada").await;
    tres_diferencias(&nube).await;

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), false).await.unwrap());

    assert_eq!(r.descuadres.len(), 2);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true));
    assert!(reparaciones(&repo).await.is_empty());
    assert_eq!(nube.contraste.informes.lock().unwrap()[0]["reparacion_apagada"], json!(true));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_algo_por_subir_no_se_pide_nada() {
    let (repo, db, dir, nube) = negocio_igual("por-subir").await;
    sembrar(
        &db,
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-1', 'main_op', '[]', 1);",
    )
    .await;

    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();

    assert!(matches!(pasada, Contraste::Aplazado), "{pasada:?}");
    assert!(nube.pedidas().is_empty());

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_nube_dice_que_ahora_no_se_aplaza_sin_informar() {
    let (repo, db, dir, nube) = negocio_igual("ocupada").await;
    tres_diferencias(&nube).await;

    // El negocio está escribiendo.
    *nube.contraste.ocupada.lock().unwrap() = true;
    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();
    assert!(matches!(pasada, Contraste::Aplazado), "{pasada:?}");

    // O hay un cambio de una Handy que esta Main todavía no ha aplicado.
    *nube.contraste.ocupada.lock().unwrap() = false;
    *nube.contraste.ultimo_ajeno.lock().unwrap() = 41;
    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();
    assert!(matches!(pasada, Contraste::Aplazado), "{pasada:?}");

    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar/resumen", "/v1/sync/verificar/resumen"]);
    assert!(reparaciones(&repo).await.is_empty());

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_nube_se_mueve_entre_el_resumen_y_las_filas_no_se_toca_nada() {
    let (repo, db, dir, nube) = negocio_igual("se-mueve").await;
    tres_diferencias(&nube).await;
    *nube.contraste.hasta_seq_de_las_paginas.lock().unwrap() = Some(46);

    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();

    assert!(matches!(pasada, Contraste::Aplazado), "{pasada:?}");
    assert!(reparaciones(&repo).await.is_empty());
    assert!(!nube.pedidas().contains(&"/v1/sync/salud".to_string()), "lo de una foto movida no se informa");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn una_sentencia_de_la_nube_que_no_es_una_lectura_no_se_ejecuta() {
    let (repo, db, dir, nube) = negocio_igual("no-lectura").await;
    tres_diferencias(&nube).await;
    nube.contraste.sentencia_mandada.lock().unwrap().extend([
        ("Zonas".to_string(), "DELETE FROM Zonas;".to_string()),
        ("Mesas".to_string(), "WITH x AS (SELECT 1) DELETE FROM Mesas;".to_string()),
        ("Productos".to_string(), "SELECT * FROM Productos; DELETE FROM Productos;".to_string()),
    ]);

    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());

    let mut sin_comparar = r.tablas_sin_comparar.clone();
    sin_comparar.sort();
    assert_eq!(sin_comparar, vec!["Mesas", "Productos", "Zonas"]);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, 3, "aquí no se ha borrado nada");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Productos;").await, 2);
    assert!(reparaciones(&repo).await.is_empty(), "de lo que no se compara no se repara nada");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_las_filas_de_un_cubo_no_son_las_del_resumen_esa_tabla_no_se_repara() {
    let (repo, db, dir, nube) = negocio_igual("cubo-ajeno").await;
    tres_diferencias(&nube).await;
    // La nube contesta las filas de las mesas con algo que no es lo que resumió (una escritura que
    // no pasó por el log): no se compara con ello.
    let resumen = nube.contraste.resumen_para(40).await;
    nube.contraste.sembrar("UPDATE Mesas SET Capacidad = 9 WHERE ID_Mesa = 'm1';").await;
    let marca = repo.contraste_marca().await.unwrap();

    let ContrasteLocal::Hecho(r) =
        repo.contrastar_con_la_nube(resumen, marca, &Paginas(&nube.contraste), true).await.unwrap()
    else {
        panic!("se tenía que comparar");
    };

    assert!(r.tablas_sin_comparar.contains(&"Mesas".to_string()), "{:?}", r.tablas_sin_comparar);
    let sube = reparaciones(&repo).await;
    assert!(!sube.iter().any(|s| s.sql.contains("\"Mesas\"")), "{sube:?}");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

// ── La nube de un negocio con tres cierres de caja, dos de ellos fuera de la ventana ──────────

/// `Periodo_Desde` va porque dos cierres vigentes no pueden empezar en el mismo sitio (RI-58).
const COLUMNAS_CIERRE: [&str; 3] = ["ID_Cierre", "Fecha_Hora", "Periodo_Desde"];

/// `/v1/sync/bootstrap`: la fase 1 trae el cierre de ayer y dice que la tabla viene recortada.
fn volcado_de_la_fase_1() -> JsonValue {
    json!({
        "ok": true, "seq": 40, "total_filas": 1,
        "tablas": [{
            "nombre": "Cierres_Caja", "columnas": COLUMNAS_CIERRE,
            "filas": [["cierre-de-ayer", "2026-11-12 02:00:00", "2026-04-30 02:00:00"]],
            "parcial": true,
        }],
        "backfill": ["Cierres_Caja"],
    })
}

/// `/v1/sync/historico`: la fase 2 trae la tabla entera, la ventana incluida.
fn pagina_del_historico() -> JsonValue {
    json!({
        "tabla": "Cierres_Caja", "columnas": COLUMNAS_CIERRE,
        "filas": [
            ["cierre-de-marzo", "2026-03-31 02:00:00", null],
            ["cierre-de-abril", "2026-04-30 02:00:00", "2026-03-31 02:00:00"],
            ["cierre-de-ayer", "2026-11-12 02:00:00", "2026-04-30 02:00:00"],
        ],
        "siguiente_cursor": null,
    })
}

/// La base de la nube: los tres cierres, con el log en 40.
async fn la_nube_de_los_tres_cierres(nombre: &str) -> Nube {
    let nube = Nube::nueva(nombre).await;
    nube.contraste
        .sembrar(
            "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde) VALUES
               ('cierre-de-marzo', '2026-03-31 02:00:00', NULL),
               ('cierre-de-abril', '2026-04-30 02:00:00', '2026-03-31 02:00:00'),
               ('cierre-de-ayer', '2026-11-12 02:00:00', '2026-04-30 02:00:00');",
        )
        .await;
    *nube.contraste.hasta_seq.lock().unwrap() = 40;
    nube
}

#[tokio::test]
async fn recien_recuperada_el_contraste_no_borra_de_la_nube_lo_que_el_historico_no_ha_traido() {
    let (repo, db, dir) = base("historico").await;
    let nube = la_nube_de_los_tres_cierres("historico").await;

    // Fase 1 de la recuperación: entra la ventana y el checkpoint queda en el `Seq` de la foto.
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(repo.get_checkpoint().await.unwrap(), 40);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 1);
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 1);

    // El contraste, con el histórico a medias: los dos cierres antiguos «sobran» arriba y el
    // checkpoint alcanza la foto. No se pide nada a la nube ni sale nada hacia ella.
    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();
    assert!(matches!(pasada, Contraste::HistoricoPendiente), "{pasada:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/bootstrap"], "ni el resumen ni las filas");
    assert!(reparaciones(&repo).await.is_empty(), "ningún borrado sube a la nube");

    // Fase 2: el backfill trae los cierres antiguos y la cola queda vacía.
    nube.responde("/v1/sync/historico", pagina_del_historico());
    uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 3);

    // Ahora sí se contrasta, y cuadra: no hay nada que borrar ni que subir.
    let r = hecho(uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap());
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    assert!(reparaciones(&repo).await.is_empty());

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn aunque_se_llegue_a_comparar_con_el_historico_a_medias_no_se_borra_arriba() {
    // La segunda guarda, por si el contraste llega al repositorio con la cola del backfill sin
    // vaciar (otro camino que no sea el caso de uso): la guarda del repositorio dice que no.
    let (repo, db, dir) = base("historico-repo").await;
    let nube = la_nube_de_los_tres_cierres("historico-repo").await;
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    let marca = repo.contraste_marca().await.unwrap();
    let resumen = nube.contraste.resumen_para(marca.checkpoint).await;
    let ContrasteLocal::Hecho(r) =
        repo.contrastar_con_la_nube(resumen, marca, &Paginas(&nube.contraste), true).await.unwrap()
    else {
        panic!("se tenía que comparar");
    };

    assert_eq!(r.descuadres, vec![descuadre("Cierres_Caja", 0, 2, 0)], "se ve lo que falta por bajar");
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, true));
    assert!(reparaciones(&repo).await.is_empty());

    nube.cerrar().await;
    cerrar(db, dir).await;
}

// ── VERIF-02: el horario del contraste, con la regla, el estado y el contraste de verdad ─────────

const MIN: i64 = 60 * 1000;
const HORA: i64 = 60 * MIN;

/// Un mediodía de invierno (hora UTC): lejos de un cambio de horario en cualquier zona.
const MEDIODIA: i64 = 1_768_478_400_000;

/// Una Main operativa, arrancada hace una hora, en el instante `ahora_ms`.
fn momento(ahora_ms: i64) -> Momento {
    Momento { ahora_ms, desde_el_arranque_ms: HORA, main_operativa: true }
}

/// La hora local que la base guardaría para ese instante.
fn hora_local(ms: i64) -> String {
    chrono::Local.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Una Main con una zona, el checkpoint en 40 y la última escritura en `ultima_escritura_ms`.
async fn main_al_dia(db: &Arc<Db>, ultima_escritura_ms: i64) {
    sembrar(
        db,
        &format!(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');
             UPDATE _Sync_State SET Last_Seq = 40 WHERE Id = 1;
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-vieja', 40, {ultima_escritura_ms});"
        ),
    )
    .await;
}

/// La caja se cierra en `ms`: el cierre y la escritura que lo deja. Devuelve el cierre, para
/// ponerlo también en la nube.
async fn cerrar_la_caja(db: &Arc<Db>, ms: i64) -> String {
    let cierre = format!(
        "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde) VALUES ('cierre-{ms}', '{}', '{}');",
        hora_local(ms),
        hora_local(ms - 12 * HORA),
    );
    sembrar(
        db,
        &format!("{cierre}\nINSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-cierre-{ms}', 0, {ms});"),
    )
    .await;
    cierre
}

/// La nube de la Main de `main_al_dia`: la misma zona, con el log en 40.
async fn la_nube_cuadra(nombre: &str) -> Nube {
    let nube = Nube::nueva(nombre).await;
    nube.contraste.sembrar("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;
    *nube.contraste.hasta_seq.lock().unwrap() = 40;
    nube
}

async fn vuelta(
    nube: &Nube,
    repo: &SqliteSyncRepository,
    estado: &SqliteVerificacionNube,
    m: Momento,
) -> AppResult<Vuelta> {
    uc_verificacion::verificar_si_toca(nube, repo, estado, m, true).await
}

#[tokio::test]
async fn tras_el_cierre_de_caja_contrasta_en_cuanto_hay_calma_y_no_vuelve_a_hacerlo_sin_motivo() {
    let (repo, db, dir) = base("horario-cierre").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-cierre").await;
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;
    // Una pasada buena hace tres horas, para que el único motivo sea el cierre.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 3 * HORA).await.unwrap();
    let cierre = cerrar_la_caja(&db, MEDIODIA).await;
    nube.contraste.sembrar(&cierre).await;

    // A los 4 min del cierre todavía no hay motivo; a los 7 hay motivo pero no calma. Nada sale.
    for (minutos, espera) in [(4, Espera::SinMotivo), (7, Espera::ActividadReciente), (14, Espera::ActividadReciente)] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + minutos * MIN)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(e) if e == espera), "a los {minutos} min: {v:?}");
    }
    assert!(nube.pedidas().is_empty(), "mientras no toca no se pide nada a la nube");

    // Al cuarto de hora de la última escritura, contrasta.
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 16 * MIN)).await.unwrap();
    let Vuelta::Hecha(r) = v else { panic!("tenía que contrastar: {v:?}") };
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);
    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar/resumen", "/v1/sync/salud"]);
    assert_eq!(estado.situacion(i64::MAX).await.unwrap().ultima_ok_ms, Some(MEDIODIA + 16 * MIN));

    // Y hasta que haya otro cierre o pasen veinte horas, no vuelve a pedir nada.
    for horas in [1, 10, 19] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + horas * HORA)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(Espera::SinMotivo)), "a las {horas} h: {v:?}");
    }
    assert_eq!(nube.pedidas().len(), 2);

    // A las veinte horas, otra vez.
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 16 * MIN + 20 * HORA)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_algo_pendiente_de_subir_o_recien_arrancada_no_contrasta() {
    let (repo, db, dir) = base("horario-ocupada").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-ocupada").await;
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // Nunca se ha contrastado, así que toca; pero la aplicación lleva dos minutos arrancada.
    let recien = Momento { desde_el_arranque_ms: 2 * MIN, ..momento(MEDIODIA) };
    let v = vuelta(&nube, &repo, &estado, recien).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::ArranqueReciente)), "{v:?}");

    // Con una operación sin subir tampoco.
    sembrar(
        &db,
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-1', 'main_op', '[]', 1);",
    )
    .await;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::SubidaPendiente)), "{v:?}");

    // Ni sin estar operativa (una recuperación en curso).
    let recuperando = Momento { main_operativa: false, ..momento(MEDIODIA) };
    let v = vuelta(&nube, &repo, &estado, recuperando).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::NoOperativa)), "{v:?}");

    assert!(nube.pedidas().is_empty());
    assert_eq!(estado.situacion(i64::MAX).await.unwrap().ultimo_intento_ms, None, "no ha habido ningún intento");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_el_historico_a_medias_el_horario_ni_lo_intenta() {
    // VERIF-01, visto desde el job: recién recuperada, por mucho que lleve sin contrastar.
    let (repo, db, dir) = base("horario-historico").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_de_los_tres_cierres("horario-historico").await;
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * 24 * HORA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::HistoricoPendiente)), "{v:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/bootstrap"]);

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn un_fallo_de_la_nube_espera_su_propia_escalera() {
    let (repo, db, dir) = base("horario-fallo").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-fallo").await;
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // La nube no contesta: el intento falla y se anota.
    *nube.caida.lock().unwrap() = true;
    assert!(vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.is_err());
    let s = estado.situacion(i64::MAX).await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(MEDIODIA), 1));
    assert_eq!(nube.pedidas().len(), 1);

    // Las vueltas siguientes (el motor vuelve al minuto, y luego cada cuarto de hora) no piden nada.
    for minutos in [1, 15, 29] {
        let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + minutos * MIN)).await.unwrap();
        assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "a los {minutos} min: {v:?}");
    }
    assert_eq!(nube.pedidas().len(), 1, "no se martillea a una nube caída");

    // A la media hora se reintenta; si vuelve a fallar, la espera siguiente es de una hora.
    assert!(vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN)).await.is_err());
    assert_eq!(estado.situacion(i64::MAX).await.unwrap().fallos, 2);
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN + 59 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "{v:?}");

    // Y cuando contesta, la cuenta vuelve a cero.
    *nube.caida.lock().unwrap() = false;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 30 * MIN + 60 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");
    let s = estado.situacion(i64::MAX).await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.fallos), (Some(MEDIODIA + 90 * MIN), 0));

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_nube_va_por_delante_no_se_compara_y_se_reintenta_a_los_diez_minutos() {
    let (repo, db, dir) = base("horario-foto").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-foto").await;
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;

    // La nube tiene una zona que una Handy acaba de crear (Seq 41) y que aquí aún no ha bajado.
    // Comparar diría que sobra arriba; lo que pasa es que está de camino. La nube lo ve (el
    // checkpoint de la Main no llega a ese cambio ajeno) y dice que ahora no.
    nube.contraste.sembrar("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-handy', 'Barra');").await;
    *nube.contraste.hasta_seq.lock().unwrap() = 41;
    *nube.contraste.ultimo_ajeno.lock().unwrap() = 41;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::Aplazada), "{v:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/verificar/resumen"], "ni filas ni informe");
    assert!(reparaciones(&repo).await.is_empty());
    let s = estado.situacion(i64::MAX).await.unwrap();
    assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(MEDIODIA), 0), "no es un fallo");

    // A los 9 min todavía espera; a los 10, con el cambio ya bajado, contrasta y cuadra.
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 9 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::Reintento)), "{v:?}");
    sembrar(
        &db,
        "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-handy', 'Barra');
         UPDATE _Sync_State SET Last_Seq = 41 WHERE Id = 1;",
    )
    .await;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 10 * MIN)).await.unwrap();
    let Vuelta::Hecha(r) = v else { panic!("tenía que contrastar: {v:?}") };
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn una_escritura_hecha_con_el_reloj_adelantado_no_deja_al_contraste_sin_correr() {
    // Alguien adelantó el reloj una semana, se vendió con él y se corrigió. Esa escritura lleva
    // una hora que no ha llegado: si contara como la última, no habría momento tranquilo en siete
    // días, por muy parado que estuviera el bar.
    let (repo, db, dir) = base("horario-reloj").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-reloj").await;
    main_al_dia(&db, MEDIODIA - 3 * HORA).await;
    sembrar(
        &db,
        &format!(
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-adelantada', 0, {});",
            MEDIODIA + 7 * 24 * HORA
        ),
    )
    .await;

    // Pero lo que se escribe de verdad después sí se ve: con una venta hace dos minutos, espera.
    sembrar(
        &db,
        &format!(
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-reciente', 0, {});",
            MEDIODIA - 2 * MIN
        ),
    )
    .await;
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::ActividadReciente)), "{v:?}");

    // Y pasada la calma, contrasta, con la fila adelantada todavía ahí.
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA + 20 * MIN)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");

    nube.cerrar().await;
    cerrar(db, dir).await;
}

#[tokio::test]
async fn a_las_48_horas_bastan_cinco_minutos_de_calma() {
    let (repo, db, dir) = base("horario-48h").await;
    let estado = SqliteVerificacionNube::new(db.clone());
    let nube = la_nube_cuadra("horario-48h").await;
    main_al_dia(&db, MEDIODIA - 6 * MIN).await;

    // Con la última pasada hace 47 h, seis minutos sin escribir no bastan.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 47 * HORA).await.unwrap();
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::NoToca(Espera::ActividadReciente)), "{v:?}");

    // Hace 48 h, sí.
    estado.anotar(IntentoVerificacion::Hecha, MEDIODIA - 48 * HORA).await.unwrap();
    let v = vuelta(&nube, &repo, &estado, momento(MEDIODIA)).await.unwrap();
    assert!(matches!(v, Vuelta::Hecha(_)), "{v:?}");

    nube.cerrar().await;
    cerrar(db, dir).await;
}
