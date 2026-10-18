//! Comandos Tauri de la reserva desde la web (docs/estudios/reservas-web.md), capa fina.
//!
//! El interruptor general y los días cerrados son administración del negocio, como el resto de
//! Configuración: exigen Administrador. Las mesas, quien edita el plano. Sólo existe en la Main
//! (`reservas_web_repo`).

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::reservas_web as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::reservas_web::{
    AjustesReservaWebDto, ClaveReservaWebDto, ReservaWebActivarInput, ReservaWebCierreInput,
    ReservaWebMesaDto, ReservaWebMesaInput, ReservaWebQuitarCierreInput,
};
use tpv_infra_licensing::PairingAdapter;

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

/// La línea que se pega en la web del negocio, con su clave pública (la crea el worker si no
/// tiene). Hace falta conexión: la clave vive en la nube.
#[tauri::command]
#[specta::specta]
pub async fn reserva_web_clave(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaveReservaWebDto, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    // Sólo en la Main: la clave se pide con la firma del equipo principal.
    state.reservas_web_repo().await?;
    let dir = app.path().app_data_dir().map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(uc::clave_para_la_web(&PairingAdapter::new(dir)).await?)
}

/// Qué mesas se pueden reservar desde la web y cuándo. Se configura en el editor del plano, así
/// que lo puede quien edita el plano (`plano.gestionar`), igual que el resto de cada mesa. El
/// interruptor general y los días cerrados siguen siendo del administrador.
#[tauri::command]
#[specta::specta]
pub async fn reserva_web_mesas(state: State<'_, AppState>) -> Result<Vec<ReservaWebMesaDto>, AppErrorDto> {
    state.exigir_permiso("plano.gestionar").await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::mesas(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reserva_web_guardar_mesa(
    state: State<'_, AppState>,
    args: ReservaWebMesaInput,
) -> Result<(), AppErrorDto> {
    state.exigir_permiso("plano.gestionar").await?;
    let repo = state.reservas_web_repo().await?;
    Ok(uc::guardar_mesa(repo.as_ref(), args).await?)
}
