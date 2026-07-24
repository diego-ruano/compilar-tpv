//! Comandos Tauri de **licensing** (capa fina hexagonal). No SQLite: el adaptador usa
//! keyring + `license_state.json` (en AppData) + HTTP al worker de licencias.
//! Mismos nombres de invoke que el monolito previo.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use tpv_application::use_cases::licensing as uc;
use tpv_contracts::licensing::{
    LicenseActivateInput, LicenseActivateOutcome, LicenseDeviceChangeInput, LicenseGateResult,
    LicenseLocalState,
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
    // Notifier (mode-switched) para avisar de licencia por caducar / caducada-en-gracia / gracia
    // offline. `None` si aún no hay modo/BD → no se avisa. La decisión del gate NO depende de esto.
    let notifier = app.state::<crate::AppState>().notifier().await.ok();
    let service = svc(&app)?;
    Ok(uc::gate(&service, notifier.as_deref()).await?)
}

#[tauri::command]
pub async fn license_check_now(app: AppHandle) -> Result<LicenseGateResult, String> {
    Ok(uc::check_now(&svc(&app)?).await?)
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    args: LicenseActivateInput,
) -> Result<LicenseActivateOutcome, String> {
    Ok(uc::activate(&svc(&app)?, args).await?)
}

/// Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia (§6.4).
#[tauri::command]
pub async fn license_request_device_change(
    app: AppHandle,
    args: LicenseDeviceChangeInput,
) -> Result<String, String> {
    uc::request_device_change(&svc(&app)?, args).await?;
    Ok("OK".into())
}
