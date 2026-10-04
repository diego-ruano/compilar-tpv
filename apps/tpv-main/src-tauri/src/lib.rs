//! Crate de librería `tpv_lib`: contiene TODA la app Tauri (AppState, comandos, `run()`). Es el
//! punto de entrada compartido: en escritorio el binario `main.rs` llama a `run()`; en **móvil** el
//! cdylib `libtpv_lib.so` arranca por el `#[tauri::mobile_entry_point]` de este mismo `run()`.

mod commands;
mod interruptores;
mod jobs;
mod printing;

use base64::prelude::*;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use tpv_infra_sqlite::db::Db;

use tpv_application::use_cases::pairing as uc_pairing;

use tpv_application::ports::licensing::PairingService;
use tpv_application::ports::{
    avisos::AvisosScanRepository,
    cierre_caja::CierreCajaRepository,
    clientes::ClientesRepository,
    configuracion::ConfiguracionRepository,
    cuentas::CuentasRepository,
    inventario::InventarioRepository,
    jobs::JobsStateRepository,
    login::LoginRepository,
    mesas::MesasRepository,
    notificaciones::{NotificacionesRepository, Notifier},
    pedidos_proveedor::PedidoProveedorRepository,
    proveedores::ProveedoresRepository,
    reconciliacion::ReconciliacionRepository,
    reservas::ReservasRepository,
    stats::StatsRepository,
    stock_alertas::StockAlertasRepository,
    sync::SyncRepository,
    tareas::TareasRepository,
    tickets::TicketsRepository,
    trabajadores::TrabajadoresRepository,
    venta_rapida::VentaRapidaRepository,
    verifactu::VerifactuRepository,
};
use tpv_contracts::errors::AppErrorDto;
use tpv_infra_http::{
    cierre_caja::HttpCierreCajaRepository, clientes::HttpClientesRepository,
    configuracion::HttpConfiguracionRepository, cuentas::HttpCuentasRepository,
    inventario::HttpInventarioRepository, login::HttpLoginRepository, mesas::HttpMesasRepository,
    notificaciones::HttpNotificacionesRepository, proveedores::HttpProveedoresRepository,
    reservas::HttpReservasRepository, stats::HttpStatsRepository, tareas::HttpTareasRepository,
    trabajadores::HttpTrabajadoresRepository, venta_rapida::HttpVentaRapidaRepository, CloudClient,
    CLOUD_API_BASE,
};
use tpv_infra_licensing::{LicensingAdapter, PairingAdapter};
use tpv_infra_sqlite::{
    avisos::SqliteAvisosScanRepository, cierre_caja::SqliteCierreCajaRepository,
    clientes::SqliteClientesRepository, configuracion::SqliteConfiguracionRepository,
    cuentas::SqliteCuentasRepository, inventario::SqliteInventarioRepository,
    jobs::SqliteJobsStateRepository, login::SqliteLoginRepository, mesas::SqliteMesasRepository,
    notificaciones::SqliteNotificacionesRepository,
    pedidos_proveedor::SqlitePedidoProveedorRepository, proveedores::SqliteProveedoresRepository,
    reconciliacion::SqliteReconciliacionRepository, reservas::SqliteReservasRepository,
    stats::SqliteStatsRepository, stock_alertas::SqliteStockAlertasRepository,
    sync::SqliteSyncRepository, tareas::SqliteTareasRepository,
    tickets::SqliteTicketsRepository, trabajadores::SqliteTrabajadoresRepository, venta_rapida::SqliteVentaRapidaRepository,
    verifactu::SqliteVerifactuRepository,
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

/// SYNC-17: qué hace la Main respecto a la nube. **Ya no es una elección del usuario**: la
/// conectividad es un estado derivado del WebSocket (se intenta siempre y el badge refleja lo que
/// hay). Esto es solo la palanca de emergencia, sin UI, para el caso patológico —una red que tira
/// el socket en bucle, o alguien que no quiere sus datos en la nube—: se toca a mano en
/// `device_config.json` o desde `set_connection_mode`.
///
/// `Auto` (por defecto, y lo que se asume si el campo falta): intentar conectar siempre.
/// `Off`: no abrir el WebSocket. La Main sigue siendo Local-First y el outbox sigue capturando,
/// así que al volver a `Auto` se drena lo acumulado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ConnectivityMode {
    Auto,
    Off,
}

/// Lectura tolerante del campo: los `device_config.json` anteriores a SYNC-17 guardan
/// `"offline"`/`"online"` (el ajuste que se ha eliminado). Un valor desconocido tiene que caer a
/// `None` —o sea, `Auto`— y NO reventar el parseo: `load_config` hace `unwrap_or_default()`, así
/// que un error aquí se llevaría por delante también `mode` y `printer_name` (el dispositivo
/// olvidaría que es la Main). Que `"offline"` pase a `Auto` es justo lo que queremos: el ajuste
/// desaparece y todo el mundo conecta solo.
fn connectivity_tolerante<'de, D>(d: D) -> Result<Option<ConnectivityMode>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let crudo = Option::<String>::deserialize(d).unwrap_or(None);
    Ok(match crudo.as_deref() {
        Some("off") => Some(ConnectivityMode::Off),
        Some("auto") => Some(ConnectivityMode::Auto),
        _ => None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DeviceConfig {
    mode: Option<DeviceMode>,
    #[serde(default, deserialize_with = "connectivity_tolerante")]
    connectivity: Option<ConnectivityMode>,
    /// Impresora de tickets seleccionada en este dispositivo físico. Es una preferencia LOCAL
    /// (la impresora está conectada a esta máquina), por eso vive en `device_config.json` y no
    /// en la BD (que se sincroniza entre dispositivos).
    ///
    /// Se conserva como el destino "caja" y sigue leyéndose para no perder la selección de quien
    /// ya la tenía puesta; lo nuevo va en `printers`.
    #[serde(default)]
    printer_name: Option<String>,
    /// Impresora por DESTINO (`caja`, `cocina`, …). Hoy solo se usa `caja`; `cocina` está
    /// declarado para que añadir la comanda de cocina no obligue a rehacer el modelo ni a migrar
    /// la configuración de nadie. Una entrada ausente = ese destino no tiene impresora.
    #[serde(default)]
    printers: std::collections::HashMap<String, String>,
    /// FISCAL-01: **huella digital** del certificado elegido para remitir a la AEAT.
    ///
    /// Vive aquí y no en la BD por la misma razón que la impresora: el certificado está instalado
    /// en ESTA máquina, y replicarlo a la nube y a las Handy sería anunciar una elección que allí
    /// no significa nada.
    ///
    /// **Es lo único que se guarda del certificado, y no es un secreto**: la huella lo identifica
    /// pero no lo abre. La clave privada no sale nunca del almacén de Windows — quien firma el
    /// handshake es Windows. Por eso el certificado ni siquiera toca el `secret_store`: un secreto
    /// menos que proteger es un secreto menos que filtrar.
    #[serde(default)]
    verifactu_cert: Option<String>,
}

/// Guarda (o borra) la huella del certificado con el que se remite a la AEAT.
///
/// Sólo la huella: la clave privada no sale nunca del almacén de Windows, y la huella no es un
/// secreto — identifica al certificado pero no lo abre.
pub(crate) fn set_certificado_verifactu(
    app_data_dir: &Path,
    huella: Option<String>,
) -> Result<(), String> {
    let mut cfg = load_config(app_data_dir);
    cfg.verifactu_cert = huella;
    save_config(app_data_dir, &cfg)
}

/// La huella del certificado elegido para remitir a la AEAT, o `None`.
pub(crate) fn certificado_verifactu(app_data_dir: &Path) -> Option<String> {
    load_config(app_data_dir)
        .verifactu_cert
        .map(|s| s.trim().to_uppercase().replace([' ', ':'], ""))
        .filter(|s| !s.is_empty())
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
struct SetDeviceModeArgs {
    mode: DeviceMode,
}

/// Destino de impresión (`caja` | `cocina`). Ausente = `caja`.
#[derive(Debug, Clone, Deserialize)]
struct DestinoArgs {
    #[serde(default)]
    destino: Option<String>,
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
    /// Destino al que se asigna (`caja` | `cocina`). Ausente = `caja`.
    #[serde(default)]
    destino: Option<String>,
}

/* =========================================================
   FISCAL-01: identidad del PRODUCTOR del software
   ---------------------------------------------------------
   Va en el bloque `SistemaInformatico` de cada registro de facturación (art. 13 de la Orden
   HAC/1177/2024). Describe a quien ha hecho el TPV, no al bar que lo usa.

   Es DATO DECLARADO: la AEAT no lo contrasta contra ningún registro de actividad económica, así
   que el epígrafe del productor es irrelevante para que un envío se acepte. Lo que sí valida es el
   FORMATO (el NIF tiene que tener nueve caracteres) y las longitudes máximas.

   ⚠️ `PRODUCTOR_NIF` ESTÁ VACÍO A PROPÓSITO, y aplazarlo es seguro. Todavía no se sabe si el
   productor será un autónomo o una sociedad. Lo que hace que la espera no cueste nada:

     · El job SE NIEGA A REMITIR sin identidad (`verifactu::productor_configurado`). No es una
       carencia: mandar un registro con `"NIF":""` sería que la AEAT lo rechazara por formato, y ese
       rechazo es DEFINITIVO porque `Sistema_Json` se congela en la fila y no se recompone al
       remitir. Quedándose `PENDIENTE` se sale; «rechazado» no.
     · Con la constante puesta, los registros emitidos sin ella se corrigen solos antes del primer
       envío (`verifactu::asegurar_sistema_reparado`, precondición del job). Es legítimo porque
       `SistemaInformatico` NO entra en la cadena de huella.
     · El panel y el aviso dicen que la culpa es del programa, no del bar.

   Lo que falta y por qué, en docs/pendientes.md (Veri*factu). Va junto con la declaración
   responsable del art. 13 RRSIF.
========================================================= */

/// Razón social del productor. Máx. 120 caracteres.
pub(crate) const PRODUCTOR_NOMBRE_RAZON: &str = "Altaria Lights";
/// NIF del productor. Máx. 9 (formato NIF).
pub(crate) const PRODUCTOR_NIF: &str = "";
/// Nombre comercial del sistema informático. Máx. **30**.
pub(crate) const PRODUCTOR_NOMBRE_SISTEMA: &str = "TPV Altaria";
/// Código corto del sistema que asigna el productor. Máx. **2** — no es el nombre.
pub(crate) const PRODUCTOR_ID_SISTEMA: &str = "01";

/* =========================================================
   Helpers básicos
========================================================= */

/// ¿Este dispositivo ya está **aprovisionado** (licencia activada alguna vez)? La señal es
/// `license_state.json` con `tenant_id`, que vive FUERA de `data.db` (igual que la clave del
/// dispositivo, en el keyring). Es lo que permite distinguir una instalación nueva —donde hay que
/// sembrar el admin y pedir el PIN— de una BD perdida, donde sembrarlo fabricaría una credencial
/// falsa y la replicaría a la nube. Ver `tpv_infra_sqlite::connection::seed_admin_if_empty`.
fn dispositivo_aprovisionado(app_data_dir: &Path) -> bool {
    use tpv_application::ports::licensing::LicensingService;
    matches!(
        LicensingAdapter::new(app_data_dir.to_path_buf()).load_state(),
        Ok(Some(st)) if !st.tenant_id.trim().is_empty()
    )
}

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
    let img = image::load_from_memory(bytes).map_err(|e| format!("Imagen no válida: {e}"))?;

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
    matches!(
        parts[1],
        "productos" | "categorias" | "proveedores" | "alergenos" | "logo"
    ) && !parts[2].is_empty()
}

fn content_type_for(rel_path: &str) -> &'static str {
    match rel_path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
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
    pub(crate) db: Arc<Mutex<Option<Arc<Db>>>>,
    cloud: Arc<Mutex<Option<Arc<CloudClient>>>>,
    mode: Arc<Mutex<Option<DeviceMode>>>,
    /// Espejo SÍNCRONO del modo para el firmante de telemetría (que corre en otro hilo sin async).
    /// Se mantiene en paralelo con `mode` en cada cambio de modo.
    mode_sync: Arc<std::sync::RwLock<Option<DeviceMode>>>,
    /// SEC-01: quién ha iniciado sesión, **según el backend**. `None` mientras no se haya pasado
    /// por `login_user`. No se persiste: al arrancar se pide PIN, y está bien así.
    sesion: Arc<Mutex<Option<Sesion>>>,
}

// ──────────────────────────────────────────────────────────────────────────────
// Sesión (SEC-01)
// ──────────────────────────────────────────────────────────────────────────────

/// Quién está usando la app, establecido por `login_user` con lo que devuelve el repositorio
/// (SQLite en la Main, worker en la Handy). **Nunca a partir de un argumento del frontend**:
/// quien puede invocar un comando puede escribir lo que quiera en sus args, así que un rol que
/// llega por ahí no es una comprobación, es una sugerencia.
#[derive(Clone, Debug)]
pub(crate) struct Sesion {
    pub id_usuario: String,
    /// Hoy nadie lo lee: lo que se firma en las filas (`Anulado_Por`, el cobrador…) es `id_usuario`.
    #[allow(dead_code)]
    pub id_trabajador: Option<String>,
    pub rol: String,
    /// Diagnóstico: desde cuándo está abierta la sesión que autorizó algo.
    #[allow(dead_code)]
    pub iniciada_en: i64,
}

/// El rol privilegiado. Está aquí y no repartido por los comandos para que renombrarlo sea un
/// sitio, no una docena.
pub(crate) const ADMIN: &str = "Administrador";

pub(crate) fn permiso_denegado(detalle: impl Into<String>) -> AppErrorDto {
    AppErrorDto::new(tpv_contracts::errors::ErrorCode::PermisoDenegado, detalle)
}

/// Conecta el callback local del outbox con el ciclo WebSocket. Se usa en los tres puntos donde
/// puede nacer un `Db`: arranque, elección de modo y sustitución por una copia restaurada.
pub(crate) fn configure_outbox_notifier(app: &AppHandle, db: &Arc<Db>) {
    let h = app.clone();
    db.set_outbox_notifier(move || {
        let _ = h.emit("outbox:pending", ());
    });
}

/// TRAB-03: construye el cifrador de campo con la DEK guardada en el almacén de secretos.
///
/// Devuelve `None` cuando no hay clave (instalación todavía sin activar) o cuando la que hay
/// no es utilizable. En ese caso el repositorio opera en claro: es preferible a impedir dar de
/// alta a un trabajador. La DEK llega en la respuesta de activación y no se vuelve a pedir.
fn field_cipher() -> Option<Arc<dyn tpv_application::ports::field_cipher::FieldCipher>> {
    let dek = match tpv_infra_licensing::device::get_field_dek() {
        Ok(Some(d)) => d,
        Ok(None) => return None,
        Err(e) => {
            log::warn!("no se pudo leer la field_dek del almacén de secretos: {e}");
            return None;
        }
    };

    match tpv_infra_licensing::field_crypto::FieldCipherAes::new(&dek) {
        Ok(c) => Some(Arc::new(c)),
        Err(e) => {
            log::warn!("field_dek inválida, se opera sin cifrado de campo: {e}");
            None
        }
    }
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
                    let client =
                        self.cloud.lock().await.as_ref().cloned().ok_or_else(|| {
                            "Cliente nube no inicializado (modo Handy)".to_string()
                        })?;
                    Ok(Arc::new(<$http>::new(client)) as Arc<dyn $trait>)
                }
                None => Err("Modo de dispositivo no seleccionado".to_string()),
            }
        }
    };
}

impl AppState {
    /* ── El gate (SEC-01) ─────────────────────────────────────────────────────────────────
       Dos helpers, no una comprobación copiada en cada comando. Devuelven la sesión porque
       quien pregunta "¿puede?" casi siempre necesita después "¿quién?": ese `id_usuario` es
       el que va al caso de uso, en vez del que mande el frontend. */

    /// La sesión actual, o `permiso_denegado` si no hay ninguna. Para lo que escribe algo
    /// **atribuible** pero que hace cualquiera (abrir el cajón para dar cambio).
    pub(crate) async fn sesion(&self) -> Result<Sesion, AppErrorDto> {
        self.sesion
            .lock()
            .await
            .clone()
            .ok_or_else(|| permiso_denegado("Inicia sesión para hacer esto"))
    }

    /// La sesión actual si su rol está entre los permitidos; si no, error.
    pub(crate) async fn exigir_rol(&self, permitidos: &[&str]) -> Result<Sesion, AppErrorDto> {
        let s = self.sesion().await?;
        if permitidos.iter().any(|r| *r == s.rol) {
            Ok(s)
        } else {
            Err(permiso_denegado(format!(
                "Esta acción es de {}",
                permitidos.join(" o ")
            )))
        }
    }

    /// Como `exigir_rol`, pero **sin sesión deja pasar**.
    ///
    /// Es para los comandos que se alcanzan desde las pantallas ANTERIORES al login —el
    /// selector de modo, la activación de licencia— y también desde Configuración con la app
    /// ya abierta. Exigir sesión a secas dejaría un equipo recién instalado sin poder
    /// arrancar jamás (no hay con quién iniciarla); no comprobar nada dejaría que un camarero
    /// desvinculase el equipo escribiendo la URL. Esto cierra el segundo camino sin tocar el
    /// primero.
    pub(crate) async fn exigir_rol_si_hay_sesion(
        &self,
        permitidos: &[&str],
    ) -> Result<(), AppErrorDto> {
        if self.sesion.lock().await.is_none() {
            return Ok(());
        }
        self.exigir_rol(permitidos).await.map(|_| ())
    }

    /// Establece la sesión. Sólo la llama `login_user`.
    pub(crate) async fn iniciar_sesion(&self, s: Sesion) {
        *self.sesion.lock().await = Some(s);
    }

    /// La limpia. La llama el comando `logout` — y con él el cierre por inactividad y el
    /// arranque del frontend, que barre una sesión que hubiera quedado colgada tras un F5.
    pub(crate) async fn cerrar_sesion(&self) {
        *self.sesion.lock().await = None;
    }

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
        cierre_caja_repo,
        CierreCajaRepository,
        SqliteCierreCajaRepository,
        HttpCierreCajaRepository
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
    // TRAB-03: `trabajadores` no usa `repo_accessor!` porque es el único repositorio que
    // necesita el cifrador de campo inyectado (DNI/IBAN/nº SS). La rama Handy no lo lleva a
    // propósito: la clave vive SOLO en la Main, así que la Handy ni escribe ni lee esas
    // columnas (el worker las excluye de sus sentencias y de sus consultas).
    pub(crate) async fn trabajadores_repo(
        &self,
    ) -> Result<Arc<dyn TrabajadoresRepository>, String> {
        match *self.mode.lock().await {
            Some(DeviceMode::Tpv) => {
                let conn = self
                    .db
                    .lock()
                    .await
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "DB no inicializada (modo TPV)".to_string())?;
                Ok(Arc::new(SqliteTrabajadoresRepository::with_cipher(
                    conn,
                    field_cipher(),
                )) as Arc<dyn TrabajadoresRepository>)
            }
            Some(DeviceMode::Handy) => {
                let client = self
                    .cloud
                    .lock()
                    .await
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "Cliente nube no inicializado (modo Handy)".to_string())?;
                Ok(Arc::new(HttpTrabajadoresRepository::new(client))
                    as Arc<dyn TrabajadoresRepository>)
            }
            None => Err("Modo de dispositivo no seleccionado".to_string()),
        }
    }
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

    /// Registros de facturación (FISCAL-01). **No es mode-switched: sólo existe en la Main.**
    ///
    /// La Handy no cobra (`soloLaMainCobra`), así que no emite registros — y no debe poder
    /// hacerlo. La cadena de huellas vive en el SIF del obligado, que es este equipo; la nube es
    /// una copia para poder recuperarla, no una fuente. El veto también está en el worker
    /// (`applyViaHub`), porque una regla que sólo vive en el cliente es una sugerencia.
    pub(crate) async fn verifactu_repo(&self) -> Result<Arc<dyn VerifactuRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "Los registros de facturación sólo existen en el TPV principal".to_string())?;
        Ok(Arc::new(SqliteVerifactuRepository::new(conn)) as Arc<dyn VerifactuRepository>)
    }

    /// El ticket de un cobro (RI-29). Tampoco es mode-switched: imprime la Main, que es la que cobra,
    /// la que tiene la impresora y la que guarda los registros de facturación.
    pub(crate) async fn tickets_repo(&self) -> Result<Arc<dyn TicketsRepository>, String> {
        let conn = self
            .db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| "Los tickets sólo se imprimen en el TPV principal".to_string())?;
        Ok(Arc::new(SqliteTicketsRepository::new(conn)) as Arc<dyn TicketsRepository>)
    }

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
        Ok(Arc::new(SqlitePedidoProveedorRepository::new(conn))
            as Arc<dyn PedidoProveedorRepository>)
    }

    /// Condición de los jobs que leen o escriben negocio. Una BD vacía o recién restaurada existe,
    /// pero no está disponible: ejecutarlos ahí podría fabricar outbox y bloquear el bootstrap.
    pub(crate) async fn es_main_operativa(&self) -> bool {
        if *self.mode.lock().await != Some(DeviceMode::Tpv) {
            return false;
        }
        let db = self.db.lock().await.as_ref().cloned();
        let Some(db) = db else {
            return false;
        };
        matches!(
            tpv_infra_sqlite::recovery::status(&db).await,
            Ok(tpv_contracts::recovery::RecoveryStatus {
                state: tpv_contracts::recovery::RecoveryState::Ready
            })
        )
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
    pub(crate) async fn reconciliacion_repo(
        &self,
    ) -> Result<Arc<dyn ReconciliacionRepository>, String> {
        let conn = self.db.lock().await.as_ref().cloned().ok_or_else(|| {
            "DB no inicializada (la reconciliación requiere modo Main)".to_string()
        })?;
        Ok(Arc::new(SqliteReconciliacionRepository::new(conn))
            as Arc<dyn ReconciliacionRepository>)
    }

    pub(crate) async fn avisos_scan_repo(&self) -> Result<Arc<dyn AvisosScanRepository>, String> {
        let conn = self.db.lock().await.as_ref().cloned().ok_or_else(|| {
            "DB no inicializada (escáner de avisos requiere modo Main)".to_string()
        })?;
        Ok(Arc::new(SqliteAvisosScanRepository::new(conn)) as Arc<dyn AvisosScanRepository>)
    }

    /// Escáner de stock negativo (sobreventa): solo Main (SQLite). En Handy no hay BD local → error
    /// y el job lo salta por su `Requiere`.
    pub(crate) async fn stock_alertas_repo(
        &self,
    ) -> Result<Arc<dyn StockAlertasRepository>, String> {
        let conn = self.db.lock().await.as_ref().cloned().ok_or_else(|| {
            "DB no inicializada (alertas de stock requieren modo Main)".to_string()
        })?;
        Ok(Arc::new(SqliteStockAlertasRepository::new(conn)) as Arc<dyn StockAlertasRepository>)
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

/// Lee la palanca de conectividad de `device_config.json`. `None` = nunca se tocó = `Auto`
/// (el frontend asume `auto`): SYNC-17, conectar es el comportamiento por defecto.
#[tauri::command]
fn get_connection_mode(app: AppHandle) -> Result<Option<ConnectivityMode>, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(load_config(&app_data_dir).connectivity)
}

/// Persiste la palanca de conectividad en `device_config.json`. **Sin UI**: es la salida de
/// emergencia de SYNC-17 (ver [`ConnectivityMode`]), no un ajuste que se ofrezca al usuario.
///
/// La captura de escrituras para el outbox está SIEMPRE activa (el outbox es el log de cambios
/// local), así que apagar y volver a encender no pierde nada: al volver a `Auto` se drena.
///
/// Aquí ya NO se valida la licencia. Antes se hacía porque activar "online" era una acción
/// explícita del usuario; ahora la autoridad es el worker (`/v1/ws/ticket` exige JWT + device
/// proof y rechaza una licencia no activa) y, antes que eso, el gate de AppBoot ya bloquea la app
/// entera si la licencia no deja pasar. Duplicar la comprobación aquí solo añadía una llamada de
/// red a un camino que no la necesita.
#[tauri::command]
fn set_connection_mode(app: AppHandle, args: SetConnectionModeArgs) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

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
    tpv_telemetry::set_device_context(device_id, signing_mode(Some(args.mode)).unwrap_or("unset"));

    // En modo Handy preparamos el cliente HTTP a la nube (no hace red, sólo lo deja listo)
    // para que el cambio de modo sea efectivo sin reiniciar la app.
    if args.mode == DeviceMode::Handy {
        let mut c = state.cloud.lock().await;
        if c.is_none() {
            let client =
                CloudClient::new(CLOUD_API_BASE, app_data_dir.clone()).map_err(String::from)?;
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
    let db = tpv_infra_sqlite::connection::init_main_db(
        &app_data_dir,
        dispositivo_aprovisionado(&app_data_dir),
    )
    .await
    .map_err(String::from)?;

    // Drenado inmediato: cada escritura local que confirma en el outbox emite este evento; el
    // WS (useMainSocket) lo escucha y drena la nube al instante (sin esperar al poll de seguridad).
    configure_outbox_notifier(&app, &db);

    // Aquí no va ningún trabajo de mantenimiento (RI-01). Este comando sólo abre la base la primera
    // vez que se elige «TPV»: en un arranque normal ya la abrió `setup()` y sale arriba. Lo que haya
    // que hacer con la base abierta es un job (`jobs/registro.rs`) o la precondición de uno.
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
async fn device_reset_mode(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    // SEC-01: con la app abierta esto es de administrador (se llega por Configuración →
    // Dispositivo, cuya ruta no tiene candado). Sin sesión pasa, porque el otro camino que lleva
    // aquí es el botón "volver al selector de modo" de las pantallas de arranque, donde todavía
    // no hay con quién iniciar sesión.
    state.exigir_rol_si_hay_sesion(&[ADMIN]).await?;

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
pub(crate) async fn drenar_imagenes(app: &AppHandle, state: &AppState) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let Some(mode_str) = signing_mode(*state.mode.lock().await) else {
        return Ok("sin_modo".into());
    };

    // PROD-06: apagado desde la nube. Aquí y no en el job porque la cola también la drenan el
    // evento de guardar una imagen y la reconexión del WebSocket. Lo pendiente sigue en su fichero.
    if interruptores::apagado(app, tpv_contracts::interruptores::Interruptor::Imagenes).is_some() {
        return Ok("apagado".into());
    }

    let pending = read_image_queue(&app_data_dir);
    if pending.is_empty() {
        return Ok("vacio".into());
    }

    let svc = PairingAdapter::new(app_data_dir.clone());
    let mut remaining: Vec<PendingImage> = Vec::new();
    let mut failed = false;
    let mut subidas = 0u32;
    let mut ultimo_error: Option<String> = None;

    tracing::debug!(target: "tpv::imagenes", modo = %mode_str, en_cola = pending.len(), "drenando cola de imágenes");

    for item in &pending {
        tracing::debug!(target: "tpv::imagenes", ruta = %item.rel_path, tipo = %item.content_type, "pendiente");
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
                tracing::warn!(target: "tpv::imagenes", ruta = %item.rel_path, error = %e, "no se pudo leer el fichero a subir");
                continue;
            }
        };

        let path = format!("/v1/images/{}", item.rel_path);
        tracing::debug!(target: "tpv::imagenes", ruta = %item.rel_path, %path, "subiendo");
        match uc_pairing::upload_image(&svc, mode_str, &path, &item.content_type, bytes).await {
            Ok(_) => {
                tracing::debug!(target: "tpv::imagenes", ruta = %item.rel_path, "subida OK");
                subidas += 1;
            }
            Err(e) => {
                let msg = format!("{e:?}");
                tracing::warn!(target: "tpv::imagenes", ruta = %item.rel_path, error = %msg, "fallo subiendo imagen a R2");
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
        Some(err) => format!(
            "subidas={subidas} pendientes={} error={err}",
            remaining.len()
        ),
        None => format!("subidas={subidas} pendientes={}", remaining.len()),
    };
    tracing::debug!(target: "tpv::imagenes", %resultado, "fin del drenado");
    if ultimo_error.is_some() {
        Err(resultado)
    } else {
        Ok(resultado)
    }
}

#[tauri::command]
async fn images_drain_pending(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    drenar_imagenes(&app, &state)
        .await
        .map_err(AppErrorDto::from)
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
            // WARN y no DEBUG: si esto falla, la imagen no está ni en disco ni en R2 y la UI la
            // reintentará en cada resolución. Merece verse en Axiom, no sólo en la consola de dev.
            tracing::warn!(target: "tpv::imagenes", ruta = %rel_path, error = ?e, "fallo bajando imagen de R2");
            Ok(false)
        }
    }
}

/// Backfill único: encola todas las imágenes existentes en disco que aún no estén en el bucket.
/// Pensado para Mains que ya tenían imágenes antes de existir R2. Se protege con un marcador
/// para no re-escanear en cada arranque. La subida real la hace `images_drain_pending`.
#[tauri::command]
async fn images_backfill(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
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

/// Destino por defecto cuando nadie dice cuál: el ticket de cliente.
const DESTINO_CAJA: &str = "caja";

/// Normaliza el destino pedido (vacío => `caja`).
fn destino_o_caja(v: Option<String>) -> String {
    v.map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DESTINO_CAJA.to_string())
}

/// Impresora de un destino, con el campo antiguo (`printer_name`) como respaldo de `caja`.
fn impresora_de(cfg: &DeviceConfig, destino: &str) -> Option<String> {
    cfg.printers
        .get(destino)
        .cloned()
        .or_else(|| {
            if destino == DESTINO_CAJA {
                cfg.printer_name.clone()
            } else {
                None
            }
        })
        .filter(|s| !s.trim().is_empty())
}

/// Devuelve la impresora seleccionada para un destino (o `None`).
#[tauri::command]
fn printer_get_selected(
    app: AppHandle,
    args: Option<DestinoArgs>,
) -> Result<Option<String>, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    let destino = destino_o_caja(args.and_then(|a| a.destino));
    Ok(impresora_de(&load_config(&dir), &destino))
}

/// Persiste la impresora de un destino en `device_config.json` (nombre vacío => deselecciona).
#[tauri::command]
fn printer_set_selected(app: AppHandle, args: SetPrinterArgs) -> Result<String, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    let mut cfg = load_config(&dir);
    let destino = destino_o_caja(args.destino);
    let name = args.name.trim();

    if name.is_empty() {
        cfg.printers.remove(&destino);
    } else {
        cfg.printers.insert(destino.clone(), name.to_string());
    }
    // El campo antiguo se mantiene al día para `caja`: si alguien vuelve a una versión anterior,
    // su impresora sigue estando donde esa versión la busca.
    if destino == DESTINO_CAJA {
        cfg.printer_name = if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }

    save_config(&dir, &cfg)?;
    Ok("OK".into())
}

/// Resuelve la impresora a usar: la explícita si viene, si no la del destino en config.
fn resolve_printer_destino(
    app: &AppHandle,
    explicit: Option<String>,
    destino: &str,
) -> Result<String, String> {
    if let Some(n) = explicit.filter(|s| !s.trim().is_empty()) {
        return Ok(n);
    }
    let dir = app_data_dir_of(app).map_err(|e| e.to_string())?;
    impresora_de(&load_config(&dir), destino)
        .ok_or_else(|| "No hay impresora seleccionada".to_string())
}

fn resolve_printer(app: &AppHandle, explicit: Option<String>) -> Result<String, String> {
    resolve_printer_destino(app, explicit, DESTINO_CAJA)
}

/// Maqueta un ticket y lo manda a la impresora. Lo comparten la precuenta y el ticket de un cobro.
async fn imprimir_ticket(
    app: &AppHandle,
    payload: printing::PrintTicketPayload,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(app, payload.printer_name.clone())?;

    // El logo se lee AQUÍ y no dentro del builder: `build_ticket` no toca el disco, que es lo que
    // lo mantiene comprobable con un test. Si el fichero no está o no se puede decodificar, el
    // ticket sale sin logo — mejor que no salir.
    let logo = if payload.show_logo {
        payload
            .logo_path
            .as_deref()
            .and_then(|ruta| leer_imagen_local(app, ruta))
    } else {
        None
    };

    let bytes = printing::build_ticket(&payload, logo.as_deref());
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Ticket TPV", &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("OK".into())
}

/// Imprime una **precuenta**: lo que se le enseña al cliente antes de cobrar, compuesto en la
/// pantalla. Sale sin número, sin QR y sin marca de copia aunque la pantalla los mande
/// (`como_precuenta`, RI-29): el ticket de un cobro sólo sale de `printer_imprimir_pago`.
#[tauri::command]
async fn printer_imprimir_precuenta(
    app: AppHandle,
    payload: printing::PrintTicketPayload,
) -> Result<String, AppErrorDto> {
    imprimir_ticket(&app, printing::como_precuenta(payload)).await
}

/// El ticket de un cobro, compuesto desde la base (RI-29): las líneas que cobró ese pago y su
/// factura. Es lo que enseña la vista previa, y lo mismo que imprime `printer_imprimir_pago`.
///
/// Basta con estar identificado: lo imprime quien acaba de cobrar, a mitad de servicio.
#[tauri::command]
async fn printer_ticket_de_pago(
    state: State<'_, AppState>,
    args: tpv_contracts::impresion::TicketDePagoInput,
) -> Result<printing::PrintTicketPayload, AppErrorDto> {
    state.sesion().await?;
    let tickets = state.tickets_repo().await?;
    let config = state.configuracion_repo().await?;
    Ok(tpv_application::use_cases::tickets::ticket_de_pago(tickets.as_ref(), config.as_ref(), &args).await?)
}

/// Imprime el ticket de un cobro. No recibe el papel: lo vuelve a componer desde la base, así que
/// lo que sale es siempre lo que dice la factura.
#[tauri::command]
async fn printer_imprimir_pago(
    app: AppHandle,
    state: State<'_, AppState>,
    args: tpv_contracts::impresion::TicketDePagoInput,
) -> Result<String, AppErrorDto> {
    state.sesion().await?;
    let tickets = state.tickets_repo().await?;
    let config = state.configuracion_repo().await?;
    let payload =
        tpv_application::use_cases::tickets::ticket_de_pago(tickets.as_ref(), config.as_ref(), &args)
            .await?;
    imprimir_ticket(&app, payload).await
}

/// Imprime el papel de un arqueo (CUENTA-06).
///
/// Documento **interno**: no gasta numero de ticket ni abre el cajon -que ya esta abierto, se acaba
/// de contar-. Va aparte del ticket de venta a proposito: compartir el camino del ticket de
/// venta invitaria a que un cambio en uno se colara en el otro.
#[tauri::command]
async fn printer_print_arqueo(
    app: AppHandle,
    payload: printing::PrintArqueoPayload,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(&app, payload.printer_name.clone())?;
    let bytes = printing::build_arqueo(&payload);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Cierre de caja", &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok("OK".into())
}

/// Columnas de caracteres que de verdad caben con la configuración actual de papel y márgenes.
///
/// Lo pregunta la previsualización para enseñar el ancho real (y recortar los nombres donde los
/// recorta el papel) en vez de una versión más amable. Vive aquí y no duplicado en TypeScript
/// porque es la MISMA cuenta que usa el builder ESC/POS: dos copias acabarían discrepando, que es
/// justo lo que hace que una previsualización deje de servir para nada.
#[tauri::command]
fn printer_ticket_cols(args: printing::GeometriaTicket) -> Result<u32, AppErrorDto> {
    Ok(printing::cols_efectivas(
        args.paper_width_mm,
        args.chars_per_line,
        args.margin_left_mm,
        args.margin_right_mm,
    ) as u32)
}

/// Lee del disco una imagen guardada en AppData (`images/{sub}/{archivo}`) o descodifica un data
/// URL heredado. `None` si no se puede: quien llama decide qué hacer sin ella.
fn leer_imagen_local(app: &AppHandle, ruta: &str) -> Option<Vec<u8>> {
    let r = ruta.trim();
    if r.is_empty() {
        return None;
    }

    // Data URL heredado (`data:image/png;base64,…`): los logos antiguos se guardaron así.
    if let Some(b64) = r.split_once(";base64,").map(|(_, b)| b) {
        use base64::Engine;
        return base64::engine::general_purpose::STANDARD.decode(b64).ok();
    }

    let dir = app_data_dir_of(app).ok()?;
    std::fs::read(ruta_dentro_de(&dir, r)?).ok()
}

/// Resuelve una ruta relativa **dentro** de `dir`, o `None` si se sale.
///
/// ⚠️ No basta con `dir.join(ruta).starts_with(dir)`: `Path::starts_with` compara componentes, y
/// `AppData/tpv/../../otro` empieza por `AppData/tpv` tal cual está escrito. El `..` no lo resuelve
/// nadie hasta que el sistema operativo abre el fichero, o sea que la comprobación pasaba y la
/// lectura salía igualmente del directorio.
///
/// Por eso se rechaza cualquier `..` y cualquier ruta absoluta **antes** de juntar nada, que es lo
/// único que no depende de que el fichero exista ya.
fn ruta_dentro_de(dir: &std::path::Path, ruta: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;

    let limpia = ruta.trim().replace('\\', "/");
    if limpia.is_empty() {
        return None;
    }

    let relativa = std::path::Path::new(&limpia);
    for c in relativa.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            // `..`, `/` inicial, `C:` … cualquiera de estos saca del directorio.
            _ => return None,
        }
    }

    let completa = dir.join(relativa);

    // Si además existe, se contrasta la ruta ya resuelta: cubre los enlaces simbólicos, que no
    // llevan `..` y aun así apuntan fuera.
    if let (Ok(real), Ok(raiz)) = (completa.canonicalize(), dir.canonicalize()) {
        if !real.starts_with(&raiz) {
            return None;
        }
    }
    Some(completa)
}

/// Abre el cajón portamonedas sin imprimir nada.
///
/// Existe para dar cambio o cuadrar caja, que es algo que el camarero necesita hacer, así que no
/// se pide permiso de administrador. Lo que sí se hace es **dejarlo anotado** con quién y cuándo:
/// una apertura sin venta detrás es la única por la que alguien pregunta cuando falta dinero.
///
/// SEC-01: por eso pide `sesion()` —basta estar identificado, da igual el rol— y el `id_usuario`
/// sale de ahí, no de los args. Una fila de auditoría firmada con el nombre que le pase la
/// pantalla no registra quién abrió el cajón; registra quién dijo alguien que lo abrió.
///
/// El registro es best-effort a propósito: si la BD fallara, el cajón se abre igual. Bloquear el
/// cambio de un cliente porque no se pudo escribir una fila de auditoría sería peor que la falta
/// de esa fila. El gate NO es best-effort: sin sesión no se abre.
#[tauri::command]
async fn printer_open_drawer(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    let id_usuario = Some(state.sesion().await?.id_usuario);

    if let Ok(repo) = state.cuentas_repo().await {
        if let Err(e) =
            tpv_application::use_cases::cuentas::registrar_apertura_cajon(repo.as_ref(), id_usuario)
                .await
        {
            tracing::warn!(target: "tpv::caja", error = %e, "no se pudo anotar la apertura del cajón");
        }
    }

    let printer = resolve_printer(&app, None)?;
    let bytes = printing::build_abrir_cajon();
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, "Abrir cajón", &bytes))
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

    // Con la Main a medio recuperar, esta notificación es una escritura de negocio: entra en
    // `_Sync_Outbox`... y el outbox es justo lo que bloquea la restauración, que es la única
    // salida. Como el socket está parado mientras faltan los datos, esa operación no se puede
    // subir NUNCA: el equipo se queda sin poder restaurar ni con conexión.
    //
    // El aviso no se pierde: el banner y el evento `update:available` son de UI y siguen saliendo,
    // y el próximo chequeo (al reabrir, o a las 6 h) lo emitirá con el equipo ya operativo.
    if !state.es_main_operativa().await {
        return;
    }

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
    //
    // El contexto se genera aquí, y no al final en `.run()`, porque el entorno sale de él.
    let context = tauri::generate_context!();
    let sentry_guard = tpv_telemetry::init_sentry(tpv_telemetry::SentryConfig {
        dsn: option_env!("TPV_SENTRY_DSN").map(|s| s.to_string()),
        environment: entorno_de_sentry(&context.config().identifier, cfg!(debug_assertions))
            .to_string(),
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

    let builder = tauri::Builder::default();

    // REV-05: una sola instancia por equipo. Dos procesos sobre la misma `data.db` abren dos
    // WebSockets con el mismo `deviceId` (el TenantHub echa al anterior: bucle de `replaced`),
    // duplican los jobs —dos remisiones a la AEAT, dos copias, dos backfills— y drenan el outbox a
    // la vez. El segundo lanzamiento termina antes de hacer nada y el primero trae su ventana al
    // frente, que es lo que espera quien ha hecho doble clic en el acceso directo.
    //
    // Tiene que ser el PRIMER plugin (lo pide su documentación): el segundo proceso sale dentro de
    // su inicialización, y cualquier plugin anterior ya habría arrancado su trabajo.
    //
    // El candado va por `identifier`, así que el build de E2E (`…tpv.e2e`) no choca con la app de
    // trabajo abierta en el mismo equipo, igual que no comparte su AppData.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(ventana) = app.get_webview_window("main") {
            let _ = ventana.unminimize();
            let _ = ventana.show();
            let _ = ventana.set_focus();
        }
    }));

    let builder = builder
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

            // FISCAL-01: el bloque `SistemaInformatico` que va EN CADA registro de facturación.
            //
            // Se inyecta aquí porque dos de sus datos sólo se conocen en el shell: la versión (de
            // `tauri.conf.json`) y el número de instalación (el `tenant_id`, que vive en
            // `license_state.json`, fuera de `data.db`). El resto identifica al PRODUCTOR del
            // software —nosotros—, no al bar, y es dato declarado: la AEAT no lo contrasta contra
            // ningún registro de actividad económica.
            //
            // ⚠️ El NIF está vacío a propósito y no rompe nada: ver el bloque de constantes arriba
            // y docs/pendientes.md (Veri*factu).
            {
                let tenant = tpv_infra_licensing::LicensingAdapter::new(app_data_dir.clone());
                let numero_instalacion = {
                    use tpv_application::ports::licensing::LicensingService;
                    match tenant.load_state() {
                        Ok(Some(st)) => st.tenant_id,
                        _ => String::new(),
                    }
                };
                tpv_infra_sqlite::verifactu::set_sistema_informatico(
                    tpv_infra_sqlite::verifactu::SistemaInformatico {
                        nombre_razon: PRODUCTOR_NOMBRE_RAZON.to_string(),
                        nif: PRODUCTOR_NIF.to_string(),
                        nombre_sistema: PRODUCTOR_NOMBRE_SISTEMA.to_string(),
                        id_sistema: PRODUCTOR_ID_SISTEMA.to_string(),
                        version: handle.package_info().version.to_string(),
                        numero_instalacion,
                    },
                );
            }

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
                    // sin `tracing` todavía: es lo que está fallando
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
                // Tenant (restaurante): en Handy sale del token; en Main, de `license_state.json`.
                // A Axiom el endpoint de telemetría le pone el del JWT de todos modos (y descarta
                // el que mande el cliente), pero Sentry sólo tiene esta etiqueta: sin ella, un error
                // de una Main no decía de qué negocio era. Un equipo sin licencia activada no tiene
                // tenant todavía; la activación lo fija (`commands/licensing.rs`).
                let tenant = match mode {
                    Some(DeviceMode::Handy) => {
                        uc_pairing::handy_get_tenant(&PairingAdapter::new(app_data_dir.clone()))
                            .ok()
                            .flatten()
                    }
                    Some(DeviceMode::Tpv) => {
                        use tpv_application::ports::licensing::LicensingService;
                        tpv_infra_licensing::LicensingAdapter::new(app_data_dir.clone())
                            .load_state()
                            .ok()
                            .flatten()
                            .map(|st| st.tenant_id)
                    }
                    None => None,
                };
                if let Some(tenant) = tenant.filter(|t| !t.is_empty()) {
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
                let abierta = tauri::async_runtime::block_on(async {
                    tpv_infra_sqlite::connection::init_main_db(
                        &app_data_dir,
                        dispositivo_aprovisionado(&app_data_dir),
                    )
                    .await
                });

                match abierta {
                    Ok(db) => {
                        // Drenado inmediato (ver init_main): el outbox avisa al WS al confirmar una escritura.
                        configure_outbox_notifier(handle, &db);
                        Some(db)
                    }
                    // Una `data.db` corrupta o ilegible NO puede tumbar el arranque. Con un panic
                    // aquí la app no llega a abrir ninguna ventana, y entonces la pantalla de
                    // recuperación —donde están las copias locales y el volcado de la nube— es
                    // inalcanzable: el equipo queda inservible justo en el caso para el que se
                    // guardan las copias. Se arranca sin base; los comandos de arranque fallan, el
                    // frontend lo lee como datos perdidos y entra en recuperación, que funciona
                    // sin `Db` (listar copias y restaurar sólo tocan ficheros).
                    Err(e) => {
                        tracing::error!(
                            target: "tpv::startup",
                            error = %e,
                            "no se pudo abrir la base local; se arranca en modo recuperación"
                        );
                        None
                    }
                }
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
                // Se arranca SIN sesión: la app siempre pide PIN al abrirse.
                sesion: Arc::new(Mutex::new(None)),
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
            // auto-actualización (updater)
            updater_check,
            updater_status,
            updater_install,
            // impresión (host/Windows — printing.rs)
            printer_list,
            printer_get_selected,
            printer_set_selected,
            printer_imprimir_precuenta,
            printer_ticket_de_pago,
            printer_imprimir_pago,
            printer_print_arqueo,
            printer_ticket_cols,
            printer_open_drawer,
            printer_print_test,
            // auth / login
            commands::login::list_login_users,
            commands::login::setup_pendiente,
            commands::login::login_user,
            commands::login::logout,
            commands::login::get_today_punch_status,
            commands::login::punch,
            commands::login::complete_initial_setup,
            commands::login::set_turno_partido_hoy,
            commands::recuperacion_pin::login_recuperar_pin_solicitar,
            commands::recuperacion_pin::login_recuperar_pin_confirmar,
            commands::correo_recuperacion::correo_recuperacion_estado,
            commands::correo_recuperacion::correo_recuperacion_solicitar,
            commands::correo_recuperacion::correo_recuperacion_confirmar,
            commands::correo_recuperacion::correo_recuperacion_usar_el_de_la_compra,
            // recuperación local
            commands::recovery::recovery_status,
            commands::recovery::recovery_list_backups,
            commands::recovery::recovery_create_backup,
            commands::recovery::recovery_export_backup,
            commands::recovery::recovery_import_backup,
            commands::recovery::recovery_restore_backup,
            commands::recovery::recovery_complete,
            // mesass
            commands::mesas::save_layout,
            commands::mesas::load_layout,
            commands::mesas::set_reserva_estado,
            commands::mesas::get_comanda_abierta_by_mesa,
            commands::mesas::abrir_comanda,
            commands::mesas::comanda_set_trabajador_if_null,
            commands::mesas::get_lineas_comanda,
            commands::mesas::add_linea_comanda,
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
            commands::inventario::inventario_get_product_detail,
            commands::inventario::inventario_delete_producto,
            commands::inventario::inventario_upsert_producto,
            commands::inventario::inventario_list_lotes_by_producto,
            commands::inventario::inventario_create_lote,
            commands::inventario::inventario_update_lote,
            commands::inventario::inventario_ajustar_lote,
            commands::inventario::inventario_ajustar_stock_suelto,
            // tareas
            commands::tareas::tareas_get_trabajadores,
            commands::tareas::tareas_create_tarea,
            commands::tareas::tareas_get_tareas_admin,
            commands::tareas::tareas_get_tarea_by_id,
            commands::tareas::tareas_update_tarea,
            commands::tareas::tareas_get_tarea_asignados,
            commands::tareas::tareas_set_asignaciones_tarea,
            commands::tareas::tareas_delete_tarea,
            commands::tareas::tareas_get_papelera,
            commands::tareas::tareas_restaurar_tarea,
            commands::tareas::tareas_vaciar_papelera,
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
            commands::cuentas::cuentas_anular_pago,
            commands::cuentas::cuentas_previsualizar_cambio,
            commands::cierre_caja::cierre_preparar,
            commands::cierre_caja::cierre_confirmar,
            commands::cierre_caja::cierre_listar,
            commands::cierre_caja::cierre_detalle,
            commands::cierre_caja::cierre_reabrir,
            // clientes (migrado a arquitectura hexagonal — commands/clientes.rs)
            commands::clientes::clientes_get_overview,
            commands::clientes::clientes_get_cliente_form,
            commands::clientes::clientes_create_cliente,
            commands::clientes::clientes_update_cliente,
            commands::clientes::clientes_recalcular_gasto,
            // reservas (migrado a arquitectura hexagonal — commands/reservas.rs)
            commands::reservas::reservas_get_meta,
            commands::reservas::reservas_get_mes,
            commands::reservas::reservas_save,
            commands::reservas::reservas_buscar_cliente,
            commands::reservas::reservas_delete,
            // proveedores (migrado a arquitectura hexagonal — commands/proveedores.rs)
            commands::proveedores::proveedores_get_all,
            commands::proveedores::proveedores_save,
            commands::proveedores::proveedores_delete,
            commands::proveedores::proveedores_get_productos,
            commands::proveedores::proveedores_get_categorias,
            commands::proveedores::proveedores_get_productos_all,
            commands::proveedores::proveedores_set_vinculos,
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
            commands::notificaciones::notificaciones_descartar,
            commands::notificaciones::notificaciones_papelera,
            commands::notificaciones::notificaciones_restaurar,
            commands::notificaciones::notificaciones_eliminar,
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
            commands::venta_rapida::vr_delete_comanda_if_safe,
            commands::venta_rapida::vr_get_index_rows,
            commands::venta_rapida::vr_get_detalles_ver_ticket,
            // verifactu (FISCAL-01). Sólo LECTURAS: la emisión ocurre dentro de la transacción
            // del cobro, no por un comando propio.
            commands::verifactu::verifactu_estado,
            commands::verifactu::verifactu_listar,
            commands::verifactu::verifactu_certificados,
            commands::verifactu::verifactu_set_certificado,
            commands::verifactu::verifactu_probar_conexion,
            commands::verifactu::verifactu_emitir_factura_de_ticket,
            commands::verifactu::verifactu_subsanar_rechazados,
            commands::verifactu::verifactu_set_modo_prueba,
            commands::verifactu::verifactu_reconocer_anomalias,
            commands::verifactu::verifactu_exportar,
            commands::verifactu::verifactu_declaracion_responsable,
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
            commands::licensing::license_sumar_clave,
            commands::licensing::license_request_device_change,
            commands::licensing::license_clear_state,
            commands::licensing::license_gate,
            commands::licensing::license_check_now,
            // pairing (migrado a arquitectura hexagonal — commands/pairing.rs)
            commands::pairing::handy_set_token,
            commands::pairing::handy_get_tenant,
            commands::pairing::handy_get_ws_auth,
            commands::pairing::device_get_identity,
            commands::pairing::device_sign_b64,
            commands::pairing::device_hora_para_firmar,
            commands::pairing::tpv_server_post_json,
            commands::pairing::pair_create,
            commands::pairing::config_upload_initial_setup,
            // sincronización nube → Main (aplicar cambios recibidos por WebSocket / catch-up)
            commands::sync::sync_apply_changes,
            commands::sync::sync_get_checkpoint,
            // sincronización Main → nube (outbox de escrituras locales)
            commands::sync::sync_outbox_pending,
            commands::sync::sync_outbox_mark_sent,
            commands::sync::sync_outbox_mark_failed,
            commands::sync::sync_outbox_mark_encolada,
            commands::sync::sync_liberar_encoladas,
            commands::sync::sync_health,
            commands::sync::sync_backfill_estado,
            commands::sync::sync_bootstrap_desde_nube,
            commands::sync::sync_inicializar_tenant_vacio,
            // tareas periódicas de fondo (runner de jobs)
            commands::jobs::jobs_status,
            commands::jobs::interruptores_apagados,
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
        .run(context)
        .expect("error while running tauri application");
}

/// Con qué entorno se etiquetan los errores que suben a Sentry.
///
/// El DSN se embebe en cualquier build que se compile con `TPV_SENTRY_DSN` puesta, también los de
/// la máquina de desarrollo, así que el entorno es lo único que separa un error de un cliente de uno
/// provocado a propósito. El E2E se compila en release y rompe la base de datos adrede: sin esto,
/// sus errores llegaban como `prod`. Se decide por el identificador porque es lo que define ese
/// build (apps/tpv-main/e2e/README.md), no por una variable que alguien pueda olvidar al compilar.
fn entorno_de_sentry(identificador: &str, depuracion: bool) -> &'static str {
    if identificador.ends_with(".e2e") {
        "e2e"
    } else if depuracion {
        "dev"
    } else {
        "prod"
    }
}

#[cfg(test)]
mod tests_entorno_de_sentry {
    use super::entorno_de_sentry;

    #[test]
    fn el_build_de_e2e_no_se_mezcla_con_los_clientes() {
        assert_eq!(entorno_de_sentry("com.altarialights.tpv.e2e", false), "e2e");
        assert_eq!(entorno_de_sentry("com.altarialights.tpv.e2e", true), "e2e");
        assert_eq!(entorno_de_sentry("com.altarialights.tpv", true), "dev");
        assert_eq!(entorno_de_sentry("com.altarialights.tpv", false), "prod");
    }

    /// Si alguien cambia el identificador de alguno de los dos builds, esto tiene que enterarse.
    #[test]
    fn los_identificadores_reales_caen_donde_toca() {
        let leer = |fichero: &str| -> String {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(fichero);
            let json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(ruta).unwrap()).unwrap();
            json["identifier"].as_str().unwrap().to_string()
        };
        assert_eq!(entorno_de_sentry(&leer("tauri.e2e.conf.json"), false), "e2e");
        assert_eq!(entorno_de_sentry(&leer("tauri.conf.json"), false), "prod");
    }
}

#[cfg(test)]
mod tests_impresora_por_destino {
    //! A qué impresora sale cada cosa.
    //!
    //! La configuración guarda una impresora **por destino** (caja, cocina). El campo antiguo
    //! `printer_name` sigue existiendo porque las instalaciones que ya estaban lo tienen relleno:
    //! si dejara de leerse, a esos usuarios les desaparecería la impresora sin tocar nada.

    use super::*;

    fn config(printers: &[(&str, &str)], antiguo: Option<&str>) -> DeviceConfig {
        DeviceConfig {
            printer_name: antiguo.map(|s| s.to_string()),
            printers: printers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn sin_destino_se_entiende_la_caja() {
        assert_eq!(destino_o_caja(None), "caja");
        assert_eq!(destino_o_caja(Some(String::new())), "caja");
        assert_eq!(destino_o_caja(Some("   ".into())), "caja");
    }

    #[test]
    fn el_destino_no_distingue_mayusculas_ni_espacios() {
        // Llega de la UI y del IPC; dos formas de escribir "Cocina" no pueden ser dos impresoras.
        assert_eq!(destino_o_caja(Some("  Cocina ".into())), "cocina");
        assert_eq!(destino_o_caja(Some("COCINA".into())), "cocina");
    }

    #[test]
    fn cada_destino_saca_la_suya() {
        let cfg = config(&[("caja", "EPSON"), ("cocina", "STAR")], None);

        assert_eq!(impresora_de(&cfg, "caja").as_deref(), Some("EPSON"));
        assert_eq!(impresora_de(&cfg, "cocina").as_deref(), Some("STAR"));
    }

    #[test]
    fn una_instalacion_antigua_sigue_imprimiendo_por_caja() {
        // Solo tiene el campo viejo: sin el respaldo, el TPV diría "no hay impresora
        // seleccionada" en mitad de un servicio, después de una actualización.
        let cfg = config(&[], Some("EPSON DE SIEMPRE"));

        assert_eq!(
            impresora_de(&cfg, "caja").as_deref(),
            Some("EPSON DE SIEMPRE")
        );
    }

    #[test]
    fn el_campo_antiguo_no_se_cuela_en_los_demas_destinos() {
        // Si la cocina heredara la de caja, la comanda saldría en la barra y nadie la vería.
        let cfg = config(&[], Some("EPSON"));

        assert_eq!(impresora_de(&cfg, "cocina"), None);
    }

    #[test]
    fn lo_nuevo_manda_sobre_lo_viejo() {
        let cfg = config(&[("caja", "NUEVA")], Some("VIEJA"));

        assert_eq!(impresora_de(&cfg, "caja").as_deref(), Some("NUEVA"));
    }

    #[test]
    fn una_impresora_en_blanco_es_no_tener_impresora() {
        // Guardar "" y tratarlo como un nombre haría que el trabajo se mandara a la nada, sin
        // error visible: el camarero se queda esperando un ticket que no va a salir.
        let cfg = config(&[("caja", "   ")], None);

        assert_eq!(impresora_de(&cfg, "caja"), None);
    }
}

#[cfg(test)]
mod tests_ruta_del_logo {
    //! Que el logo se lea de dentro de AppData y de ningún otro sitio.
    //!
    //! La ruta viene de la configuración del negocio, que se sincroniza: no es un dato que escriba
    //! solo quien está delante del TPV.

    use super::*;

    fn temporal() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tpv_ruta_test_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images/logo.png"), b"png").unwrap();
        dir
    }

    #[test]
    fn una_ruta_normal_se_resuelve_dentro() {
        let dir = temporal();
        let r = ruta_dentro_de(&dir, "images/logo.png").expect("debería resolver");

        assert!(
            r.ends_with("images/logo.png") || r.ends_with("images\\logo.png"),
            "{r:?}"
        );
    }

    #[test]
    fn las_barras_de_windows_valen_igual() {
        let dir = temporal();
        assert!(ruta_dentro_de(&dir, "images\\logo.png").is_some());
    }

    #[test]
    fn una_ruta_con_dos_puntos_no_saca_del_directorio() {
        // `Path::starts_with` compara componentes, así que "AppData/tpv/../../x" empieza por
        // "AppData/tpv" tal cual está escrito y la comprobación pasaba: el `..` no lo resolvía
        // nadie hasta que el sistema abría el fichero, ya fuera de AppData.
        let dir = temporal();

        assert_eq!(ruta_dentro_de(&dir, "../../secreto.png"), None);
        assert_eq!(ruta_dentro_de(&dir, "images/../../secreto.png"), None);
        assert_eq!(ruta_dentro_de(&dir, "images/..\\..\\secreto.png"), None);
    }

    #[test]
    fn la_comprobacion_ingenua_no_habria_bastado() {
        // Este test no prueba nuestro código: fija el comportamiento de la biblioteca estándar del
        // que venía el agujero, para que el día que alguien "simplifique" la función vea por qué
        // no puede. `starts_with` compara COMPONENTES, y nadie resuelve el `..` por el camino.
        let dir = std::path::Path::new("/appdata/tpv");
        let ingenua = dir.join("../../secreto.png");

        assert!(
            ingenua.starts_with(dir),
            "si esto dejara de ser cierto, la comprobación de antes valdría"
        );
        assert_eq!(
            ruta_dentro_de(dir, "../../secreto.png"),
            None,
            "la de ahora sí lo para"
        );
    }

    #[test]
    fn una_ruta_absoluta_tampoco() {
        let dir = temporal();

        assert_eq!(ruta_dentro_de(&dir, "/etc/passwd"), None);
        assert_eq!(ruta_dentro_de(&dir, "C:/Windows/win.ini"), None);
    }

    #[test]
    fn una_ruta_vacia_no_es_una_ruta() {
        let dir = temporal();

        assert_eq!(ruta_dentro_de(&dir, ""), None);
        assert_eq!(ruta_dentro_de(&dir, "   "), None);
    }

    #[test]
    fn un_punto_solo_no_estorba() {
        // "./images/logo.png" es la misma ruta escrita de otra forma.
        let dir = temporal();
        assert!(ruta_dentro_de(&dir, "./images/logo.png").is_some());
    }
}

#[cfg(test)]
mod tests_sesion_y_permisos {
    //! El gate por rol (SEC-01).
    //!
    //! Los comandos no se pueden instanciar sin una app de Tauri, pero la decisión no vive en
    //! ellos: vive en estos tres métodos de `AppState`, que sí son puros respecto a Tauri. Lo
    //! que se prueba aquí es lo que un comando gateado hereda al llamarlos.

    use super::*;

    fn estado() -> AppState {
        AppState {
            db: Arc::new(Mutex::new(None)),
            cloud: Arc::new(Mutex::new(None)),
            mode: Arc::new(Mutex::new(Some(DeviceMode::Tpv))),
            mode_sync: Arc::new(std::sync::RwLock::new(Some(DeviceMode::Tpv))),
            sesion: Arc::new(Mutex::new(None)),
        }
    }

    fn sesion_de(rol: &str) -> Sesion {
        Sesion {
            id_usuario: "u-1".into(),
            id_trabajador: Some("t-1".into()),
            rol: rol.into(),
            iniciada_en: 1_700_000_000_000,
        }
    }

    /// Sin sesión no se pasa, y el error tiene que llegar con el código por el que ramifica el
    /// frontend: con un `internal` genérico, la UI no podría distinguir "no puedes" de "ha
    /// fallado" y ofrecería reintentar donde no hay nada que reintentar.
    #[tokio::test]
    async fn sin_sesion_se_deniega_con_su_codigo() {
        let st = estado();

        let e = st.sesion().await.unwrap_err();
        assert_eq!(e.code, tpv_contracts::errors::ErrorCode::PermisoDenegado);

        let e = st.exigir_rol(&[ADMIN]).await.unwrap_err();
        assert_eq!(e.code, tpv_contracts::errors::ErrorCode::PermisoDenegado);
    }

    /// El caso que motiva el plan entero: identificarse no es autorizarse.
    #[tokio::test]
    async fn un_rol_que_no_toca_no_pasa_aunque_haya_sesion() {
        let st = estado();

        for rol in ["Camarero", "Cocinero", "Limpieza"] {
            st.iniciar_sesion(sesion_de(rol)).await;

            // Está identificado: lo atribuible sí lo puede hacer (abrir el cajón para dar cambio).
            assert!(st.sesion().await.is_ok(), "{rol} debería estar identificado");

            let e = st.exigir_rol(&[ADMIN]).await.unwrap_err();
            assert_eq!(
                e.code,
                tpv_contracts::errors::ErrorCode::PermisoDenegado,
                "{rol} no debería pasar el gate de administrador"
            );
        }
    }

    /// El rol se compara EXACTO. Aceptar "administrador" o " Administrador " sería aceptar
    /// cualquier fila de `Roles` que alguien escribiera de otra manera.
    #[tokio::test]
    async fn el_rol_se_compara_exacto() {
        let st = estado();

        for parecido in [
            "administrador",
            "ADMINISTRADOR",
            " Administrador",
            "Administrador ",
        ] {
            st.iniciar_sesion(sesion_de(parecido)).await;
            assert!(
                st.exigir_rol(&[ADMIN]).await.is_err(),
                "{parecido:?} no es el rol Administrador"
            );
        }
    }

    #[tokio::test]
    async fn con_el_rol_correcto_pasa_y_dice_quien_es() {
        let st = estado();
        st.iniciar_sesion(sesion_de(ADMIN)).await;

        let s = st.exigir_rol(&[ADMIN]).await.expect("un admin debe pasar");

        // Lo que devuelve el gate es lo que acaba en la fila: el `id_usuario` de la sesión y no
        // uno que haya llegado en los args. Es todo el sentido de SEC-01.
        assert_eq!(s.id_usuario, "u-1");
        assert_eq!(s.rol, ADMIN);
    }

    /// Cerrar sesión no es cosmético: es lo que impide que la siguiente persona herede el
    /// permiso de la anterior cuando el TPV se queda desatendido.
    #[tokio::test]
    async fn cerrar_sesion_devuelve_el_gate_a_cero() {
        let st = estado();
        st.iniciar_sesion(sesion_de(ADMIN)).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        st.cerrar_sesion().await;

        assert!(st.sesion().await.is_err());
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /// Cerrar dos veces (el cierre por inactividad y el arranque del webview pueden solaparse)
    /// no puede fallar ni resucitar nada.
    #[tokio::test]
    async fn cerrar_sesion_es_idempotente() {
        let st = estado();
        st.cerrar_sesion().await;
        st.cerrar_sesion().await;
        assert!(st.sesion().await.is_err());
    }

    /// Iniciar sesión reemplaza: si dos logins seguidos acumularan, el segundo usuario operaría
    /// con el permiso del primero.
    #[tokio::test]
    async fn iniciar_sesion_reemplaza_a_la_anterior() {
        let st = estado();
        st.iniciar_sesion(sesion_de(ADMIN)).await;
        st.iniciar_sesion(sesion_de("Camarero")).await;

        assert_eq!(st.sesion().await.unwrap().rol, "Camarero");
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /* ── `exigir_rol_si_hay_sesion`: el gate de las pantallas de arranque ──────────────────── */

    /// Sin sesión pasa, y esto NO es un descuido. A `device_reset_mode` se llega también desde el
    /// selector de modo y desde la pantalla de activación, que se pintan en lugar del router: ahí
    /// no hay con quién iniciar sesión, y un gate duro dejaría un equipo recién instalado sin
    /// poder activarse jamás.
    #[tokio::test]
    async fn sin_sesion_el_gate_blando_deja_pasar() {
        let st = estado();
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_ok());
    }

    /// Y con sesión sí manda, que es lo que cierra el camino de Configuración → Dispositivo.
    #[tokio::test]
    async fn con_sesion_el_gate_blando_exige_el_rol() {
        let st = estado();

        st.iniciar_sesion(sesion_de("Camarero")).await;
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_err());

        st.iniciar_sesion(sesion_de(ADMIN)).await;
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_ok());
    }
}

#[cfg(test)]
mod tests_exenciones_del_gate {
    //! Los comandos que NUNCA pueden exigir sesión (SEC-01).
    //!
    //! Esto no se prueba ejecutándolos: haría falta una app de Tauri entera y, sobre todo, el
    //! fallo que hay que impedir no es que devuelvan mal — es que **alguien les añada un gate**
    //! el día que amplíe la lista mirando el fichero de al lado. Así que lo que se vigila es el
    //! propio fuente.
    //!
    //! El caso grave es `recovery.rs`. Esa pantalla existe precisamente para el escenario de
    //! CERO USUARIOS: un equipo que ha perdido su `data.db` no tiene con quién iniciar sesión.
    //! Ponerle el gate cierra la única salida que le queda —el callejón sin salida en el que ya se
    //! quedó un equipo cuando recuperar de la nube era la única vía— y encima lo hace en silencio,
    //! porque en un equipo sano no se nota. Es la hermana exacta de la regla que ya estaba
    //! escrita: *todo lo que hay en ese camino tiene que tolerar `state.db == None`*. Añádele:
    //! **y `sesion == None`**.

    /// Ficheros cuyos comandos se alcanzan sin sesión, y por qué.
    const EXENTOS: &[(&str, &str, &str)] = &[
        (
            "commands/recovery.rs",
            include_str!("commands/recovery.rs"),
            "la recuperación existe para el caso de cero usuarios: no hay con quién iniciar sesión",
        ),
        (
            "commands/recuperacion_pin.rs",
            include_str!("commands/recuperacion_pin.rs"),
            "recuperar el PIN es para el administrador que no puede iniciar sesión (LOGIN-07)",
        ),
    ];

    /// Marcas de que alguien ha metido el gate donde no puede estar.
    const SENALES_DE_GATE: &[&str] = &["exigir_rol", "state.sesion()"];

    #[test]
    fn los_comandos_de_recuperacion_no_pueden_exigir_sesion() {
        for (fichero, fuente, porque) in EXENTOS {
            for senal in SENALES_DE_GATE {
                assert!(
                    !fuente.contains(senal),
                    "{fichero} usa `{senal}`, y no puede: {porque}.\n\
                     Si de verdad hiciera falta, lo que habría que cambiar es el plan de \
                     recuperación, no este test."
                );
            }
        }
    }

    /// El login no puede pedir sesión: sería circular. Se comprueba aparte de `EXENTOS` porque
    /// `commands/login.rs` **sí** toca la sesión (la establece y la cierra), así que la señal no
    /// puede ser "menciona la sesión" sino "la exige".
    #[test]
    fn el_login_no_puede_exigir_lo_que_todavia_no_existe() {
        let fuente = include_str!("commands/login.rs");
        assert!(
            !fuente.contains("exigir_rol"),
            "los comandos de login no pueden exigir rol: son el camino por el que se obtiene"
        );
    }

    /// REV-26: lo registrado es lo invocable, así que lo que no se invoca no se registra.
    ///
    /// Había trece comandos en el `generate_handler!` que ningún sitio del frontend ni del E2E
    /// llamaba por su nombre. No es sólo limpieza: **todo lo registrado es alcanzable por el IPC**,
    /// y el modelo de amenaza de §14 asume que quien tiene la máquina delante puede invocarlo. Dos
    /// de ellos eran de verdad incómodos: `tpv_server_signed_headers` devolvía la firma de
    /// cualquier petición **sin pasar por ningún gate** —mientras su hermano `tpv_server_post_json`
    /// sí exige Administrador para `/v1/pair/…` y `/v1/device/…`, o sea que era la vuelta a esa
    /// esquina—, y `cobrar_venta_rapida` era un segundo camino de cobro de barra, no idempotente y
    /// sin nadie que lo usara.
    ///
    /// Esto vigila los dos que importan. El resto se fue con ellos y lo cubre
    /// `scripts/check-comandos-tauri.mjs`, que rompe si el frontend invoca algo que no está.
    #[test]
    fn los_comandos_retirados_no_vuelven_por_la_puerta_de_atras() {
        // Sólo el registro, no el fichero entero: si no, este propio test —que nombra los
        // comandos— se contaría como una reaparición.
        const FUENTE_COMPLETA: &str = include_str!("lib.rs");
        let desde = FUENTE_COMPLETA
            .find("generate_handler![")
            .expect("no se encuentra el registro de comandos");
        let hasta = FUENTE_COMPLETA[desde..]
            .find("])")
            .expect("el registro de comandos no cierra")
            + desde;
        let registro = &FUENTE_COMPLETA[desde..hasta];

        for (comando, porque) in [
            (
                "tpv_server_signed_headers",
                "firma cualquier petición sin gate: es la vuelta a la esquina del candado de                  `tpv_server_post_json` (SEC-01)",
            ),
            (
                "printer_print_ticket",
                "imprimía lo que la pantalla le mandara, número y QR incluidos: un papel con número que                  no era el de su factura (RI-29). El ticket de un cobro se compone en Rust desde la base",
            ),
            (
                "cobrar_venta_rapida",
                "es un segundo camino de cobro de barra, y no es idempotente",
            ),
            (
                "vr_restar_stock",
                "descuenta stock fuera de un cobro, sin su rastro en `Lote_Consumos` (el cobro ya lo \
                 descuenta en su propia transacción, STOCK-01)",
            ),
            (
                "hash_password",
                "con él la pantalla volvería a mandar un hash hecho fuera, que el backend guarda sin \
                 poder exigir la política del PIN ni las iteraciones; el alta y la edición reciben el \
                 PIN y lo hashean dentro (RI-63)",
            ),
            (
                "get_mesas_ocupadas",
                "era la vuelta del plano cuando fallaba `mesas_meta_all`, de antes de que existiera el \
                 detalle de cada mesa; el plano usa sólo el detalle (RI-52)",
            ),
            (
                "proveedores_create_producto",
                "era una segunda alta de producto, sin IVA, sin venta suelta ni alérgenos, cuyo \
                 `ON CONFLICT` pisaba el precio; los productos se dan de alta desde Inventario \
                 (RI-52)",
            ),
        ] {
            assert!(
                !registro.contains(comando),
                "`{comando}` ha vuelto al registro de comandos, y no puede: {porque} (REV-26).
                 Si de verdad hace falta, lo que hay que construir es su gate, no el comando."
            );
        }
    }

    /// REV-24: la webview no puede escribir sobre los ficheros de los que depende el equipo.
    ///
    /// `fs:allow-write-file` iba sin ámbito, y `fs:default` ya permite el directorio de datos de
    /// la aplicación entero: o sea que cualquier código de la webview podía escribir encima de
    /// `data.db`, del estado de licencia o de las copias de seguridad. La CSP es estricta y no hay
    /// `eval`, así que no es una puerta abierta de par en par — pero una dependencia del bundle
    /// está dentro de ese perímetro, y lo que se juega es la base de datos del negocio.
    ///
    /// El permiso se conserva porque hace falta: guardar un PDF en la ruta que elige la persona.
    /// Esa ruta la autoriza el diálogo en tiempo de ejecución (`tauri-plugin-dialog` llama a
    /// `allow_file` con lo que se ha elegido), así que lo único que hay que quitar del alcance es
    /// lo que nunca se escribe desde la interfaz.
    ///
    /// Se lee el fichero de capacidades porque el fallo a impedir no es que algo se comporte mal
    /// hoy: es que mañana alguien añada `fs:allow-write-text-file` sin ámbito y nadie lo note.
    #[test]
    fn la_webview_no_puede_escribir_sobre_los_ficheros_del_equipo() {
        const CAPACIDADES: &str = include_str!("../capabilities/default.json");

        /// Lo que no puede quedar al alcance de un `writeFile` de la webview.
        const INTOCABLES: &[&str] = &[
            "$APPDATA/data.db",
            "$APPDATA/device_config.json",
            "$APPDATA/license_state.json",
            "$APPDATA/traslado-pendiente",
            "$APPDATA/interruptores.json",
            "$APPDATA/backups/**",
        ];

        // Un permiso de escritura suelto (una cadena, sin objeto) no lleva ámbito: eso es
        // exactamente lo que REV-24 encontró.
        for linea in CAPACIDADES.lines().map(str::trim) {
            let suelto = linea.trim_end_matches(',').trim_matches('"');
            assert!(
                !(suelto.starts_with("fs:allow-write") || suelto == "fs:write-all"),
                "`{suelto}` está declarado sin ámbito.
                 Un permiso de escritura de la webview tiene que ir como objeto con su `deny`, o                  vuelve a alcanzar a `data.db` (REV-24)."
            );
        }

        for intocable in INTOCABLES {
            assert!(
                CAPACIDADES.contains(intocable),
                "`{intocable}` ya no está en el `deny` de capabilities/default.json (REV-24).
                 Si el fichero ha cambiado de nombre, cámbialo aquí; si se ha quitado el `deny`,                  la webview puede escribir encima de él."
            );
        }
    }

    /// REV-17: y el que cobra tiene que SACAR de la sesión quién cobra.
    ///
    /// Es el reverso del test de arriba: allí se vigila que nadie ponga el gate donde no cabe, y
    /// aquí que nadie lo quite donde hace falta. El cobrador que se guarda con el pago es el rastro
    /// con el que se investiga un descuadre del cajón, así que aceptarlo de la entrada —como se
    /// hacía— es dejar que cualquiera firme su cobro en efectivo con el nombre de otro.
    ///
    /// Se vigila el fuente y no el comportamiento porque el fallo que hay que impedir no es que un
    /// cobro devuelva mal: es que el **próximo** camino de cobro nazca sin esta línea, que es
    /// exactamente como nacieron los tres que había.
    #[test]
    fn todo_comando_que_cobra_saca_el_cobrador_de_la_sesion() {
        const FUENTES: &[(&str, &str)] = &[
            ("commands/mesas.rs", include_str!("commands/mesas.rs")),
            (
                "commands/venta_rapida.rs",
                include_str!("commands/venta_rapida.rs"),
            ),
        ];

        let mut vistos = 0;
        for (fichero, fuente) in FUENTES {
            for bloque in fuente.split("#[tauri::command]").skip(1) {
                // El cuerpo llega hasta el comando siguiente; con eso basta para mirar dentro.
                let Some(firma) = bloque.split("pub async fn ").nth(1) else {
                    continue;
                };
                let nombre = firma.split('(').next().unwrap_or("").trim();
                if !nombre.contains("cobrar") {
                    continue;
                }
                vistos += 1;
                assert!(
                    bloque.contains("state.sesion()"),
                    "{fichero}::{nombre} no saca el cobrador de la sesión (SEC-01/REV-17).\n\
                     Quién cobra no puede llegar en los argumentos: es el rastro con el que se \
                     investiga un descuadre del cajón."
                );
            }
        }

        // Si mañana se renombran, este test dejaría de mirar nada y seguiría en verde. Eran tres
        // hasta que REV-26 retiró `cobrar_venta_rapida`, que no invocaba nadie.
        assert_eq!(
            vistos, 2,
            "se esperaban 2 comandos de cobro (cobrar_detalles, vr_cobrar_fraccionado); si has \
             añadido o quitado uno, actualiza el número"
        );
    }

    /// PROD-06: ningún interruptor remoto puede impedir cobrar ni emitir el registro fiscal de un
    /// cobro. La lista cerrada ya no tiene nada de eso, pero la forma de romperlo no es añadir un
    /// interruptor «cobrar»: es que alguien consulte uno existente dentro de este camino («si la
    /// remisión está apagada, mejor no emitir»). Por eso se vigila el fuente del camino entero.
    #[test]
    fn ningun_interruptor_toca_el_camino_del_cobro() {
        const FUENTES: &[(&str, &str)] = &[
            ("commands/mesas.rs", include_str!("commands/mesas.rs")),
            ("commands/venta_rapida.rs", include_str!("commands/venta_rapida.rs")),
            ("commands/cuentas.rs", include_str!("commands/cuentas.rs")),
            ("printing.rs", include_str!("printing.rs")),
            (
                "tpv-infra-sqlite/src/mesas.rs",
                include_str!("../../../../crates/tpv-infra-sqlite/src/mesas.rs"),
            ),
            (
                "tpv-infra-sqlite/src/venta_rapida.rs",
                include_str!("../../../../crates/tpv-infra-sqlite/src/venta_rapida.rs"),
            ),
            (
                "tpv-infra-sqlite/src/verifactu.rs",
                include_str!("../../../../crates/tpv-infra-sqlite/src/verifactu.rs"),
            ),
        ];
        for (fichero, fuente) in FUENTES {
            // Sólo el código, sin comentarios: citar `docs/arquitectura/jobs-e-interruptores.md` en
            // un comentario no consulta ningún interruptor, y en `verifactu.rs` lo hacía saltar.
            // Toda consulta real pasa por un identificador (`interruptores::`, `Interruptor`).
            let codigo = fuente
                .lines()
                .map(|linea| linea.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !codigo.to_lowercase().contains("interruptor"),
                "{fichero} consulta un interruptor remoto (PROD-06). Nada de lo que rodea al cobro \
                 puede depender de uno: la regla más firme del producto es que nada impide cobrar."
            );
        }
    }

    /// Y al revés: `login_user` tiene que dejar la sesión puesta, o todos los comandos gateados
    /// dejarían de funcionar — también en la Handy, que pasa por este mismo comando.
    #[test]
    fn login_user_deja_la_sesion_puesta_y_logout_la_quita() {
        let fuente = include_str!("commands/login.rs");
        assert!(
            fuente.contains("iniciar_sesion"),
            "`login_user` debe establecer la sesión: sin eso el gate no deja pasar a nadie"
        );
        assert!(
            fuente.contains("cerrar_sesion"),
            "debe existir el comando `logout` que la limpia"
        );
    }
}
