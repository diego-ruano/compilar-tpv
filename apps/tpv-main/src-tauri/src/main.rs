// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cloud_sync;
mod commands;
mod fallback_local;
mod licensing;
mod login;
mod mesas;
mod sync_manager;
mod pairing;
mod stats;
mod tareas;
mod trabajadores;
mod venta_rapida;

use base64::prelude::*;
use libsql::{Builder, Connection, Value};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

// ──────────────────────────────────────────────────────────────────────────────
// Device mode (TPV / HANDY) + config persistente
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DeviceMode {
    Tpv,
    Handy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DeviceConfig {
    mode: Option<DeviceMode>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
struct SetDeviceModeArgs {
    mode: DeviceMode,
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
    mode: Arc<Mutex<Option<DeviceMode>>>,
}

pub(crate) async fn get_db(state: &State<'_, AppState>) -> Result<Arc<Connection>, String> {
    let guard = state.db.lock().await;

    guard
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada (modo handy o sin init_main)".to_string())
}

// ──────────────────────────────────────────────────────────────────────────────
// Inicialización TPV MAIN (DB local)
// ──────────────────────────────────────────────────────────────────────────────

fn value_to_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

async fn query_single_i64(conn: &Connection, sql: &str) -> Result<i64, String> {
    let mut rows = conn
        .query(sql, Vec::<Value>::new())
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(0);
    };

    let v = row
        .get_value(0)
        .map_err(|e| format!("DB get_value error: {e}"))?;

    Ok(value_to_i64(v).unwrap_or(0))
}

async fn seed_admin_if_empty(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO Roles (Nombre_Rol) VALUES ('Administrador');",
        Vec::<Value>::new(),
    )
    .await
    .map_err(|e| format!("Error creando rol Administrador: {e}"))?;

    let users_count = query_single_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await?;

    if users_count > 0 {
        return Ok(());
    }

    let id_admin = query_single_i64(
        conn,
        "SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador' LIMIT 1;",
    )
    .await?;

    if id_admin <= 0 {
        return Err("No se pudo resolver ID_Rol de Administrador".to_string());
    }

    let hash = login::hash_password("1234".to_string())?;

    conn.execute(
        r#"
        INSERT INTO Usuarios (
            ID_Rol,
            Email,
            Password_Hash,
            Nombre,
            Apellido,
            Estado,
            Requiere_Setup
        )
        VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            ?5,
            'Activo',
            1
        );
        "#,
        vec![
            Value::Integer(id_admin),
            Value::Text("admin@local".to_string()),
            Value::Text(hash),
            Value::Text("Admin".to_string()),
            Value::Text("TPV".to_string()),
        ],
    )
    .await
    .map_err(|e| format!("Error creando usuario admin inicial: {e}"))?;

    Ok(())
}

async fn init_main_db(app_data_dir: &Path) -> Result<Connection, String> {
    let db_path = app_data_dir.join("data.db");

    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| "Ruta de BD inválida".to_string())?;

    let db = Builder::new_local(db_path_str)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let c = db.connect().map_err(|e| e.to_string())?;

    let schema = include_str!("../schema.sql");

    c.execute_batch(schema)
        .await
        .map_err(|e| format!("Error ejecutando schema.sql: {e}"))?;

    seed_admin_if_empty(&c)
        .await
        .map_err(|e| format!("Error haciendo seed_admin_if_empty: {e}"))?;

    Ok(c)
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

    let mut m = state.mode.lock().await;
    *m = Some(args.mode);

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

    let conn = init_main_db(&app_data_dir).await?;
    let db = Arc::new(conn);

    sync_manager::start_sync_manager_loop(db.clone());

    let mut guard = state.db.lock().await;
    *guard = Some(db);

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
                    init_main_db(&app_data_dir)
                        .await
                        .expect("Error init_main_db")
                })))
            } else {
                None
            };

            if let Some(db) = db_opt.as_ref().cloned() {
                sync_manager::start_sync_manager_loop(db);
            }

            app.manage(AppState {
                db: Arc::new(Mutex::new(db_opt)),
                mode: Arc::new(Mutex::new(mode)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // device
            get_device_mode,
            set_device_mode,
            init_main,
            // genéricos
            save_image,
            get_app_data_path,
            // sync
            cloud_sync::sync_get_last_cloud_change_id,
            cloud_sync::sync_apply_cloud_changes,
            cloud_sync::sync_mark_local_operation_applied,
            sync_manager::sync_enqueue_pending_local_apply,
            sync_manager::sync_manager_kick,
            sync_manager::sync_pending_local_apply_count,
            // auth / login
            login::list_login_users,
            login::login_user,
            login::hash_password,
            login::get_today_punch_status,
            login::punch,
            login::complete_initial_setup,
            login::set_turno_partido_hoy,
            // mesass
            mesas::save_layout,
            mesas::load_layout,
            mesas::get_mesas_ocupadas,
            mesas::set_reserva_estado,
            mesas::get_comanda_abierta_by_mesa,
            mesas::abrir_comanda,
            mesas::comanda_set_trabajador_if_null,
            mesas::cerrar_comanda,
            mesas::get_lineas_comanda,
            mesas::add_linea_comanda,
            mesas::get_or_create_mesa_barra,
            mesas::get_or_create_comanda_barra,
            mesas::cobrar_venta_rapida,
            mesas::create_comanda_barra,
            mesas::list_comandas_barra,
            mesas::delete_comanda_barra_if_safe,
            mesas::mesas_meta_all,
            mesas::list_categorias_vendibles,
            mesas::list_productos_by_categoria,
            mesas::search_productos_by_nombre,
            mesas::remove_one_pending_detalle,
            mesas::delete_detalle,
            mesas::update_detalle_nota,
            mesas::cobrar_detalles,
            mesas::kitchen_list_today_pending,
            mesas::kitchen_set_line_state,
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
            tareas::tareas_get_trabajadores,
            tareas::tareas_create_tarea,
            tareas::tareas_get_tareas_admin,
            tareas::tareas_get_tarea_by_id,
            tareas::tareas_update_tarea,
            tareas::tareas_get_tarea_asignados,
            tareas::tareas_set_asignaciones_tarea,
            tareas::tareas_delete_tarea,
            tareas::tareas_get_mis_tareas,
            tareas::tareas_marcar_tarea_finalizada,
            tareas::tareas_create_tarea_after_remote_ok,
            tareas::tareas_update_tarea_after_remote_ok,
            tareas::tareas_set_asignaciones_tarea_after_remote_ok,
            tareas::tareas_delete_tarea_after_remote_ok,
            tareas::tareas_marcar_tarea_finalizada_after_remote_ok,
            // trabajadores
            trabajadores::trabajadores_get_roles,
            trabajadores::trabajadores_get_all,
            trabajadores::trabajadores_get_detail,
            trabajadores::trabajadores_get_trabajador_id_by_usuario,
            trabajadores::turnos_get_all,
            trabajadores::horarios_get_asignaciones_semana,
            trabajadores::horarios_create_asignacion,
            trabajadores::horarios_update_asignacion,
            trabajadores::horarios_delete_asignacion,
            trabajadores::horarios_copy_semana_asignaciones,
            trabajadores::horarios_set_predeterminado_desde_semana,
            trabajadores::horarios_create_asignacion_after_remote_ok,
            trabajadores::horarios_update_asignacion_after_remote_ok,
            trabajadores::horarios_delete_asignacion_after_remote_ok,
            trabajadores::horarios_copy_semana_asignaciones_after_remote_ok,
            trabajadores::horarios_set_predeterminado_desde_semana_after_remote_ok,
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
            venta_rapida::vr_list_categorias_vendibles,
            venta_rapida::vr_list_productos_by_categoria,
            venta_rapida::vr_search_productos,
            venta_rapida::vr_create_comanda_barra,
            venta_rapida::vr_list_comandas_barra,
            venta_rapida::vr_get_lineas_comanda,
            venta_rapida::vr_add_linea_comanda,
            venta_rapida::vr_remove_last_unpaid_linea,
            venta_rapida::vr_delete_linea_if_unpaid,
            venta_rapida::vr_update_nota_detalle,
            venta_rapida::vr_cobrar_fraccionado,
            venta_rapida::vr_restar_stock,
            venta_rapida::vr_delete_comanda_if_safe,
            venta_rapida::vr_get_index_rows,
            venta_rapida::vr_get_detalles_ver_ticket,
            // stats
            stats::stats_mesas_get,
            stats::stats_productos_list_categorias,
            stats::stats_productos_resumen,
            stats::stats_reservas_resumen,
            stats::stats_trabajadores_resumen,
            stats::stats_clientes_resumen,
            stats::stats_proveedores_resumen,
            // licensing
            licensing::license_get_state,
            licensing::license_activate,
            licensing::license_clear_state,
            licensing::license_gate,
            licensing::license_check_now,
            licensing::api_get_auth_headers,
            // pairing
            pairing::tpv_server_signed_headers,
            pairing::license_read_state_for_ui,
            pairing::handy_set_token,
            pairing::handy_clear_token,
            pairing::handy_get_tenant,
            pairing::device_get_identity,
            pairing::device_sign_b64,
            pairing::tpv_server_post_json,
            // configuración (migrado a arquitectura hexagonal — commands/configuracion.rs)
            commands::configuracion::config_get_business_settings,
            commands::configuracion::config_patch_business_settings,
            commands::configuracion::config_get_ticket_settings,
            commands::configuracion::config_patch_ticket_settings,
            // fallback_local
            fallback_local::fallback_local_outbox_enqueue,
            fallback_local::fallback_local_outbox_get_pending,
            fallback_local::fallback_local_outbox_pending_count,
            fallback_local::fallback_local_outbox_mark_syncing,
            fallback_local::fallback_local_outbox_mark_applied,
            fallback_local::fallback_local_outbox_mark_failed,
            fallback_local::fallback_local_outbox_requeue_syncing,
            fallback_local::fallback_local_outbox_get_by_op_id,
            fallback_local::fallback_local_outbox_delete_applied,
            fallback_local::fallback_local_outbox_claim_next,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}