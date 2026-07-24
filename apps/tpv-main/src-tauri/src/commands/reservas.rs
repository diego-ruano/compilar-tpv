//! Comandos Tauri de reservas (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::reservas as uc;
use tpv_contracts::reservas::{
    ReservaDeleteInput, ReservaDto, ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use crate::AppState;

#[tauri::command]
pub async fn reservas_get_meta(state: State<'_, AppState>) -> Result<ReservasMetaDto, String> {
    let repo = state.reservas_repo().await?;
    Ok(uc::get_meta(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn reservas_get_mes(
    state: State<'_, AppState>,
    args: ReservasGetMesArgs,
) -> Result<Vec<ReservaDto>, String> {
    let repo = state.reservas_repo().await?;
    Ok(uc::get_mes(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn reservas_save(
    state: State<'_, AppState>,
    args: ReservaSaveInput,
) -> Result<bool, String> {
    let repo = state.reservas_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::guardar(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn reservas_delete(
    state: State<'_, AppState>,
    args: ReservaDeleteInput,
) -> Result<bool, String> {
    let repo = state.reservas_repo().await?;
    Ok(uc::eliminar(repo.as_ref(), args).await?)
}
