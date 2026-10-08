//! Comandos Tauri de trabajadores / horarios (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.
//!
//! SEC-01: el alta, la edición y **la lectura de la ficha** exigen Administrador. La ficha entra
//! en la lista porque es la única que devuelve la PII cifrada del personal (DNI, IBAN, nº SS), y
//! su ruta (`/Trabajadores/editar/:id`) no tiene candado: basta escribirla. El listado, los
//! turnos y los horarios NO se gatean — todos los roles tienen Trabajadores en su menú para ver
//! su cuadrante.

use tauri::State;

use tpv_application::use_cases::trabajadores as uc;
use tpv_contracts::trabajadores::{
    AsignacionCreateInput, AsignacionDeleteInput, AsignacionRow, AsignacionUpdateInput,
    CopySemanaInput, HorariosSemanaArgs, RolRow, SetPredeterminadoInput, TrabajadorCreateInput,
    TrabajadorDetailArgs, TrabajadorDetailRow, TrabajadorIdByUsuarioArgs, TrabajadorRow,
    TrabajadorUpdateInput, TurnoRow,
};
use crate::{AppState, ADMIN};
use tpv_contracts::errors::AppErrorDto;

/* Lecturas */

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_get_roles(state: State<'_, AppState>) -> Result<Vec<RolRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_roles(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_get_all(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_all(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_get_detail(
    state: State<'_, AppState>,
    args: TrabajadorDetailArgs,
) -> Result<Option<TrabajadorDetailRow>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_detail(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_get_trabajador_id_by_usuario(
    state: State<'_, AppState>,
    args: TrabajadorIdByUsuarioArgs,
) -> Result<Option<String>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_trabajador_id_by_usuario(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn turnos_get_all(state: State<'_, AppState>) -> Result<Vec<TurnoRow>, AppErrorDto> {
    let repo = state.trabajadores_repo().await?;
    Ok(uc::turnos_get_all(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn horarios_get_asignaciones_semana(
    state: State<'_, AppState>,
    args: HorariosSemanaArgs,
) -> Result<Vec<AsignacionRow>, AppErrorDto> {
    state.sesion().await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::get_asignaciones_semana(repo.as_ref(), args).await?)
}

/* Alta / edición de trabajador */

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_create(
    state: State<'_, AppState>,
    args: TrabajadorCreateInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::create_trabajador(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn trabajadores_update(
    state: State<'_, AppState>,
    args: TrabajadorUpdateInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::update_trabajador(repo.as_ref(), args).await?)
}

/* Escrituras */

#[tauri::command]
#[specta::specta]
pub async fn horarios_create_asignacion(
    state: State<'_, AppState>,
    args: AsignacionCreateInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("horarios.gestionar").await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::create_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn horarios_update_asignacion(
    state: State<'_, AppState>,
    args: AsignacionUpdateInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("horarios.gestionar").await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::update_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn horarios_delete_asignacion(
    state: State<'_, AppState>,
    args: AsignacionDeleteInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("horarios.gestionar").await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::delete_asignacion(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn horarios_copy_semana_asignaciones(
    state: State<'_, AppState>,
    args: CopySemanaInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("horarios.gestionar").await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::copy_semana_asignaciones(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn horarios_set_predeterminado_desde_semana(
    state: State<'_, AppState>,
    args: SetPredeterminadoInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("horarios.gestionar").await?;
    let repo = state.trabajadores_repo().await?;
    Ok(uc::set_predeterminado_desde_semana(repo.as_ref(), args).await?)
}
