//! Comandos Tauri de la **recuperación del PIN de un administrador** (LOGIN-07). Capa fina: la
//! lógica y sus porqués están en `tpv_application::use_cases::recuperacion_pin`.
//!
//! ⚠️ Sin sesión, por definición: quien llega aquí es quien no puede iniciarla. Por eso este
//! fichero está en `tests_exenciones_del_gate`, junto a la recuperación de datos.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::recuperacion_pin as uc;
use tpv_contracts::errors::{AppErrorDto, ErrorCode};
use tpv_contracts::login::{CodigoEnviado, ConfirmarCodigoPinInput, SolicitarCodigoPinInput};
use tpv_infra_licensing::PairingAdapter;

use crate::{AppState, DeviceMode};

/// La Handy no guarda PINs (entra contra el worker). El worker también lo rechaza; esto sólo
/// ahorra el viaje y da un mensaje que se entiende.
async fn solo_en_la_main(state: &AppState) -> Result<(), AppErrorDto> {
    if matches!(*state.mode.lock().await, Some(DeviceMode::Tpv)) {
        return Ok(());
    }
    Err(AppErrorDto::new(
        ErrorCode::Validation,
        "El PIN se recupera desde el TPV principal",
    ))
}

fn nube(app: &AppHandle) -> Result<PairingAdapter, AppErrorDto> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(PairingAdapter::new(dir))
}

/// Manda un código al correo del titular de la licencia.
#[tauri::command]
#[specta::specta]
pub async fn login_recuperar_pin_solicitar(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SolicitarCodigoPinInput,
) -> Result<CodigoEnviado, AppErrorDto> {
    solo_en_la_main(&state).await?;
    let repo = state.login_repo().await?;
    Ok(uc::solicitar(repo.as_ref(), &nube(&app)?, args).await?)
}

/// Verifica el código y, sólo si vale, guarda el PIN nuevo. Las dos cosas aquí dentro.
#[tauri::command]
#[specta::specta]
pub async fn login_recuperar_pin_confirmar(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConfirmarCodigoPinInput,
) -> Result<String, AppErrorDto> {
    solo_en_la_main(&state).await?;
    let repo = state.login_repo().await?;
    uc::confirmar(repo.as_ref(), &nube(&app)?, args).await?;
    Ok("OK".to_string())
}
