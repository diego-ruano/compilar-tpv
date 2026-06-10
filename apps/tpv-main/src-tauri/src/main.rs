// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use base64::prelude::*;
use libsql::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use tpv_application::ports::licensing::PairingService;
use tpv_application::ports::{
    clientes::ClientesRepository, configuracion::ConfiguracionRepository,
    cuentas::CuentasRepository, inventario::InventarioRepository, login::LoginRepository,
    mesas::MesasRepository, proveedores::ProveedoresRepository, reservas::ReservasRepository,
    stats::StatsRepository, tareas::TareasRepository, trabajadores::TrabajadoresRepository,
    venta_rapida::VentaRapidaRepository,
};
use tpv_infra_http::{
    clientes::HttpClientesRepository, configuracion::HttpConfiguracionRepository,
    cuentas::HttpCuentasRepository, inventario::HttpInventarioRepository,
    login::HttpLoginRepository, mesas::HttpMesasRepository, proveedores::HttpProveedoresRepository,
    reservas::HttpReservasRepository, stats::HttpStatsRepository, tareas::HttpTareasRepository,
    trabajadores::HttpTrabajadoresRepository, venta_rapida::HttpVentaRapidaRepository, CloudClient,
    CLOUD_API_BASE,
};
use tpv_infra_licensing::PairingAdapter;
use tpv_infra_sqlite::{
    clientes::SqliteClientesRepository, configuracion::SqliteConfiguracionRepository,
    cuentas::SqliteCuentasRepository, inventario::SqliteInventarioRepository,
    login::SqliteLoginRepository, mesas::SqliteMesasRepository,
    proveedores::SqliteProveedoresRepository, reservas::SqliteReservasRepository,
    stats::SqliteStatsRepository, tareas::SqliteTareasRepository,
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

// ──────────────────────────────────────────────────────────────────────────────
// Estado global
// ──────────────────────────────────────────────────────────────────────────────

pub(crate) struct AppState {
    db: Arc<Mutex<Option<Arc<Connection>>>>,
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

/// Persiste el modo de funcionamiento (offline/online) en `device_config.json`.
#[tauri::command]
fn set_connection_mode(app: AppHandle, args: SetConnectionModeArgs) -> Result<String, String> {
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

    let conn = tpv_infra_sqlite::connection::init_main_db(&app_data_dir, include_str!("../../../../packages/database/schema.sql"))
        .await
        .map_err(String::from)?;
    let db = Arc::new(conn);

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

    let file_path = dir_path.join(&filename);

    let image_bytes = BASE64_STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Error al decodificar Base64: {e}"))?;

    fs::write(&file_path, image_bytes)
        .map_err(|e| format!("Error escribiendo el archivo en {:?}: {e}", file_path))?;

    Ok("Imagen guardada correctamente".to_string())
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

            let db_opt: Option<Arc<Connection>> = if mode == Some(DeviceMode::Tpv) {
                Some(Arc::new(tauri::async_runtime::block_on(async {
                    tpv_infra_sqlite::connection::init_main_db(
                        &app_data_dir,
                        include_str!("../../../../packages/database/schema.sql"),
                    )
                    .await
                    .expect("Error init_main_db")
                })))
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
            get_app_data_path,
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
            commands::licensing::api_get_auth_headers,
            // pairing (migrado a arquitectura hexagonal — commands/pairing.rs)
            commands::pairing::tpv_server_signed_headers,
            commands::pairing::license_read_state_for_ui,
            commands::pairing::handy_set_token,
            commands::pairing::handy_clear_token,
            commands::pairing::handy_get_tenant,
            commands::pairing::device_get_identity,
            commands::pairing::device_sign_b64,
            commands::pairing::tpv_server_post_json,
            commands::pairing::pair_create,
            commands::pairing::config_upload_initial_setup,
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