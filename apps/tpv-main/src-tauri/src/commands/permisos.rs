//! RI-70: capacidades de la sesión y gestor exclusivo del administrador en Main.
use tauri::State;
use tpv_contracts::{errors::AppErrorDto, permisos::*};
use tpv_application::use_cases::permisos as uc;
use crate::{AppState, DeviceMode, ADMIN};
#[tauri::command]
#[specta::specta]
pub async fn permisos_sesion(state: State<'_, AppState>) -> Result<AutorizacionUsuario, AppErrorDto> {
    Ok(state.autorizacion().await?.1)
}
#[tauri::command]
#[specta::specta]
pub async fn permisos_configuracion(state: State<'_, AppState>) -> Result<ConfiguracionPermisos, AppErrorDto> {
    let s = state.exigir_rol(&[ADMIN]).await?;
    let repo = state.permisos_repo().await?;
    Ok(uc::configuracion(repo.as_ref(), &s.id_usuario).await?)
}
#[tauri::command]
#[specta::specta]
pub async fn permisos_guardar(state: State<'_, AppState>, args: GuardarPermisosInput) -> Result<(), AppErrorDto> {
    let s = state.exigir_rol(&[ADMIN]).await?;
    if *state.mode.lock().await != Some(DeviceMode::Tpv) { return Err(crate::permiso_denegado("Los permisos se administran en el TPV principal")); }
    let repo = state.permisos_repo().await?;
    Ok(uc::guardar(repo.as_ref(), &s.id_usuario, args).await?)
}
