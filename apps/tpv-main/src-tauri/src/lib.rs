//! Crate de librería `tpv_lib`: contiene TODA la app Tauri (AppState, comandos, `run()`). Es el
//! punto de entrada compartido: en escritorio el binario `main.rs` llama a `run()`; en **móvil** el
//! cdylib `libtpv_lib.so` arranca por el `#[tauri::mobile_entry_point]` de este mismo `run()`.

mod commands;
mod diagnostico;
mod factura_pdf;
mod interruptores;
mod imagenes;
mod replicacion;
mod reservas_web;
mod socket_handy;
mod jobs;
mod navegacion;
mod notificador;
mod pdf;
mod printing;
mod zoom;
#[cfg(target_os = "ios")]
mod vista_ios;

use base64::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use tpv_infra_sqlite::db::Db;

use tpv_application::use_cases::pairing as uc_pairing;
use tpv_application::use_cases::autorizacion_guardada::{self as uc_autorizacion, AutorizacionGuardada};

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
    notificaciones::HttpNotificacionesRepository,
    pedidos_proveedor::HttpPedidoProveedorRepository, proveedores::HttpProveedoresRepository,
    reservas::HttpReservasRepository, stats::HttpStatsRepository, tareas::HttpTareasRepository,
    trabajadores::HttpTrabajadoresRepository, venta_rapida::HttpVentaRapidaRepository, CloudClient,
    CLOUD_API_BASE,
};
use tpv_infra_licensing::{LicensingAdapter, PairingAdapter};
use tpv_infra_licensing::cola_imagenes::ColaImagenes;
use tpv_application::ports::licensing::ResultadoSubidaImagen;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum DeviceMode {
    Tpv,
    Handy,
}

/// SYNC-17: qué hace la Main respecto a la nube. **Ya no es una elección del usuario**: la
/// conectividad es un estado derivado del WebSocket (se intenta siempre y el badge refleja lo que
/// hay). Esto es solo la palanca de emergencia, sin UI ni comando, para el caso patológico —una red
/// que tira el socket en bucle, o alguien que no quiere sus datos en la nube—: se toca a mano, en
/// el campo `connectivity` de `device_config.json`. Nadie avisa al motor de la réplica: la ve en
/// su siguiente comprobación (con la sesión abierta, a los 10 s como mucho con actividad y hasta
/// 30 s en reposo; en `Off`, al acabar su espera, de hasta un minuto).
///
/// `Auto` (por defecto, y lo que se asume si el campo falta): intentar conectar siempre.
/// `Off`: no abrir el WebSocket. La Main sigue siendo Local-First y el outbox sigue capturando,
/// así que al volver a `Auto` se drena lo acumulado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
enum ConnectivityMode {
    Auto,
    Off,
}

/// Lectura tolerante del campo: los `device_config.json` anteriores a SYNC-17 guardan
/// `"offline"`/`"online"` (el ajuste que se ha eliminado). Un valor desconocido tiene que caer a
/// `None` —o sea, `Auto`— y NO reventar el parseo: `load_config` hace `unwrap_or_default()`, así
/// que un error aquí se llevaría por delante también `mode` y `printers` (el dispositivo
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, specta::Type)]
struct DeviceConfig {
    mode: Option<DeviceMode>,
    #[serde(default, deserialize_with = "connectivity_tolerante")]
    connectivity: Option<ConnectivityMode>,
    /// Impresora de tickets por DESTINO (`caja`, `cocina`, …) en este dispositivo físico. Es una
    /// preferencia LOCAL (la impresora está conectada a esta máquina), por eso vive en
    /// `device_config.json` y no en la BD (que se sincroniza entre dispositivos). Hoy solo se usa
    /// `caja`; `cocina` está declarado para que añadir la comanda de cocina no obligue a rehacer el
    /// modelo. Una entrada ausente = ese destino no tiene impresora.
    #[serde(default)]
    printers: std::collections::HashMap<String, String>,
    /// Tamaño de la interfaz fijado a mano en este equipo (`1` = 100 %). Ausente = automático,
    /// según el monitor (`zoom.rs`).
    #[serde(default)]
    zoom: Option<f64>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
struct SetDeviceModeArgs {
    mode: DeviceMode,
}

/// Destino de impresión (`caja` | `cocina`). Ausente = `caja`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
struct DestinoArgs {
    #[serde(default)]
    destino: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
struct SaveImageArgs {
    subfolder: String,
    base64_data: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
struct DeleteImageArgs {
    /// Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`.
    rel_path: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
struct EnsureImageArgs {
    /// Ruta relativa tal cual se guarda en BD: `images/{subcarpeta}/{archivo}`.
    rel_path: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
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

   Es DATO DECLARADO: la AEAT no lo contrasta contra ningún registro de actividad económica. Lo que
   sí valida es el FORMATO (el NIF tiene que tener nueve caracteres) y las longitudes máximas.

   `PRODUCTOR_NIF` está vacío: esta rama no remite a la AEAT, y `SistemaInformatico` NO entra en la
   cadena de huella, así que rellenarlo después no cambia ninguna huella ya calculada. Cómo se
   corrigen los registros emitidos sin él, en la rama `con-verifactu`.
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
    negocio_de_la_licencia(app_data_dir).is_some()
}

/// AUD-06 · El negocio de la licencia, si la base abierta es la suya (su sello). Lo que sube o baja
/// algo de la nube sin pasar por la base (las imágenes) lo pregunta, y lo lleva consigo.
pub(crate) async fn negocio_de_la_base_en_uso(state: &AppState, app_data_dir: &Path) -> Option<String> {
    let negocio = negocio_de_la_licencia(app_data_dir)?;
    let db = state.db.lock().await.as_ref().cloned()?;
    match tpv_infra_sqlite::recovery::base_del_negocio(&db, &negocio).await {
        Ok(true) => Some(negocio),
        _ => None,
    }
}

/// AUD-06 · El negocio de la licencia vigente en este equipo, si la hay. Con él se abre la base:
/// una base sólo se usa con la licencia de su negocio (`connection::init_main_db`). Una licencia
/// pendiente de reinicio no cuenta: es la vigente hasta que el arranque la cambie.
pub(crate) fn negocio_de_la_licencia(app_data_dir: &Path) -> Option<String> {
    use tpv_application::ports::licensing::LicensingService;
    match LicensingAdapter::new(app_data_dir.to_path_buf()).load_state() {
        Ok(Some(st)) if !st.tenant_id.trim().is_empty() => Some(st.tenant_id.trim().to_string()),
        _ => None,
    }
}

/// AUD-06 · Si se activó la licencia de otro negocio, el arranque aparta los datos del anterior y
/// la aplica (`use_cases::licensing::aplicar_cambio_de_negocio_pendiente`) antes de abrir la base
/// y de leer la licencia para nada. Va antes que cualquier tarea: hasta aquí, nada del negocio nuevo
/// existe en el proceso.
///
/// El proceso de antes puede tardar un instante en soltar la base al reiniciarse: un fallo se
/// reintenta unas cuantas veces, que el cambio se puede repetir desde cualquier punto.
fn aplicar_cambio_de_negocio_al_arrancar(app_data_dir: &Path) -> tpv_application::error::AppResult<Option<String>> {
    use tpv_application::use_cases::licensing as uc_licencia;
    let licencias = LicensingAdapter::new(app_data_dir.to_path_buf());
    let base = tpv_infra_sqlite::recovery::BaseLocal::new(app_data_dir, None);
    let mut intento = 1;
    loop {
        match tauri::async_runtime::block_on(uc_licencia::aplicar_cambio_de_negocio_pendiente(&licencias, &base)) {
            Err(e) if intento < 10 && tpv_infra_sqlite::recovery::hay_cambio_de_negocio_pendiente(app_data_dir) => {
                tracing::warn!(target: "tpv::startup", intento, error = %e, "no se pudo terminar el cambio de negocio; se reintenta");
                intento += 1;
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            resultado => return resultado,
        }
    }
}

/// AUD-06 · Con un cambio de negocio a medias (el arranque no pudo terminarlo), no se abre ni se
/// instala ninguna base en caliente: sería la del negocio anterior. Lo termina el arranque.
pub(crate) fn sin_cambio_de_negocio_a_medias(app_data_dir: &Path) -> Result<(), AppErrorDto> {
    if tpv_infra_sqlite::recovery::hay_cambio_de_negocio_pendiente(app_data_dir) {
        return Err(tpv_application::error::AppError::conflict(
            "El TPV está cambiando de licencia y no ha podido terminar. Ciérralo y vuelve a abrirlo.",
        )
        .into());
    }
    Ok(())
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

    // AUD-28: el nombre del fichero y no la ruta de AppData, que lleva el usuario de Windows; el
    // mensaje sale del equipo con el fallo del comando. El `io::Error` no cita la ruta.
    fs::write(&tmp, &txt)
        .map_err(|e| format!("No se pudo guardar la configuración del equipo (device_config.json.tmp): {e}"))?;
    fs::rename(&tmp, &p)
        .map_err(|e| format!("No se pudo guardar la configuración del equipo (device_config.json): {e}"))?;

    Ok(())
}

fn ensure_folders(app_data_dir: &Path) -> Result<(), String> {
    let folders = ["", "images", "images/categorias", "images/productos", "images/logo"];

    for carpeta in folders {
        let f = app_data_dir.join(carpeta);
        if !f.exists() {
            // AUD-28: la carpeta dentro de AppData, sin la ruta: un fallo aquí acaba en el pánico
            // del arranque, que va a Sentry.
            let nombre = if carpeta.is_empty() { "la carpeta de datos" } else { carpeta };
            fs::create_dir_all(&f).map_err(|e| format!("No se pudo crear {nombre}: {e}"))?;
        }
    }

    Ok(())
}

fn normalize_required(input: &str, mensaje: &str) -> Result<String, String> {
    let out = input.trim().to_string();

    if out.is_empty() {
        return Err(mensaje.to_string());
    }

    Ok(out)
}

/* =========================================================
   Imágenes: procesado (resize + recompresión JPEG) + cola de subida a R2
========================================================= */

// RI-67: solo un drenaje a la vez; encolar no espera a las subidas HTTP.
static DRENAJE_IMAGENES: Mutex<()> = Mutex::const_new(());

fn enqueue_image(app_data_dir: &Path, rel_path: &str, content_type: &str) -> Result<(), String> {
    ColaImagenes::new(app_data_dir).encolar(rel_path, content_type)
}

/// Valida que una ruta relativa de imagen tenga la forma esperada y no escape de `images/`
/// (evita borrar/leer ficheros arbitrarios desde el frontend).
fn is_safe_image_rel_path(rel: &str) -> bool {
    imagenes::ruta_segura(rel)
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
    /// RI-29: los cobros cuyo ticket original ya ha salido en esta sesión. Volver a imprimirlo
    /// saca una COPIA, que no abre el cajón.
    tickets_impresos: Arc<printing::TicketsImpresos>,
    /// PERM-CACHE: la autorización de la sesión, guardada entre gates. Sólo vale en la Handy y con
    /// el socket de avisos abierto (`use_cases::autorizacion_guardada`); en la Main no se usa.
    autorizacion: Arc<std::sync::Mutex<AutorizacionGuardada>>,
    /// Cómo se entera la pantalla de la Main de un aviso que se crea o se resuelve aquí mismo
    /// (`notificador.rs`). En la Handy no se usa.
    avisar_notificaciones: notificador::AvisarPantalla,
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
    /// Identidad de la ficha de trabajador para comandas y tareas propias (RI-22).
    pub id_trabajador: Option<String>,
    pub rol: String,
    /// Cuándo se abrió (ms). Con `id_usuario` identifica la sesión: la autorización guardada
    /// (PERM-CACHE) sólo vale para la misma, y `autorizacion()` descarta la respuesta de una
    /// consulta que termina después de un logout o de un cambio de usuario.
    pub iniciada_en: i64,
}

/// El rol privilegiado. Está aquí y no repartido por los comandos para que renombrarlo sea un
/// sitio, no una docena.
pub(crate) const ADMIN: &str = tpv_domain::permisos::ADMIN;

pub(crate) fn permiso_denegado(detalle: impl Into<String>) -> AppErrorDto {
    AppErrorDto::new(tpv_contracts::errors::ErrorCode::PermisoDenegado, detalle)
}

/// Ahora, por los dos relojes del equipo: con ellos se mide la edad de la autorización guardada
/// (PERM-CACHE). El monótono cuenta desde la primera vez que se pregunta.
fn instante() -> uc_autorizacion::Instante {
    static ORIGEN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    uc_autorizacion::Instante {
        monotono_ms: ORIGEN.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64,
        reloj_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64),
    }
}

/// Conecta el callback local del outbox con el ciclo WebSocket. Se usa en los tres puntos donde
/// puede nacer un `Db`: arranque, elección de modo y sustitución por una copia restaurada.
pub(crate) fn configure_outbox_notifier(app: &AppHandle, db: &Arc<Db>) {
    let h = app.clone();
    db.set_outbox_notifier(move || {
        if let Some(sync) = h.try_state::<replicacion::SyncNativo>() { sync.despertar.notify_one(); }
    });
}

/// TRAB-03: construye el cifrador de campo con la DEK guardada en el almacén de secretos.
///
/// Devuelve `None` cuando no hay clave (instalación todavía sin activar) o cuando la que hay
/// no es utilizable. En ese caso el repositorio opera en claro: es preferible a impedir dar de
/// alta a un trabajador. La DEK llega en la respuesta de activación y no se vuelve a pedir.
///
/// AUD-06: la del negocio de la base que se va a cifrar (su sello). La de otro no se entrega.
fn field_cipher(negocio: Option<&str>) -> Option<Arc<dyn tpv_application::ports::field_cipher::FieldCipher>> {
    let dek = match tpv_infra_licensing::device::get_field_dek_de(negocio?) {
        Ok(Some(d)) => d,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!("no se pudo leer la field_dek del almacén de secretos: {e}");
            return None;
        }
    };

    match tpv_infra_licensing::field_crypto::FieldCipherAes::new(&dek) {
        Ok(c) => Some(Arc::new(c)),
        Err(e) => {
            tracing::warn!("field_dek inválida, se opera sin cifrado de campo: {e}");
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
        Ok(self.autorizacion().await?.0)
    }

    async fn autorizacion(&self) -> Result<(Sesion, tpv_contracts::permisos::AutorizacionUsuario), AppErrorDto> {
        let mut s = self.sesion.lock().await.clone().ok_or_else(|| permiso_denegado("Inicia sesión para hacer esto"))?;
        let repo = self.permisos_repo().await?;
        // PERM-CACHE: en la Handy, con el socket de avisos abierto, vale lo que se leyó la última
        // vez. En la Main (y en la Handy sin socket) se lee siempre.
        let permisos = uc_autorizacion::usuario_de_la_sesion(repo.as_ref(), &self.autorizacion, &s.id_usuario, s.iniciada_en, instante).await?;
        // Una consulta HTTP puede terminar después de un logout o un cambio de usuario.
        if !self.sesion.lock().await.as_ref().is_some_and(|actual| actual.id_usuario == s.id_usuario && actual.iniciada_en == s.iniciada_en) {
            return Err(permiso_denegado("La sesión ha cambiado"));
        }
        s.rol = permisos.rol.clone();
        Ok((s, permisos))
    }

    pub(crate) async fn exigir_permiso(&self, permiso: &str) -> Result<Sesion, AppErrorDto> {
        Ok(self.exigir_permiso_con_contexto(permiso).await?.0)
    }

    pub(crate) async fn exigir_permiso_con_contexto(&self, permiso: &str) -> Result<(Sesion, tpv_contracts::permisos::AutorizacionUsuario), AppErrorDto> {
        let (s, u) = self.autorizacion().await?;
        if !tpv_domain::permisos::permite(&u.rol, &u.permisos, permiso) {
            return Err(permiso_denegado("No tienes permiso para esta acción"));
        }
        Ok((s, u))
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
        self.olvidar_autorizacion();
    }

    /// La limpia. La llama el comando `logout` — y con él el cierre por inactividad y el
    /// arranque del frontend, que barre una sesión que hubiera quedado colgada tras un F5.
    pub(crate) async fn cerrar_sesion(&self) {
        *self.sesion.lock().await = None;
        self.olvidar_autorizacion();
    }

    /* ── PERM-CACHE: cuándo deja de valer la autorización guardada ───────────────────────────
       Las reglas están en `use_cases::autorizacion_guardada`. Aquí sólo llegan los tres avisos:
       cambia la sesión o este equipo escribe en `Usuarios` (`olvidar_autorizacion`), cambia el
       socket de avisos (`canal_de_avisos`) o llega un cambio de otro equipo (`aviso_de_cambio`). */

    fn autorizacion_guardada(&self) -> std::sync::MutexGuard<'_, AutorizacionGuardada> {
        self.autorizacion.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// La sesión cambia, o este equipo acaba de escribir algo de lo que sale la autorización: su
    /// propio cambio no le vuelve como aviso.
    pub(crate) fn olvidar_autorizacion(&self) {
        self.autorizacion_guardada().olvidar();
    }

    /// El socket de avisos de la Handy ha cambiado de estado (`socket_handy.rs`).
    pub(crate) fn canal_de_avisos(&self, canal: Option<uc_autorizacion::Canal>) {
        self.autorizacion_guardada().canal(canal);
    }

    /// Ha llegado un cambio de otro equipo. Va antes de avisar a la pantalla, que relee sus
    /// permisos al enterarse.
    pub(crate) fn aviso_de_cambio(&self, cambio: &tpv_contracts::sync::CambioReplicado) {
        self.autorizacion_guardada().aviso(cambio);
    }

    repo_accessor!(permisos_repo, tpv_application::ports::permisos::PermisosRepository,
        tpv_infra_sqlite::permisos::SqlitePermisosRepository, tpv_infra_http::permisos::HttpPermisosRepository);
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
    // PED-HANDY: los pedidos a proveedores también se gestionan desde la Handy, contra la nube.
    repo_accessor!(
        pedidos_proveedor_repo,
        PedidoProveedorRepository,
        SqlitePedidoProveedorRepository,
        HttpPedidoProveedorRepository
    );
    repo_accessor!(
        reservas_repo,
        ReservasRepository,
        SqliteReservasRepository,
        HttpReservasRepository
    );
    // El correo al cliente de una reserva web que el restaurante cambia (docs/estudios/reservas-web.md
    // §5.7): la Main lo encola para su job; la Handy lo manda ya.
    repo_accessor!(
        avisos_reserva_web,
        tpv_application::ports::reservas::AvisosReservaWeb,
        tpv_infra_sqlite::reservas_web_avisos::SqliteAvisosReservaWeb,
        tpv_infra_http::reservas::HttpAvisosReservaWeb
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
                let negocio = tpv_infra_sqlite::sello::leer(&conn.read().await).await.ok().flatten();
                Ok(Arc::new(SqliteTrabajadoresRepository::with_cipher(
                    conn,
                    field_cipher(negocio.as_deref()),
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
    /// El puerto de emisión `Notifier`: en la Handy, el adaptador HTTP (`emitir` va por REST → DO
    /// → broadcast, y el aviso le vuelve por el socket); en la Main, el SQLite envuelto para que su
    /// pantalla se entere de lo que se crea o se resuelve aquí (`notificador.rs`).
    pub(crate) async fn notifier(&self) -> Result<Arc<dyn Notifier>, String> {
        match *self.mode.lock().await {
            Some(DeviceMode::Tpv) => {
                let conn = self
                    .db
                    .lock()
                    .await
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "DB no inicializada (modo TPV)".to_string())?;
                Ok(Arc::new(notificador::NotifierDeLaMain::new(
                    SqliteNotificacionesRepository::new(conn),
                    self.avisar_notificaciones.clone(),
                )) as Arc<dyn Notifier>)
            }
            Some(DeviceMode::Handy) => {
                let client = self.cloud.lock().await.as_ref().cloned().ok_or_else(|| {
                    "Cliente nube no inicializado (modo Handy)".to_string()
                })?;
                Ok(Arc::new(HttpNotificacionesRepository::new(client)) as Arc<dyn Notifier>)
            }
            None => Err("Modo de dispositivo no seleccionado".to_string()),
        }
    }

    /// La base local, para lo que **sólo existe en la Main**: los registros de facturación, el
    /// ticket de un cobro, la reserva web, la réplica y lo que recorren los jobs.
    ///
    /// Pedirlo desde una Handy no es un fallo del programa: es algo que ese equipo no tiene. Se
    /// contesta `conflict` —el estado del equipo no admite la operación—, como hacen sus
    /// repositorios HTTP con la caja, y con la frase que se enseña. Como `internal` contaría como
    /// fallo del programa e iría a Sentry (`fallosDeComandos.ts`). Una Main sin su base sí lo es.
    async fn base_de_la_main(&self, solo_en_la_main: &str) -> Result<Arc<Db>, AppErrorDto> {
        if *self.mode.lock().await == Some(DeviceMode::Handy) {
            return Err(AppErrorDto::new(
                tpv_contracts::errors::ErrorCode::Conflict,
                solo_en_la_main,
            ));
        }
        self.db
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or_else(|| AppErrorDto::internal("La base de datos de este TPV no está abierta"))
    }

    /// Registros de facturación (FISCAL-01). **No es mode-switched: sólo existe en la Main.**
    ///
    /// La Handy no cobra (`soloLaMainCobra`), así que no emite registros — y no debe poder
    /// hacerlo. La cadena de huellas vive en el SIF del obligado, que es este equipo; la nube es
    /// una copia para poder recuperarla, no una fuente. El veto también está en el worker
    /// (`applyViaHub`), porque una regla que sólo vive en el cliente es una sugerencia.
    pub(crate) async fn verifactu_repo(&self) -> Result<Arc<dyn VerifactuRepository>, AppErrorDto> {
        let conn = self
            .base_de_la_main("Los registros de facturación sólo existen en el TPV principal")
            .await?;
        Ok(Arc::new(SqliteVerifactuRepository::new(conn)) as Arc<dyn VerifactuRepository>)
    }

    /// Las fichas de cliente desde el formulario de la factura completa (FISCAL-02). Sólo en la Main,
    /// que es la que cobra y factura.
    pub(crate) async fn clientes_factura_repo(
        &self,
    ) -> Result<Arc<dyn tpv_application::ports::clientes::ClientesFacturaRepository>, AppErrorDto> {
        let conn = self
            .base_de_la_main("Los clientes de una factura se eligen en el TPV principal")
            .await?;
        Ok(Arc::new(SqliteClientesRepository::new(conn)))
    }

    /// La base de la que salen las facturas completas de las fichas de cliente y su PDF. Sólo en la
    /// Main: es la que factura y la que guarda los registros y los PDF.
    pub(crate) async fn base_de_las_facturas(&self) -> Result<Arc<Db>, AppErrorDto> {
        self.base_de_la_main("Las facturas de los clientes se ven en el TPV principal").await
    }

    /// Las fichas de cliente y sus facturas completas (las de su NIF). Sólo en la Main.
    pub(crate) async fn facturas_de_clientes_repos(
        &self,
    ) -> Result<
        (
            Arc<dyn ClientesRepository>,
            Arc<dyn tpv_application::ports::facturas_pdf::FacturasDeClienteRepository>,
        ),
        AppErrorDto,
    > {
        let conn = self.base_de_las_facturas().await?;
        Ok((
            Arc::new(SqliteClientesRepository::new(conn.clone())),
            Arc::new(tpv_infra_sqlite::facturas_pdf::SqliteFacturasPdf::new(conn)),
        ))
    }

    /// El ticket de un cobro (RI-29). Tampoco es mode-switched: imprime la Main, que es la que cobra,
    /// la que tiene la impresora y la que guarda los registros de facturación.
    pub(crate) async fn tickets_repo(&self) -> Result<Arc<dyn TicketsRepository>, AppErrorDto> {
        let conn = self
            .base_de_la_main("Los tickets sólo se imprimen en el TPV principal")
            .await?;
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

    /// El mismo repositorio de sincronización, para los comandos que se pueden pedir desde una
    /// Handy (el panel de salud de Conectividad): ahí no hay base que sincronizar, y decirlo no es
    /// un fallo del programa (`base_de_la_main`). La réplica, la recuperación y los jobs siguen
    /// con `sync_repo`, que sólo corren en la Main.
    pub(crate) async fn sync_repo_de_la_main(
        &self,
        solo_en_la_main: &str,
    ) -> Result<Arc<dyn SyncRepository>, AppErrorDto> {
        let conn = self.base_de_la_main(solo_en_la_main).await?;
        Ok(Arc::new(SqliteSyncRepository::new(conn)) as Arc<dyn SyncRepository>)
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
    ///
    /// Los repositorios de aquí abajo son sólo de la Main. Los jobs que los usan no corren en una
    /// Handy (`Requiere::MainOperativa`), pero algunos comandos que se pueden pedir desde ella sí
    /// (recalcular el gasto de un cliente, la reserva web): allí contestan `conflict` con la frase
    /// que se enseña (`base_de_la_main`), no un error interno que iría a Sentry como un fallo del
    /// programa.
    pub(crate) async fn jobs_state_repo(&self) -> Result<Arc<dyn JobsStateRepository>, AppErrorDto> {
        let conn = self.base_de_la_main("Las tareas periódicas sólo corren en el TPV principal").await?;
        Ok(Arc::new(SqliteJobsStateRepository::new(conn)) as Arc<dyn JobsStateRepository>)
    }

    /// Reconciliación de los valores derivados (DB-14): el job y el botón de recalcular el gasto
    /// de un cliente.
    pub(crate) async fn reconciliacion_repo(
        &self,
    ) -> Result<Arc<dyn ReconciliacionRepository>, AppErrorDto> {
        let conn = self
            .base_de_la_main("El gasto de un cliente se recalcula desde el TPV principal")
            .await?;
        Ok(Arc::new(SqliteReconciliacionRepository::new(conn))
            as Arc<dyn ReconciliacionRepository>)
    }

    /// Escáner de avisos (tareas vencidas / reservas próximas).
    pub(crate) async fn avisos_scan_repo(&self) -> Result<Arc<dyn AvisosScanRepository>, AppErrorDto> {
        let conn = self.base_de_la_main("Los avisos se buscan en el TPV principal").await?;
        Ok(Arc::new(SqliteAvisosScanRepository::new(conn)) as Arc<dyn AvisosScanRepository>)
    }

    /// Escáner de stock negativo (sobreventa).
    pub(crate) async fn stock_alertas_repo(
        &self,
    ) -> Result<Arc<dyn StockAlertasRepository>, AppErrorDto> {
        let conn = self.base_de_la_main("Las alertas de stock se buscan en el TPV principal").await?;
        Ok(Arc::new(SqliteStockAlertasRepository::new(conn)) as Arc<dyn StockAlertasRepository>)
    }

    /// La reserva desde la web (docs/estudios/reservas-web.md): su configuración es de la Main.
    pub(crate) async fn reservas_web_repo(
        &self,
    ) -> Result<Arc<dyn tpv_application::ports::reservas_web::ReservasWebRepository>, AppErrorDto> {
        let conn = self
            .base_de_la_main("La reserva desde la web se configura en el TPV principal")
            .await?;
        Ok(Arc::new(tpv_infra_sqlite::reservas_web::SqliteReservasWebRepository::new(conn)))
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos: modo device + init main
// ──────────────────────────────────────────────────────────────────────────────

#[tauri::command(async)]
#[specta::specta]
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
#[tauri::command(async)]
#[specta::specta]
fn get_connection_mode(app: AppHandle) -> Result<Option<ConnectivityMode>, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(load_config(&app_data_dir).connectivity)
}

#[tauri::command]
#[specta::specta]
async fn set_device_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SetDeviceModeArgs,
) -> Result<String, AppErrorDto> {
    // RI-70: una sesión no se traslada entre SQLite y otro backend/tenant.
    state.cerrar_sesion().await;
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

    socket_handy::contexto_cambiado(&app);
    Ok("OK".into())
}

#[tauri::command]
#[specta::specta]
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
    // AUD-06: una apertura en caliente no termina un cambio de negocio: lo hace el arranque.
    sin_cambio_de_negocio_a_medias(&app_data_dir)?;

    // `init_main_db` devuelve el `Db` ya montado: escritor único serializado + pool de lectura
    // (WAL), tablas de control creadas y admin sembrado. La captura de escrituras al outbox está
    // SIEMPRE activa (también offline): el outbox es el log de cambios local; se drena a la nube
    // cuando el modo es "online".
    let db = tpv_infra_sqlite::connection::init_main_db(
        &app_data_dir,
        negocio_de_la_licencia(&app_data_dir).as_deref(),
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
#[specta::specta]
async fn device_reset_mode(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    // SEC-01: con la app abierta esto es de administrador (Configuración → Dispositivo). Sin
    // sesión pasa, porque el otro camino que lleva aquí es el «← Volver» de la activación de la
    // licencia, donde todavía no hay con quién iniciar sesión. AUD-23: el «← Volver» de la
    // vinculación de la Handy ya no llega aquí (enseña el selector sin tocar nada guardado), así
    // que en la Handy sólo lo pide Configuración. No se endurece para ella: `handy_set_token`, que
    // va sin sesión para poder emparejar, sustituye el vínculo igual, y el IPC no es una frontera
    // (docs/arquitectura/permisos.md).
    state.exigir_rol_si_hay_sesion(&[ADMIN]).await?;

    state.cerrar_sesion().await;

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

    socket_handy::contexto_cambiado(&app);
    Ok("OK".into())
}

// ──────────────────────────────────────────────────────────────────────────────
// Comandos genéricos
// ──────────────────────────────────────────────────────────────────────────────

/// RI-07: reconstruye una imagen en su formato real y devuelve su ruta relativa.
#[tauri::command]
#[specta::specta]
async fn save_image(app: AppHandle, state: State<'_, AppState>, args: SaveImageArgs) -> Result<String, AppErrorDto> {
    match args.subfolder.as_str() {
        "logo" => { state.exigir_rol(&[ADMIN]).await?; },
        "productos" | "categorias" => { state.exigir_permiso("catalogo.editar").await?; },
        "proveedores" => { state.exigir_permiso("proveedores.gestionar").await?; },
        _ => { state.sesion().await?; },
    }

    let subfolder = normalize_required(&args.subfolder, "Falta la carpeta de la imagen.")?;
    // La carpeta, con un nombre de los que pone la app (OBS-06: sólo se admite un UUID).
    if !is_safe_image_rel_path(&format!("images/{subfolder}/{}.jpg", uuid::Uuid::nil())) {
        return Err("Carpeta de imagen no válida".into());
    }
    // Base64 añade un tercio: limitar antes de decodificar o copiar la entrada.
    if args.base64_data.len() > imagenes::MAX_BYTES.div_ceil(3) * 4 {
        return Err("La imagen debe pesar como máximo 5 MB".into());
    }
    let raw_bytes = BASE64_STANDARD.decode(&args.base64_data).map_err(|_| "Imagen Base64 no válida")?;
    let (processed, extension) = tokio::task::spawn_blocking(move || imagenes::procesar(&raw_bytes))
        .await.map_err(|e| format!("Error procesando imagen: {e}"))??;
    let rel_path = format!("images/{subfolder}/{}.{}", uuid::Uuid::new_v4(), extension);
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file_path = imagenes::destino(&app_data_dir, &rel_path, true)?;
    fs::write(file_path, processed).map_err(|e| format!("No se ha podido guardar la imagen: {e}"))?;
    enqueue_image(&app_data_dir, &rel_path, content_type_for(&rel_path))?;
    let _ = app.emit("images:queue_changed", ());
    Ok(rel_path)
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

    let modo = *state.mode.lock().await;
    let Some(mode_str) = signing_mode(modo) else {
        return Ok("sin_modo".into());
    };

    // PROD-06: apagado desde la nube. Aquí y no en el job porque la cola también la drenan el
    // evento de guardar una imagen y la reconexión del WebSocket. Lo pendiente sigue en su fichero.
    if interruptores::apagado(app, tpv_contracts::interruptores::Interruptor::Imagenes).is_some() {
        return Ok("apagado".into());
    }

    // AUD-06: la cola es del negocio del equipo, y se sube con las credenciales del de la licencia.
    // En la Main, sólo si la base abierta es la de ese negocio (su sello). Y cada subida lleva el
    // negocio con el que empezó: el adaptador no la firma con un token de otro.
    let negocio = match modo {
        Some(DeviceMode::Tpv) => match negocio_de_la_base_en_uso(state, &app_data_dir).await {
            Some(negocio) => negocio,
            None => return Ok("base_de_otro_negocio".into()),
        },
        _ => match uc_pairing::handy_get_tenant(&PairingAdapter::new(app_data_dir.clone())) {
            Ok(Some(negocio)) => negocio,
            _ => return Ok("sin_negocio".into()),
        },
    };

    let Ok(_guard) = DRENAJE_IMAGENES.try_lock() else { return Ok("en_curso".into()); };
    let cola = ColaImagenes::new(&app_data_dir);
    let pendientes = cola.pendientes()?;
    let svc = PairingAdapter::new(app_data_dir.clone());
    let mut subidas = 0u32;
    let mut apartadas = 0u32;
    let mut ultimo_error = None;
    for imagen in pendientes {
        let rechazo = match imagenes::destino(&app_data_dir, &imagen.rel_path, false) {
            Ok(ruta) => match imagenes::leer_para_subida(&ruta) {
                Ok(Some(bytes)) => {
                    let path = format!("/v1/images/{}", imagen.rel_path);
                    match uc_pairing::upload_image(&svc, mode_str, &path, &imagen.content_type, bytes, &negocio).await {
                        Ok(ResultadoSubidaImagen::Subida) => {
                            cola.terminar(&imagen, None)?;
                            subidas += 1;
                            let _ = app.emit("images:queue_changed", ());
                            continue;
                        }
                        Ok(ResultadoSubidaImagen::Rechazada { motivo }) => motivo,
                        Err(error) => {
                            // Red, credenciales o servidor: conservar y esperar al siguiente disparador.
                            ultimo_error = Some(error.to_string());
                            break;
                        }
                    }
                }
                Ok(None) => "La imagen supera 5 MB. Sustitúyela desde su ficha.".to_string(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound =>
                    "No se encuentra el archivo. Sustituye la imagen en su ficha.".to_string(),
                Err(error) => {
                    ultimo_error = Some(format!("No se pudo leer la imagen: {error}"));
                    continue;
                }
            },
            Err(error) => error,
        };
        if cola.terminar(&imagen, Some(&rechazo))? {
            apartadas += 1;
            // La capa tracing -> Sentry ya existe: avisar una vez, tras persistir el rechazo.
            // AUD-28: la imagen sin el nombre que alguien le dio (`para_registro`).
            tracing::error!(target: "tpv::imagenes", ruta = %imagenes::para_registro(&imagen.rel_path),
                motivo = %rechazo, "image_upload_rejected");
            let _ = app.emit("images:queue_changed", ());
        }
        // Una imagen rechazada no impide subir la siguiente.
    }
    let estado = cola.estado()?;
    let resumen = format!("subidas={subidas} apartadas={apartadas} pendientes={}", estado.pendientes);
    match ultimo_error {
        Some(error) => Err(format!("{resumen}: {error}")),
        None => Ok(resumen),
    }
}

#[tauri::command]
#[specta::specta]
async fn images_drain_pending(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    drenar_imagenes(&app, &state)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
async fn images_upload_status(app: AppHandle, state: State<'_, AppState>)
    -> Result<tpv_contracts::imagenes::EstadoColaImagenes, AppErrorDto> {
    state.exigir_rol(&[tpv_domain::permisos::ADMIN]).await?;
    let carpeta = app.path().app_data_dir().map_err(|e| e.to_string())?;
    ColaImagenes::new(&carpeta).estado().map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
async fn images_retry_upload(app: AppHandle, state: State<'_, AppState>, args: tpv_contracts::imagenes::ReintentarImagenArgs)
    -> Result<(), AppErrorDto> {
    state.exigir_rol(&[tpv_domain::permisos::ADMIN]).await?;
    let carpeta = app.path().app_data_dir().map_err(|e| e.to_string())?;
    imagenes::destino(&carpeta, &args.rel_path, false)?;
    ColaImagenes::new(&carpeta).reintentar(&args.rel_path)?;
    let _ = app.emit("images:queue_changed", ());
    Ok(())
}

/// Borra una imagen: del disco local y (best-effort) del bucket R2. Se usa al reemplazar la
/// imagen de un producto/categoría/proveedor para no dejar huérfanos ni servir caché obsoleta.
#[tauri::command]
#[specta::specta]
async fn images_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    args: DeleteImageArgs,
) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let rel_path = normalize_required(&args.rel_path, "Falta la ruta de la imagen.")?;
    if !is_safe_image_rel_path(&rel_path) {
        return Err("La ruta de la imagen no es válida.".into());
    }

    ColaImagenes::new(&app_data_dir).descartar(&rel_path)?;
    let _ = app.emit("images:queue_changed", ());
    // Borrado local (ignoramos si ya no existe).
    let _ = fs::remove_file(imagenes::destino(&app_data_dir, &rel_path, false)?);

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
#[specta::specta]
async fn images_ensure_local(
    app: AppHandle,
    state: State<'_, AppState>,
    args: EnsureImageArgs,
) -> Result<bool, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let rel_path = normalize_required(&args.rel_path, "Falta la ruta de la imagen.")?;
    if !is_safe_image_rel_path(&rel_path) {
        return Err("La ruta de la imagen no es válida.".into());
    }

    let file_path = imagenes::destino(&app_data_dir, &rel_path, false)?;
    if file_path.exists() {
        return Ok(true);
    }

    let modo = *state.mode.lock().await;
    let Some(mode_str) = signing_mode(modo) else {
        return Ok(false);
    };

    // AUD-06: en la Main, lo que baja es del negocio de la licencia y va a la carpeta de imágenes
    // de su base: sólo si la base abierta es la de ese negocio (su sello).
    if modo == Some(DeviceMode::Tpv) && negocio_de_la_base_en_uso(&state, &app_data_dir).await.is_none() {
        return Ok(false);
    }

    let svc = PairingAdapter::new(app_data_dir.clone());
    match uc_pairing::download_image(&svc, mode_str, &rel_path).await {
        Ok(Some(bytes)) => {
            // AUD-31: lo que baja de R2 pasa por RI-07 antes de llegar al disco, como lo que se guarda
            // aquí (`save_image`): JPEG o PNG, dentro de sus cotas, y reconstruido. Lo que no pasa no se
            // escribe, y la pantalla pinta el marcador (`imageUrl.ts` recibe `false`).
            let bytes = match imagenes::procesar(&bytes) {
                Ok((reconstruida, _)) => reconstruida,
                Err(e) => {
                    tracing::warn!(target: "tpv::imagenes", ruta = %imagenes::para_registro(&rel_path), error = %e,
                        "imagen de R2 que no pasa RI-07: no se guarda");
                    return Ok(false);
                }
            };
            let file_path = imagenes::destino(&app_data_dir, &rel_path, true)?;
            // AUD-28: sin la ruta de AppData ni el nombre que alguien le dio a la imagen.
            fs::write(&file_path, bytes).map_err(|e| {
                format!("No se pudo guardar la imagen descargada ({}): {e}", imagenes::para_registro(&rel_path))
            })?;
            Ok(true)
        }
        // Aún no está en R2 (404) o falló la red: no es un error duro, el UI reintentará.
        Ok(None) => Ok(false),
        Err(e) => {
            // WARN y no DEBUG: si esto falla, la imagen no está ni en disco ni en R2 y la UI la
            // reintentará en cada resolución. Merece verse en Axiom, no sólo en la consola de dev.
            tracing::warn!(target: "tpv::imagenes", ruta = %imagenes::para_registro(&rel_path), error = %e,
                "fallo bajando imagen de R2");
            Ok(false)
        }
    }
}

/// Las carpetas de las imágenes que usan las filas del negocio (`Ruta_Imagen`): las que repasa el
/// backfill.
const CARPETAS_DEL_BACKFILL: [&str; 4] = ["productos", "categorias", "proveedores", "alergenos"];

/// OBS-06 · Las imágenes heredadas (guardadas antes de que la app les pusiera un UUID, con el nombre
/// que alguien le dio al fichero) pasan a un nombre opaco antes de que ese nombre salga en ninguna
/// petición: la ruta de una imagen viaja en la URL con la que se sube, se sirve y se borra.
///
/// Por cada una que usa alguna fila: se copia con su nombre nuevo, se encola la copia, se cambian
/// las filas que la usan (`tpv_infra_sqlite::imagenes::renombrar_imagen`, por `WriteGuard`, así que
/// sube a la nube), se borra el fichero de antes y se quita de la cola el viejo si estaba. En ese
/// orden, si algo se corta a medias las filas apuntan a un fichero que existe y está en la cola: la
/// copia se encola antes de cambiar las filas porque, cambiadas, ya no es heredada y el marcador del
/// backfill no la volvería a encolar. Una copia que se queda sin filas (el cambio falla o se corta
/// antes) sale de la cola si se puede, y si no, se sube sin que la use nadie. Una heredada que no usa
/// nadie se queda como está: ni se renombra ni se sube. Devuelve cuántas ha renombrado.
async fn renombrar_imagenes_heredadas(app_data_dir: &Path, db: &Db) -> Result<u32, String> {
    let cola = ColaImagenes::new(app_data_dir);
    let mut renombradas = 0u32;
    for sub in CARPETAS_DEL_BACKFILL {
        let Ok(entradas) = fs::read_dir(app_data_dir.join("images").join(sub)) else {
            continue;
        };
        for entrada in entradas.flatten() {
            let origen = entrada.path();
            if !origen.is_file() {
                continue;
            }
            let Some(nombre) = entrada.file_name().to_str().map(String::from) else {
                continue;
            };
            let antes = format!("images/{sub}/{nombre}");
            let Some(despues) = imagenes::nombre_opaco(&antes) else {
                continue;
            };
            if !tpv_infra_sqlite::imagenes::imagen_en_uso(db, &antes).await.map_err(|e| e.to_string())? {
                continue;
            }
            let destino = imagenes::destino(app_data_dir, &despues, false)?;
            fs::copy(&origen, &destino).map_err(|e| format!("No se pudo copiar una imagen heredada: {e}"))?;
            let deshacer_la_copia = || {
                let _ = cola.descartar(&despues);
                let _ = fs::remove_file(&destino);
            };
            if let Err(e) = enqueue_image(app_data_dir, &despues, content_type_for(&despues)) {
                deshacer_la_copia();
                return Err(e);
            }
            match tpv_infra_sqlite::imagenes::renombrar_imagen(db, &antes, &despues).await {
                Ok(0) => {
                    // Entretanto ha dejado de usarla nadie.
                    deshacer_la_copia();
                    continue;
                }
                Ok(_) => {}
                Err(e) => {
                    deshacer_la_copia();
                    return Err(e.to_string());
                }
            }
            renombradas += 1;
            // Ya no la usa nadie. Si no se puede borrar, el repaso siguiente la deja como está; y si
            // no sale de la cola, el drenaje la aparta sin subirla (`imagenes::ruta_segura`).
            if let Err(e) = fs::remove_file(&origen) {
                tracing::warn!(target: "tpv::imagenes", error = %e, "no se pudo borrar una imagen heredada ya renombrada");
            }
            if let Err(e) = cola.descartar(&antes) {
                tracing::warn!(target: "tpv::imagenes", error = %e, "no se pudo quitar de la cola una imagen heredada ya renombrada");
            }
        }
    }
    Ok(renombradas)
}

/// Backfill: encola una vez las imágenes que ya había en disco, para Mains que las tenían antes de
/// existir R2. Un marcador evita volver a encolarlas en cada arranque. La subida real la hace
/// `images_drain_pending`.
///
/// OBS-06: antes, en cada arranque de la Main, las heredadas pasan a un nombre opaco
/// (`renombrar_imagenes_heredadas`). Lo que se encola, se sube, se baja o se borra es siempre una
/// imagen con un UUID por nombre (`imagenes::ruta_segura`): una heredada que no se ha podido
/// renombrar no sale del equipo.
#[tauri::command]
#[specta::specta]
async fn images_backfill(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let marker = app_data_dir.join("image_backfill_done");

    // Sólo la Main tiene imágenes locales pre-existentes; en Handy marcamos y salimos.
    let is_main = matches!(*state.mode.lock().await, Some(DeviceMode::Tpv));
    if !is_main {
        if !marker.exists() {
            let _ = fs::write(&marker, b"handy");
        }
        return Ok("no_aplica".into());
    }

    // AUD-06: las imágenes que hay son del negocio de la base. Sólo se tocan si es el de la
    // licencia y se está usando; si no, se espera (sin dar el repaso por hecho).
    if negocio_de_la_base_en_uso(&state, &app_data_dir).await.is_none() {
        return Ok("base_de_otro_negocio".into());
    }
    let Some(db) = state.db.lock().await.as_ref().cloned() else {
        return Ok("base_de_otro_negocio".into());
    };

    let renombradas = match renombrar_imagenes_heredadas(&app_data_dir, &db).await {
        Ok(n) => n,
        Err(e) => {
            // El arranque siguiente lo vuelve a intentar; mientras tanto, la heredada no sale.
            tracing::warn!(target: "tpv::imagenes", error = %e, "no se pudieron renombrar las imágenes heredadas");
            0
        }
    };
    if marker.exists() {
        return Ok(format!("ya_hecho renombradas={renombradas}"));
    }

    let mut encoladas = 0u32;
    for sub in CARPETAS_DEL_BACKFILL {
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
    Ok(format!("encoladas={encoladas} renombradas={renombradas}"))
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
#[specta::specta]
async fn printer_list() -> Result<Vec<printing::PrinterInfo>, AppErrorDto> {
    tokio::task::spawn_blocking(printing::list_printers)
        .await
        .map_err(|e| AppErrorDto::internal(e.to_string()))?
        .map_err(fallo_de_impresora)
}

/// Lo que falla al imprimir es del entorno —la impresora, su driver, la cola de Windows, que no
/// haya ninguna elegida—, no un fallo del programa: va como `External`, y así cada rollo que se
/// acaba no cuenta como un fallo del programa (`fallosDeComandos.ts`).
fn fallo_de_impresora(e: String) -> AppErrorDto {
    AppErrorDto::new(tpv_contracts::errors::ErrorCode::External, e)
}

/// El hilo que maqueta e imprime no ha terminado (un pánico): eso sí es un fallo del programa. A
/// la pantalla le llega qué hacer; el detalle (`task 12 panicked…`, en inglés) es para quien lo
/// arregle y va al registro (AUD-30).
fn hilo_de_impresion_caido(e: tokio::task::JoinError) -> AppErrorDto {
    tracing::warn!(target: "tpv::impresion", error = %e, "el hilo de impresión no ha terminado");
    AppErrorDto::internal("No se pudo completar la impresión. Vuelve a intentarlo.")
}

/// Destino por defecto cuando nadie dice cuál: el ticket de cliente.
const DESTINO_CAJA: &str = "caja";

/// Normaliza el destino pedido (vacío => `caja`).
fn destino_o_caja(v: Option<String>) -> String {
    v.map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DESTINO_CAJA.to_string())
}

/// Impresora de un destino (una en blanco es no tener ninguna).
fn impresora_de(cfg: &DeviceConfig, destino: &str) -> Option<String> {
    cfg.printers.get(destino).cloned().filter(|s| !s.trim().is_empty())
}

/// Devuelve la impresora seleccionada para un destino (o `None`).
#[tauri::command(async)]
#[specta::specta]
fn printer_get_selected(
    app: AppHandle,
    args: Option<DestinoArgs>,
) -> Result<Option<String>, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    let destino = destino_o_caja(args.and_then(|a| a.destino));
    Ok(impresora_de(&load_config(&dir), &destino))
}

/// Persiste la impresora de un destino en `device_config.json` (nombre vacío => deselecciona).
#[tauri::command(async)]
#[specta::specta]
fn printer_set_selected(app: AppHandle, args: SetPrinterArgs) -> Result<String, AppErrorDto> {
    let dir = app_data_dir_of(&app)?;
    let mut cfg = load_config(&dir);
    let destino = destino_o_caja(args.destino);
    let name = args.name.trim();

    if name.is_empty() {
        cfg.printers.remove(&destino);
    } else {
        cfg.printers.insert(destino, name.to_string());
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
    let printer = resolve_printer(app, payload.printer_name.clone()).map_err(fallo_de_impresora)?;

    // AUD-30: leer el logo y rasterizarlo es disco y CPU, así que va en el hilo de bloqueo de la
    // impresión y no en la tarea del comando. Si ahí hubiera un pánico, el comando contesta con
    // un error (`hilo_de_impresion_caido`) en vez de no contestar nunca.
    let app_data = app_data_dir_of(app).ok();
    tokio::task::spawn_blocking(move || {
        // El logo se lee AQUÍ y no dentro del builder: `build_ticket` no toca el disco, que es lo
        // que lo mantiene comprobable con un test. Si el fichero no está o no se puede
        // decodificar, el ticket sale sin logo — mejor que no salir.
        let logo = if payload.show_logo {
            payload
                .logo_path
                .as_deref()
                .and_then(|ruta| leer_imagen_local(app_data.as_deref(), ruta))
        } else {
            None
        };

        let bytes = printing::build_ticket(&payload, logo.as_deref());
        printing::print_raw(&printer, printing::DOC_TICKET, &bytes)
    })
    .await
    .map_err(hilo_de_impresion_caido)?
    .map_err(fallo_de_impresora)?;
    Ok("OK".into())
}

/// Imprime una **precuenta**: lo que se le enseña al cliente antes de cobrar, compuesto en la
/// pantalla. Sale sin número y sin marca de copia aunque la pantalla los mande
/// (`como_precuenta`, RI-29): el ticket de un cobro sólo sale de `printer_imprimir_pago`.
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
async fn printer_ticket_de_pago(
    state: State<'_, AppState>,
    args: tpv_contracts::impresion::TicketDePagoInput,
) -> Result<printing::PrintTicketPayload, AppErrorDto> {
    state.sesion().await?;
    let args = copia_si_ya_salio(&state, args);
    let tickets = state.tickets_repo().await?;
    let config = state.configuracion_repo().await?;
    Ok(tpv_application::use_cases::tickets::ticket_de_pago(tickets.as_ref(), config.as_ref(), &args).await?)
}

/// El ticket original de un cobro sale una vez: si ya salió en esta sesión, lo que se pide es una
/// copia (sale marcada COPIA y no abre el cajón). Sólo afecta a la factura del propio cobro; las
/// demás (la F3 de un canje, una rectificativa) no abren el cajón nunca.
fn copia_si_ya_salio(
    state: &AppState,
    mut args: tpv_contracts::impresion::TicketDePagoInput,
) -> tpv_contracts::impresion::TicketDePagoInput {
    let es_la_del_cobro = args.num_factura.as_deref().map(str::trim).is_none_or(str::is_empty);
    if es_la_del_cobro && state.tickets_impresos.ya_impreso(&args.id_pago) {
        args.es_copia = true;
    }
    args
}

/// Imprime el ticket de un cobro. No recibe el papel: lo vuelve a componer desde la base, así que
/// lo que sale es siempre lo que dice la factura.
#[tauri::command]
#[specta::specta]
async fn printer_imprimir_pago(
    app: AppHandle,
    state: State<'_, AppState>,
    args: tpv_contracts::impresion::TicketDePagoInput,
) -> Result<String, AppErrorDto> {
    state.sesion().await?;
    let args = copia_si_ya_salio(&state, args);
    let tickets = state.tickets_repo().await?;
    let config = state.configuracion_repo().await?;
    let payload =
        tpv_application::use_cases::tickets::ticket_de_pago(tickets.as_ref(), config.as_ref(), &args)
            .await?;
    let original = !payload.es_copia && args.num_factura.as_deref().map(str::trim).is_none_or(str::is_empty);
    let r = imprimir_ticket(&app, payload).await?;
    // Se anota DESPUÉS de imprimir: si la impresora no estaba, el original no ha salido y el
    // siguiente intento tiene que seguir siendo el original (y abrir el cajón).
    if original {
        state.tickets_impresos.anotar(&args.id_pago);
    }
    Ok(r)
}

/// Imprime el papel de un arqueo (CUENTA-06).
///
/// Documento **interno**: no gasta numero de ticket ni abre el cajon -que ya esta abierto, se acaba
/// de contar-. Va aparte del ticket de venta a proposito: compartir el camino del ticket de
/// venta invitaria a que un cambio en uno se colara en el otro.
#[tauri::command]
#[specta::specta]
async fn printer_print_arqueo(
    app: AppHandle,
    payload: printing::PrintArqueoPayload,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(&app, payload.printer_name.clone()).map_err(fallo_de_impresora)?;
    let bytes = printing::build_arqueo(&payload);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, printing::DOC_ARQUEO, &bytes))
        .await
        .map_err(hilo_de_impresion_caido)?
        .map_err(fallo_de_impresora)?;
    Ok("OK".into())
}

/// Columnas de caracteres que de verdad caben con la configuración actual de papel y márgenes.
///
/// Lo pregunta la previsualización para enseñar el ancho real (y recortar los nombres donde los
/// recorta el papel) en vez de una versión más amable. Vive aquí y no duplicado en TypeScript
/// porque es la MISMA cuenta que usa el builder ESC/POS: dos copias acabarían discrepando, que es
/// justo lo que hace que una previsualización deje de servir para nada.
#[tauri::command(async)]
#[specta::specta]
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
///
/// AUD-30: la ruta es `Logo_DataUrl`, que llega replicado (o, en la precuenta, de la pantalla), y
/// puede ser cualquier texto. Ni el data URL ni el fichero se leen más allá de lo que pesa una
/// imagen admitida (`imagenes::MAX_BYTES`): lo que pasa de ahí no se iba a imprimir.
fn leer_imagen_local(app_data: Option<&std::path::Path>, ruta: &str) -> Option<Vec<u8>> {
    let r = ruta.trim();
    if r.is_empty() {
        return None;
    }

    // Data URL heredado (`data:image/png;base64,…`): los logos antiguos se guardaron así.
    if let Some(b64) = r.split_once(";base64,").map(|(_, b)| b) {
        // Base64 añade un tercio: se mide antes de decodificar, como en `save_image`.
        if b64.len() > imagenes::MAX_BYTES.div_ceil(3) * 4 {
            tracing::warn!(target: "tpv::impresion", "el logo pesa más de 5 MB: el ticket sale sin él");
            return None;
        }
        use base64::Engine;
        return base64::engine::general_purpose::STANDARD.decode(b64).ok();
    }

    // Sólo una imagen guardada (`images/{sub}/{archivo}`). Cualquier otro nombre puede ser un
    // dispositivo de Windows (`COM1`, `NUL`), que se abre como un fichero aunque esté escrito
    // dentro de AppData, y de un puerto serie no se acaba de leer nunca.
    if !imagenes::ruta_segura(r) {
        return None;
    }
    let leido = imagenes::leer_para_subida(&ruta_dentro_de(app_data?, r)?).ok()?;
    if leido.is_none() {
        tracing::warn!(target: "tpv::impresion", "el logo pesa más de 5 MB: el ticket sale sin él");
    }
    leido
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
#[specta::specta]
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

    let printer = resolve_printer(&app, None).map_err(fallo_de_impresora)?;
    let bytes = printing::build_abrir_cajon();
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, printing::DOC_CAJON, &bytes))
        .await
        .map_err(hilo_de_impresion_caido)?
        .map_err(fallo_de_impresora)?;
    Ok("OK".into())
}

/// Imprime un ticket de prueba en la impresora indicada (o la seleccionada) para verificarla.
#[tauri::command]
#[specta::specta]
async fn printer_print_test(
    app: AppHandle,
    args: Option<SetPrinterArgs>,
) -> Result<String, AppErrorDto> {
    let printer = resolve_printer(&app, args.map(|a| a.name)).map_err(fallo_de_impresora)?;
    let bytes = printing::build_test_ticket(&printer);
    tokio::task::spawn_blocking(move || printing::print_raw(&printer, printing::DOC_PRUEBA, &bytes))
        .await
        .map_err(hilo_de_impresion_caido)?
        .map_err(fallo_de_impresora)?;
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
#[derive(Debug, Clone, Serialize, specta::Type)]
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
#[derive(Debug, Clone, Serialize, specta::Type)]
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
    let updater = updater_del_equipo(app)?;

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

/// RI-30 · El updater, con la identidad del equipo en la cabecera `X-Tpv-Device`: con ella el feed
/// sabe si es de un bar piloto, que recibe las versiones del canal `beta` antes que nadie.
///
/// La identidad se LEE, nunca se crea (RI-72). Sin ella —equipo sin activar, o almacén que no
/// contesta— sale sin cabecera y el feed le da el canal normal: buscar actualizaciones no puede
/// fallar por esto.
#[cfg(desktop)]
fn updater_del_equipo(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder();
    match tpv_infra_licensing::device::leer_device_id() {
        Ok(Some(id)) => {
            builder = builder
                .header("X-Tpv-Device", id)
                .map_err(|e| format!("cabecera del updater: {e}"))?;
        }
        Ok(None) => {}
        Err(e) => tracing::warn!("[updater] sin la identidad del equipo, se pide el canal normal: {e}"),
    }
    builder
        .build()
        .map_err(|e| format!("updater no disponible: {e}"))
}

/// Comprueba el feed y devuelve los metadatos de la nueva versión, o `None` si ya está al día.
///
/// En móvil no hay updater: el APK nuevo se instala encima. Contesta `None` («nada que
/// actualizar por esta vía») y no un error, porque `UpdateBanner` lo pide al arrancar en todas las
/// plataformas y un `Err` llegaba a Sentry como fallo del programa en cada arranque (AND-01).
#[tauri::command]
#[specta::specta]
async fn updater_check(app: AppHandle) -> Result<Option<UpdateInfo>, AppErrorDto> {
    #[cfg(desktop)]
    {
        check_and_announce(&app).await.map_err(AppErrorDto::from)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Estado para la pantalla de actualizaciones: versión instalada + resultado de comprobar el feed.
/// Comprueba de verdad (no devuelve nada cacheado), así que el botón "Buscar actualizaciones"
/// también dispara el aviso si aparece una versión nueva.
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
async fn updater_install(app: AppHandle) -> Result<(), AppErrorDto> {
    #[cfg(desktop)]
    {
        let updater = updater_del_equipo(&app)?;

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
/// RI-87: este registro genera tanto el IPC como sus funciones y DTO TypeScript.
pub fn command_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            // device
            get_device_mode,
            set_device_mode,
            get_connection_mode,
            init_main,
            device_reset_mode,
            // genéricos
            save_image,
            images_drain_pending,
            images_upload_status,
            images_retry_upload,
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

            // mesas
            commands::mesas::save_layout,
            commands::mesas::load_layout,
            commands::mesas::set_reserva_estado,
            commands::mesas::get_comanda_abierta_by_mesa,
            commands::mesas::abrir_comanda,
            commands::mesas::mesas_abrir_o_retomar,
            commands::mesas::comanda_set_trabajador_if_null,
            commands::mesas::comanda_set_reserva_if_null,
            commands::mesas::get_lineas_comanda,
            commands::mesas::add_linea_comanda,
            commands::mesas::mesas_meta_all,
            commands::mesas::list_categorias_vendibles,
            commands::mesas::list_productos_by_categoria,
            commands::mesas::search_productos_by_nombre,
            commands::mesas::remove_one_pending_detalle,
            commands::mesas::delete_detalle,
            commands::mesas::update_detalle_nota,
            commands::mesas::update_detalle_ingredientes,
            commands::mesas::cobrar_detalles,
            commands::mesas::kitchen_list_today_pending,
            commands::mesas::kitchen_set_line_state,
            // inventario (commands/inventario.rs)
            commands::inventario::inventario_list_categorias,
            commands::inventario::inventario_create_categoria,
            commands::inventario::inventario_list_proveedores_mini,
            commands::inventario::inventario_list_productos_by_categoria,
            commands::inventario::inventario_get_resumen,
            commands::inventario::inventario_list_alergenos,
            commands::inventario::inventario_get_product_detail,
            commands::inventario::inventario_delete_producto,
            commands::inventario::inventario_borrar_categoria,
            commands::inventario::inventario_upsert_producto,
            commands::inventario::inventario_list_lotes_by_producto,
            commands::inventario::inventario_create_lote,
            commands::inventario::inventario_update_lote,
            commands::inventario::inventario_ajustar_lote,
            commands::inventario::inventario_ajustar_stock_suelto,
            commands::inventario::inventario_catalogo_ingredientes,
            commands::inventario::inventario_ingredientes_de_producto,
            commands::inventario::inventario_guardar_categoria_ingrediente,
            commands::inventario::inventario_borrar_categoria_ingrediente,
            commands::inventario::inventario_guardar_ingrediente,
            commands::inventario::inventario_borrar_ingrediente,
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
            commands::trabajadores::trabajadores_eliminar,
            commands::trabajadores::horarios_marcar_libre,
            commands::trabajadores::turnos_get_all,
            commands::trabajadores::horarios_get_asignaciones_semana,
            commands::trabajadores::horarios_guardar_asignacion,
            commands::trabajadores::horarios_delete_asignacion,
            commands::trabajadores::horarios_copy_semana_asignaciones,
            commands::trabajadores::horarios_set_predeterminado_desde_semana,
            // cuentas (commands/cuentas.rs)
            commands::cuentas::cuentas_get_entradas,
            commands::cuentas::cuentas_get_salidas,
            commands::cuentas::cuentas_get_resumen,
            commands::cuentas::cuentas_create_gasto,
            commands::cuentas::cuentas_update_gasto,
            commands::cuentas::cuentas_delete_gasto,
            commands::cuentas::cuentas_update_pago,
            commands::cuentas::cuentas_anular_pago,
            commands::cuentas::cuentas_lineas_devolubles,
            commands::cuentas::cuentas_devolver_lineas,
            commands::cuentas::cuentas_previsualizar_cambio,
            commands::cierre_caja::cierre_preparar,
            commands::cierre_caja::cierre_confirmar,
            commands::cierre_caja::cierre_listar,
            commands::cierre_caja::cierre_detalle,
            commands::cierre_caja::cierre_reabrir,
            // clientes (commands/clientes.rs)
            commands::clientes::clientes_get_overview,
            commands::clientes::clientes_get_cliente_form,
            commands::clientes::clientes_create_cliente,
            commands::clientes::clientes_update_cliente,
            commands::clientes::clientes_recalcular_gasto,
            commands::clientes::clientes_para_factura,
            commands::clientes::clientes_guardar_datos_fiscales,
            commands::clientes::clientes_facturas,
            commands::clientes::clientes_factura_pdf,
            // reservas (commands/reservas.rs)
            commands::reservas::reservas_get_meta,
            commands::reservas::reservas_get_mes,
            commands::reservas::reservas_save,
            commands::reservas::reservas_buscar_cliente,
            commands::reservas::reservas_delete,
            commands::reservas::reservas_cancelar,
            commands::reservas_web::reserva_web_ajustes,
            commands::reservas_web::reserva_web_activar,
            commands::reservas_web::reserva_web_cerrar_dia,
            commands::reservas_web::reserva_web_quitar_cierre,
            commands::reservas_web::reserva_web_clave,
            commands::reservas_web::reserva_web_mesas,
            commands::reservas_web::reserva_web_guardar_mesa,
            // proveedores (commands/proveedores.rs)
            commands::proveedores::proveedores_get_all,
            commands::proveedores::proveedores_save,
            commands::proveedores::proveedores_delete,
            commands::proveedores::proveedores_get_productos,
            commands::proveedores::proveedores_get_categorias,
            commands::proveedores::proveedores_get_productos_all,
            commands::proveedores::proveedores_set_vinculos,
            // pedidos a proveedores (la Main en su base; la Handy contra la nube, PED-HANDY)
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
            commands::venta_rapida::vr_guardar_cobro_pendiente,
            commands::venta_rapida::vr_listar_cobros_pendientes,
            commands::venta_rapida::vr_resolver_cobro_pendiente,
            commands::venta_rapida::vr_cancelar_cobro_pendiente,
            commands::venta_rapida::vr_delete_comanda_if_safe,
            commands::venta_rapida::vr_get_index_rows,
            commands::venta_rapida::vr_get_detalles_ver_ticket,
            // registro de facturación (FISCAL-01). La emisión de un cobro ocurre dentro de su
            // transacción, no por un comando propio.
            commands::verifactu::verifactu_estado,
            commands::verifactu::verifactu_emitir_factura_de_tickets,
            commands::verifactu::verifactu_facturas_canjeables,
            commands::verifactu::verifactu_corregir_factura,
            // stats
            commands::stats::stats_mesas_get,
            commands::stats::stats_productos_list_categorias,
            commands::stats::stats_productos_resumen,
            commands::stats::stats_reservas_resumen,
            commands::stats::stats_trabajadores_resumen,
            commands::stats::stats_clientes_resumen,
            commands::stats::stats_proveedores_resumen,
            // licensing (commands/licensing.rs)
            commands::licensing::license_get_state,
            commands::licensing::license_activate,
            commands::licensing::license_sumar_clave,
            commands::licensing::license_request_device_change,
            commands::licensing::license_clear_state,
            commands::licensing::license_gate,
            commands::licensing::license_check_now,
            // pairing (commands/pairing.rs)
            commands::pairing::handy_set_token,
            commands::pairing::handy_get_tenant,
            commands::pairing::handy_url_imagenes,

            commands::pairing::device_get_identity,
            commands::pairing::device_firmar_emparejamiento,
            // RELOJ-01: el aviso del reloj desfasado (sin sesión: commands/reloj.rs)
            commands::reloj::reloj_desfase,
            commands::pairing::tpv_server_post_json,
            commands::pairing::pair_create,
            // sincronización con la nube, permisos de la sesión y socket de la Handy
            commands::sync::sync_health,
            commands::permisos::permisos_sesion,
            commands::permisos::permisos_configuracion,
            commands::permisos::permisos_guardar,
            commands::socket_handy::handy_socket_estado,
            commands::socket_handy::handy_socket_reintentar,
            commands::sync::sync_estado,
            commands::sync::sync_reintentar,
            commands::sync::sync_backfill_estado,
            commands::sync::sync_subida_estado,
            commands::sync::sync_bootstrap_desde_nube,
            commands::sync::sync_inicializar_tenant_vacio,
            // tareas periódicas de fondo (runner de jobs)
            commands::jobs::jobs_status,
            commands::jobs::interruptores_apagados,
            // registro de los fallos de comandos que ve la pantalla
            commands::telemetria::telemetria_fallo_de_comando,
            // OPS-02: el paquete de diagnóstico para soporte
            commands::diagnostico::diagnostico_generar_paquete,
            // tamaño de la interfaz (zoom de la ventana)
            commands::ventana::ventana_zoom_estado,
            commands::ventana::ventana_zoom_cambiar,
            // configuración (commands/configuracion.rs)
            commands::configuracion::config_get_business_settings,
            commands::configuracion::config_patch_business_settings,
            commands::configuracion::config_get_ticket_settings,
            commands::configuracion::config_patch_ticket_settings,
            commands::configuracion::config_get_contact_settings,
            commands::configuracion::config_patch_contact_settings,
            // correo electrónico (lo envía el worker, DB-04)
            commands::email_config::email_enviar_pedido,
        ])
        .typ::<tpv_contracts::inventario::ProductoDetalleDto>()
        .typ::<tpv_contracts::notificaciones::CrearNotificacionInput>()
        // Reservas desde la web: el alta que manda el widget al worker (lo usa su drift-guard).
        .typ::<tpv_contracts::reservas_web::ReservaWebAltaInput>()
        // Y lo que viaja entre su agenda y la Main (la recogida, §5.4 del plan).
        .typ::<tpv_contracts::reservas_web::PendientesReservaWebDto>()
        .typ::<tpv_contracts::reservas_web::RecogidasReservaWebInput>()
        .typ::<tpv_contracts::reservas_web::AvisoReservaWebInput>()
        .typ::<tpv_contracts::socket_handy::AvisoSocketHandy>()
        .typ::<tpv_contracts::sync::BootstrapSnapshot>()
        .typ::<tpv_contracts::sync::ResumenNube>()
        .typ::<tpv_contracts::sync::ComandaReplicada>()
        .typ::<tpv_contracts::sync::CambioReplicado>()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .dangerously_cast_bigints_to_number()
        .typ::<tpv_telemetry::event::SpoolEvent>()
}

/// Sólo genera ficheros; no inicia la aplicación, abre bases ni conecta a servicios.
pub fn exportar_contratos(destino: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    command_builder().export(specta_typescript::Typescript::default(), destino)?;
    Ok(())
}

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
    tpv_telemetry::init_platform_logging();
    tpv_infra_licensing::init_java_vm(vm);
    0x0001_0006 // JNI_VERSION_1_6
}

/// RI-75: `MainActivity` entrega aquí el `Context` de la aplicación antes de arrancar Tauri
/// (`TpvNativo.entregarContexto`, en `gen/android`). Como `JNI_OnLoad`, tiene que vivir en el cdylib
/// para que el símbolo se exporte.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_altarialights_tpv_TpvNativo_entregarContexto(
    env: *mut std::os::raw::c_void,
    _clase: *mut std::os::raw::c_void,
    contexto: *mut std::os::raw::c_void,
) {
    tpv_infra_licensing::init_contexto(env, contexto);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logcat temprano y puente a tracing comparten un único propietario del logger global.
    tpv_telemetry::init_platform_logging();
    tracing::warn!("[TPV] run() start");

    // Sentry primero: captura panics y crashes nativos desde el arranque. El DSN (público) se embebe
    // en el build vía `TPV_SENTRY_DSN`; si no está, el cliente queda DESHABILITADO (no-op) pero el
    // plugin se registra igualmente para que el Sentry de la Webview tenga transporte. El guard y el
    // de minidump deben vivir todo el proceso (por eso son locales de `run`, que bloquea en `.run()`).
    //
    // El contexto se genera aquí, y no al final en `.run()`, porque el entorno sale de él.
    let context = tauri::generate_context!();
    // Antes de leer ningún secreto: el build de E2E guarda los suyos aparte de los de la app de
    // trabajo del mismo equipo (ver `espacio_de_secretos`).
    if let Some(espacio) = espacio_de_secretos(&context.config().identifier) {
        tpv_infra_licensing::apartar_secretos(espacio);
    }
    let sentry_guard = tpv_telemetry::init_sentry(tpv_telemetry::SentryConfig {
        dsn: option_env!("TPV_SENTRY_DSN").map(|s| s.to_string()),
        environment: entorno_de_sentry(&context.config().identifier, cfg!(debug_assertions))
            .to_string(),
        release: Some(env!("TPV_SENTRY_RELEASE").to_string()),
        build_variant: env!("TPV_BUILD_VARIANT").to_string(),
        commit: option_env!("TPV_BUILD_COMMIT").map(str::to_string),
    });
    tpv_infra_licensing::configurar_metadatos_cliente(env!("CARGO_PKG_VERSION"), env!("TPV_BUILD_VARIANT"));
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
    // duplican los jobs —dos contrastes con la nube, dos copias, dos backfills— y drenan el outbox a
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
        .plugin(tauri_plugin_dialog::init())
        // AUD-25: la ventana no navega fuera de la aplicación.
        .plugin(navegacion::plugin());

    // El lector de QR con la cámara, para vincular una Handy escaneando el código de la Main. Sólo
    // existe en móvil (Android e iOS): en escritorio ni se compila. Sus permisos, en
    // `capabilities/mobile.json`.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    // Sentry (bridge webview+core) es solo escritorio: el plugin arrastra el minidump (proceso
    // helper) y native-tls. En móvil el crate `sentry` (rustls) sigue capturando panics de Rust.
    #[cfg(desktop)]
    // La Webview inicializa su SDK en initSentry(), con el filtro de datos personales.
    // La inyección automática añadiría otro cliente y otros listeners sin ese filtro.
    let builder = builder.plugin(tauri_plugin_sentry::init_with_no_injection(&sentry_guard));

    // El updater es solo escritorio (el plugin no cross-compila a móvil).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .on_window_event(|window, event| {
            // La ventana puede haber pasado a otro monitor: el zoom automático sale de él.
            #[cfg(desktop)]
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Some(ventana) = window.app_handle().get_webview_window(window.label()) {
                    zoom::aplicar(&ventana);
                }
            }
            let revisar = matches!(event, tauri::WindowEvent::Focused(true));
            #[cfg(mobile)]
            let revisar = revisar || matches!(event, tauri::WindowEvent::Resumed);
            if revisar {
                // Comprueba la conexión con un ping; no la corta si contesta (INC-20261030-019).
                let app = window.app_handle();
                if let Some(handy) = app.try_state::<socket_handy::HandyNativo>() { handy.reintentar(app, false); }
            }
        })
        .setup(|app| {
            let handle = app.handle();

            let app_data_dir = handle
                .path()
                .app_data_dir()
                .expect("Error obteniendo AppData");

            ensure_folders(&app_data_dir).expect("Error creando carpetas");
            // AUD-28: el nombre de la carpeta (el identificador de la app: prod, dev o e2e), no la
            // ruta, que lleva el usuario de Windows.
            tracing::warn!(
                carpeta = %app_data_dir.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                "[TPV] setup: carpeta de datos"
            );

            let cfg = load_config(&app_data_dir);
            let mode = cfg.mode;

            // AUD-06: lo primero que se hace con la licencia y con la base. Se registra cuando ya hay
            // telemetría, más abajo.
            let cambio_de_negocio = (mode == Some(DeviceMode::Tpv))
                .then(|| aplicar_cambio_de_negocio_al_arrancar(&app_data_dir));

            // El tamaño de la interfaz, antes de que la página pinte nada.
            zoom::fijar_manual(cfg.zoom);
            #[cfg(desktop)]
            if let Some(ventana) = handle.get_webview_window("main") {
                zoom::aplicar(&ventana);
            }
            // La webview de iOS a pantalla completa y sin desplazar la página entera.
            #[cfg(target_os = "ios")]
            vista_ios::ajustar(handle);

            // Espejo SÍNCRONO del modo: lo lee el firmante de telemetría desde su propio hilo (sin
            // contexto async). Se comparte con el `AppState` para mantenerlo al día en cada cambio.
            let mode_sync = Arc::new(std::sync::RwLock::new(mode));

            // FISCAL-01: el bloque `SistemaInformatico` que va EN CADA registro de facturación.
            //
            // Se inyecta aquí porque dos de sus datos sólo se conocen en el shell: la versión (de
            // `tauri.conf.json`) y el número de instalación (el `tenant_id`, que vive en
            // `license_state.json`, fuera de `data.db`). El resto identifica al PRODUCTOR del
            // software —nosotros—, no al bar, y es dato declarado: la AEAT no lo contrasta contra
            // ningún registro de actividad económica. El NIF está vacío: ver el bloque de
            // constantes arriba.
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
                // iOS: el registro, en Documentos/registros, que se ve en la app Archivos
                // (`UIFileSharingEnabled`, Info.ios.plist). Sin un Mac no hay otra forma de leerlo.
                #[cfg(target_os = "ios")]
                {
                    tcfg.logs_dir = handle.path().document_dir().ok().map(|d| d.join("registros"));
                }
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
                tracing::warn!("[TPV] setup: device_id={device_id}");
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
                match &cambio_de_negocio {
                    Some(Ok(Some(_))) => tracing::info!(
                        target: "tpv::startup",
                        "licencia de otro negocio: datos del anterior apartados y licencia aplicada"
                    ),
                    Some(Err(e)) => tracing::error!(
                        target: "tpv::startup",
                        error = %e,
                        "no se pudo terminar el cambio de negocio; se arranca sin base"
                    ),
                    _ => {}
                }
                tracing::info!(
                    target: "tpv::startup",
                    version = %handle.package_info().version,
                    mode = ?mode,
                    "TPV iniciado"
                );
            }

            // AUD-06: con un cambio de negocio sin terminar no se abre la base, que sería la del
            // anterior: se arranca sin ella, como con una ilegible, y el siguiente arranque lo repite.
            let db_opt: Option<Arc<Db>> = if mode == Some(DeviceMode::Tpv) && !matches!(cambio_de_negocio, Some(Err(_))) {
                // `Db`: escritor único serializado + pool de lectura (WAL). La captura al outbox
                // está SIEMPRE activa (también offline); se drena en "online".
                let abierta = tauri::async_runtime::block_on(async {
                    // AUD-06: con el negocio de la licencia guardada. Si la base es de otro, se
                    // aparta aquí, antes de abrir nada; si no se puede, se arranca sin base.
                    tpv_infra_sqlite::connection::init_main_db(
                        &app_data_dir,
                        negocio_de_la_licencia(&app_data_dir).as_deref(),
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
                tickets_impresos: Arc::new(printing::TicketsImpresos::default()),
                autorizacion: Arc::default(),
                avisar_notificaciones: notificador::avisar_con_evento(handle.clone()),
            });

            // Tareas periódicas de fondo (licencia, avisos, actualizaciones): las declara
            // `jobs/registro.rs` y las corre el runner con una política común —vencimiento en reloj
            // de pared, jitter, backoff y gating por modo—. Va DESPUÉS de `app.manage` porque los
            // cuerpos resuelven sus repositorios desde el `AppState`.
            replicacion::arrancar(handle.clone());
            socket_handy::arrancar(handle.clone());
            jobs::arrancar(handle);

            Ok(())
        })
        .invoke_handler(command_builder().invoke_handler())
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

/// Dónde guarda este build sus secretos (`device-id`, clave, tokens, DEK) en el almacén del sistema.
///
/// El de E2E, aparte: comparte Windows con la app de trabajo y, con los mismos nombres, la nube los
/// veía como el mismo equipo. Si la app de trabajo era la Main de una licencia viva, activar la
/// licencia de la tanda la canjeaba en ésa (REV-13) y la tanda acababa trabajando en su negocio.
/// Producción no se toca nunca: cambiarle los nombres sería perder la identidad de cada equipo.
fn espacio_de_secretos(identificador: &str) -> Option<&'static str> {
    identificador.ends_with(".e2e").then_some("e2e")
}

#[cfg(test)]
mod tests_espacio_de_secretos {
    use super::espacio_de_secretos;

    #[test]
    fn el_e2e_guarda_sus_secretos_aparte_y_produccion_donde_siempre() {
        assert_eq!(espacio_de_secretos("com.altarialights.tpv.e2e"), Some("e2e"));
        assert_eq!(espacio_de_secretos("com.altarialights.tpv"), None);
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
    //! La configuración guarda una impresora **por destino** (caja, cocina).

    use super::*;

    fn config(printers: &[(&str, &str)]) -> DeviceConfig {
        DeviceConfig {
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
        let cfg = config(&[("caja", "EPSON"), ("cocina", "STAR")]);

        assert_eq!(impresora_de(&cfg, "caja").as_deref(), Some("EPSON"));
        assert_eq!(impresora_de(&cfg, "cocina").as_deref(), Some("STAR"));
    }

    #[test]
    fn una_impresora_en_blanco_es_no_tener_impresora() {
        // Guardar "" y tratarlo como un nombre haría que el trabajo se mandara a la nada, sin
        // error visible: el camarero se queda esperando un ticket que no va a salir.
        let cfg = config(&[("caja", "   ")]);

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

    // AUD-30: el valor llega replicado, así que sólo se lee una imagen guardada, y no más de lo
    // que pesa una admitida, venga como fichero o como data URL.

    /// El logo de las pruebas, con el nombre que le pone `save_image` (un UUID, OBS-06).
    const LOGO: &str = "images/logo/0190f3a1-7b2c-4d4e-8f00-123456789abc.png";
    /// Otro nombre de los que pone la app, en la misma carpeta.
    const GRANDE: &str = "images/logo/0190f3a1-7b2c-4d4e-8f00-0000000000ff.png";

    /// `temporal()` con un logo donde lo deja `save_image`.
    fn con_logo() -> std::path::PathBuf {
        let dir = temporal();
        std::fs::create_dir_all(dir.join("images/logo")).unwrap();
        std::fs::write(dir.join(LOGO), b"logo").unwrap();
        dir
    }

    #[test]
    fn un_logo_se_lee_del_disco_o_de_un_data_url() {
        let dir = con_logo();

        assert_eq!(leer_imagen_local(Some(&dir), LOGO).as_deref(), Some(&b"logo"[..]));
        // «logo» en base64.
        assert_eq!(leer_imagen_local(None, "data:image/png;base64,bG9nbw==").as_deref(), Some(&b"logo"[..]));
        assert_eq!(leer_imagen_local(Some(&dir), GRANDE), None);
    }

    #[test]
    fn solo_se_lee_una_imagen_guardada() {
        // `images/logo.png` existe dentro de AppData, pero no es donde se guarda una imagen. Y
        // `NUL` es un dispositivo de Windows: se abre como un fichero vacío en cualquier carpeta,
        // igual que `COM1` se abriría como un puerto serie del que no se acaba de leer.
        let dir = con_logo();

        std::fs::write(dir.join("images/logo/logo.png"), b"logo").unwrap();
        // OBS-06: ni una heredada, con el nombre que alguien le dio.
        for ruta in ["images/logo.png", "images/logo/logo.png", "NUL", "../../secreto.png", "C:/Windows/win.ini"] {
            assert_eq!(leer_imagen_local(Some(&dir), ruta), None, "{ruta}");
        }
    }

    #[test]
    fn un_data_url_mas_largo_que_una_imagen_admitida_no_se_decodifica() {
        // El mismo tope que `save_image` pone a lo que le manda la pantalla.
        let tope = imagenes::MAX_BYTES.div_ceil(3) * 4;
        let data_url = |largo: usize| format!("data:image/png;base64,{}", "A".repeat(largo));

        assert!(leer_imagen_local(None, &data_url(tope)).is_some());
        assert!(leer_imagen_local(None, &data_url(tope + 4)).is_none());
    }

    #[test]
    fn un_fichero_mas_grande_que_una_imagen_admitida_no_se_lee() {
        let dir = con_logo();
        let grande = dir.join(GRANDE);
        std::fs::File::create(&grande).unwrap().set_len((imagenes::MAX_BYTES + 1) as u64).unwrap();

        let leido = leer_imagen_local(Some(&dir), GRANDE);
        std::fs::remove_file(&grande).unwrap();

        assert!(leido.is_none(), "se han leído {} bytes", leido.map_or(0, |b| b.len()));
    }
}

#[cfg(test)]
mod tests_hilo_de_impresion {
    //! Si el hilo que maqueta e imprime se cae, la pantalla recibe qué hacer, en español, y no el
    //! texto de tokio (AUD-30).

    use super::*;

    #[tokio::test]
    async fn un_panico_al_imprimir_no_llega_a_la_pantalla_en_ingles() {
        let caido = tokio::task::spawn_blocking(|| {
            panic!("index out of bounds");
        })
        .await
        .expect_err("el hilo ha entrado en pánico");
        assert!(caido.to_string().contains("panicked"), "{caido}");

        let error = hilo_de_impresion_caido(caido);

        assert!(matches!(error.code, tpv_contracts::errors::ErrorCode::Internal));
        assert_eq!(error.message, "No se pudo completar la impresión. Vuelve a intentarlo.");
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
    use tpv_infra_sqlite::ejecutor::Value;

    async fn estado() -> AppState {
        let dir = std::env::temp_dir().join(format!("tpv-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        AppState {
            db: Arc::new(Mutex::new(Some(db))),
            cloud: Arc::new(Mutex::new(None)),
            mode: Arc::new(Mutex::new(Some(DeviceMode::Tpv))),
            mode_sync: Arc::new(std::sync::RwLock::new(Some(DeviceMode::Tpv))),
            sesion: Arc::new(Mutex::new(None)),
            tickets_impresos: Arc::new(printing::TicketsImpresos::default()),
            autorizacion: Arc::default(),
            avisar_notificaciones: Arc::new(|| {}),
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

    async fn iniciar(st: &AppState, rol: &str) {
        let db = st.db.lock().await.as_ref().unwrap().clone();
        let w = db.write().await;
        w.raw().execute("INSERT INTO Roles (ID_Rol,Nombre_Rol) VALUES (?1,?1) ON CONFLICT(Nombre_Rol) DO NOTHING", vec![Value::Text(rol.into())]).await.unwrap();
        w.raw().execute("INSERT INTO Usuarios (ID_Usuario,ID_Rol,Email,Password_Hash,Nombre,Estado) VALUES ('u-1',(SELECT ID_Rol FROM Roles WHERE Nombre_Rol=?1),'gate@test','hash','Gate','Activo') ON CONFLICT(ID_Usuario) DO UPDATE SET ID_Rol=excluded.ID_Rol", vec![Value::Text(rol.into())]).await.unwrap();
        drop(w);
        st.iniciar_sesion(sesion_de(rol)).await;
    }

    #[tokio::test]
    async fn desactivar_o_quitar_el_rol_revoca_la_sesion_abierta() {
        let st = estado().await; iniciar(&st, ADMIN).await;
        let db = st.db.lock().await.as_ref().unwrap().clone();
        db.write().await.raw().execute("UPDATE Usuarios SET Estado='Inactivo' WHERE ID_Usuario='u-1'", ()).await.unwrap();
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
        assert!(st.sesion().await.is_err());
    }

    #[tokio::test]
    async fn cambiar_el_rol_revoca_al_admin_sin_cerrar_la_sesion() {
        let st = estado().await; iniciar(&st, ADMIN).await;
        let db = st.db.lock().await.as_ref().unwrap().clone();
        db.write().await.raw().execute("UPDATE Usuarios SET ID_Rol=(SELECT ID_Rol FROM Roles WHERE Nombre_Rol='Camarero') WHERE ID_Usuario='u-1'", ()).await.unwrap();
        assert_eq!(st.sesion().await.unwrap().rol, "Camarero");
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
        assert!(st.exigir_permiso("cuentas.cobros").await.is_ok());
        assert!(st.exigir_permiso("stock.ajustar").await.is_err());
    }

    /// Sin sesión no se pasa, y el error tiene que llegar con el código por el que ramifica el
    /// frontend: con un `internal` genérico, la UI no podría distinguir "no puedes" de "ha
    /// fallado" y ofrecería reintentar donde no hay nada que reintentar.
    #[tokio::test]
    async fn sin_sesion_se_deniega_con_su_codigo() {
        let st = estado().await;

        let e = st.sesion().await.unwrap_err();
        assert_eq!(e.code, tpv_contracts::errors::ErrorCode::PermisoDenegado);

        let e = st.exigir_rol(&[ADMIN]).await.unwrap_err();
        assert_eq!(e.code, tpv_contracts::errors::ErrorCode::PermisoDenegado);
    }

    /// El caso que motiva el plan entero: identificarse no es autorizarse.
    #[tokio::test]
    async fn un_rol_que_no_toca_no_pasa_aunque_haya_sesion() {
        let st = estado().await;

        for rol in ["Camarero", "Cocinero", "Limpieza"] {
            iniciar(&st, rol).await;

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
        let st = estado().await;

        for parecido in [
            "administrador",
            "ADMINISTRADOR",
            " Administrador",
            "Administrador ",
        ] {
            iniciar(&st, parecido).await;
            assert!(
                st.exigir_rol(&[ADMIN]).await.is_err(),
                "{parecido:?} no es el rol Administrador"
            );
        }
    }

    #[tokio::test]
    async fn con_el_rol_correcto_pasa_y_dice_quien_es() {
        let st = estado().await;
        iniciar(&st, ADMIN).await;

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
        let st = estado().await;
        iniciar(&st, ADMIN).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        st.cerrar_sesion().await;

        assert!(st.sesion().await.is_err());
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /// Cerrar dos veces (el cierre por inactividad y el arranque del webview pueden solaparse)
    /// no puede fallar ni resucitar nada.
    #[tokio::test]
    async fn cerrar_sesion_es_idempotente() {
        let st = estado().await;
        st.cerrar_sesion().await;
        st.cerrar_sesion().await;
        assert!(st.sesion().await.is_err());
    }

    /// Iniciar sesión reemplaza: si dos logins seguidos acumularan, el segundo usuario operaría
    /// con el permiso del primero.
    #[tokio::test]
    async fn iniciar_sesion_reemplaza_a_la_anterior() {
        let st = estado().await;
        iniciar(&st, ADMIN).await;
        iniciar(&st, "Camarero").await;

        assert_eq!(st.sesion().await.unwrap().rol, "Camarero");
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /* ── `exigir_rol_si_hay_sesion`: el gate de las pantallas de arranque ──────────────────── */

    /// Sin sesión pasa, y esto NO es un descuido. A `device_reset_mode` se llega también desde la
    /// pantalla de activación, que se pinta en lugar del router: ahí no hay con quién iniciar
    /// sesión, y un gate duro dejaría un equipo recién instalado sin poder activarse jamás.
    #[tokio::test]
    async fn sin_sesion_el_gate_blando_deja_pasar() {
        let st = estado().await;
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_ok());
    }

    /// Y con sesión sí manda, que es lo que cierra el camino de Configuración → Dispositivo.
    #[tokio::test]
    async fn con_sesion_el_gate_blando_exige_el_rol() {
        let st = estado().await;

        iniciar(&st, "Camarero").await;
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_err());

        iniciar(&st, ADMIN).await;
        assert!(st.exigir_rol_si_hay_sesion(&[ADMIN]).await.is_ok());
    }
}

#[cfg(test)]
mod tests_autorizacion_guardada {
    //! PERM-CACHE: los gates con la autorización guardada.
    //!
    //! Las reglas tienen sus tests en `use_cases::autorizacion_guardada`. Aquí se comprueba el
    //! cableado: que los gates del `AppState` usan lo guardado y que lo tiran la sesión, el socket
    //! de avisos y los cambios que llegan. El repositorio es el SQLite de siempre; lo que hace de
    //! Handy es el canal de avisos, abierto a mano.

    use super::*;
    use tpv_contracts::sync::{CambioReplicado, ComandaReplicada};
    use tpv_infra_sqlite::ejecutor::Value;
    use uc_autorizacion::Canal;

    const CONEXION: Canal = Canal { generacion: 1, conexion: 1 };

    async fn estado() -> AppState {
        let dir = std::env::temp_dir().join(format!("tpv-autorizacion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        AppState {
            db: Arc::new(Mutex::new(Some(db))),
            cloud: Arc::new(Mutex::new(None)),
            mode: Arc::new(Mutex::new(Some(DeviceMode::Tpv))),
            mode_sync: Arc::new(std::sync::RwLock::new(Some(DeviceMode::Tpv))),
            sesion: Arc::new(Mutex::new(None)),
            tickets_impresos: Arc::new(printing::TicketsImpresos::default()),
            autorizacion: Arc::default(),
            avisar_notificaciones: Arc::new(|| {}),
        }
    }

    async fn poner_rol(st: &AppState, rol: &str) {
        let db = st.db.lock().await.as_ref().unwrap().clone();
        let w = db.write().await;
        w.raw().execute("INSERT INTO Roles (ID_Rol,Nombre_Rol) VALUES (?1,?1) ON CONFLICT(Nombre_Rol) DO NOTHING", vec![Value::Text(rol.into())]).await.unwrap();
        w.raw().execute("INSERT INTO Usuarios (ID_Usuario,ID_Rol,Email,Password_Hash,Nombre,Estado) VALUES ('u-1',(SELECT ID_Rol FROM Roles WHERE Nombre_Rol=?1),'gate@test','hash','Gate','Activo') ON CONFLICT(ID_Usuario) DO UPDATE SET ID_Rol=excluded.ID_Rol", vec![Value::Text(rol.into())]).await.unwrap();
    }

    async fn entrar(st: &AppState, rol: &str, iniciada_en: i64) {
        poner_rol(st, rol).await;
        st.iniciar_sesion(Sesion { id_usuario: "u-1".into(), id_trabajador: None, rol: rol.into(), iniciada_en }).await;
    }

    fn cambio(tablas: &[&str]) -> CambioReplicado {
        CambioReplicado {
            tablas: Some(tablas.iter().map(|t| t.to_string()).collect()),
            comanda: ComandaReplicada { ids: vec![], touched_comanda: false, uncertain: false, touched_catalog: false },
        }
    }

    /// Sin canal de avisos (la Main, o una Handy sin socket) nada se guarda: quitar el rol se nota
    /// en el siguiente gate, como siempre.
    #[tokio::test]
    async fn sin_canal_de_avisos_cada_gate_lee_lo_vigente() {
        let st = estado().await;
        entrar(&st, ADMIN, 1).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());
        poner_rol(&st, "Camarero").await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /// Con el canal abierto los gates usan lo guardado, y el aviso del cambio lo tira.
    #[tokio::test]
    async fn con_el_canal_abierto_el_aviso_del_cambio_retira_el_permiso() {
        let st = estado().await;
        st.canal_de_avisos(Some(CONEXION));
        entrar(&st, ADMIN, 1).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        // Otro equipo le quita el rol. Hasta que llega su aviso, vale lo guardado…
        poner_rol(&st, "Camarero").await;
        st.aviso_de_cambio(&cambio(&["comandas", "pagos"]));
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok(), "un cambio de otras tablas no hace releer");

        // …y con el aviso, los tres gates ven lo de ahora.
        st.aviso_de_cambio(&cambio(&["usuarios"]));
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
        assert_eq!(st.sesion().await.unwrap().rol, "Camarero");
        assert!(st.exigir_permiso("stock.ajustar").await.is_err());
    }

    /// Se cae el socket, o se abre otra conexión: lo guardado con la anterior no vale.
    #[tokio::test]
    async fn al_cambiar_el_socket_de_avisos_se_vuelve_a_leer() {
        let st = estado().await;
        st.canal_de_avisos(Some(CONEXION));
        entrar(&st, ADMIN, 1).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        poner_rol(&st, "Camarero").await;
        st.canal_de_avisos(None);
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());

        poner_rol(&st, ADMIN).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok(), "sin socket no se guarda nada");
        st.canal_de_avisos(Some(Canal { generacion: 1, conexion: 2 }));
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());
    }

    /// Entrar y salir tiran lo guardado, y lo que este equipo escribe en `Usuarios`, también.
    #[tokio::test]
    async fn la_sesion_y_lo_que_escribe_este_equipo_tiran_lo_guardado() {
        let st = estado().await;
        st.canal_de_avisos(Some(CONEXION));
        entrar(&st, ADMIN, 1).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        // Este equipo le cambia el rol: su propio cambio no le llega como aviso.
        poner_rol(&st, "Camarero").await;
        st.olvidar_autorizacion();
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());

        // La misma persona vuelve a entrar con otro rol: la sesión nueva no hereda nada.
        poner_rol(&st, ADMIN).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_err(), "sigue valiendo lo guardado de esta sesión");
        st.iniciar_sesion(Sesion { id_usuario: "u-1".into(), id_trabajador: None, rol: ADMIN.into(), iniciada_en: 2 }).await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_ok());

        st.cerrar_sesion().await;
        assert!(st.exigir_rol(&[ADMIN]).await.is_err());
    }

    /// El servicio del socket avisa al `AppState` donde hace falta, y el orden importa: la
    /// autorización se tira antes de que la pantalla se entere del cambio.
    #[test]
    fn el_socket_de_avisos_y_la_edicion_de_trabajadores_avisan() {
        let socket = include_str!("socket_handy.rs");
        let antes_de_emitir = |trozo: &str, aviso: &str, evento: &str| {
            let emite = trozo.find(&format!(r#"app.emit("{evento}""#)).expect("emite el evento");
            trozo[..emite].contains(aviso)
        };
        let publicar = socket.split("fn publicar(").nth(1).unwrap();
        assert!(antes_de_emitir(publicar, "avisar_del_canal(app, &p.foto)", "handy:estado"));
        let contexto = socket.split("pub fn contexto_cambiado(").nth(1).unwrap();
        assert!(antes_de_emitir(contexto, "avisar_del_canal(app, &p.foto)", "handy:estado"));
        let avisos = socket.split("if let Some(cambio) = p.atender(m)?").nth(1).unwrap();
        assert!(antes_de_emitir(avisos, "aviso_de_cambio(&cambio)", "handy:cambio"));
        // La única foto que sale sin avisar del canal es la del cambio de presencia de la Main, que
        // no cambia de conexión.
        assert_eq!(
            socket.matches(r#"app.emit("handy:estado""#).count(),
            socket.matches("avisar_del_canal(app, &p.foto)").count() + 1
        );

        // Lo que este equipo escribe en el rol o el estado de un usuario no le vuelve como aviso.
        let trabajadores = include_str!("commands/trabajadores.rs");
        let editar = trabajadores.split("pub async fn trabajadores_update(").nth(1).unwrap().split("\n}").next().unwrap();
        assert!(editar.contains("state.olvidar_autorizacion()"), "la edición de un trabajador tira lo guardado");
        let eliminar = trabajadores.split("pub async fn trabajadores_eliminar(").nth(1).unwrap().split("
}").next().unwrap();
        assert!(eliminar.contains("state.olvidar_autorizacion()"), "eliminar a un trabajador tira lo guardado");
    }
}

#[cfg(test)]
mod tests_solo_en_la_main {
    //! Lo que sólo existe en la Main (registros de facturación, tickets, la reserva web, los jobs),
    //! pedido desde una Handy: es una respuesta esperada, no un fallo del programa. El código es lo
    //! que decide si el fallo de un comando va a Sentry (`fallosDeComandos.ts`).

    use super::*;
    use tpv_contracts::errors::ErrorCode;

    async fn base() -> Arc<Db> {
        let dir = std::env::temp_dir().join(format!("tpv-solo-main-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    fn estado(modo: Option<DeviceMode>, db: Option<Arc<Db>>) -> AppState {
        AppState {
            db: Arc::new(Mutex::new(db)),
            cloud: Arc::new(Mutex::new(None)),
            mode: Arc::new(Mutex::new(modo)),
            mode_sync: Arc::new(std::sync::RwLock::new(modo)),
            sesion: Arc::new(Mutex::new(None)),
            tickets_impresos: Arc::new(printing::TicketsImpresos::default()),
            autorizacion: Arc::default(),
            avisar_notificaciones: Arc::new(|| {}),
        }
    }

    /// Los accesos, con el nombre de cada uno para el mensaje del test. Los de los jobs no se
    /// llegan a pedir en una Handy, pero contestan igual: lo que manda es que no es un fallo.
    async fn errores(st: &AppState) -> Vec<(&'static str, Option<AppErrorDto>)> {
        vec![
            ("verifactu_repo", st.verifactu_repo().await.err()),
            ("tickets_repo", st.tickets_repo().await.err()),
            ("reservas_web_repo", st.reservas_web_repo().await.err()),
            ("reconciliacion_repo", st.reconciliacion_repo().await.err()),
            ("sync_repo_de_la_main", st.sync_repo_de_la_main("Sólo en el TPV principal").await.err()),
            ("jobs_state_repo", st.jobs_state_repo().await.err()),
            ("avisos_scan_repo", st.avisos_scan_repo().await.err()),
            ("stock_alertas_repo", st.stock_alertas_repo().await.err()),
        ]
    }

    /// Estadísticas pregunta por el histórico también en una Handy: allí no hay nada que bajar.
    #[tokio::test]
    async fn en_una_handy_el_historico_no_tiene_nada_pendiente_y_no_es_un_error() {
        for db in [None, Some(base().await)] {
            let st = estado(Some(DeviceMode::Handy), db);
            let h = crate::commands::sync::estado_del_historico(&st).await.expect("una Handy contesta");
            assert_eq!((h.tablas_pendientes, h.tablas_completadas, h.filas_traidas), (0, 0, 0));
        }
        // En la Main, el de su base.
        let st = estado(Some(DeviceMode::Tpv), Some(base().await));
        assert_eq!(crate::commands::sync::estado_del_historico(&st).await.unwrap().tablas_pendientes, 0);
    }

    #[tokio::test]
    async fn en_una_handy_se_contesta_que_es_de_la_main_y_no_un_error_interno() {
        let st = estado(Some(DeviceMode::Handy), None);
        for (acceso, error) in errores(&st).await {
            let error = error.unwrap_or_else(|| panic!("{acceso}: una Handy no tiene esto"));
            assert_eq!(error.code, ErrorCode::Conflict, "{acceso}: {}", error.message);
            assert!(error.message.contains("TPV principal"), "{acceso}: {}", error.message);
        }
    }

    /// Un escritorio que fue Main y pasa a Handy conserva la base abierta hasta reiniciar: lo que
    /// manda es el modo, no que haya un fichero.
    #[tokio::test]
    async fn una_handy_con_la_base_de_cuando_fue_main_tampoco_lo_tiene() {
        let st = estado(Some(DeviceMode::Handy), Some(base().await));
        for (acceso, error) in errores(&st).await {
            let error = error.unwrap_or_else(|| panic!("{acceso}: una Handy no tiene esto"));
            assert_eq!(error.code, ErrorCode::Conflict, "{acceso}: {}", error.message);
        }
    }

    #[tokio::test]
    async fn una_main_sin_su_base_si_es_un_fallo_del_programa() {
        for modo in [Some(DeviceMode::Tpv), None] {
            let st = estado(modo, None);
            for (acceso, error) in errores(&st).await {
                let error = error.unwrap_or_else(|| panic!("{acceso}: sin base no hay repositorio"));
                assert_eq!(error.code, ErrorCode::Internal, "{acceso}: {}", error.message);
            }
        }
    }

    #[tokio::test]
    async fn la_main_los_tiene() {
        let st = estado(Some(DeviceMode::Tpv), Some(base().await));
        for (acceso, error) in errores(&st).await {
            assert!(error.is_none(), "{acceso}: {:?}", error.map(|e| e.message));
        }
    }
}

#[cfg(test)]
mod tests_imagenes_heredadas {
    //! OBS-06: una imagen heredada que usa alguna fila pasa a un UUID antes de que su nombre salga
    //! en ninguna petición: el fichero, las filas (por `WriteGuard`, al outbox) y la cola de subida.

    use super::*;
    use tpv_infra_sqlite::db::Reader;
    use tpv_infra_sqlite::ejecutor::Value;

    const HEREDADA: &str = "images/proveedores/Juan-Perez.jpg";
    const SIN_USO: &str = "images/proveedores/sin-uso.png";
    const YA_OPACA: &str = "images/proveedores/0190f3a1-7b2c-4d4e-8f00-123456789abc.jpg";

    async fn texto(db: &Db, sql: &str) -> Vec<String> {
        let r = db.read().await;
        let mut filas = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let mut salida = Vec::new();
        while let Some(fila) = filas.next().await.unwrap() {
            salida.push(tpv_infra_sqlite::mapping::v_string(fila.get_value(0).unwrap()).unwrap_or_default());
        }
        salida
    }

    #[tokio::test]
    async fn la_heredada_en_uso_pasa_a_un_uuid_con_sus_filas_y_su_entrada_en_la_cola() {
        let dir = std::env::temp_dir().join(format!("tpv-heredadas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("images/proveedores")).unwrap();
        for (rel, bytes) in [(HEREDADA, &b"jpg"[..]), (SIN_USO, b"png"), (YA_OPACA, b"otra")] {
            std::fs::write(dir.join(rel), bytes).unwrap();
        }
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write()
            .await
            .raw()
            .execute(
                "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Nombre_Imagen, Ruta_Imagen) VALUES ('p', 'Juan', 'Juan-Perez.jpg', ?1);",
                vec![Value::Text(HEREDADA.into())],
            )
            .await
            .unwrap();
        // Como la dejaba encolada el backfill de antes, con su nombre.
        enqueue_image(&dir, HEREDADA, "image/jpeg").unwrap();

        assert_eq!(renombrar_imagenes_heredadas(&dir, &db).await.unwrap(), 1);

        let ruta = texto(&db, "SELECT Ruta_Imagen FROM Proveedores;").await.remove(0);
        assert!(imagenes::ruta_segura(&ruta) && ruta.starts_with("images/proveedores/") && ruta.ends_with(".jpg"), "{ruta}");
        assert_eq!(std::fs::read(dir.join(&ruta)).unwrap(), b"jpg");
        assert!(!dir.join(HEREDADA).exists());
        assert_eq!(texto(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, vec!["1".to_string()]);
        let cola: Vec<String> = ColaImagenes::new(&dir).pendientes().unwrap().into_iter().map(|i| i.rel_path).collect();
        assert_eq!(cola, vec![ruta.clone()]);
        // La que no usa nadie se queda como estaba, sin subir; la que ya era opaca, también.
        assert!(dir.join(SIN_USO).exists() && dir.join(YA_OPACA).exists());

        // El repaso siguiente no encuentra nada que hacer.
        assert_eq!(renombrar_imagenes_heredadas(&dir, &db).await.unwrap(), 0);
        assert_eq!(texto(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, vec!["1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Si no se pueden cambiar las filas, no queda nada a medias: ni la copia, ni su entrada en la cola.
    #[tokio::test]
    async fn si_no_se_pueden_cambiar_las_filas_no_queda_la_copia_ni_su_entrada_en_la_cola() {
        let dir = std::env::temp_dir().join(format!("tpv-heredadas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("images/proveedores")).unwrap();
        std::fs::write(dir.join(HEREDADA), b"jpg").unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write()
            .await
            .raw()
            .execute(
                "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Ruta_Imagen) VALUES ('p', 'Juan', ?1);",
                vec![Value::Text(HEREDADA.into())],
            )
            .await
            .unwrap();
        // Como durante una recuperación: no entra ninguna escritura de negocio.
        db.bloquear_escrituras_de_negocio(true);

        assert!(renombrar_imagenes_heredadas(&dir, &db).await.is_err());

        assert_eq!(texto(&db, "SELECT Ruta_Imagen FROM Proveedores;").await, vec![HEREDADA.to_string()]);
        let ficheros: Vec<String> = std::fs::read_dir(dir.join("images/proveedores"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(ficheros, vec!["Juan-Perez.jpg".to_string()]);
        assert!(ColaImagenes::new(&dir).pendientes().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests_imagen_bajada_de_r2 {
    //! AUD-31 · Lo que baja de R2 pasa por RI-07 antes de escribirse en disco.
    //!
    //! `images_ensure_local` necesita una app de Tauri y red; lo que se vigila es el propio fuente: que
    //! los bytes bajados se reconstruyan con `imagenes::procesar` antes del `fs::write` y que, si no
    //! pasan, no se escriba nada y se conteste `false` (la pantalla pinta el marcador).

    fn cuerpo_de_images_ensure_local() -> &'static str {
        let fuente = include_str!("lib.rs");
        let desde = fuente.find("async fn images_ensure_local(").expect("images_ensure_local");
        let resto = &fuente[desde..];
        // Acaba en la primera llave de cierre en la primera columna (LF o CRLF).
        &resto[..resto.find("\n}").expect("fin de la función")]
    }

    #[test]
    fn la_imagen_bajada_se_reconstruye_antes_de_escribirla() {
        let cuerpo = cuerpo_de_images_ensure_local();
        let procesar = cuerpo.find("imagenes::procesar(&bytes)").expect("lo bajado pasa por imagenes::procesar");
        let escribir = cuerpo.find("fs::write(").expect("fs::write");
        assert!(procesar < escribir, "procesar va antes de escribir");
        assert!(cuerpo[procesar..escribir].contains("return Ok(false);"), "si no pasa RI-07, no se escribe y se contesta false");
    }

    #[test]
    fn lo_que_no_es_una_imagen_no_pasa_ri_07() {
        // Lo que podría haber en el bucket con las credenciales de un dispositivo.
        let webp: &[u8] = b"RIFF\x1a\0\0\0WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0";
        for bytes in [&b"<svg onload=alert(1)>"[..], webp] {
            assert!(crate::imagenes::procesar(bytes).is_err());
        }
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
            "commands/socket_handy.rs",
            include_str!("commands/socket_handy.rs"),
            "el estado de la Main debe conocerse antes de desbloquear el login de la Handy",
        ),
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
        (
            "commands/telemetria.rs",
            include_str!("commands/telemetria.rs"),
            "registra también los fallos de antes del login, que son los que más cuesta averiguar",
        ),
        (
            "commands/diagnostico.rs",
            include_str!("commands/diagnostico.rs"),
            "el diagnóstico es para cuando algo va mal, también cuando no se puede entrar (OPS-02)",
        ),
        (
            "commands/ventana.rs",
            include_str!("commands/ventana.rs"),
            "el tamaño de la pantalla se ajusta también en el login",
        ),
        (
            "commands/reloj.rs",
            include_str!("commands/reloj.rs"),
            "el aviso del reloj desfasado cuelga también sobre el login y la espera de la Handy (RELOJ-01)",
        ),
    ];

    /// Marcas de que alguien ha metido el gate donde no puede estar.
    const SENALES_DE_GATE: &[&str] = &["exigir_rol", "exigir_permiso", "state.sesion()"];

    #[test]
    fn la_replica_y_las_credenciales_no_se_exponen_a_la_webview() {
        let registro = include_str!("lib.rs").split("collect_commands!").nth(1).unwrap().split("])").next().unwrap();
        for comando in ["sync_apply_changes", "sync_outbox_pending", "sync_outbox_mark_sent", "sync_outbox_mark_failed", "sync_outbox_mark_encolada", "sync_liberar_encoladas", "recovery_complete", "device_sign_b64", "handy_get_ws_auth", "device_firmar_hello"] {
            assert!(!registro.contains(comando), "{comando} debe ser interno");
        }
        let proxy = include_str!("commands/pairing.rs");
        assert!(proxy.contains("if !permitido"));
        assert!(proxy.contains("Esta ruta no está disponible"));
    }

    #[test]
    fn la_webview_no_abre_sockets_y_la_csp_solo_admite_el_ipc_en_produccion() {
        for fuente in [include_str!("../../src/shared/lib/socketHandy.ts"), include_str!("../../src/shared/lib/socketMain.ts")] {
            assert!(!fuente.contains("new WebSocket"));
        }
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for campo in ["csp", "devCsp"] {
            let csp = config["app"]["security"][campo].as_str().unwrap();
            let connect = csp.split(';').find(|s| s.trim().starts_with("connect-src")).unwrap();
            assert!(!connect.contains("workers.dev") && !connect.contains("altarialights.com") && !connect.contains("wss:"));
            // AUD-31: ninguna imagen de la app es un `data:`; uno que llegara replicado no se pinta.
            let img = csp.split(';').find(|s| s.trim().starts_with("img-src")).unwrap();
            assert!(!img.split_whitespace().any(|t| t == "data:"), "{campo}: img-src sin data:");
        }
    }

    /// INFRA-03: la Handy pinta las imágenes por el GET del worker (`handy_url_imagenes`), no por el
    /// `r2.dev` del bucket. `img-src` admite el origen de `CLOUD_API_BASE` —el mismo, no otro escrito
    /// a mano— y nada de `r2.dev`; y el frontend no compone la dirección por su cuenta.
    #[test]
    fn las_imagenes_de_la_handy_salen_del_worker_y_no_de_r2_dev() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for campo in ["csp", "devCsp"] {
            let csp = config["app"]["security"][campo].as_str().unwrap();
            let img = csp.split(';').find(|s| s.trim().starts_with("img-src")).unwrap();
            assert!(img.split_whitespace().any(|t| t == super::CLOUD_API_BASE), "{campo}: img-src con el origen del worker");
            assert!(!csp.contains("r2.dev"), "{campo}: sin el r2.dev del bucket");
        }
        let front = include_str!("../../src/shared/lib/imageUrl.ts");
        assert!(front.contains("commands.handyUrlImagenes()"), "la base sale de handy_url_imagenes");
        assert!(!front.contains("r2.dev") && !front.contains("workers.dev"), "imageUrl.ts no escribe la dirección a mano");
    }

    /// RELOJ-01: el aviso del reloj está registrado, se pide desde el arranque (encima del login y
    /// de la espera de la Handy, no dentro de una pantalla con sesión) y sólo lee: ni firma, ni sale a
    /// la red, ni escribe.
    #[test]
    fn el_aviso_del_reloj_se_ve_antes_del_login_y_solo_lee() {
        let registro = include_str!("lib.rs").split("collect_commands!").nth(1).unwrap().split("])").next().unwrap();
        assert!(registro.contains("commands::reloj::reloj_desfase"), "reloj_desfase registrado");

        let arranque = include_str!("../../src/app/AppBoot.tsx");
        assert!(arranque.contains("<AvisoReloj"), "la franja cuelga del arranque, fuera de las rutas");
        let franja = include_str!("../../src/app/arranque/AvisoReloj.tsx");
        assert!(franja.contains("commands.relojDesfase()"), "la franja pregunta por reloj_desfase");

        let comando = include_str!("commands/reloj.rs");
        for prohibido in ["WriteGuard", "execute", "enviar", "firmar", "reqwest"] {
            assert!(!comando.split("pub fn reloj_desfase").nth(1).unwrap().contains(prohibido), "reloj_desfase no {prohibido}");
        }
    }

    #[test]
    fn atribuciones_de_servicio_salen_de_la_sesion() {
        for (fuente, comandos) in [
            (include_str!("commands/mesas.rs"), vec!["abrir_comanda", "mesas_abrir_o_retomar", "add_linea_comanda", "comanda_set_trabajador_if_null", "kitchen_set_line_state"]),
            (include_str!("commands/tareas.rs"), vec!["tareas_marcar_tarea_finalizada"]),
            (include_str!("commands/venta_rapida.rs"), vec!["vr_create_comanda_barra"]),
            (include_str!("commands/inventario.rs"), vec!["inventario_upsert_producto", "inventario_create_lote", "inventario_ajustar_lote", "inventario_ajustar_stock_suelto"]),
            // AUD-26: qué se ve, en nombre de quién se marca leído y sobre qué actúa la papelera.
            (include_str!("commands/notificaciones.rs"), vec!["notificaciones_listar", "notificaciones_no_leidas", "notificaciones_marcar_leida", "notificaciones_marcar_todas_leidas", "notificaciones_descartar", "notificaciones_papelera", "notificaciones_restaurar", "notificaciones_eliminar"]),
        ] {
            for comando in comandos {
                let cuerpo = fuente.split(&format!("pub async fn {comando}(" )).nth(1).unwrap().split("#[tauri::command]").next().unwrap();
                assert!((cuerpo.contains("state.sesion().await?") || cuerpo.contains("state.exigir_permiso")), "{comando} debe obtener el actor del backend");
                assert!(cuerpo.contains("sesion.id_") || (cuerpo.contains("state.sesion().await?.id_") || cuerpo.contains(".await?.id_")));
            }
        }
    }

    #[test]
    fn guardar_imagen_valida_antes_de_escribir() {
        let fuente = include_str!("lib.rs");
        let comando = fuente.split("async fn save_image(").nth(1).unwrap().split("/// Drena").next().unwrap();
        assert!(comando.find("is_safe_image_rel_path").unwrap() < comando.find("fs::write").unwrap());
        assert!(comando.contains("imagenes::destino"));
        assert!(comando.contains("imagenes::MAX_BYTES"));
    }


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
    /// No es sólo limpieza: **todo lo registrado es alcanzable por el IPC**, y el modelo de amenaza
    /// de §14 asume que quien tiene la máquina delante puede invocarlo. Algunos de los retirados eran
    /// de verdad incómodos: `tpv_server_signed_headers` devolvía la firma de cualquier petición
    /// **sin pasar por ningún gate** —mientras su hermano `tpv_server_post_json` sí exige
    /// Administrador para `/v1/pair/…` y `/v1/device/…`, o sea que era la vuelta a esa esquina—, y
    /// `cobrar_venta_rapida` era un segundo camino de cobro de barra, no idempotente y sin nadie que
    /// lo usara.
    ///
    /// Esto vigila que no vuelvan los retirados, cada uno con su porqué. Que lo que se invoca exista
    /// lo da el propio registro (`collect_commands!` en `command_builder`): de él salen las funciones
    /// de `@tpv/client` y los nombres que invoca el E2E (`nombresComandos`), así que un comando que
    /// no está no compila, y CI comprueba con `generate-types --check` y el typecheck que lo generado
    /// está al día.
    #[test]
    fn los_comandos_retirados_no_vuelven_por_la_puerta_de_atras() {
        // Sólo el registro, no el fichero entero: si no, este propio test —que nombra los
        // comandos— se contaría como una reaparición.
        const FUENTE_COMPLETA: &str = include_str!("lib.rs");
        let desde = FUENTE_COMPLETA
            .find("collect_commands![")
            .expect("no se encuentra el registro de comandos");
        let hasta = FUENTE_COMPLETA[desde..]
            .find("])")
            .expect("el registro de comandos no cierra")
            + desde;
        let registro = &FUENTE_COMPLETA[desde..hasta];

        for (comando, porque) in [
            (
                "tpv_server_signed_headers",
                "firma cualquier petición sin gate: es la vuelta a la esquina del candado de \
                 `tpv_server_post_json` (SEC-01)",
            ),
            (
                "printer_print_ticket",
                "imprimía lo que la pantalla le mandara, número y QR incluidos: un papel con número \
                 que no era el de su factura (RI-29). El ticket de un cobro se compone en Rust desde \
                 la base",
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
            (
                "config_upload_initial_setup",
                "subía a la nube, sin sesión ni `Requiere_Setup`, el PIN que le dijeran para el \
                 usuario que le dijeran; el setup inicial sube por el outbox (AUD-24)",
            ),
            (
                "set_connection_mode",
                "apagaba la réplica de la Main sin sesión ni gate, y ninguna pantalla lo usaba; la \
                 palanca de emergencia es el campo `connectivity` de `device_config.json`, que se \
                 toca a mano (SYNC-17)",
            ),
            (
                "device_hora_para_firmar",
                "daba a la pantalla, sin sesión, la hora de la nube para firmar con ella; la pantalla \
                 no firma nada: el emparejamiento y el saludo los firma Rust con esa hora (PROD-04)",
            ),
        ] {
            // Un porqué partido en dos líneas sin su `\` arrastra la sangría de la segunda.
            assert!(
                !porque.contains("  "),
                "el porqué de `{comando}` lleva espacios de más: a su línea partida le falta el `\\`"
            );
            assert!(
                !registro.contains(comando),
                "`{comando}` ha vuelto al registro de comandos, y no puede: {porque} (REV-26). \
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
            // SYNC-32: la base anterior a lo que guarda la nube, pendiente de traerla.
            "$APPDATA/anterior-a-la-nube",
            // AUD-06: el cambio de negocio pendiente de reinicio, y la licencia que espera a él.
            "$APPDATA/cambio-de-negocio",
            "$APPDATA/cambio-de-negocio.tmp",
            "$APPDATA/license_state.pending.json",
            "$APPDATA/license_state.pending.json.tmp",
            "$APPDATA/interruptores.json",
            "$APPDATA/backups/**",
            "$APPDATA/image_uploads.json",
            "$APPDATA/image_uploads.json.tmp",
            "$APPDATA/telemetry-spool/**",
            "$APPDATA/logs/**",
            "$APPDATA/image_backfill_done",
            // El PDF de cada factura completa: lo que se entregó, que no se reescribe.
            "$APPDATA/facturas/**",
        ];

        // RI-51: la interfaz solo exporta a ficheros autorizados por el diálogo; no lee AppData.
        let capacidades: serde_json::Value = serde_json::from_str(CAPACIDADES).unwrap();
        for permiso in capacidades["permissions"].as_array().unwrap() {
            let id = permiso.as_str().or_else(|| permiso["identifier"].as_str()).unwrap();
            assert!(!matches!(id, "fs:default" | "fs:read-all") && !id.starts_with("fs:allow-read"),
                "La lectura de archivos desde la webview requiere revisar RI-51: {id}");
        }

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
                    (bloque.contains("state.sesion()") || bloque.contains(r#"state.exigir_permiso("servicio.vender")"#)),
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
    /// sincronización está apagada, mejor no emitir»). Por eso se vigila el fuente del camino entero.
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

    /// El camarero entra en Cuentas sólo a los cobros y sus bajas (`docs/arquitectura/permisos.md`).
    /// Se vigila el fuente porque el fallo no se ve: un gate abierto de más no rompe nada, y uno
    /// cerrado de más sólo se nota cuando un camarero intenta devolver a mitad de servicio.
    #[test]
    fn el_camarero_solo_entra_en_los_cobros_de_cuentas() {
        const FUENTE: &str = include_str!("commands/cuentas.rs");
        let cuerpo = |nombre: &str| -> &str {
            let inicio = FUENTE
                .find(&format!("pub async fn {nombre}("))
                .unwrap_or_else(|| panic!("no está el comando {nombre}"));
            let resto = &FUENTE[inicio..];
            let fin = resto.find("#[tauri::command]").unwrap_or(resto.len());
            &resto[..fin]
        };
        for nombre in [
            "cuentas_get_entradas",
            "cuentas_anular_pago",
            "cuentas_lineas_devolubles",
            "cuentas_devolver_lineas",
        ] {
            assert!(
                cuerpo(nombre).contains(r#"exigir_permiso("cuentas.cobros")"#),
                "{nombre} es de los cobros y sus bajas: lo hace también el camarero"
            );
        }
        for nombre in [
            "cuentas_get_salidas",
            "cuentas_get_resumen",
            "cuentas_create_gasto",
            "cuentas_update_gasto",
            "cuentas_delete_gasto",
            "cuentas_update_pago",
        ] {
            let c = cuerpo(nombre);
            assert!(
                c.contains(r#"exigir_permiso("cuentas.gastos")"#) && !c.contains(r#""cuentas.cobros""#),
                "{nombre} es del administrador"
            );
        }
        let previsualizar = cuerpo("cuentas_previsualizar_cambio");
        assert!(
            previsualizar
                .contains(r#"CambioCajaInput::AnularPago { .. } => state.exigir_permiso("cuentas.cobros")"#)
                && previsualizar.contains(r#"_ => state.exigir_permiso("cuentas.gastos")"#),
            "el aviso previo lo pide el camarero sólo para una baja"
        );
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

#[cfg(test)]
mod tests_hilo_de_la_interfaz {
    //! SYN-INC-08: un comando Tauri síncrono corre en el hilo principal, que en Android es el de la
    //! interfaz. Los de la vinculación leen el Keystore por JNI y los de la licencia, el disco: con
    //! el equipo sin red o lento, la pantalla se congelaba y Android la daba por colgada (ANR). Un
    //! comando o es `async`, o lleva `#[tauri::command(async)]`, que lo saca del hilo principal sin
    //! cambiar lo que ve el frontend.

    #[test]
    fn ningun_comando_corre_en_el_hilo_de_la_interfaz() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut ficheros = vec![dir.join("lib.rs")];
        for entrada in std::fs::read_dir(dir.join("commands")).unwrap() {
            let ruta = entrada.unwrap().path();
            if ruta.extension().is_some_and(|e| e == "rs") {
                ficheros.push(ruta);
            }
        }
        let mut vistos = 0;
        for fichero in ficheros {
            let fuente = std::fs::read_to_string(&fichero).unwrap();
            for bloque in fuente.split("#[tauri::command]").skip(1) {
                // Lo que sigue al atributo, saltando otros atributos y comentarios. Si no es una
                // función, el texto era una cadena (los tests de este fichero lo citan).
                let firma = bloque
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty() && !l.starts_with("#[") && !l.starts_with("//"))
                    .unwrap_or("");
                let es_funcion = ["pub ", "pub(crate) ", "async ", "fn "].iter().any(|p| firma.starts_with(p));
                if !es_funcion {
                    continue;
                }
                vistos += 1;
                assert!(
                    firma.contains("async fn"),
                    "{}: `{firma}` correría en el hilo de la interfaz; hazlo `async` o ponle `#[tauri::command(async)]`",
                    fichero.display()
                );
            }
        }
        assert!(vistos > 100, "el test ha dejado de ver los comandos ({vistos})");
    }
}
