//! AUD-19 · Una copia anterior a lo que guarda la nube, de punta a punta, con SQLite real.
//!
//! 1. La copia diaria tiene a `u-baja` activo, administrador y con el PIN de entonces, el cursor
//!    en 10 y en el outbox una operación que el equipo de entonces subió después (su
//!    `Applied_Operations` en la nube ya caducó: si volviera a subir, se aplicaría otra vez).
//! 2. Se pierde la base y se restaura esa copia: queda en reconciliación.
//! 3. La nube ya purgó hasta el 700. El motor real, en recuperación, se para sin aplicar ni subir
//!    nada: «Esta copia es anterior a lo que guarda la nube».
//! 4. «Recuperar el estado actual de la nube» (`bootstrap_desde_nube`): la copia se guarda entera en
//!    `backups/antes-de-la-nube-*`, con su outbox, y el outbox no pasa a la base nueva.
//! 5. La reconciliación termina sin subir nada: la baja de `u-baja` se queda como está.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{PairingService, ResultadoSubidaImagen};
use tpv_application::ports::replicacion::{CanalReplicacion, ContextoReplicacion, RitmoDeSubida};
use tpv_application::ports::sync::SyncRepository;
use tpv_application::use_cases::{replicacion, sync as uc_sync};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceFirmarEmparejamientoArgs, DeviceIdentity, FirmaDispositivo,
    PairCreateResult,
};
use tpv_contracts::recovery::RecoveryState;
use tpv_contracts::sync::{OutboxFallo, SqlStatement};
use tpv_domain::login::hash_pin;
use tpv_infra_sqlite::connection::init_main_db;
use tpv_infra_sqlite::db::Db;
use tpv_infra_sqlite::ejecutor::Value;
use tpv_infra_sqlite::recovery;
use tpv_infra_sqlite::sync::SqliteSyncRepository;
use tpv_infra_sqlite::sync_reparacion::valor_a_json;

// Los dos roles que siembra 0001_inicial.sql.
const ROL_ADMIN: &str = "00000000-0000-7000-8000-000000000001";
const ROL_CAMARERO: &str = "00000000-0000-7000-8000-000000000002";

// ── Dobles ────────────────────────────────────────────────────────────────────

/// La nube: lo que contesta `/v1/sync/changes` en cada momento, el volcado de `/v1/sync/bootstrap`
/// y lo que se le ha pedido.
#[derive(Default)]
struct Nube {
    cambios: Mutex<JsonValue>,
    volcado: Mutex<JsonValue>,
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
        match path {
            "/v1/sync/changes" => Ok(self.cambios.lock().unwrap().clone()),
            "/v1/sync/bootstrap" => Ok(self.volcado.lock().unwrap().clone()),
            otro => Err(AppError::external(format!("respuesta no prevista para {otro}"))),
        }
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

/// El contexto del shell sin Tauri: desbloquear es `complete_reconciliation`, como en `completar`.
struct Ctx {
    db: Arc<Db>,
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
        recovery::complete_reconciliation(&self.db).await
    }
    async fn sigue_disponible(&self, _: bool) -> AppResult<bool> {
        Ok(false)
    }
    fn ritmo_de_subida(&self) -> Arc<RitmoDeSubida> {
        Arc::default()
    }
}

/// El socket: apunta lo que manda la Main y no le llega nada.
#[derive(Default)]
struct Socket {
    enviados: Vec<JsonValue>,
}

#[async_trait]
impl CanalReplicacion for Socket {
    async fn enviar(&mut self, m: JsonValue) -> AppResult<()> {
        self.enviados.push(m);
        Ok(())
    }
    async fn recibir(&mut self, _: Duration) -> AppResult<Option<JsonValue>> {
        Ok(None)
    }
}

// ── Ayudantes ─────────────────────────────────────────────────────────────────

fn dir_temporal() -> PathBuf {
    let sello = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir()
        .join("tpv_tests")
        .join(format!("aud19-nube-{}-{sello}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn escribir(db: &Db, sql: &str, args: Vec<Value>) {
    let w = db.write().await;
    w.raw().execute(sql, args).await.unwrap();
}

async fn texto(db: &Db, sql: &str) -> String {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<String>(0).unwrap()
}

async fn numero(db: &Db, sql: &str) -> i64 {
    let r = db.read().await;
    let mut filas = r.conn().query(sql, ()).await.unwrap();
    let fila = filas.next().await.unwrap().expect("una fila");
    fila.get::<i64>(0).unwrap()
}

/// La tabla `Usuarios` tal y como la vuelca la nube: columnas y filas posicionales.
async fn usuarios_como_la_nube(db: &Db) -> (Vec<String>, Vec<Vec<JsonValue>>) {
    let r = db.read().await;
    let mut cols = Vec::new();
    let mut filas = r.conn().query("PRAGMA table_info(\"Usuarios\");", ()).await.unwrap();
    while let Some(f) = filas.next().await.unwrap() {
        cols.push(f.get::<String>(1).unwrap());
    }
    let mut out = Vec::new();
    let mut filas = r.conn().query("SELECT * FROM Usuarios ORDER BY ID_Usuario;", ()).await.unwrap();
    while let Some(f) = filas.next().await.unwrap() {
        out.push((0..cols.len()).map(|i| valor_a_json(&f.get_value(i as i32).unwrap())).collect());
    }
    (cols, out)
}

/// Las sentencias del outbox que guarda una copia comprimida.
fn outbox_de_la_copia(copia: &Path, dir: &Path) -> Vec<String> {
    let base = dir.join("mirar-copia.db");
    let mut entrada = flate2::read::GzDecoder::new(std::fs::File::open(copia).unwrap());
    std::io::copy(&mut entrada, &mut std::fs::File::create(&base).unwrap()).unwrap();
    let conn = rusqlite::Connection::open(&base).unwrap();
    let mut st = conn.prepare("SELECT Statements_Json FROM _Sync_Outbox;").unwrap();
    st.query_map([], |f| f.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
}

async fn cerrar(db: Arc<Db>) {
    db.cerrar().await.unwrap();
    drop(db);
}

#[tokio::test]
async fn elegir_la_nube_tras_una_copia_anterior_al_log_no_sube_el_outbox_de_la_copia() {
    let dir = dir_temporal();
    let pin_viejo = hash_pin("1111").unwrap();
    let pin_nuevo = hash_pin("2222").unwrap();

    // 1) La copia: `u-baja` activo, administrador y con el PIN viejo; el cursor en 10; y en el
    //    outbox lo que puso ese PIN, que el equipo de entonces subió después.
    let db = init_main_db(&dir, Some("negocio-de-prueba")).await.unwrap();
    for (id, email, pin) in [("u-duena", "duena@bar.test", hash_pin("9999").unwrap()), ("u-baja", "baja@bar.test", pin_viejo.clone())] {
        escribir(
            &db,
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) VALUES (?1, ?2, ?3, ?4, 'Nombre', 'Activo');",
            vec![Value::Text(id.into()), Value::Text(ROL_ADMIN.into()), Value::Text(email.into()), Value::Text(pin)],
        )
        .await;
    }
    escribir(&db, "UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;", vec![]).await;
    let sentencias = json!([{
        "sql": "UPDATE Usuarios SET Password_Hash = ?1, ID_Rol = ?2, Estado = 'Activo' WHERE ID_Usuario = ?3;",
        "args": [pin_viejo, ROL_ADMIN, "u-baja"],
    }]);
    escribir(
        &db,
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-pin-viejo', 'trabajadores_update', ?1, 1);",
        vec![Value::Text(sentencias.to_string())],
    )
    .await;
    let copia = recovery::create_backup(&db, &dir).await.unwrap().expect("copia hecha");
    cerrar(db).await;

    // 2) Se pierde la base y se restaura la copia, como `recovery_restore_backup`.
    for f in ["data.db", "data.db-wal", "data.db-shm"] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    let vacia = init_main_db(&dir, Some("negocio-de-prueba")).await.unwrap();
    recovery::asegurar_reemplazo_seguro(&vacia).await.unwrap();
    let preparada = recovery::prepare_restore(&dir, &copia.id, Some("negocio-de-prueba")).await.unwrap();
    cerrar(vacia).await;
    recovery::install_prepared(&dir, &preparada).unwrap();
    let db = init_main_db(&dir, Some("negocio-de-prueba")).await.unwrap();
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);
    let repo = Arc::new(SqliteSyncRepository::new(db.clone()));
    let ctx = Ctx { db: db.clone(), repo: repo.clone() };

    // 3) La nube ya purgó hasta el 700: la reconciliación se para sin aplicar ni subir nada.
    let nube = Nube::default();
    *nube.cambios.lock().unwrap() = json!({
        "ok": true,
        "items": [{"opId": "op-701", "seq": 701, "statements": []}],
        "nextSince": 701, "highWater": 1700, "purgadoHasta": 700,
    });
    let mut socket = Socket::default();
    let e = replicacion::ejecutar(&ctx, &nube, &mut socket, true).await.unwrap_err();
    assert_eq!(e.to_string(), "Esta copia es anterior a lo que guarda la nube: recupera el estado actual de la nube.");
    assert!(socket.enviados.is_empty());
    assert_eq!(numero(&db, "SELECT Last_Seq FROM _Sync_State WHERE Id = 1;").await, 10);

    // 4) «Recuperar el estado actual de la nube»: en la nube, `u-baja` está de baja, es camarero y
    //    tiene el PIN nuevo.
    let (columnas, mut filas) = usuarios_como_la_nube(&db).await;
    let pos = |c: &str| columnas.iter().position(|x| x == c).unwrap();
    let baja = filas.iter_mut().find(|f| f[pos("ID_Usuario")] == json!("u-baja")).unwrap();
    baja[pos("Estado")] = json!("Inactivo");
    baja[pos("ID_Rol")] = json!(ROL_CAMARERO);
    baja[pos("Password_Hash")] = json!(pin_nuevo);
    *nube.volcado.lock().unwrap() = json!({
        "seq": 1700,
        "total_filas": filas.len(),
        "tablas": [{"nombre": "Usuarios", "columnas": columnas, "filas": filas, "parcial": false}],
        "backfill": [],
    });
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();

    // La copia queda guardada entera, con su outbox; la base nueva no lo tiene.
    let guardadas = std::fs::read_dir(dir.join("backups"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().unwrap().to_str().unwrap().starts_with("antes-de-la-nube-"))
        .collect::<Vec<_>>();
    assert_eq!(guardadas.len(), 1, "la copia sin reconciliar se guarda antes de traer la nube");
    assert_eq!(outbox_de_la_copia(&guardadas[0], &dir), vec![sentencias.to_string()]);
    assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);
    assert!(recovery::list_backups(&dir).unwrap().iter().all(|b| !b.id.starts_with("antes-de-la-nube-")), "no se ofrece como copia");

    // 5) La reconciliación termina sin subir nada: la baja se queda como la tiene la nube.
    *nube.cambios.lock().unwrap() = json!({"ok": true, "items": [], "nextSince": 1700, "highWater": 1700, "purgadoHasta": 700});
    let mut socket = Socket::default();
    replicacion::ejecutar(&ctx, &nube, &mut socket, true).await.unwrap();
    assert!(socket.enviados.iter().all(|m| m["type"] != "apply_lote"), "{:?}", socket.enviados);
    assert_eq!(socket.enviados.last().unwrap()["type"], "recovery_ready");
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::Ready);
    assert_eq!(texto(&db, "SELECT Estado FROM Usuarios WHERE ID_Usuario = 'u-baja';").await, "Inactivo");
    assert_eq!(texto(&db, "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario = 'u-baja';").await, pin_nuevo);

    drop(ctx);
    drop(repo);
    cerrar(db).await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// Con una Main nueva y un worker de antes de AUD-19, `/v1/sync/changes` no dice `purgadoHasta`. La
/// reconciliación que sigue a traer la nube también es modo recuperación y tampoco termina: el
/// worker se despliega antes que la Main.
#[tokio::test]
async fn tras_traer_la_nube_la_reconciliacion_tampoco_termina_contra_un_worker_sin_purgado_hasta() {
    let dir = dir_temporal();
    let db = init_main_db(&dir, Some("negocio-de-prueba")).await.unwrap();

    // Lo que tiene la nube: una administradora. Se toma con las columnas de esta versión y la base
    // se deja sin usuarios, como una que se ha perdido.
    escribir(
        &db,
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) VALUES ('u-duena', ?1, 'duena@bar.test', ?2, 'Marta', 'Activo');",
        vec![Value::Text(ROL_ADMIN.into()), Value::Text(hash_pin("9999").unwrap())],
    )
    .await;
    let (columnas, filas) = usuarios_como_la_nube(&db).await;
    escribir(&db, "DELETE FROM Usuarios;", vec![]).await;
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::DataMissing);

    let repo = Arc::new(SqliteSyncRepository::new(db.clone()));
    let ctx = Ctx { db: db.clone(), repo: repo.clone() };
    let nube = Nube::default();
    *nube.volcado.lock().unwrap() = json!({
        "seq": 50,
        "total_filas": filas.len(),
        "tablas": [{"nombre": "Usuarios", "columnas": columnas, "filas": filas, "parcial": false}],
        "backfill": [],
    });
    uc_sync::bootstrap_desde_nube(&nube, repo.as_ref()).await.unwrap();
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);

    // Un worker de antes: la respuesta no trae `purgadoHasta`.
    *nube.cambios.lock().unwrap() = json!({"ok": true, "items": [], "nextSince": 50, "highWater": 50});
    let mut socket = Socket::default();
    let e = replicacion::ejecutar(&ctx, &nube, &mut socket, true).await.unwrap_err();
    assert!(e.to_string().contains("no dice hasta dónde ha purgado"), "{e}");
    assert!(socket.enviados.is_empty());
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);

    // Con el worker actualizado, la misma reconciliación termina.
    *nube.cambios.lock().unwrap() = json!({"ok": true, "items": [], "nextSince": 50, "highWater": 50, "purgadoHasta": 0});
    replicacion::ejecutar(&ctx, &nube, &mut socket, true).await.unwrap();
    assert_eq!(recovery::status(&db).await.unwrap().state, RecoveryState::Ready);

    drop(ctx);
    drop(repo);
    cerrar(db).await;
    let _ = std::fs::remove_dir_all(&dir);
}
