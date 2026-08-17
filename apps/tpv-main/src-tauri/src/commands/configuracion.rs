//! Comandos Tauri de configuración (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::configuracion as uc;
use tpv_contracts::configuracion::{BusinessSettings, ConfigPatchInput, ContactSettings, TicketSettings};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
pub async fn config_get_business_settings(
    state: State<'_, AppState>,
) -> Result<BusinessSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_business(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn config_get_ticket_settings(
    state: State<'_, AppState>,
) -> Result<TicketSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_ticket(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn config_patch_business_settings(
    state: State<'_, AppState>,
    args: ConfigPatchInput,
) -> Result<String, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_business(repo.as_ref(), args.patch).await?)
}

#[tauri::command]
pub async fn config_patch_ticket_settings(
    state: State<'_, AppState>,
    args: ConfigPatchInput,
) -> Result<String, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_ticket(repo.as_ref(), args.patch).await?)
}

#[tauri::command]
pub async fn config_get_contact_settings(
    state: State<'_, AppState>,
) -> Result<ContactSettings, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::get_contact(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn config_patch_contact_settings(
    state: State<'_, AppState>,
    args: ConfigPatchInput,
) -> Result<String, AppErrorDto> {
    let repo = state.configuracion_repo().await?;
    Ok(uc::patch_contact(repo.as_ref(), args.patch).await?)
}
