//! Comandos Tauri de la reserva desde la web (docs/estudios/reservas-web.md), capa fina.
//!
//! Configurarla es administración del negocio, como el resto de Configuración: exige
//! Administrador. Sólo existe en la Main (`reservas_web_repo`).

use tauri::State;

use tpv_application::use_cases::reservas_web as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::reservas_web::{
    AjustesReservaWebDto, ReservaWebActivarInput, ReservaWebCierreInput,
    ReservaWebQuitarCierreInput,
};

use crate::{AppState, ADMIN};

#[tauri::command]
#[specta::specta]
pub async fn reserva_web_ajustes(state: State<'_, AppState>) -> Result<AjustesReservaWebDto, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::ajustes(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reserva_web_activar(
    state: State<'_, AppState>,
    args: ReservaWebActivarInput,
) -> Result<(), AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::activar(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reserva_web_cerrar_dia(
    state: State<'_, AppState>,
    args: ReservaWebCierreInput,
) -> Result<String, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::cerrar_dia(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reserva_web_quitar_cierre(
    state: State<'_, AppState>,
    args: ReservaWebQuitarCierreInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::quitar_cierre(repo.as_ref(), args).await?)
}
