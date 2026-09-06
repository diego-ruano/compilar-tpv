//! Comandos Tauri de **licensing** (capa fina hexagonal). No SQLite: el adaptador usa
//! keyring + `license_state.json` (en AppData) + HTTP al worker de licencias.
//! Mismos nombres de invoke que el monolito previo.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use tpv_application::use_cases::licensing as uc;
use tpv_contracts::licensing::{
    LicenseActivateInput, LicenseActivateOutcome, LicenseDeviceChangeInput, LicenseGateResult,
    LicenseLocalState,
};
use tpv_infra_licensing::LicensingAdapter;
use tpv_contracts::errors::AppErrorDto;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/// `pub(crate)` porque el job periódico de licencia (`jobs/registro.rs`) construye el mismo
/// servicio: el pulso de fondo y los comandos de la UI deben hablar con el MISMO adaptador.
pub(crate) fn svc(app: &AppHandle) -> Result<LicensingAdapter, String> {
    Ok(LicensingAdapter::new(app_data_dir(app)?))
}

#[tauri::command]
pub fn license_get_state(app: AppHandle) -> Result<Option<LicenseLocalState>, AppErrorDto> {
    Ok(uc::get_state(&svc(&app)?)?)
}

#[tauri::command]
pub fn license_clear_state(app: AppHandle) -> Result<String, AppErrorDto> {
    uc::clear_state(&svc(&app)?)?;
    Ok("OK".into())
}

#[tauri::command]
pub async fn license_gate(app: AppHandle) -> Result<LicenseGateResult, AppErrorDto> {
    // Notifier (mode-switched) para avisar de licencia por caducar / caducada-en-gracia / gracia
    // offline. `None` si aún no hay modo/BD → no se avisa. La decisión del gate NO depende de esto.
    let notifier = app.state::<crate::AppState>().notifier().await.ok();
    let service = svc(&app)?;
    Ok(uc::gate(&service, notifier.as_deref()).await?)
}

/// Comprueba la licencia contra el servidor AHORA, sin esperar al pulso del job.
///
/// Emite `license:changed` con el resultado, igual que hace el job: quien llame a esto puede no ser
/// la pantalla —lo llama también el WebSocket cuando la nube le rechaza el ticket por licencia—, y
/// sin el evento el veredicto se quedaba en el fichero de estado mientras la interfaz seguía
/// vendiendo tan tranquila hasta la siguiente vuelta del job, seis horas después.
#[tauri::command]
pub async fn license_check_now(app: AppHandle) -> Result<LicenseGateResult, AppErrorDto> {
    let res = uc::check_now(&svc(&app)?).await?;

    // Best-effort: que no se pueda avisar a la ventana no invalida la comprobación.
    if let Err(e) = app.emit("license:changed", res.clone()) {
        tracing::warn!(target: "tpv::licensing", error = %e, "no se pudo emitir license:changed");
    }

    Ok(res)
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    args: LicenseActivateInput,
) -> Result<LicenseActivateOutcome, AppErrorDto> {
    Ok(uc::activate(&svc(&app)?, args).await?)
}

/// Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia (§6.4).
#[tauri::command]
pub async fn license_request_device_change(
    app: AppHandle,
    args: LicenseDeviceChangeInput,
) -> Result<String, AppErrorDto> {
    uc::request_device_change(&svc(&app)?, args).await?;
    Ok("OK".into())
}
