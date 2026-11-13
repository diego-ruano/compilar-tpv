//! SYNC-19 · fase 2: el ritmo del backfill del histórico (`use_cases::sync::backfill_paso`), con la
//! nube simulada y el repositorio SQLite real.
//!
//! Con el equipo trabajando baja como siempre: diez páginas de 2.000 filas por vencimiento del job.
//! Con el equipo en calma (nadie ha escrito en unos minutos), páginas de 10.000 y hasta cuarenta por
//! vencimiento: un año de un bar grande baja en horas y no en días. La calma se mira antes de cada
//! página: si entra una venta a mitad, lo que queda va al ritmo de trabajo.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::sync::{
    self as uc_sync, BACKFILL_FILAS_POR_PAGINA, BACKFILL_FILAS_POR_PAGINA_EN_CALMA, BACKFILL_PAGINAS_POR_TICK,
    BACKFILL_PAGINAS_POR_TICK_EN_CALMA,
};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo, PairCreateResult,
};
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::sync::SqliteSyncRepository;

/// La nube: `/v1/sync/historico` de una tabla de `total` comandas, con el `rowid` de 1 a `total`,
/// paginada como el worker (`siguiente_cursor` mientras pueda quedar algo). Apunta lo que se le pide
/// y, antes de contestar la página `actividad_en`, apunta una escritura en la base de la Main.
struct Nube {
    total: i64,
    /// Lo que admite el worker por página (el de verdad, 10.000; uno anterior, 2.000).
    tope_del_worker: i64,
    limites: Mutex<Vec<i64>>,
    actividad_en: Option<(usize, Arc<Db>)>,
}

impl Nube {
    fn new(total: i64) -> Self {
        Nube { total, tope_del_worker: 10_000, limites: Mutex::new(Vec::new()), actividad_en: None }
    }

    fn limites(&self) -> Vec<i64> {
        self.limites.lock().unwrap().clone()
    }
}

/// Una escritura de la Main, como la deja una venta o un cambio aplicado de la nube.
async fn escribir_ahora(db: &Arc<Db>, op: &str) {
    let ahora = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let w = db.write().await;
    w.raw()
        .execute(
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2);",
            vec![tpv_infra_sqlite::ejecutor::Value::Text(op.into()), tpv_infra_sqlite::ejecutor::Value::Integer(ahora)],
        )
        .await
        .unwrap();
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
    async fn tpv_server_post_json(&self, _mode: &str, path: &str, cuerpo: JsonValue) -> AppResult<JsonValue> {
        if path != "/v1/sync/historico" {
            return Err(AppError::external(format!("respuesta no prevista para {path}")));
        }
        let limite = cuerpo["limite"].as_i64().unwrap();
        let cursor = cuerpo["cursor"].as_i64().unwrap();
        let pedidas = {
            let mut l = self.limites.lock().unwrap();
            l.push(limite);
            l.len()
        };
        if let Some((en, db)) = &self.actividad_en {
            if pedidas == *en {
                escribir_ahora(db, "venta-a-mitad").await;
            }
        }
        let n = limite.min(self.tope_del_worker);
        let filas: Vec<JsonValue> = (cursor + 1..=(cursor + n).min(self.total))
            .map(|i| json!([format!("c-{i:06}"), "BARRA", "2025-01-01 12:00:00", "Pagada"]))
            .collect();
        let ultimo = cursor + filas.len() as i64;
        Ok(json!({
            "ok": true,
            "tabla": "Comandas",
            "columnas": ["ID_Comanda", "Canal", "Fecha_Hora_Apertura", "Estado"],
            "filas": filas,
            "siguiente_cursor": if filas.len() as i64 == n { json!(ultimo) } else { JsonValue::Null },
        }))
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

/// Una Main recién recuperada: la fase 2 de `Comandas` anotada y por empezar.
async fn base(nombre: &str) -> (Arc<SqliteSyncRepository>, Arc<Db>, PathBuf) {
    let marca = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("historico-ritmo-{nombre}-{}-{marca}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    {
        let w = db.write().await;
        w.raw()
            .execute_batch("INSERT INTO _Backfill_Historico (Tabla, Orden, Completada) VALUES ('Comandas', 0, 0);")
            .await
            .unwrap();
    }
    (Arc::new(SqliteSyncRepository::new(db.clone())), db, dir)
}

async fn cerrar(db: Arc<Db>, dir: PathBuf) {
    let _ = db.cerrar().await;
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn comandas(db: &Arc<Db>) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query("SELECT COUNT(*) FROM Comandas;", ()).await.unwrap();
    filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
}

#[tokio::test]
async fn con_el_equipo_en_calma_baja_en_paginas_grandes_y_muchas_por_vencimiento() {
    let (repo, db, dir) = base("calma").await;
    let total = 3 * BACKFILL_FILAS_POR_PAGINA_EN_CALMA + 7;
    let nube = Nube::new(total);

    // Nadie ha escrito nunca: está en calma. Cuatro páginas de 10.000 traen la tabla entera de una vez.
    let filas = uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(filas, total);
    assert_eq!(nube.limites(), vec![BACKFILL_FILAS_POR_PAGINA_EN_CALMA; 4]);
    assert_eq!(comandas(&db).await, total);
    let estado = repo.backfill_estado().await.unwrap();
    assert_eq!((estado.tablas_pendientes, estado.tablas_completadas), (0, 1));

    // Y el ritmo de calma da para lo que se busca: más de un millón de filas a la hora.
    let por_hora = BACKFILL_PAGINAS_POR_TICK_EN_CALMA as i64 * BACKFILL_FILAS_POR_PAGINA_EN_CALMA * 12;
    assert!(por_hora >= 1_000_000, "{por_hora} filas a la hora");
    cerrar(db, dir).await;
}

#[tokio::test]
async fn con_el_equipo_trabajando_baja_como_siempre() {
    let (repo, db, dir) = base("trabajando").await;
    escribir_ahora(&db, "venta-de-hace-un-momento").await;
    let nube = Nube::new(1_000_000);

    let filas = uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(nube.limites(), vec![BACKFILL_FILAS_POR_PAGINA; BACKFILL_PAGINAS_POR_TICK]);
    assert_eq!(filas, BACKFILL_FILAS_POR_PAGINA * BACKFILL_PAGINAS_POR_TICK as i64);
    // Por donde se quedó: el siguiente vencimiento sigue desde ahí.
    assert_eq!(repo.backfill_siguiente().await.unwrap(), Some(("Comandas".to_string(), filas)));
    cerrar(db, dir).await;
}

#[tokio::test]
async fn si_entra_una_venta_a_mitad_lo_que_queda_va_al_ritmo_de_trabajo() {
    let (repo, db, dir) = base("a-mitad").await;
    let mut nube = Nube::new(1_000_000);
    // La venta entra mientras se pide la tercera página: ésa ya iba a ritmo de calma.
    nube.actividad_en = Some((3, db.clone()));

    uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    let limites = nube.limites();
    assert_eq!(limites.len(), BACKFILL_PAGINAS_POR_TICK, "no pasa de las páginas del ritmo de trabajo: {limites:?}");
    assert_eq!(&limites[..3], &[BACKFILL_FILAS_POR_PAGINA_EN_CALMA; 3]);
    assert!(limites[3..].iter().all(|l| *l == BACKFILL_FILAS_POR_PAGINA), "{limites:?}");
    cerrar(db, dir).await;
}

#[tokio::test]
async fn un_worker_anterior_recorta_las_paginas_y_el_historico_baja_igual() {
    let (repo, db, dir) = base("worker-anterior").await;
    let mut nube = Nube::new(9_001);
    nube.tope_del_worker = 2_000;

    let filas = uc_sync::backfill_paso(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(filas, 9_001);
    assert_eq!(comandas(&db).await, 9_001);
    assert_eq!(repo.backfill_estado().await.unwrap().tablas_pendientes, 0);
    cerrar(db, dir).await;
}
