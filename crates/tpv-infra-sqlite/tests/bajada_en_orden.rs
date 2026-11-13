//! AUD-18 · La bajada nube → Main estrictamente en orden, de punta a punta.
//!
//! Recorre el motor real de réplica (`tpv_application::use_cases::replicacion`) sobre el
//! repositorio SQLite real, con la nube y el socket simulados, y después el contraste diario real
//! (`use_cases::sync::verificar_contra_la_nube`, el cuerpo del job `verificar_nube`).
//!
//! La nube simulada sirve `/v1/sync/changes` como la ruta real (`sync.routes.ts`,
//! `cambiosJson.ts`): `Seq > since`, en orden, con tope por página, `nextSince` = el último `Seq`
//! servido, `highWater` = el mayor y `purgadoHasta` = 0 (nada purgado). Lo que llega en vivo se
//! anota en su log al entregarse, que es lo que hace el DO: confirmar en Turso y después difundir,
//! en orden de `Seq`.
//!
//! Los escenarios son los de la investigación de AUD-18 (un fallo en mitad de una página del
//! catch-up y otro en vivo): ningún cambio se pierde, nada se aplica fuera de orden y
//! `verificar_nube` no borra ni pisa nada arriba mientras quede un fallo de bajada.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::replicacion::{CanalReplicacion, ContextoReplicacion};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::{replicacion, sync as uc_sync};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    PairCreateResult,
};
use tpv_contracts::sync::{OutboxFallo, SqlStatement};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

/// Cambios por página. El worker sirve 500; aquí pocos, para que haya páginas.
const POR_PAGINA: usize = 4;

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La nube: el log `Sync_Changes`, respuestas preparadas para el resto de rutas y lo que se le pidió.
#[derive(Default)]
struct Nube {
    log: Mutex<Vec<JsonValue>>,
    respuestas: Mutex<HashMap<String, VecDeque<JsonValue>>>,
    peticiones: Mutex<Vec<(String, JsonValue)>>,
}

impl Nube {
    fn con_log(cambios: Vec<JsonValue>) -> Arc<Nube> {
        let nube = Nube::default();
        *nube.log.lock().unwrap() = cambios;
        Arc::new(nube)
    }

    fn responde(&self, ruta: &str, cuerpo: JsonValue) {
        self.respuestas.lock().unwrap().entry(ruta.to_string()).or_default().push_back(cuerpo);
    }

    /// Los `since` con los que la Main ha pedido `/v1/sync/changes`, en orden.
    fn since_pedidos(&self) -> Vec<i64> {
        self.peticiones
            .lock()
            .unwrap()
            .iter()
            .filter(|(ruta, _)| ruta == "/v1/sync/changes")
            .map(|(_, cuerpo)| cuerpo["since"].as_i64().unwrap())
            .collect()
    }

    fn cambios_desde(&self, since: i64) -> JsonValue {
        let log = self.log.lock().unwrap();
        fn seq(c: &JsonValue) -> i64 {
            c["seq"].as_i64().unwrap()
        }
        let mut pendientes: Vec<JsonValue> = log.iter().filter(|c| seq(c) > since).cloned().collect();
        pendientes.sort_by_key(seq);
        let items: Vec<JsonValue> = pendientes.into_iter().take(POR_PAGINA).collect();
        let next_since = items.last().map(seq).unwrap_or(since);
        let high_water = log.iter().map(seq).max().unwrap_or(0);
        json!({ "ok": true, "items": items, "nextSince": next_since, "highWater": high_water, "purgadoHasta": 0 })
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
        self.peticiones.lock().unwrap().push((path.to_string(), body.clone()));
        if path == "/v1/sync/changes" {
            return Ok(self.cambios_desde(body["since"].as_i64().unwrap_or(0)));
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

/// El contexto del shell (`src-tauri/src/replicacion.rs::Contexto`) sin Tauri.
struct Ctx {
    repo: Arc<SqliteSyncRepository>,
}

#[async_trait]
impl ContextoReplicacion for Ctx {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> {
        Ok(self.repo.clone())
    }
    fn cambios(&self, _: &[SqlStatement]) {}
    fn fase_recuperacion(&self, _: &str) {}
    fn solicitud_emparejamiento(&self) {}
    fn reservas_web(&self) {}
    fn fallo_subida(&self, _: &str, _: &OutboxFallo) {}
    async fn completar_recuperacion(&self, _: i64) -> AppResult<()> {
        Ok(())
    }
    /// La sesión acaba cuando se cae el socket, como en producción.
    async fn sigue_disponible(&self, _: bool) -> AppResult<bool> {
        Ok(true)
    }
    fn volcado_permitido(&self) -> bool {
        false
    }
}

/// Lo que llega por el WebSocket de una sesión.
enum Llega {
    /// Un cambio que el DO difunde: se anota en el log de la nube (donde el DO lo escribió antes
    /// de difundirlo) y se entrega.
    Cambio(JsonValue),
    /// Vence la espera de `recibir` sin que llegue nada. Antes, opcionalmente, pasa algo aquí.
    Nada(Option<&'static str>),
}

/// El WebSocket de una sesión: entrega en orden lo preparado y, al acabarse, se cierra (`recibir`
/// da error), que es como ve el motor real una conexión caída. Apunta cuánto le piden esperar.
struct Socket {
    entrantes: VecDeque<Llega>,
    nube: Arc<Nube>,
    db: Arc<Db>,
    esperas: Vec<Duration>,
}

fn socket(nube: &Arc<Nube>, db: &Arc<Db>, entrantes: Vec<Llega>) -> Socket {
    Socket { entrantes: entrantes.into(), nube: nube.clone(), db: db.clone(), esperas: vec![] }
}

#[async_trait]
impl CanalReplicacion for Socket {
    async fn enviar(&mut self, _: JsonValue) -> AppResult<()> {
        Ok(())
    }
    async fn recibir(&mut self, espera: Duration) -> AppResult<Option<JsonValue>> {
        self.esperas.push(espera);
        match self.entrantes.pop_front() {
            None => Err(AppError::external("socket cerrado")),
            Some(Llega::Cambio(cambio)) => {
                self.nube.log.lock().unwrap().push(cambio.clone());
                let mut mensaje = cambio;
                mensaje["type"] = json!("change");
                Ok(Some(mensaje))
            }
            Some(Llega::Nada(antes)) => {
                if let Some(sql) = antes {
                    let w = self.db.write().await;
                    w.raw().execute_batch(sql).await.unwrap();
                }
                Ok(None)
            }
        }
    }
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("aud18-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf) {
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
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

/// Un cambio como lo guarda `Sync_Changes` y lo sirve `/v1/sync/changes` (`cambiosJson.ts`).
fn item(op: &str, seq: i64, sentencias: Vec<(&str, Vec<JsonValue>)>) -> JsonValue {
    let statements: Vec<JsonValue> =
        sentencias.into_iter().map(|(sql, args)| json!({ "sql": sql, "args": args })).collect();
    json!({
        "seq": seq, "opId": op, "command": "handy", "deviceId": "handy-1",
        "createdAtMs": 1, "statements": statements,
    })
}

fn sql(op: &str, seq: i64, sql: &str) -> JsonValue {
    item(op, seq, vec![(sql, vec![])])
}

/// Las sentencias de las reparaciones encoladas (`main_reparacion`), que es lo que sube a Turso.
async fn reparaciones(repo: &SqliteSyncRepository) -> Vec<SqlStatement> {
    repo.outbox_pending(100)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.command_name == "main_reparacion")
        .flat_map(|e| e.statements)
        .collect()
}

fn esperas_en_segundos(s: &Socket) -> Vec<u64> {
    s.esperas.iter().map(|d| d.as_secs_f64().round() as u64).collect()
}

// ── Escenario A: un fallo en mitad de una página del catch-up ─────────────────

/// Un cambio que la Main no sabe aplicar (como una tabla que su versión aún no tiene), con más
/// cambios detrás en su página y otra página después.
fn log_escenario_a() -> Vec<JsonValue> {
    vec![
        sql("op-1", 1, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-ok','B');"),
        sql("op-2", 2, "UPDATE Tabla_Que_No_Existe SET x = 1;"),
        sql("op-3", 3, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-handy','C');"),
        sql("op-4", 4, "UPDATE Zonas SET Nombre_Zona = 'Terraza' WHERE ID_Zona = 'z1';"),
        sql("op-5", 5, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-5','E');"),
    ]
}

#[tokio::test]
async fn un_fallo_en_mitad_de_una_pagina_detiene_la_bajada_y_nada_se_pierde_ni_se_borra_arriba() {
    let (repo, db, dir) = base("pagina").await;
    sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
    let ctx = Ctx { repo: repo.clone() };
    let nube = Nube::con_log(log_escenario_a());

    // La sesión: el 2 falla en la primera página. Se reintenta cuatro veces más, con sus esperas,
    // sin pedir la página siguiente; pasa a cuarentena y el catch-up sigue desde él.
    let mut s = socket(&nube, &db, vec![Llega::Nada(None), Llega::Nada(None), Llega::Nada(None), Llega::Nada(None)]);
    assert!(replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await.is_err(), "acaba al caerse el socket");

    assert_eq!(nube.since_pedidos(), vec![0, 2, 5], "la página siguiente se pide desde el 2, no desde el 4");
    assert_eq!(esperas_en_segundos(&s)[..4], [1, 2, 4, 8]);
    assert_eq!(repo.get_checkpoint().await.unwrap(), 5);
    let salud = repo.health().await.unwrap();
    assert_eq!((salud.failing, salud.quarantined), (0, 1));
    assert_eq!(numero(&db, "SELECT Attempts FROM _Sync_Failed WHERE Op_Id = 'op-2' AND Quarantined = 1;").await, 5);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z-handy';").await, 1, "el 3 entró");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z1' AND Nombre_Zona = 'Terraza';").await, 1, "el 4 entró");
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z-5';").await, 1, "el 5 entró");

    // `verificar_nube`, con una fila arriba que aquí no está: con la cuarentena, no se borra.
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Zonas", "filas": 5 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 5,
        }),
    );
    nube.responde(
        "/v1/sync/verificar-claves",
        json!({ "tablas": [{
            "nombre": "Zonas", "columnas": ["ID_Zona"],
            "claves": [["z1"], ["z-ok"], ["z-handy"], ["z-5"], ["z-x"]], "truncada": false,
        }] }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
    let r = uc_sync::verificar_contra_la_nube(nube.as_ref(), repo.as_ref(), true).await.unwrap();
    assert_eq!((r.borradas, r.aplazado), (0, true));
    assert!(reparaciones(&repo).await.is_empty(), "nada sube a la nube");

    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_la_sesion_se_cae_mientras_se_reintenta_el_checkpoint_espera_y_la_siguiente_sigue() {
    // Con el socket caído a mitad de los reintentos, el cambio sigue anotado por delante del
    // checkpoint y la sesión siguiente empieza por él: nada de lo de detrás se ha aplicado antes.
    let (repo, db, dir) = base("caida").await;
    sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
    let ctx = Ctx { repo: repo.clone() };
    let nube = Nube::con_log(log_escenario_a());

    let mut s = socket(&nube, &db, vec![Llega::Nada(None)]);
    let _ = replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await;
    assert_eq!(repo.get_checkpoint().await.unwrap(), 1);
    assert_eq!(numero(&db, "SELECT Attempts * 10 + Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-2';").await, 20);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z-handy','z-5');").await, 0);

    let mut s = socket(&nube, &db, vec![Llega::Nada(None), Llega::Nada(None)]);
    let _ = replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await;
    assert_eq!(nube.since_pedidos(), vec![0, 2, 5], "ni la sesión siguiente pide desde el 4");
    assert_eq!(repo.get_checkpoint().await.unwrap(), 5);
    assert_eq!(numero(&db, "SELECT Attempts * 10 + Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-2';").await, 51);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z-handy','z-5');").await, 2);

    cerrar(db, dir).await;
}

// ── Escenario B: en vivo, con un desencadenante del producto ──────────────────

const AHORA: &str = "2026-11-08 20:00:00";
const INSERT_CLIENTE: &str = "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) \
     VALUES (?1, ?2, ?3, ?4, ?5);";
const INSERT_RESERVA: &str = "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, \
     Turno, Comensales, Nota, Estado, Duracion_Min, Created_At) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROXIMA', ?9, ?10);";

fn reserva(id: &str, cliente: Option<&str>, dia: &str, hora: &str, turno: &str, n: i64) -> Vec<JsonValue> {
    vec![
        json!(id), json!(cliente), JsonValue::Null, json!(dia), json!(hora), json!(turno),
        json!(n), JsonValue::Null, JsonValue::Null, json!(AHORA),
    ]
}

/// Lo que llega en vivo: (10) la Handy reserva para una clienta nueva con el correo de una que la
/// Main acaba de dar de alta (la nube no la tiene aún y lo acepta); (11) otra reserva cualquiera;
/// (12) otra reserva de la clienta de (10), que la nube ya tiene; (13) otra reserva cualquiera.
fn en_vivo_escenario_b() -> Vec<Llega> {
    vec![
        Llega::Cambio(item("op-10", 10, vec![
            (INSERT_CLIENTE, vec![json!("c-handy"), json!("Ana López"), json!("600000000"), json!("ANA@example.com"), json!(AHORA)]),
            (INSERT_RESERVA, reserva("r-1", Some("c-handy"), "2026-11-20", "21:00", "CENA", 2)),
        ])),
        Llega::Cambio(item("op-11", 11, vec![(INSERT_RESERVA, reserva("r-2", None, "2026-11-21", "14:00", "COMIDA", 4))])),
        Llega::Cambio(item("op-12", 12, vec![(INSERT_RESERVA, reserva("r-3", Some("c-handy"), "2026-11-27", "21:30", "CENA", 2))])),
        Llega::Cambio(item("op-13", 13, vec![(INSERT_RESERVA, reserva("r-4", None, "2026-11-22", "13:30", "COMIDA", 6))])),
    ]
}

fn verificacion_escenario_b(nube: &Nube) {
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Clientes", "filas": 1 }, { "nombre": "Reservas", "filas": 4 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 13,
        }),
    );
    nube.responde(
        "/v1/sync/verificar-claves",
        json!({ "tablas": [{
            "nombre": "Reservas", "columnas": ["ID_Reserva"],
            "claves": [["r-1"], ["r-2"], ["r-3"], ["r-4"]], "truncada": false,
        }] }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
}

async fn clienta_de_la_main(db: &Arc<Db>) {
    sembrar(
        db,
        "INSERT INTO Clientes (ID_Cliente, Nombre, Email, Created_At) \
         VALUES ('c-main','Ana','ana@example.com','2026-11-08 19:58:00');",
    )
    .await;
}

#[tokio::test]
async fn en_vivo_lo_que_llega_detras_de_un_fallo_no_se_aplica_antes_y_nada_se_borra_arriba() {
    let (repo, db, dir) = base("vivo").await;
    clienta_de_la_main(&db).await;
    let ctx = Ctx { repo: repo.clone() };
    let nube = Nube::con_log(vec![]);

    // El 10 falla (el correo) y detiene la bajada; el 11, el 12 y el 13 llegan mientras se espera y
    // no se aplican. El 10 se reintenta hasta la cuarentena; el catch-up trae el resto desde él y el
    // 12 (cuya clienta no existe aquí) hace lo mismo.
    let mut entrantes = en_vivo_escenario_b();
    entrantes.extend((0..8).map(|_| Llega::Nada(None)));
    let mut s = socket(&nube, &db, entrantes);
    assert!(replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await.is_err());

    assert_eq!(nube.since_pedidos(), vec![0, 10, 12, 13], "nada se pide por encima de un fallo");
    assert_eq!(repo.get_checkpoint().await.unwrap(), 13);
    let salud = repo.health().await.unwrap();
    assert_eq!((salud.failing, salud.quarantined), (0, 2));
    assert_eq!(
        numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'op-10' AND Last_Error LIKE '%ux_clientes_email%' AND Attempts = 5;").await,
        1
    );
    assert_eq!(
        numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'op-12' AND Last_Error LIKE '%FOREIGN KEY%' AND Attempts = 5;").await,
        1
    );
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Reservas WHERE ID_Reserva IN ('r-2','r-4');").await, 2);

    // `verificar_nube`: la nube tiene r-1 y r-3 y aquí no están. Con las cuarentenas, no se borran.
    verificacion_escenario_b(&nube);
    let r = uc_sync::verificar_contra_la_nube(nube.as_ref(), repo.as_ref(), true).await.unwrap();
    assert_eq!((r.borradas, r.aplazado), (0, true));
    assert!(
        !reparaciones(&repo).await.iter().any(|s| s.sql.starts_with("DELETE")),
        "no se borra arriba ninguna reserva de la Handy"
    );

    cerrar(db, dir).await;
}

#[tokio::test]
async fn en_vivo_un_fallo_que_se_resuelve_al_reintentar_entra_y_lo_de_detras_le_sigue_en_orden() {
    // El mismo arranque, pero el conflicto desaparece durante la primera espera (aquí, la clienta
    // de la Main cambia de correo). El 10 entra al reintentarlo y lo de detrás, el 12 incluido
    // (que necesita a la clienta del 10), entra después y en orden: sin cuarentenas.
    let (repo, db, dir) = base("vivo-resuelto").await;
    clienta_de_la_main(&db).await;
    let ctx = Ctx { repo: repo.clone() };
    let nube = Nube::con_log(vec![]);

    let mut entrantes = en_vivo_escenario_b();
    entrantes.push(Llega::Nada(Some("UPDATE Clientes SET Email = 'ana.main@example.com' WHERE ID_Cliente = 'c-main';")));
    let mut s = socket(&nube, &db, entrantes);
    assert!(replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await.is_err());

    assert_eq!(nube.since_pedidos(), vec![0, 10, 13]);
    assert_eq!(repo.get_checkpoint().await.unwrap(), 13);
    let salud = repo.health().await.unwrap();
    assert_eq!((salud.failing, salud.quarantined), (0, 0));
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Reservas;").await, 4);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'c-handy';").await, 1);

    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_la_difusion_en_orden_una_caida_no_pierde_lo_que_aun_no_habia_llegado() {
    // El DO confirma y difunde en orden: si el 11 ya está en Turso pero el socket se cae antes de
    // que llegue, la Main lo pide al reconectar, porque su checkpoint se quedó en el 10.
    let (repo, db, dir) = base("caida-en-orden").await;
    let ctx = Ctx { repo: repo.clone() };
    let nube = Nube::con_log(vec![]);

    let mut s = socket(
        &nube,
        &db,
        vec![Llega::Cambio(sql("op-10", 10, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-10','X');"))],
    );
    let _ = replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await;
    nube.log.lock().unwrap().push(sql("op-11", 11, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-11','Y');"));

    let mut s = socket(&nube, &db, vec![]);
    let _ = replicacion::ejecutar(&ctx, nube.as_ref(), &mut s, false).await;

    assert_eq!(nube.since_pedidos(), vec![0, 10, 11]);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z-10','z-11');").await, 2);

    cerrar(db, dir).await;
}
