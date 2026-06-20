// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod printing;

use base64::prelude::*;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};
use tpv_infra_sqlite::db::Db;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use tpv_application::use_cases::pairing as uc_pairing;

use tpv_application::ports::licensing::PairingService;
use tpv_application::ports::{
    clientes::ClientesRepository, configuracion::ConfiguracionRepository,
    cuentas::CuentasRepository, inventario::InventarioRepository, login::LoginRepository,
    mesas::MesasRepository, proveedores::ProveedoresRepository, reservas::ReservasRepository,
    stats::StatsRepository, sync::SyncRepository, tareas::TareasRepository,
    trabajadores::TrabajadoresRepository, venta_rapida::VentaRapidaRepository,
};
use tpv_infra_http::{
    clientes::HttpClientesRepository, configuracion::HttpConfiguracionRepository,
    cuentas::HttpCuentasRepository, inventario::HttpInventarioRepository,
    login::HttpLoginRepository, mesas::HttpMesasRepository, proveedores::HttpProveedoresRepository,
    reservas::HttpReservasRepository, stats::HttpStatsRepository, tareas::HttpTareasRepository,
    trabajadores::HttpTrabajadoresRepository, venta_rapida::HttpVentaRapidaRepository, CloudClient,
    CLOUD_API_BASE,
};
use tpv_infra_licensing::{LicensingAdapter, PairingAdapter};
use tpv_infra_sqlite::{
    clientes::SqliteClientesRepository, configuracion::SqliteConfiguracionRepository,
    cuentas::SqliteCuentasRepository, inventario::SqliteInventarioRepository,
    login::SqliteLoginRepository, mesas::SqliteMesasRepository,
    proveedores::SqliteProveedoresRepository, reservas::SqliteReservasRepository,
    stats::SqliteStatsRepository, sync::SqliteSyncRepository, tareas::SqliteTareasRepository,
    trabajadores::SqliteTrabajadoresRepository, venta_rapida::SqliteVentaRapidaRepository,
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
    let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;

    fs::write(&p, txt).map_err(|e| format!("Error escribiendo config {:?}: {e}", p))?;

    Ok(())
}

fn ensure_folders(app_data_dir: &Path) -> Result<(), String> {
    let folders = vec![
        app_data_dir.to_path_buf(),
        app_data_dir.join("images"),
        app_data_dir.join("images").join("categorias"),
        app_data_dir.join("images").join("productos"),
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
    matches!(parts[1], "productos" | "categorias" | "proveedores" | "alergenos")
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
// Estado global
// ──────────────────────────────────────────────────────────────────────────────

pub(crate) struct AppState {
    db: Arc<Mutex<Option<Arc<Db>>>>,
    cloud: Arc<Mutex<Option<Arc<CloudClient>>>>,
    mode: Arc<Mutex<Option<DeviceMode>>>,
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
        // El aplicador aplica los cambios remotos sobre la conexión de escritura exclusiva del
        // `Db` (serializado con los repos, sin re-capturar en el outbox).
        Ok(Arc::new(SqliteSyncRepository::new(conn)) as Arc<dyn SyncRepository>)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos: modo device + init main
// ──────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_device_mode(app: AppHandle) -> Result<Option<DeviceMode>, String> {
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
fn get_connection_mode(app: AppHandle) -> Result<Option<ConnectivityMode>, String> {
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
) -> Result<String, String> {
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
            return Err(format!("licencia_no_valida: {}", gate.reason));
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
) -> Result<String, String> {
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
async fn init_main(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mode = *state.mode.lock().await;

    if mode != Some(DeviceMode::Tpv) {
        return Err("Este dispositivo no está en modo MAIN".into());
    }

    {
        let guard = state.db.lock().await;

        if guard.is_some() {
            return Ok("OK".into());
        }
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
    let db = tpv_infra_sqlite::connection::init_main_db(
        &app_data_dir,
        include_str!("../../../../packages/database/schema.sql"),
    )
    .await
    .map_err(String::from)?;

    let mut guard = state.db.lock().await;
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
async fn device_reset_mode(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
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
async fn save_image(app: AppHandle, args: SaveImageArgs) -> Result<String, String> {
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
#[tauri::command]
async fn images_drain_pending(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
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
    Ok(resultado)
}

/// Borra una imagen: del disco local y (best-effort) del bucket R2. Se usa al reemplazar la
/// imagen de un producto/categoría/proveedor para no dejar huérfanos ni servir caché obsoleta.
#[tauri::command]
async fn images_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    args: DeleteImageArgs,
) -> Result<String, String> {
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

/// Backfill único: encola todas las imágenes existentes en disco que aún no estén en el bucket.
/// Pensado para Mains que ya tenían imágenes antes de existir R2. Se protege con un marcador
/// para no re-escanear en cada arranque. La subida real la hace `images_drain_pending`.
#[tauri::command]
async fn images_backfill(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
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
fn get_app_data_path(app: AppHandle) -> Result<String, String> {
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
async fn printer_list() -> Result<Vec<printing::PrinterInfo>, String> {
    tokio::task::spawn_blocking(printing::list_printers)
        .await
        .map_err(|e| e.to_string())?
}

/// Devuelve la impresora seleccionada en este dispositivo (o `None`).
#[tauri::command]
fn printer_get_selected(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app_data_dir_of(&app)?;
    Ok(load_config(&dir).printer_name)
}

/// Persiste la impresora seleccionada en `device_config.json` (nombre vacío => deselecciona).
#[tauri::command]
fn printer_set_selected(app: AppHandle, args: SetPrinterArgs) -> Result<String, String> {
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
) -> Result<String, String> {
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
) -> Result<String, String> {
    let printer = resolve_printer(&app, args.map(|a| a.name))?;
    let bytes = printing::build_test_ticket(&printer);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Prueba TPV", &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("OK".into())
}

// ──────────────────────────────────────────────────────────────────────────────
// Builder (único) + registro de comandos
// ──────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();

            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("Error obteniendo AppData");

            ensure_folders(&app_data_dir).expect("Error creando carpetas");

            let cfg = load_config(&app_data_dir);
            let mode = cfg.mode;

            let db_opt: Option<Arc<Db>> = if mode == Some(DeviceMode::Tpv) {
                // `Db`: escritor único serializado + pool de lectura (WAL). La captura al outbox
                // está SIEMPRE activa (también offline); se drena en "online".
                let db = tauri::async_runtime::block_on(async {
                    tpv_infra_sqlite::connection::init_main_db(
                        &app_data_dir,
                        include_str!("../../../../packages/database/schema.sql"),
                    )
                    .await
                    .expect("Error init_main_db")
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
            });

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
            images_backfill,
            get_app_data_path,
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
            commands::mesas::get_or_create_mesa_barra,
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
            commands::licensing::license_clear_state,
            commands::licensing::license_gate,
            commands::licensing::license_check_now,
            // pairing (migrado a arquitectura hexagonal — commands/pairing.rs)
            commands::pairing::tpv_server_signed_headers,
            commands::pairing::license_read_state_for_ui,
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
            // configuración (migrado a arquitectura hexagonal — commands/configuracion.rs)
            commands::configuracion::config_get_business_settings,
            commands::configuracion::config_patch_business_settings,
            commands::configuracion::config_get_ticket_settings,
            commands::configuracion::config_patch_ticket_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}