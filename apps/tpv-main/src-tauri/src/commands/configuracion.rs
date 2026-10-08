//! Comandos Tauri de configuración (capa fina hexagonal).
//!
//! SEC-01: las **escrituras** exigen Administrador (la sección Configuración ya era suya en el
//! menú, pero un menú no es un permiso y `/configuracion` no tiene candado de ruta). Las
//! lecturas no: las llaman los stores al arrancar el modo Main, ANTES de que nadie inicie
//! sesión, y además son el nombre del negocio y el ancho del papel.

use tauri::State;

use tpv_application::use_cases::configuracion as uc;
use tpv_contracts::configuracion::{BusinessSettings, BusinessSettingsPatchInput, ContactSettings, ContactSettingsPatchInput, TicketSettings, TicketSettingsPatchInput};
use crate::{AppState, ADMIN};
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn config_get_business_settings(
    state: State<'_, AppState>,
) -> Result<BusinessSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_business(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn config_get_ticket_settings(
    state: State<'_, AppState>,
) -> Result<TicketSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_ticket(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn config_patch_business_settings(
    state: State<'_, AppState>,
    args: BusinessSettingsPatchInput,
) -> Result<String, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_business(repo.as_ref(), args.patch).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn config_patch_ticket_settings(
    state: State<'_, AppState>,
    args: TicketSettingsPatchInput,
) -> Result<String, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_ticket(repo.as_ref(), args.patch).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn config_get_contact_settings(
    state: State<'_, AppState>,
) -> Result<ContactSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_contact(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn config_patch_contact_settings(
    state: State<'_, AppState>,
    args: ContactSettingsPatchInput,
) -> Result<String, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_contact(repo.as_ref(), args.patch).await?)
}
