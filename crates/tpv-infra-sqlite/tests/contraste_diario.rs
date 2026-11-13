//! El contraste diario con la nube (`use_cases::sync::verificar_contra_la_nube`, el cuerpo del job
//! `verificar_nube`), de punta a punta: la nube simulada y el repositorio SQLite real.
//!
//! VERIF-01 · Una Main recién recuperada de la nube tiene la ventana de la fase 1 y el checkpoint
//! en el `Seq` de esa foto: por el marcapáginas está al día, y le falta todo el histórico que la
//! fase 2 todavía no ha bajado. El contraste no puede leer eso como «la nube tiene filas de más».

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::sync::{self as uc_sync, Contraste};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    PairCreateResult,
};
use tpv_contracts::sync::SqlStatement;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La nube: respuestas preparadas por ruta y lo que se le ha pedido.
#[derive(Default)]
struct Nube {
    respuestas: Mutex<HashMap<String, VecDeque<JsonValue>>>,
    peticiones: Mutex<Vec<String>>,
}

impl Nube {
    fn responde(&self, ruta: &str, cuerpo: JsonValue) {
        self.respuestas.lock().unwrap().entry(ruta.to_string()).or_default().push_back(cuerpo);
    }

    fn pedidas(&self) -> Vec<String> {
        self.peticiones.lock().unwrap().clone()
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
    async fn tpv_server_post_json(&self, _mode: &str, path: &str, _: JsonValue) -> AppResult<JsonValue> {
        self.peticiones.lock().unwrap().push(path.to_string());
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

async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

/// Las sentencias de las reparaciones encoladas (`main_reparacion`), que es lo que sube a la nube.
async fn reparaciones(repo: &SqliteSyncRepository) -> Vec<SqlStatement> {
    repo.outbox_pending(100)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.command_name == "main_reparacion")
        .flat_map(|e| e.statements)
        .collect()
}

// ── La nube de un negocio con tres cierres de caja, dos de ellos fuera de la ventana ──────────

/// `Periodo_Desde` va porque dos cierres vigentes no pueden empezar en el mismo sitio (RI-58).
const COLUMNAS_CIERRE: [&str; 3] = ["ID_Cierre", "Fecha_Hora", "Periodo_Desde"];

/// `/v1/sync/bootstrap`: la fase 1 trae el cierre de ayer y dice que la tabla viene recortada.
fn volcado_de_la_fase_1() -> JsonValue {
    json!({
        "ok": true, "seq": 40, "totalFilas": 1,
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

/// Lo que contesta la nube a un contraste: tres cierres, y sus claves si se las piden.
fn la_nube_contesta_al_contraste(nube: &Nube) {
    nube.responde(
        "/v1/sync/verificar",
        json!({
            "conteos": [{ "nombre": "Cierres_Caja", "filas": 3 }],
            "ventana": [], "ventana_omitida": false, "desde": "", "hasta_seq": 40,
        }),
    );
    nube.responde(
        "/v1/sync/verificar-claves",
        json!({ "tablas": [{
            "nombre": "Cierres_Caja", "columnas": ["ID_Cierre"],
            "claves": [["cierre-de-marzo"], ["cierre-de-abril"], ["cierre-de-ayer"]],
            "truncada": false,
        }] }),
    );
    nube.responde("/v1/sync/salud", json!({ "ok": true }));
}

#[tokio::test]
async fn recien_recuperada_el_contraste_no_borra_de_la_nube_lo_que_el_historico_no_ha_traido() {
    let (repo, db, dir) = base("historico").await;
    let nube = Nube::default();

    // Fase 1 de la recuperación: entra la ventana y el checkpoint queda en el `Seq` de la foto.
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(repo.get_checkpoint().await.unwrap(), 40);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 1);
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 1);

    // El contraste, con el histórico a medias: los dos cierres antiguos «sobran» arriba y el
    // checkpoint alcanza la foto. No se pide nada a la nube ni sale nada hacia ella.
    la_nube_contesta_al_contraste(&nube);
    let pasada = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true).await.unwrap();
    assert!(matches!(pasada, Contraste::HistoricoPendiente), "{pasada:?}");
    assert_eq!(nube.pedidas(), vec!["/v1/sync/bootstrap"], "ni la foto ni las claves");
    assert!(reparaciones(&repo).await.is_empty(), "ningún borrado sube a la nube");

    // Fase 2: el backfill trae los cierres antiguos y la cola queda vacía.
    nube.responde("/v1/sync/historico", pagina_del_historico());
    uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(uc_sync::backfill_estado(repo.as_ref()).await.unwrap().tablas_pendientes, 0);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 3);

    // Ahora sí se contrasta, y cuadra: no hay nada que borrar ni que subir.
    let r = uc_sync::verificar_contra_la_nube(&nube, repo.as_ref(), true)
        .await
        .unwrap()
        .hecho()
        .expect("con el histórico completo se compara");
    assert!(r.descuadres.is_empty(), "{:?}", r.descuadres);
    assert_eq!((r.reparadas, r.borradas, r.aplazado), (0, 0, false));
    assert!(reparaciones(&repo).await.is_empty());

    cerrar(db, dir).await;
}

#[tokio::test]
async fn aunque_se_llegue_a_comparar_con_el_historico_a_medias_no_se_borra_arriba() {
    // La segunda guarda, por si el contraste llega al repositorio con la cola del backfill sin
    // vaciar (otro camino que no sea el caso de uso): `puede_borrar_arriba` dice que no.
    let (repo, db, dir) = base("historico-repo").await;
    let nube = Nube::default();
    nube.responde("/v1/sync/bootstrap", volcado_de_la_fase_1());
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    let claves: tpv_contracts::sync::VerificacionClaves = serde_json::from_value(json!({ "tablas": [{
        "nombre": "Cierres_Caja", "columnas": ["ID_Cierre"],
        "claves": [["cierre-de-marzo"], ["cierre-de-abril"], ["cierre-de-ayer"]],
        "truncada": false,
    }] }))
    .unwrap();
    let (descuadres, reparadas, borradas, aplazado) =
        SyncRepository::contrastar_claves(repo.as_ref(), claves, 40, true).await.unwrap();

    assert_eq!(descuadres[0].sobran, 2, "se ve lo que falta por bajar");
    assert_eq!((reparadas, borradas, aplazado), (0, 0, true));
    assert!(reparaciones(&repo).await.is_empty());

    cerrar(db, dir).await;
}
