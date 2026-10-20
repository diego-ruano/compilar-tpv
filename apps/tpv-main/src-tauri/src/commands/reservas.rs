//! Comandos Tauri de reservas (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::reservas as uc;
use tpv_contracts::reservas::{
    ClienteCoincidente, ReservaBuscarClienteArgs, ReservaCancelarInput, ReservaDeleteInput,
    ReservaDto, ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/// La hora del negocio, «YYYY-MM-DD HH:MM»: la del equipo (RELOJ-01), como el día y la hora de las
/// reservas. Decide si al cliente de una reserva web aún se le avisa de un cambio.
fn ahora_local() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

#[tauri::command]
#[specta::specta]
pub async fn reservas_get_meta(state: State<'_, AppState>) -> Result<ReservasMetaDto, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    Ok(uc::get_meta(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reservas_get_mes(
    state: State<'_, AppState>,
    args: ReservasGetMesArgs,
) -> Result<Vec<ReservaDto>, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    Ok(uc::get_mes(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reservas_save(
    state: State<'_, AppState>,
    args: ReservaSaveInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    let notifier = state.notifier().await.ok();
    let avisos = state.avisos_reserva_web().await.ok();
    Ok(uc::guardar(repo.as_ref(), notifier.as_deref(), avisos.as_deref(), args, &ahora_local()).await?)
}

/// RI-61: el cliente que ya tiene ese teléfono o ese email, para preguntar antes de asignárselo.
#[tauri::command]
#[specta::specta]
pub async fn reservas_buscar_cliente(
    state: State<'_, AppState>,
    args: ReservaBuscarClienteArgs,
) -> Result<Option<ClienteCoincidente>, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    Ok(uc::buscar_cliente(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reservas_delete(
    state: State<'_, AppState>,
    args: ReservaDeleteInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    Ok(uc::eliminar(repo.as_ref(), args).await?)
}

/// Cancela una reserva que aún no ha llegado; a la de una reserva web le llega un correo.
#[tauri::command]
#[specta::specta]
pub async fn reservas_cancelar(
    state: State<'_, AppState>,
    args: ReservaCancelarInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.reservas_repo().await?;
    let avisos = state.avisos_reserva_web().await.ok();
    Ok(uc::cancelar(repo.as_ref(), avisos.as_deref(), args, &ahora_local()).await?)
}
