//! Comandos Tauri de trabajadores / horarios (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.

use tauri::State;

use tpv_application::use_cases::trabajadores as uc;
use tpv_contracts::trabajadores::{
    AsignacionCreateInput, AsignacionDeleteInput, AsignacionRow, AsignacionUpdateInput,
    CopySemanaInput, HorariosSemanaArgs, RolRow, SetPredeterminadoInput, TrabajadorCreateInput,
    TrabajadorDetailArgs, TrabajadorDetailRow, TrabajadorIdByUsuarioArgs, TrabajadorRow,
    TrabajadorUpdateInput, TurnoRow,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/* Lecturas */

#[tauri::command]
pub async fn trabajadores_get_roles(state: State<'_, AppState>) -> Result<Vec<RolRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_roles(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn trabajadores_get_all(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_all(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn trabajadores_get_detail(
    state: State<'_, AppState>,
    args: TrabajadorDetailArgs,
) -> Result<Option<TrabajadorDetailRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_detail(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn trabajadores_get_trabajador_id_by_usuario(
    state: State<'_, AppState>,
    args: TrabajadorIdByUsuarioArgs,
) -> Result<Option<String>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_trabajador_id_by_usuario(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn turnos_get_all(state: State<'_, AppState>) -> Result<Vec<TurnoRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::turnos_get_all(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn horarios_get_asignaciones_semana(
    state: State<'_, AppState>,
    args: HorariosSemanaArgs,
) -> Result<Vec<AsignacionRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_asignaciones_semana(repo.as_ref(), args).await?)
}

/* Alta / edición de trabajador */

#[tauri::command]
pub async fn trabajadores_create(
    state: State<'_, AppState>,
    args: TrabajadorCreateInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::create_trabajador(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn trabajadores_update(
    state: State<'_, AppState>,
    args: TrabajadorUpdateInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::update_trabajador(repo.as_ref(), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn horarios_create_asignacion(
    state: State<'_, AppState>,
    args: AsignacionCreateInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::create_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn horarios_update_asignacion(
    state: State<'_, AppState>,
    args: AsignacionUpdateInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::update_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn horarios_delete_asignacion(
    state: State<'_, AppState>,
    args: AsignacionDeleteInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::delete_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn horarios_copy_semana_asignaciones(
    state: State<'_, AppState>,
    args: CopySemanaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::copy_semana_asignaciones(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn horarios_set_predeterminado_desde_semana(
    state: State<'_, AppState>,
    args: SetPredeterminadoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::set_predeterminado_desde_semana(repo.as_ref(), args).await?)
}
