//! Comandos Tauri de **pairing / identidad de dispositivo** (capa fina hexagonal).
//! No SQLite: keyring (clave ed25519 + handy token) + HTTP a tpv-server.
//! El `AppHandle` lo inyecta Tauri (no viaja desde JS): se usa sólo para resolver AppData,
//! necesario cuando el modo `tpv` firma con el token de `license_state.json`.

use std::path::PathBuf;

use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};

use tpv_application::use_cases::cloud_sync as uc_sync;
use tpv_application::use_cases::pairing as uc;
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, DeviceSignB64Args, HandySetTokenArgs, HandyWsAuth,
    PairCreateResult, SigB64, TpvServerPostJsonArgs, TpvServerSignedHeadersArgs,
    UploadInitialSetupArgs,
};
use tpv_infra_licensing::PairingAdapter;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

fn svc(app: &AppHandle) -> Result<PairingAdapter, String> {
    Ok(PairingAdapter::new(app_data_dir(app)?))
}

#[tauri::command]
pub fn handy_set_token(app: AppHandle, args: HandySetTokenArgs) -> Result<String, String> {
    uc::handy_set_token(&svc(&app)?, args)?;
    Ok("OK".into())
}

#[tauri::command]
pub fn handy_clear_token(app: AppHandle) -> Result<String, String> {
    uc::handy_clear_token(&svc(&app)?)?;
    Ok("OK".into())
}

#[tauri::command]
pub fn handy_get_tenant(app: AppHandle) -> Result<Option<String>, String> {
    Ok(uc::handy_get_tenant(&svc(&app)?)?)
}

/// Credenciales (token + tenant) para abrir el WebSocket del Handy (`/ws?token=`).
#[tauri::command]
pub fn handy_get_ws_auth(app: AppHandle) -> Result<HandyWsAuth, String> {
    Ok(uc::handy_get_ws_auth(&svc(&app)?)?)
}

#[tauri::command]
pub fn device_get_identity(app: AppHandle) -> Result<DeviceIdentity, String> {
    Ok(uc::device_identity(&svc(&app)?)?)
}

#[tauri::command]
pub fn device_sign_b64(app: AppHandle, args: DeviceSignB64Args) -> Result<SigB64, String> {
    Ok(uc::device_sign_b64(&svc(&app)?, args)?)
}

#[tauri::command]
pub fn tpv_server_signed_headers(
    app: AppHandle,
    args: TpvServerSignedHeadersArgs,
) -> Result<ApiSignedHeaders, String> {
    Ok(uc::tpv_server_signed_headers(&svc(&app)?, args)?)
}

#[tauri::command]
pub async fn tpv_server_post_json(
    app: AppHandle,
    args: TpvServerPostJsonArgs,
) -> Result<JsonValue, String> {
    Ok(uc::tpv_server_post_json(&svc(&app)?, args).await?)
}

/// Genera un nuevo código de emparejamiento (lo pide al worker) y lo devuelve tipado a la UI.
#[tauri::command]
pub async fn pair_create(app: AppHandle) -> Result<PairCreateResult, String> {
    Ok(uc::pair_create(&svc(&app)?).await?)
}

/// Sube a la nube el setup inicial del admin tras completarlo en local (panel de
/// configuración inicial). El `PairingAdapter` firma la petición como dispositivo TPV.
#[tauri::command]
pub async fn config_upload_initial_setup(
    app: AppHandle,
    args: UploadInitialSetupArgs,
) -> Result<String, String> {
    uc_sync::upload_initial_setup(&svc(&app)?, args).await?;
    Ok("OK".into())
}
