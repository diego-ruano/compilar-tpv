//! Crate de librería `tpv_lib`: contiene TODA la app Tauri (AppState, comandos, `run()`). Es el
//! punto de entrada compartido: en escritorio el binario `main.rs` llama a `run()`; en **móvil** el
//! cdylib `libtpv_lib.so` arranca por el `#[tauri::mobile_entry_point]` de este mismo `run()`.

mod commands;
mod jobs;
mod printing;

use base64::prelude::*;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};
use tpv_infra_sqlite::db::Db;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use tpv_application::use_cases::pairing as uc_pairing;

use tpv_application::ports::licensing::PairingService;
use tpv_application::ports::{
    avisos::AvisosScanRepository,
    clientes::ClientesRepository, configuracion::ConfiguracionRepository,
    cuentas::CuentasRepository, inventario::InventarioRepository, jobs::JobsStateRepository,
    login::LoginRepository,
    mesas::MesasRepository,
    notificaciones::{NotificacionesRepository, Notifier},
    pedidos_proveedor::PedidoProveedorRepository,
    proveedores::ProveedoresRepository, reservas::ReservasRepository,
    stats::StatsRepository, sync::SyncRepository, tareas::TareasRepository,
    trabajadores::TrabajadoresRepository, venta_rapida::VentaRapidaRepository,
};
use tpv_infra_http::{
    clientes::HttpClientesRepository, configuracion::HttpConfiguracionRepository,
    cuentas::HttpCuentasRepository, inventario::HttpInventarioRepository,
    login::HttpLoginRepository, mesas::HttpMesasRepository,
    notificaciones::HttpNotificacionesRepository, proveedores::HttpProveedoresRepository,
    reservas::HttpReservasRepository, stats::HttpStatsRepository, tareas::HttpTareasRepository,
    trabajadores::HttpTrabajadoresRepository, venta_rapida::HttpVentaRapidaRepository, CloudClient,
    CLOUD_API_BASE,
};
use tpv_contracts::errors::{AppErrorDto, ErrorCode};
use tpv_infra_licensing::{LicensingAdapter, PairingAdapter};
use tpv_infra_sqlite::{
    avisos::SqliteAvisosScanRepository,
    clientes::SqliteClientesRepository, configuracion::SqliteConfiguracionRepository,
    cuentas::SqliteCuentasRepository, inventario::SqliteInventarioRepository,
    jobs::SqliteJobsStateRepository,
    login::SqliteLoginRepository, mesas::SqliteMesasRepository,
    notificaciones::SqliteNotificacionesRepository,
    pedidos_proveedor::SqlitePedidoProveedorRepository, proveedores::SqliteProveedoresRepository,
    reservas::SqliteReservasRepository, stats::SqliteStatsRepository, sync::SqliteSyncRepository,
    tareas::SqliteTareasRepository, trabajadores::SqliteTrabajadoresRepository,
    venta_rapida::SqliteVentaRapidaRepository,
};

// ──────────────────────────────────────────────────────────────────────────────
// Device mode (TPV / HANDY) + config persistente
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DeviceMode {
    Tpv,
    Handy,
}

/// Modo de funcionamiento de la Main respecto a la nube (ajuste explícito persistido).
/// `Offline`: solo SQLite local. `Online`: además abre WebSocket con el worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConnectivityMode {
    Offline,
    Online,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DeviceConfig {
    mode: Option<DeviceMode>,
    #[serde(default)]
    connectivity: Option<ConnectivityMode>,
    /// Impresora de tickets seleccionada en este dispositivo físico. Es una preferencia LOCAL
    /// (la impresora está conectada a esta máquina), por eso vive en `device_config.json` y no
    /// en la BD (que se sincroniza entre dispositivos).
    #[serde(default)]
    printer_name: Option<String>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
struct SetDeviceModeArgs {
    mode: DeviceMode,
}

#[derive(Debug, Clone, Deserialize)]
struct SetConnectionModeArgs {
    mode: ConnectivityMode,
}

#[derive(Debug, Clone, Deserialize)]
struct SaveImageArgs {
    subfolder: String,
    filename: String,
    base64_data: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DeleteImageArgs {
    /// Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`.
    rel_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct EnsureImageArgs {
    /// Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`.
    rel_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SetPrinterArgs {
    name: String,
}

/* =========================================================
   Helpers básicos
========================================================= */

fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("device_config.json")
}

fn load_config(app_data_dir: &Path) -> DeviceConfig {
    let p = config_path(app_data_dir);

    let Ok(txt) = fs::read_to_string(&p) else {
        return DeviceConfig::default();
    };

    serde_json::from_str::<DeviceConfig>(&txt).unwrap_or_default()
}

fn save_config(app_data_dir: &Path, cfg: &DeviceConfig) -> Result<(), String> {
    let p = config_path(app_data_dir);
    let tmp = p.with_extension("json.tmp");
    let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;

    fs::write(&tmp, &txt).map_err(|e| format!("Error escribiendo config tmp {:?}: {e}", tmp))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Error renombrando config {:?}: {e}", p))?;

    Ok(())
}

fn ensure_folders(app_data_dir: &Path) -> Result<(), String> {
    let folders = vec![
        app_data_dir.to_path_buf(),
        app_data_dir.join("images"),
        app_data_dir.join("images").join("categorias"),
        app_data_dir.join("images").join("productos"),
        app_data_dir.join("images").join("logo"),
    ];

    for f in folders {
        if !f.exists() {
            fs::create_dir_all(&f).map_err(|e| format!("Error creando carpeta {:?}: {e}", f))?;
        }
    }

    Ok(())
}

fn normalize_required(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();

    if out.is_empty() {
        return Err(format!("{field} required"));
    }

    Ok(out)
}

/* =========================================================
   Imágenes: procesado (resize + recompresión JPEG) + cola de subida a R2
========================================================= */

/// Lado máximo (px) al que se redimensiona la imagen antes de guardarla/subirla. Las fotos de
/// móviles modernos (varios MB / 4000px) se reducen a algo razonable para un catálogo de TPV.
const IMAGE_MAX_SIDE: u32 = 1024;
/// Calidad JPEG (0-100). 80 da buen equilibrio tamaño/calidad para fotos de producto.
const IMAGE_JPEG_QUALITY: u8 = 80;

/// Decodifica unos bytes de imagen (jpeg/png/webp), redimensiona si excede `IMAGE_MAX_SIDE`
/// (sólo reduce, nunca amplía, preservando proporción) y recodifica a JPEG optimizado.
/// Devuelve los bytes JPEG resultantes. Así una foto de 10 MB acaba en decenas de KB.
fn process_image(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img =
        image::load_from_memory(bytes).map_err(|e| format!("Imagen no válida: {e}"))?;

    let resized = if img.width() > IMAGE_MAX_SIDE || img.height() > IMAGE_MAX_SIDE {
        img.resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, FilterType::Lanczos3)
    } else {
        img
    };

    // A RGB8 (JPEG no soporta alfa) y codificación con control de calidad.
    let rgb = DynamicImage::ImageRgb8(resized.to_rgb8());
    let mut out = Cursor::new(Vec::new());
    rgb.write_with_encoder(JpegEncoder::new_with_quality(&mut out, IMAGE_JPEG_QUALITY))
        .map_err(|e| format!("Error codificando JPEG: {e}"))?;

    Ok(out.into_inner())
}

/// Una imagen pendiente de subir al bucket R2. `rel_path` es la ruta relativa idéntica a la de
/// BD (`images/{subcarpeta}/{archivo}`); los bytes se leen del disco en el momento de subir.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingImage {
    rel_path: String,
    content_type: String,
}

fn image_queue_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("image_uploads.json")
}

fn read_image_queue(app_data_dir: &Path) -> Vec<PendingImage> {
    let Ok(txt) = fs::read_to_string(image_queue_path(app_data_dir)) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<PendingImage>>(&txt).unwrap_or_default()
}

fn write_image_queue(app_data_dir: &Path, queue: &[PendingImage]) -> Result<(), String> {
    let p = image_queue_path(app_data_dir);
    let txt = serde_json::to_string_pretty(queue).map_err(|e| e.to_string())?;
    fs::write(&p, txt).map_err(|e| format!("Error escribiendo cola de imágenes {:?}: {e}", p))
}

/// Encola una imagen para subir (dedup por `rel_path`).
fn enqueue_image(app_data_dir: &Path, rel_path: &str, content_type: &str) -> Result<(), String> {
    let mut queue = read_image_queue(app_data_dir);
    if queue.iter().any(|q| q.rel_path == rel_path) {
        return Ok(());
    }
    queue.push(PendingImage {
        rel_path: rel_path.to_string(),
        content_type: content_type.to_string(),
    });
    write_image_queue(app_data_dir, &queue)
}

/// Valida que una ruta relativa de imagen tenga la forma esperada y no escape de `images/`
/// (evita borrar/leer ficheros arbitrarios desde el frontend).
fn is_safe_image_rel_path(rel: &str) -> bool {
    if rel.contains("..") || rel.contains('\\') {
        return false;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() != 3 || parts[0] != "images" {
        return false;
    }
    matches!(parts[1], "productos" | "categorias" | "proveedores" | "alergenos" | "logo")
        && !parts[2].is_empty()
}

fn content_type_for(rel_path: &str) -> &'static str {
    match rel_path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

/// Modo de firma ("tpv"|"handy") según el modo del dispositivo, o `None` si no hay modo.
fn signing_mode(mode: Option<DeviceMode>) -> Option<&'static str> {
    match mode {
        Some(DeviceMode::Tpv) => Some("tpv"),
        Some(DeviceMode::Handy) => Some("handy"),
        None => None,
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Telemetría: firmante de la subida a /v1/telemetry
// ──────────────────────────────────────────────────────────────────────────────

/// Firma device-proof los lotes de telemetría que el worker de `tpv-telemetry` sube a la nube.
/// Vive en el shell porque la cripto (`PairingAdapter`) está fuera de la crate de telemetría (que es
/// una HOJA, sin dependencias internas): el shell inyecta esta capacidad. Devuelve las cabeceras
/// firmadas (las mismas que usa el `CloudClient`), o `None` si el dispositivo aún no puede firmar
/// (sin modo/identidad/licencia) — en ese caso el worker retiene los lotes en disco y reintenta.
struct PairingTelemetrySigner {
    app_data_dir: PathBuf,
    /// Espejo síncrono del modo (el worker firma desde su propio hilo, sin contexto async).
    mode: Arc<std::sync::RwLock<Option<DeviceMode>>>,
}

impl tpv_telemetry::IngestSigner for PairingTelemetrySigner {
    fn sign(&self, method: &str, path: &str, body: &[u8]) -> Option<Vec<(String, String)>> {
        let mode = (*self.mode.read().ok()?)?;
        let mode_str = signing_mode(Some(mode))?;
        let pairing = PairingAdapter::new(self.app_data_dir.clone());
        let h = pairing
            .tpv_server_signed_headers(mode_str, method, path, body)
            .ok()?;
        Some(vec![
            ("authorization".to_string(), h.authorization),
            ("x-device-ts".to_string(), h.x_device_ts),
            ("x-device-sig".to_string(), h.x_device_sig),
        ])
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Estado global
// ──────────────────────────────────────────────────────────────────────────────

pub(crate) struct AppState {
    db: Arc<Mutex<Option<Arc<Db>>>>,
    cloud: Arc<Mutex<Option<Arc<CloudClient>>>>,
    mode: Arc<Mutex<Option<DeviceMode>>>,
    /// Espejo SÍNCRONO del modo para el firmante de telemetría (que corre en otro hilo sin async).
    /// Se mantiene en paralelo con `mode` en cada cambio de modo.
    mode_sync: Arc<std::sync::RwLock<Option<DeviceMode>>>,
}

/// Genera un accessor `<name>(&self) -> Arc<dyn $trait>` que devuelve el repositorio
/// adecuado al modo activo (el "puntero dinámico"): el adaptador SQLite local en modo TPV
/// o el adaptador HTTP a la nube en modo Handy. El comando que lo invoca no sabe contra qué
/// backend habla. Añadir un módulo = una línea más con su puerto/adaptadores.
macro_rules! repo_accessor {
    ($name:ident, $trait:path, $sqlite:ty, $http:ty) => {
        pub(crate) async fn $name(&self) -> Result<Arc<dyn $trait>, String> {
            match *self.mode.lock().await {
                Some(DeviceMode::Tpv) => {
                    let conn = self
                        .db
                        .lock()
                        .await
                        .as_ref()
                        .cloned()
                        .ok_or_else(|| "DB no inicializada (modo TPV)".to_string())?;
                    Ok(Arc::new(<$sqlite>::new(conn)) as Arc<dyn $trait>)
                }
                Some(DeviceMode::Handy) => {
                    let client = self
                        .cloud
                        .lock()
                        .await
                        .as_ref()
                        .cloned()
                        .ok_or_else(|| "Cliente nube no inicializado (modo Handy)".to_string())?;
                    Ok(Arc::new(<$http>::new(client)) as Arc<dyn $trait>)
                }
                None => Err("Modo de dispositivo no seleccionado".to_string()),
            }
        }
    };
}

impl AppState {
    repo_accessor!(
        clientes_repo,
        ClientesRepository,
        SqliteClientesRepository,
        HttpClientesRepository
    );
    repo_accessor!(
        configuracion_repo,
        ConfiguracionRepository,
        SqliteConfiguracionRepository,
        HttpConfiguracionRepository
    );
    repo_accessor!(
        cuentas_repo,
        CuentasRepository,
        SqliteCuentasRepository,
        HttpCuentasRepository
    );
    repo_accessor!(
        inventario_repo,
        InventarioRepository,
        SqliteInventarioRepository,
        HttpInventarioRepository
    );
    repo_accessor!(
        login_repo,
        LoginRepository,
        SqliteLoginRepository,
        HttpLoginRepository
    );
    repo_accessor!(
        mesas_repo,
        MesasRepository,
        SqliteMesasRepository,
        HttpMesasRepository
    );
    repo_accessor!(
        proveedores_repo,
        ProveedoresRepository,
        SqliteProveedoresRepository,
        HttpProveedoresRepository
    );
    repo_accessor!(
        reservas_repo,
        ReservasRepository,
        SqliteReservasRepository,
        HttpReservasRepository
    );
    repo_accessor!(
        stats_repo,
        StatsRepository,
        SqliteStatsRepository,
        HttpStatsRepository
    );
    repo_accessor!(
        tareas_repo,
        TareasRepository,
        SqliteTareasRepository,
        HttpTareasRepository
    );
    repo_accessor!(
        trabajadores_repo,
        TrabajadoresRepository,
        SqliteTrabajadoresRepository,
        HttpTrabajadoresRepository
    );
    repo_accessor!(
        venta_rapida_repo,
        VentaRapidaRepository,
        SqliteVentaRapidaRepository,
        HttpVentaRapidaRepository
    );
    repo_accessor!(
        notificaciones_repo,
        NotificacionesRepository,
        SqliteNotificacionesRepository,
        HttpNotificacionesRepository
    );
    // El puerto de emisión `Notifier` lo implementa el MISMO adaptador (SQLite en Main, HTTP en
    // Handy), así que también es mode-switched: en Handy `emitir` va por REST → DO → broadcast.
    repo_accessor!(
        notifier,
        Notifier,
        SqliteNotificacionesRepository,
        HttpNotificacionesRepository
    );

    /// Repositorio de sincronización (aplicar cambios de la nube en la BD local). NO es
    /// mode-switched: siempre es la Main (SQLite local) la que aplica lo recibido por el WS.
    pub(crate) async fn sync_repo(&self) -> Result<Arc<dyn SyncRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB no inicializada (sync requiere modo Main)".to_string())?;
        Ok(Arc::new(SqliteSyncRepository::new(conn)) as Arc<dyn SyncRepository>)
    }

    /// Pedidos a proveedores: Local-First, solo disponible en modo Main (SQLite).
    pub(crate) async fn pedidos_proveedor_repo(
        &self,
    ) -> Result<Arc<dyn PedidoProveedorRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB no inicializada (pedidos requieren modo Main)".to_string())?;
        Ok(Arc::new(SqlitePedidoProveedorRepository::new(conn)) as Arc<dyn PedidoProveedorRepository>)
    }

    /// ¿Es esta la Main (modo TPV) con la BD local ya abierta? Es la condición que exige
    /// `Requiere::MainConBd` del runner de jobs: antes de elegir modo, o en Handy, no hay nada que
    /// escanear ni dónde persistir.
    pub(crate) async fn es_main_con_bd(&self) -> bool {
        *self.mode.lock().await == Some(DeviceMode::Tpv) && self.db.lock().await.is_some()
    }

    /// Estado de los jobs periódicos (`_Jobs_State`). NO es mode-switched: es una tabla de control
    /// LOCAL del dispositivo, siempre SQLite, que no viaja a la nube.
    pub(crate) async fn jobs_state_repo(&self) -> Result<Arc<dyn JobsStateRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB no inicializada (jobs requieren modo Main)".to_string())?;
        Ok(Arc::new(SqliteJobsStateRepository::new(conn)) as Arc<dyn JobsStateRepository>)
    }

    /// Escáner de avisos (tareas vencidas / reservas próximas): solo Main (SQLite). En Handy no hay
    /// BD local → devuelve error y el job lo salta por su `Requiere`.
    pub(crate) async fn avisos_scan_repo(&self) -> Result<Arc<dyn AvisosScanRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "DB no inicializada (escáner de avisos requiere modo Main)".to_string())?;
        Ok(Arc::new(SqliteAvisosScanRepository::new(conn)) as Arc<dyn AvisosScanRepository>)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos: modo device + init main
// ──────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_device_mode(app: AppHandle) -> Result<Option<DeviceMode>, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let cfg = load_config(&app_data_dir);

    Ok(cfg.mode)
}

/// Lee el modo de funcionamiento (offline/online) persistido en `device_config.json`.
/// Si nunca se eligió, devuelve `None` (la UI asume `offline`).
#[tauri::command]
fn get_connection_mode(app: AppHandle) -> Result<Option<ConnectivityMode>, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(load_config(&app_data_dir).connectivity)
}

/// Persiste el modo de funcionamiento (offline/online) en `device_config.json`. La captura de
/// escrituras para el outbox está SIEMPRE activa (el outbox es el log de cambios local); este
/// modo solo decide si, ADEMÁS, el frontend abre el WebSocket para drenar/recibir de la nube.
#[tauri::command]
async fn set_connection_mode(
    app: AppHandle,
    args: SetConnectionModeArgs,
) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    // Activar la nube exige una licencia válida AHORA: forzamos una validación contra el worker
    // (no nos fiamos del estado cacheado). Si no es válida, no activamos online.
    if args.mode == ConnectivityMode::Online {
        let svc = LicensingAdapter::new(app_data_dir.clone());
        let gate = tpv_application::use_cases::licensing::check_now(&svc).await?;
        if !gate.allowed {
            // Código genérico a propósito: nadie ramifica por esto en la UI, sólo lo
            // muestra. El motivo concreto del gate viaja en el mensaje.
            return Err(AppErrorDto::new(
                ErrorCode::Conflict,
                format!("licencia_no_valida: {}", gate.reason),
            ));
        }
    }

    let mut cfg = load_config(&app_data_dir);
    cfg.connectivity = Some(args.mode);
    save_config(&app_data_dir, &cfg)?;

    Ok("OK".into())
}

#[tauri::command]
async fn set_device_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SetDeviceModeArgs,
) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    ensure_folders(&app_data_dir)?;

    let mut cfg = load_config(&app_data_dir);
    cfg.mode = Some(args.mode);

    save_config(&app_data_dir, &cfg)?;

    {
        let mut m = state.mode.lock().await;
        *m = Some(args.mode);
    }

    // Mantener el espejo síncrono + el contexto de telemetría al día con el modo elegido.
    if let Ok(mut ms) = state.mode_sync.write() {
        *ms = Some(args.mode);
    }
    let device_id = uc_pairing::device_identity(&PairingAdapter::new(app_data_dir.clone()))
        .map(|d| d.device_id)
        .unwrap_or_else(|_| "unknown".to_string());
    tpv_telemetry::set_device_context(
        device_id,
        signing_mode(Some(args.mode)).unwrap_or("unset"),
    );

    // En modo Handy preparamos el cliente HTTP a la nube (no hace red, sólo lo deja listo)
    // para que el cambio de modo sea efectivo sin reiniciar la app.
    if args.mode == DeviceMode::Handy {
        let mut c = state.cloud.lock().await;
        if c.is_none() {
            let client = CloudClient::new(CLOUD_API_BASE, app_data_dir.clone()).map_err(String::from)?;
            *c = Some(Arc::new(client));
        }
    }

    Ok("OK".into())
}

#[tauri::command]
async fn init_main(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppErrorDto> {
    let mode = *state.mode.lock().await;

    if mode != Some(DeviceMode::Tpv) {
        return Err("Este dispositivo no está en modo MAIN".into());
    }

    let mut guard = state.db.lock().await;

    if guard.is_some() {
        return Ok("OK".into());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    ensure_folders(&app_data_dir)?;

    // `init_main_db` devuelve el `Db` ya montado: escritor único serializado + pool de lectura
    // (WAL), tablas de control creadas y admin sembrado. La captura de escrituras al outbox está
    // SIEMPRE activa (también offline): el outbox es el log de cambios local; se drena a la nube
    // cuando el modo es "online".
    let db = tpv_infra_sqlite::connection::init_main_db(&app_data_dir)
        .await
        .map_err(String::from)?;

    // Drenado inmediato: cada escritura local que confirma en el outbox emite este evento; el
    // WS (useMainSocket) lo escucha y drena la nube al instante (sin esperar al poll de seguridad).
    {
        let h = app.clone();
        db.set_outbox_notifier(move || {
            let _ = h.emit("outbox:pending", ());
        });
    }

    // TRAB-01: al arrancar el modo Main, cerrar automáticamente las jornadas que quedaron abiertas
    // de días anteriores (alguien fichó entrada y olvidó la salida). Best-effort: no debe impedir el
    // arranque si falla. Se marcan como incidencia para revisión, sin inventar hora de salida.
    match tpv_infra_sqlite::login::auto_close_stale_punches(&db).await {
        Ok(n) if n > 0 => {
            tracing::info!(target: "tpv::fichajes", cerradas = n, "jornadas colgadas auto-cerradas al arrancar")
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(target: "tpv::fichajes", error = %e, "auto_close_stale_punches falló")
        }
    }

    *guard = Some(db);

    Ok("OK".into())
}

/// Reversibilidad: vuelve al menú de selección de modo. Persiste `mode = None`, suelta los
/// backends activos (BD local y cliente de nube) y, si el dispositivo estaba en Handy,
/// lo **desvincula** (borra el token Handy del keyring) para forzar un emparejamiento limpio
/// al re-elegir. Tras esto, `get_device_mode` devuelve `null` y la UI muestra de nuevo el
/// selector Main/Handy. La licencia local (modo Main) NO se toca: si se vuelve a elegir Main,
/// el gate de licencia sigue resolviéndose con el estado guardado.
#[tauri::command]
async fn device_reset_mode(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let was_handy = { *state.mode.lock().await == Some(DeviceMode::Handy) };

    // 1) Persistir mode = None.
    let mut cfg = load_config(&app_data_dir);
    cfg.mode = None;
    save_config(&app_data_dir, &cfg)?;

    // 2) Estado en memoria: sin modo y sin backends acoplados.
    {
        *state.mode.lock().await = None;
    }
    if let Ok(mut ms) = state.mode_sync.write() {
        *ms = None;
    }
    {
        *state.db.lock().await = None;
    }
    {
        *state.cloud.lock().await = None;
    }

    // 3) Si veníamos de Handy, desvincular (borrar token del keyring). Si no había token
    //    previo, ignoramos el error.
    if was_handy {
        let _ = PairingAdapter::new(app_data_dir).handy_clear_token();
    }

    Ok("OK".into())
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos genéricos
// ──────────────────────────────────────────────────────────────────────────────

/// Guarda una imagen en el disco local (AppData) y la **encola** para subir al bucket R2.
///
/// Antes de escribir, la imagen se **redimensiona y recomprime a JPEG** (ver `process_image`),
/// de modo que tanto la copia local como la del bucket pesen poco (fotos de móvil de varios MB
/// acaban en decenas de KB). El `filename` debe terminar en `.jpg` (lo fija el frontend).
///
/// La subida a R2 NO se hace aquí: se encola y la drena `images_drain_pending` cuando hay red
/// (el frontend lo dispara tras guardar y, en la Main online, también periódicamente). Esto
/// hace la subida resiliente a estar offline en el momento de crear la imagen.
#[tauri::command]
async fn save_image(app: AppHandle, args: SaveImageArgs) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo ruta AppData: {e}"))?;

    let subfolder = normalize_required(&args.subfolder, "subfolder")?;
    let filename = normalize_required(&args.filename, "filename")?;
    let base64_data = normalize_required(&args.base64_data, "base64_data")?;

    let dir_path = app_data_dir.join("images").join(&subfolder);

    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Error creando carpeta {:?}: {e}", dir_path))?;

    let raw_bytes = BASE64_STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Error al decodificar Base64: {e}"))?;

    // Redimensionar + recomprimir a JPEG (en un hilo bloqueante: es CPU-bound).
    let processed = tokio::task::spawn_blocking(move || process_image(&raw_bytes))
        .await
        .map_err(|e| format!("Error en el procesado de imagen: {e}"))??;

    let file_path = dir_path.join(&filename);
    fs::write(&file_path, processed)
        .map_err(|e| format!("Error escribiendo el archivo en {:?}: {e}", file_path))?;

    // Encolar la subida a R2 (la ruta relativa es idéntica a la que se guarda en BD).
    let rel_path = format!("images/{}/{}", subfolder, filename);
    let content_type = content_type_for(&rel_path);
    enqueue_image(&app_data_dir, &rel_path, content_type)?;

    Ok("Imagen guardada correctamente".to_string())
}

/// Drena la cola de imágenes pendientes: por cada entrada, lee el fichero del disco y lo sube
/// al bucket R2 (PUT firmado, según el modo del dispositivo). Las subidas confirmadas se quitan
/// de la cola; si una falla (típicamente offline), se conserva y se reintenta en la próxima
/// pasada. Es idempotente: subir dos veces la misma clave simplemente la sobrescribe.
///
/// Tiene dos disparadores, con papeles distintos: el **evento** (el frontend lo llama tras guardar
/// una imagen y al reconectar el WebSocket) cubre el caso fresco, y el **job `imagenes`** del
/// runner es la red de seguridad que recupera lo que quedó sin subir. La cola vive en un fichero
/// de AppData, no en la BD, así que también aplica a Handy.
pub(crate) async fn drenar_imagenes(
    app: &AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let Some(mode_str) = signing_mode(*state.mode.lock().await) else {
        return Ok("sin_modo".into());
    };

    let pending = read_image_queue(&app_data_dir);
    if pending.is_empty() {
        return Ok("vacio".into());
    }

    let svc = PairingAdapter::new(app_data_dir.clone());
    let mut remaining: Vec<PendingImage> = Vec::new();
    let mut failed = false;
    let mut subidas = 0u32;
    let mut ultimo_error: Option<String> = None;

    eprintln!("[image_drain] modo={mode_str} en_cola={}", pending.len());

    for item in &pending {
        eprintln!("[image_drain]   pendiente: {} ({})", item.rel_path, item.content_type);
    }

    for item in pending {
        if failed {
            remaining.push(item);
            continue;
        }

        let file_path = app_data_dir.join(&item.rel_path);
        let bytes = match fs::read(&file_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[image_drain] fichero no encontrado '{}': {e}", item.rel_path);
                continue;
            },
        };

        let path = format!("/v1/images/{}", item.rel_path);
        eprintln!("[image_drain] subiendo '{}' → PUT {}", item.rel_path, path);
        match uc_pairing::upload_image(&svc, mode_str, &path, &item.content_type, bytes).await {
            Ok(_) => {
                eprintln!("[image_drain] ✓ subida OK: {}", item.rel_path);
                subidas += 1;
            },
            Err(e) => {
                let msg = format!("{e:?}");
                eprintln!("[image_drain] ✗ FALLO '{}': {}", item.rel_path, msg);
                if ultimo_error.is_none() {
                    ultimo_error = Some(msg);
                }
                failed = true;
                remaining.push(item);
            }
        }
    }

    write_image_queue(&app_data_dir, &remaining)?;
    let resultado = match &ultimo_error {
        Some(err) => format!("subidas={subidas} pendientes={} error={err}", remaining.len()),
        None => format!("subidas={subidas} pendientes={}", remaining.len()),
    };
    eprintln!("[image_drain] resultado: {resultado}");
    if ultimo_error.is_some() {
        Err(resultado)
    } else {
        Ok(resultado)
    }
}

#[tauri::command]
async fn images_drain_pending(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppErrorDto> {
    drenar_imagenes(&app, &state).await.map_err(AppErrorDto::from)
}

/// Borra una imagen: del disco local y (best-effort) del bucket R2. Se usa al reemplazar la
/// imagen de un producto/categoría/proveedor para no dejar huérfanos ni servir caché obsoleta.
#[tauri::command]
async fn images_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    args: DeleteImageArgs,
) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let rel_path = normalize_required(&args.rel_path, "rel_path")?;
    if !is_safe_image_rel_path(&rel_path) {
        return Err("rel_path inválido".into());
    }

    // Borrado local (ignoramos si ya no existe).
    let _ = fs::remove_file(app_data_dir.join(&rel_path));

    // Borrado remoto (best-effort: si falla por estar offline, el huérfano es inocuo).
    if let Some(mode_str) = signing_mode(*state.mode.lock().await) {
        let svc = PairingAdapter::new(app_data_dir.clone());
        let path = format!("/v1/images/{}", rel_path);
        let _ = uc_pairing::delete_image(&svc, mode_str, &path).await;
    }

    Ok("OK".into())
}

/// Garantiza que la imagen `rel_path` exista en el disco local, bajándola de R2 si falta
/// (camino R2 → Main). La Main sirve las imágenes desde disco, pero las creadas en otra Handy
/// solo viven en R2: su fila llega por sync, pero el binario no. Este comando lo resuelve de
/// forma perezosa y auto-curativa: lo llama el frontend al resolver la URL de una imagen.
///
/// Devuelve `true` si tras la llamada el fichero está en local (ya estaba o se bajó), `false`
/// si no se pudo (sin modo, aún no está en R2, u offline). Nunca es un error "duro": el UI
/// degrada al placeholder y reintenta en la siguiente recarga.
#[tauri::command]
async fn images_ensure_local(
    app: AppHandle,
    state: State<'_, AppState>,
    args: EnsureImageArgs,
) -> Result<bool, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let rel_path = normalize_required(&args.rel_path, "rel_path")?;
    if !is_safe_image_rel_path(&rel_path) {
        return Err("rel_path inválido".into());
    }

    let file_path = app_data_dir.join(&rel_path);
    if file_path.exists() {
        return Ok(true);
    }

    let Some(mode_str) = signing_mode(*state.mode.lock().await) else {
        return Ok(false);
    };

    let svc = PairingAdapter::new(app_data_dir.clone());
    match uc_pairing::download_image(&svc, mode_str, &rel_path).await {
        Ok(Some(bytes)) => {
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Error creando carpeta {:?}: {e}", parent))?;
            }
            fs::write(&file_path, bytes)
                .map_err(|e| format!("Error escribiendo {:?}: {e}", file_path))?;
            Ok(true)
        }
        // Aún no está en R2 (404) o falló la red: no es un error duro, el UI reintentará.
        Ok(None) => Ok(false),
        Err(e) => {
            eprintln!("[images_ensure_local] fallo bajando '{}': {e:?}", rel_path);
            Ok(false)
        }
    }
}

/// Backfill único: encola todas las imágenes existentes en disco que aún no estén en el bucket.
/// Pensado para Mains que ya tenían imágenes antes de existir R2. Se protege con un marcador
/// para no re-escanear en cada arranque. La subida real la hace `images_drain_pending`.
#[tauri::command]
async fn images_backfill(app: AppHandle, state: State<'_, AppState>) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let marker = app_data_dir.join("image_backfill_done");
    if marker.exists() {
        return Ok("ya_hecho".into());
    }

    // Sólo la Main tiene imágenes locales pre-existentes; en Handy marcamos y salimos.
    let is_main = matches!(*state.mode.lock().await, Some(DeviceMode::Tpv));
    if !is_main {
        let _ = fs::write(&marker, b"handy");
        return Ok("no_aplica".into());
    }

    let mut encoladas = 0u32;
    for sub in ["productos", "categorias", "proveedores", "alergenos"] {
        let dir = app_data_dir.join("images").join(sub);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(String::from) else {
                continue;
            };
            let rel_path = format!("images/{}/{}", sub, name);
            if !is_safe_image_rel_path(&rel_path) {
                continue;
            }
            if enqueue_image(&app_data_dir, &rel_path, content_type_for(&rel_path)).is_ok() {
                encoladas += 1;
            }
        }
    }

    let _ = fs::write(&marker, b"done");
    Ok(format!("encoladas={encoladas}"))
}

#[tauri::command]
fn get_app_data_path(app: AppHandle) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo ruta AppData: {e}"))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos: impresión (host/Windows) — ver `printing.rs`
// ──────────────────────────────────────────────────────────────────────────────

fn app_data_dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/// Lista las impresoras visibles por el SO (locales + conexiones de red/WiFi). Se ejecuta en un
/// hilo bloqueante para no congelar el runtime async (la API de Windows es síncrona).
#[tauri::command]
async fn printer_list() -> Result<Vec<printing::PrinterInfo>, AppErrorDto> {
    tokio::task::spawn_blocking(printing::list_printers)
        .await
        .map_err(|e| AppErrorDto::internal(e.to_string()))?
        .map_err(AppErrorDto::from)
}

/// Devuelve la impresora seleccionada en este dispositivo (o `None`).
#[tauri::command]
fn printer_get_selected(app: AppHandle) -> Result<Option<String>, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    Ok(load_config(&dir).printer_name)
}

/// Persiste la impresora seleccionada en `device_config.json` (nombre vacío => deselecciona).
#[tauri::command]
fn printer_set_selected(app: AppHandle, args: SetPrinterArgs) -> Result<String, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    let mut cfg = load_config(&dir);
    let name = args.name.trim();
    cfg.printer_name = if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    };
    save_config(&dir, &cfg)?;
    Ok("OK".into())
}

/// Resuelve la impresora a usar: la del payload/args si viene, si no la seleccionada en config.
fn resolve_printer(app: &AppHandle, explicit: Option<String>) -> Result<String, String> {
    let chosen = explicit
        .filter(|s| !s.trim().is_empty())
        .or_else(|| load_config(&app_data_dir_of(app).ok()?).printer_name);
    chosen
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "No hay impresora seleccionada".to_string())
}

/// Imprime un ticket real construido en ESC/POS respetando la personalización del front.
#[tauri::command]
async fn printer_print_ticket(
    app: AppHandle,
    payload: printing::PrintTicketPayload,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(&app, payload.printer_name.clone())?;
    let bytes = printing::build_ticket(&payload);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Ticket TPV", &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("OK".into())
}

/// Imprime un ticket de prueba en la impresora indicada (o la seleccionada) para verificarla.
#[tauri::command]
async fn printer_print_test(
    app: AppHandle,
    args: Option<SetPrinterArgs>,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(&app, args.map(|a| a.name))?;
    let bytes = printing::build_test_ticket(&printer);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Prueba TPV", &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("OK".into())
}

// ──────────────────────────────────────────────────────────────────────────────
// Auto-actualización (updater)
// ──────────────────────────────────────────────────────────────────────────────
//
// La DETECCIÓN corre en Rust (este módulo), no en la UI: aunque el frontend falle a futuro,
// el chequeo de arranque sigue funcionando y emite `update:available`. La INSTALACIÓN la
// dispara el usuario (comando `updater_install`), nunca de forma automática: reiniciar un TPV
// en mitad de un servicio sería peor que esperar al cierre. El feed (qué versión se sirve, y
// el rollback) se controla desde `tpv-api` sin tocar el equipo del cliente.

/// Metadatos de una actualización disponible (lo que la UI necesita para avisar).
#[derive(Debug, Clone, Serialize)]
struct UpdateInfo {
    /// Versión nueva publicada en el feed (p. ej. "0.2.0").
    version: String,
    /// Versión actualmente instalada en este equipo.
    current_version: String,
    /// Notas de la versión (texto libre del feed), si las hay.
    notes: Option<String>,
}

/// Estado completo para la pantalla Configuración → Actualizaciones. A diferencia de
/// `updater_check`, NUNCA falla: quedarse sin internet o un feed caído se reportan en `error`, para
/// que la pantalla siga pudiendo pintar la versión instalada en vez de quedarse en blanco.
#[derive(Debug, Clone, Serialize)]
struct UpdateStatus {
    /// Versión instalada en este equipo (siempre disponible, haya feed o no).
    current_version: String,
    /// `false` en plataformas sin updater (móvil/Handy Android): la UI oculta los botones.
    supported: bool,
    /// Actualización pendiente de instalar, si la hay.
    update: Option<UpdateInfo>,
    /// Motivo por el que no se pudo comprobar (sin conexión, feed caído…).
    error: Option<String>,
}

/// Consulta el feed (`tpv-api`) y, si hay versión nueva, la **anuncia**: evento `update:available`
/// (banner) + notificación in-app a los administradores (campana + toast, con dedupe por versión).
/// Es el único sitio donde se avisa, así que da igual quién dispare el chequeo —tick periódico,
/// banner o botón de Configuración—: el aviso es siempre el mismo y no se duplica.
///
/// La comparación de versiones la hace el plugin de Tauri, que además verifica la firma del paquete
/// contra la clave pública embebida en `tauri.conf.json`.
#[cfg(desktop)]
async fn check_and_announce(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("updater no disponible: {e}"))?;

    let found = updater
        .check()
        .await
        .map_err(|e| format!("error comprobando actualización: {e}"))?;

    let Some(update) = found else {
        return Ok(None);
    };

    let info = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    };
    let _ = app.emit("update:available", info.clone());
    notify_update_available(app, &info.version).await;
    Ok(Some(info))
}

/// Comprueba el feed y devuelve los metadatos de la nueva versión, o `None` si ya está al día.
#[tauri::command]
async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfo>, AppErrorDto> {
    #[cfg(desktop)]
    {
        check_and_announce(&app).await.map_err(AppErrorDto::from)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("updater no disponible en esta plataforma".into())
    }
}

/// Estado para la pantalla de actualizaciones: versión instalada + resultado de comprobar el feed.
/// Comprueba de verdad (no devuelve nada cacheado), así que el botón "Buscar actualizaciones"
/// también dispara el aviso si aparece una versión nueva.
#[tauri::command]
async fn updater_status(app: AppHandle) -> Result<UpdateStatus, AppErrorDto> {
    let current_version = app.package_info().version.to_string();

    #[cfg(desktop)]
    {
        match check_and_announce(&app).await {
            Ok(update) => Ok(UpdateStatus {
                current_version,
                supported: true,
                update,
                error: None,
            }),
            Err(e) => Ok(UpdateStatus {
                current_version,
                supported: true,
                update: None,
                error: Some(e),
            }),
        }
    }
    #[cfg(not(desktop))]
    {
        Ok(UpdateStatus {
            current_version,
            supported: false,
            update: None,
            error: None,
        })
    }
}

/// Emite (best-effort) una notificación de actualización disponible a los administradores. Si no
/// hay notifier disponible aún (sin modo/BD), no hace nada.
#[cfg(desktop)]
async fn notify_update_available(app: &AppHandle, version: &str) {
    use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

    let state = app.state::<AppState>();
    if let Ok(notifier) = state.notifier().await {
        let _ = notifier
            .emitir(NuevaNotificacion {
                tipo: "actualizacion_disponible".to_string(),
                severidad: Severidad::Info,
                titulo: "Actualización disponible".to_string(),
                cuerpo: Some(format!("Versión {version} lista para instalar.")),
                destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                accion: Some("ver_actualizacion".to_string()),
                payload: None,
                clave_dedupe: Some(format!("actualizacion:{version}")),
                expira_en: None,
            })
            .await;
    }
}

/// Descarga, verifica e instala la última actualización y reinicia la app. Vuelve a comprobar el
/// feed antes de instalar (no se fía de un estado cacheado). Pensado para invocarse cuando el
/// usuario lo decida (p. ej. al cerrar caja), no en automático.
#[tauri::command]
async fn updater_install(app: AppHandle) -> Result<(), AppErrorDto> {
    #[cfg(desktop)]
    {
        let updater = app
            .updater()
            .map_err(|e| format!("updater no disponible: {e}"))?;

        let update = updater
            .check()
            .await
            .map_err(|e| format!("error comprobando actualización: {e}"))?
            .ok_or_else(|| "no hay actualización disponible".to_string())?;

        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| format!("error instalando actualización: {e}"))?;

        // En Windows el instalador cierra la app; `restart` reabre tras aplicar.
        app.restart();
        #[allow(unreachable_code)]
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("updater no disponible en esta plataforma".into())
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Builder (único) + registro de comandos
// ──────────────────────────────────────────────────────────────────────────────

/// Punto de entrada JNI del cdylib en Android: el runtime lo llama al cargar `libtpv_lib.so`,
/// pasándole la `JavaVM` del proceso. La guardamos (en `tpv-infra-licensing`) para que el almacén de
/// secretos (Android Keystore) pueda obtener un `JNIEnv` desde cualquier hilo — Tauri no inicializa
/// `ndk_context`. Debe vivir en el **cdylib** (esta crate) para que el símbolo `JNI_OnLoad` se exporte.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn JNI_OnLoad(
    vm: *mut std::os::raw::c_void,
    _reserved: *mut std::os::raw::c_void,
) -> i32 {
    tpv_infra_licensing::init_java_vm(vm);
    0x0001_0006 // JNI_VERSION_1_6
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Diagnóstico en Android: enruta las macros `log` a logcat (tag "TPVRust"). Solo dispositivo.
    #[cfg(target_os = "android")]
    android_logger::init_once(
        android_logger::Config::default()
            // Info (no Trace): la crate `jni` loguea CADA llamada a nivel Trace/Debug; a Trace eso
            // inunda logcat (miles de líneas) y ralentiza tanto la app que el sistema la mata.
            .with_max_level(log::LevelFilter::Info)
            .with_tag("TPVRust"),
    );
    log::warn!("[TPV] run() start");

    // Sentry primero: captura panics y crashes nativos desde el arranque. El DSN (público) se embebe
    // en el build vía `TPV_SENTRY_DSN`; si no está, el cliente queda DESHABILITADO (no-op) pero el
    // plugin se registra igualmente para que el Sentry de la Webview tenga transporte. El guard y el
    // de minidump deben vivir todo el proceso (por eso son locales de `run`, que bloquea en `.run()`).
    let sentry_guard = tpv_telemetry::init_sentry(tpv_telemetry::SentryConfig {
        dsn: option_env!("TPV_SENTRY_DSN").map(|s| s.to_string()),
        environment: if cfg!(debug_assertions) { "dev" } else { "prod" }.to_string(),
        release: Some(env!("CARGO_PKG_VERSION").to_string()),
    });
    // Minidumps (crashes nativos) sólo con DSN real, para no lanzar el proceso crash-handler en vano.
    // El minidump lanza un proceso helper de crashes nativos → solo escritorio. En Android/iOS los
    // crashes nativos los captura el SDK de Sentry por plataforma (Gradle), no este mecanismo.
    #[cfg(desktop)]
    let _minidump_guard =
        option_env!("TPV_SENTRY_DSN").map(|_| tauri_plugin_sentry::minidump::init(&sentry_guard));

    // En móvil el guard no se pasa a ningún plugin, pero debe seguir vivo todo el proceso para que
    // el cliente de Sentry (crate) capture panics de Rust. Lo marcamos como usado sin moverlo.
    #[cfg(not(desktop))]
    let _ = &sentry_guard;

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    // Sentry (bridge webview+core) es solo escritorio: el plugin arrastra el minidump (proceso
    // helper) y native-tls. En móvil el crate `sentry` (rustls) sigue capturando panics de Rust.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_sentry::init(&sentry_guard));

    // El updater es solo escritorio (el plugin no cross-compila a móvil).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let handle = app.handle();

            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("Error obteniendo AppData");

            ensure_folders(&app_data_dir).expect("Error creando carpetas");
            log::warn!("[TPV] setup: app_data_dir={:?}", app_data_dir);

            let cfg = load_config(&app_data_dir);
            let mode = cfg.mode;

            // Espejo SÍNCRONO del modo: lo lee el firmante de telemetría desde su propio hilo (sin
            // contexto async). Se comparte con el `AppState` para mantenerlo al día en cada cambio.
            let mode_sync = Arc::new(std::sync::RwLock::new(mode));

            // Telemetría: lo primero (tras resolver AppData), para capturar también los errores del
            // arranque. NUNCA tumba la app: si `init` falla, se avisa por stderr y se sigue sin
            // telemetría. Destinos: consola (dev) + fichero local 7 días + cola durable que un worker
            // en segundo plano sube a `/v1/telemetry` firmando device-proof (si aún no puede firmar,
            // retiene los lotes y reintenta). El shell aporta ruta de datos, versión y el firmante.
            {
                let version = handle.package_info().version.to_string();
                let signer: Arc<dyn tpv_telemetry::IngestSigner> =
                    Arc::new(PairingTelemetrySigner {
                        app_data_dir: app_data_dir.clone(),
                        mode: mode_sync.clone(),
                    });
                let mut tcfg =
                    tpv_telemetry::TelemetryConfig::local_only(app_data_dir.clone(), version);
                tcfg.ingest = tpv_telemetry::IngestConfig {
                    url: format!("{CLOUD_API_BASE}/v1/telemetry"),
                    path: "/v1/telemetry".to_string(),
                    enabled: true,
                    signer: Some(signer),
                };
                if let Err(e) = tpv_telemetry::init(tcfg) {
                    eprintln!("[telemetry] init falló (se continúa sin telemetría): {e}");
                }
                // Etiqueta el contexto de correlación cuanto antes con la identidad REAL del
                // dispositivo (id estable derivado de su clave, disponible desde el primer arranque).
                let device_id =
                    uc_pairing::device_identity(&PairingAdapter::new(app_data_dir.clone()))
                        .map(|d| d.device_id)
                        .unwrap_or_else(|_| "unknown".to_string());
                log::warn!("[TPV] setup: device_id={device_id}");
                tpv_telemetry::set_device_context(
                    device_id,
                    mode.and_then(|m| signing_mode(Some(m))).unwrap_or("unset"),
                );
                // Tenant (restaurante): en Handy se conoce desde el token; en Main el endpoint de
                // telemetría ya inyecta el tenant autenticado en la nube, así que aquí es best-effort.
                if let Ok(Some(tenant)) =
                    uc_pairing::handy_get_tenant(&PairingAdapter::new(app_data_dir.clone()))
                {
                    tpv_telemetry::set_tenant(tenant);
                }
                tracing::info!(
                    target: "tpv::startup",
                    version = %handle.package_info().version,
                    mode = ?mode,
                    "TPV iniciado"
                );
            }

            let db_opt: Option<Arc<Db>> = if mode == Some(DeviceMode::Tpv) {
                // `Db`: escritor único serializado + pool de lectura (WAL). La captura al outbox
                // está SIEMPRE activa (también offline); se drena en "online".
                let db = tauri::async_runtime::block_on(async {
                    tpv_infra_sqlite::connection::init_main_db(&app_data_dir)
                        .await
                        .expect("Error init_main_db")
                });
                // Drenado inmediato (ver init_main): el outbox avisa al WS al confirmar una escritura.
                let h = handle.clone();
                db.set_outbox_notifier(move || {
                    let _ = h.emit("outbox:pending", ());
                });
                Some(db)
            } else {
                None
            };

            // En modo Handy dejamos preparado el cliente HTTP a la nube (sin BD local).
            let cloud_opt: Option<Arc<CloudClient>> = if mode == Some(DeviceMode::Handy) {
                Some(Arc::new(
                    CloudClient::new(CLOUD_API_BASE, app_data_dir.clone())
                        .expect("Error creando CloudClient"),
                ))
            } else {
                None
            };

            app.manage(AppState {
                db: Arc::new(Mutex::new(db_opt)),
                cloud: Arc::new(Mutex::new(cloud_opt)),
                mode: Arc::new(Mutex::new(mode)),
                mode_sync,
            });

            // Tareas periódicas de fondo (licencia, avisos, actualizaciones): las declara
            // `jobs/registro.rs` y las corre el runner con una política común —vencimiento en reloj
            // de pared, jitter, backoff y gating por modo—. Va DESPUÉS de `app.manage` porque los
            // cuerpos resuelven sus repositorios desde el `AppState`.
            jobs::arrancar(handle);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // device
            get_device_mode,
            set_device_mode,
            get_connection_mode,
            set_connection_mode,
            init_main,
            device_reset_mode,
            // genéricos
            save_image,
            images_drain_pending,
            images_delete,
            images_ensure_local,
            images_backfill,
            get_app_data_path,
            // auto-actualización (updater)
            updater_check,
            updater_status,
            updater_install,
            // impresión (host/Windows — printing.rs)
            printer_list,
            printer_get_selected,
            printer_set_selected,
            printer_print_ticket,
            printer_print_test,
            // auth / login
            commands::login::list_login_users,
            commands::login::login_user,
            commands::login::hash_password,
            commands::login::get_today_punch_status,
            commands::login::punch,
            commands::login::complete_initial_setup,
            commands::login::set_turno_partido_hoy,
            // mesass
            commands::mesas::save_layout,
            commands::mesas::load_layout,
            commands::mesas::get_mesas_ocupadas,
            commands::mesas::set_reserva_estado,
            commands::mesas::get_comanda_abierta_by_mesa,
            commands::mesas::abrir_comanda,
            commands::mesas::comanda_set_trabajador_if_null,
            commands::mesas::cerrar_comanda,
            commands::mesas::get_lineas_comanda,
            commands::mesas::add_linea_comanda,
            commands::mesas::get_or_create_comanda_barra,
            commands::mesas::cobrar_venta_rapida,
            commands::mesas::create_comanda_barra,
            commands::mesas::list_comandas_barra,
            commands::mesas::delete_comanda_barra_if_safe,
            commands::mesas::mesas_meta_all,
            commands::mesas::list_categorias_vendibles,
            commands::mesas::list_productos_by_categoria,
            commands::mesas::search_productos_by_nombre,
            commands::mesas::remove_one_pending_detalle,
            commands::mesas::delete_detalle,
            commands::mesas::update_detalle_nota,
            commands::mesas::cobrar_detalles,
            commands::mesas::kitchen_list_today_pending,
            commands::mesas::kitchen_set_line_state,
            // inventario (migrado a arquitectura hexagonal — commands/inventario.rs)
            commands::inventario::inventario_list_categorias,
            commands::inventario::inventario_create_categoria,
            commands::inventario::inventario_list_proveedores_mini,
            commands::inventario::inventario_list_productos_by_categoria,
            commands::inventario::inventario_get_resumen,
            commands::inventario::inventario_list_alergenos,
            commands::inventario::inventario_get_alergenos_producto,
            commands::inventario::inventario_set_alergenos_producto,
            commands::inventario::inventario_get_producto,
            commands::inventario::inventario_get_product_detail,
            commands::inventario::inventario_get_producto_detalle,
            commands::inventario::inventario_delete_producto,
            commands::inventario::inventario_upsert_producto,
            commands::inventario::inventario_list_lotes_by_producto,
            commands::inventario::inventario_create_lote,
            commands::inventario::inventario_update_lote,
            commands::inventario::inventario_ajustar_lote,
            // tareas
            commands::tareas::tareas_get_trabajadores,
            commands::tareas::tareas_create_tarea,
            commands::tareas::tareas_get_tareas_admin,
            commands::tareas::tareas_get_tarea_by_id,
            commands::tareas::tareas_update_tarea,
            commands::tareas::tareas_get_tarea_asignados,
            commands::tareas::tareas_set_asignaciones_tarea,
            commands::tareas::tareas_delete_tarea,
            commands::tareas::tareas_get_mis_tareas,
            commands::tareas::tareas_marcar_tarea_finalizada,
            // trabajadores
            commands::trabajadores::trabajadores_get_roles,
            commands::trabajadores::trabajadores_get_all,
            commands::trabajadores::trabajadores_get_detail,
            commands::trabajadores::trabajadores_get_trabajador_id_by_usuario,
            commands::trabajadores::trabajadores_create,
            commands::trabajadores::trabajadores_update,
            commands::trabajadores::turnos_get_all,
            commands::trabajadores::horarios_get_asignaciones_semana,
            commands::trabajadores::horarios_create_asignacion,
            commands::trabajadores::horarios_update_asignacion,
            commands::trabajadores::horarios_delete_asignacion,
            commands::trabajadores::horarios_copy_semana_asignaciones,
            commands::trabajadores::horarios_set_predeterminado_desde_semana,
            // cuentas (migrado a arquitectura hexagonal — commands/cuentas.rs)
            commands::cuentas::cuentas_get_entradas,
            commands::cuentas::cuentas_get_salidas,
            commands::cuentas::cuentas_get_resumen,
            commands::cuentas::cuentas_create_gasto,
            commands::cuentas::cuentas_update_gasto,
            commands::cuentas::cuentas_delete_gasto,
            commands::cuentas::cuentas_update_pago,
            commands::cuentas::cuentas_delete_pago,
            // clientes (migrado a arquitectura hexagonal — commands/clientes.rs)
            commands::clientes::clientes_get_overview,
            commands::clientes::clientes_get_cliente_form,
            commands::clientes::clientes_create_cliente,
            commands::clientes::clientes_update_cliente,
            // reservas (migrado a arquitectura hexagonal — commands/reservas.rs)
            commands::reservas::reservas_get_meta,
            commands::reservas::reservas_get_mes,
            commands::reservas::reservas_save,
            commands::reservas::reservas_delete,
            // proveedores (migrado a arquitectura hexagonal — commands/proveedores.rs)
            commands::proveedores::proveedores_get_all,
            commands::proveedores::proveedores_save,
            commands::proveedores::proveedores_delete,
            commands::proveedores::proveedores_get_productos,
            commands::proveedores::proveedores_get_categorias,
            commands::proveedores::proveedores_get_productos_all,
            commands::proveedores::proveedores_set_vinculos,
            commands::proveedores::proveedores_create_producto,
            // pedidos a proveedores (Local-First, modo Main)
            commands::pedidos_proveedor::pedidos_proveedor_get_page,
            commands::pedidos_proveedor::pedidos_proveedor_crear,
            commands::pedidos_proveedor::pedidos_proveedor_actualizar,
            commands::pedidos_proveedor::pedidos_proveedor_cambiar_estado,
            // notificaciones (Local-First, modo Main)
            commands::notificaciones::notificaciones_listar,
            commands::notificaciones::notificaciones_no_leidas,
            commands::notificaciones::notificaciones_marcar_leida,
            commands::notificaciones::notificaciones_marcar_todas_leidas,
            commands::notificaciones::notificaciones_crear,
            // venta rápida
            commands::venta_rapida::vr_list_categorias_vendibles,
            commands::venta_rapida::vr_list_productos_by_categoria,
            commands::venta_rapida::vr_search_productos,
            commands::venta_rapida::vr_create_comanda_barra,
            commands::venta_rapida::vr_list_comandas_barra,
            commands::venta_rapida::vr_get_lineas_comanda,
            commands::venta_rapida::vr_add_linea_comanda,
            commands::venta_rapida::vr_remove_last_unpaid_linea,
            commands::venta_rapida::vr_delete_linea_if_unpaid,
            commands::venta_rapida::vr_update_nota_detalle,
            commands::venta_rapida::vr_cobrar_fraccionado,
            commands::venta_rapida::vr_restar_stock,
            commands::venta_rapida::vr_delete_comanda_if_safe,
            commands::venta_rapida::vr_get_index_rows,
            commands::venta_rapida::vr_get_detalles_ver_ticket,
            // stats
            commands::stats::stats_mesas_get,
            commands::stats::stats_productos_list_categorias,
            commands::stats::stats_productos_resumen,
            commands::stats::stats_reservas_resumen,
            commands::stats::stats_trabajadores_resumen,
            commands::stats::stats_clientes_resumen,
            commands::stats::stats_proveedores_resumen,
            // licensing (migrado a arquitectura hexagonal — commands/licensing.rs)
            commands::licensing::license_get_state,
            commands::licensing::license_activate,
            commands::licensing::license_request_device_change,
            commands::licensing::license_clear_state,
            commands::licensing::license_gate,
            commands::licensing::license_check_now,
            // pairing (migrado a arquitectura hexagonal — commands/pairing.rs)
            commands::pairing::tpv_server_signed_headers,
            commands::pairing::handy_set_token,
            commands::pairing::handy_clear_token,
            commands::pairing::handy_get_tenant,
            commands::pairing::handy_get_ws_auth,
            commands::pairing::device_get_identity,
            commands::pairing::device_sign_b64,
            commands::pairing::tpv_server_post_json,
            commands::pairing::pair_create,
            commands::pairing::config_upload_initial_setup,
            // sincronización nube → Main (aplicar cambios recibidos por WebSocket / catch-up)
            commands::sync::sync_apply_changes,
            commands::sync::sync_get_checkpoint,
            // sincronización Main → nube (outbox de escrituras locales)
            commands::sync::sync_outbox_pending,
            commands::sync::sync_outbox_mark_sent,
            commands::sync::sync_purge_applied_ops,
            commands::sync::sync_health,
            // tareas periódicas de fondo (runner de jobs)
            commands::jobs::jobs_status,
            // configuración (migrado a arquitectura hexagonal — commands/configuracion.rs)
            commands::configuracion::config_get_business_settings,
            commands::configuracion::config_patch_business_settings,
            commands::configuracion::config_get_ticket_settings,
            commands::configuracion::config_patch_ticket_settings,
            commands::configuracion::config_get_contact_settings,
            commands::configuracion::config_patch_contact_settings,
            // correo electrónico (envío vía worker; ya no hay config SMTP local — DB-04)
            commands::email_config::email_enviar_pedido,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
