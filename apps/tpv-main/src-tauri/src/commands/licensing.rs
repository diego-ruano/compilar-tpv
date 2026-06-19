//! Comandos Tauri de **licensing** (capa fina hexagonal). No SQLite: el adaptador usa
//! keyring + `license_state.json` (en AppData) + HTTP al worker de licencias.
//! Mismos nombres de invoke que el monolito previo.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use tpv_application::use_cases::licensing as uc;
use tpv_contracts::licensing::{
    LicenseActivateInput, LicenseGateResult, LicenseLocalState,
};
use tpv_infra_licensing::LicensingAdapter;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

fn svc(app: &AppHandle) -> Result<LicensingAdapter, String> {
    Ok(LicensingAdapter::new(app_data_dir(app)?))
}

#[tauri::command]
pub fn license_get_state(app: AppHandle) -> Result<Option<LicenseLocalState>, String> {
    Ok(uc::get_state(&svc(&app)?)?)
}

#[tauri::command]
pub fn license_clear_state(app: AppHandle) -> Result<String, String> {
    uc::clear_state(&svc(&app)?)?;
    Ok("OK".into())
}

#[tauri::command]
pub async fn license_gate(app: AppHandle) -> Result<LicenseGateResult, String> {
    Ok(uc::gate(&svc(&app)?).await?)
}

#[tauri::command]
pub async fn license_check_now(app: AppHandle) -> Result<LicenseGateResult, String> {
    Ok(uc::check_now(&svc(&app)?).await?)
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    args: LicenseActivateInput,
) -> Result<LicenseLocalState, String> {
    Ok(uc::activate(&svc(&app)?, args).await?)
}
