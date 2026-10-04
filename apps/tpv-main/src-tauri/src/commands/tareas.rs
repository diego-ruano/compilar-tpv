//! Comandos Tauri de tareas (capa fina hexagonal). Local-First: sin op_id ni outbox.

use tauri::State;

use tpv_application::use_cases::tareas as uc;
use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/* Lecturas */

#[tauri::command]
pub async fn tareas_get_trabajadores(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorUI>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_trabajadores(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_get_tareas_admin(
    state: State<'_, AppState>,
) -> Result<Vec<TareaAdminRow>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tareas_admin(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_by_id(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Option<TareaRow>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tarea_by_id(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_asignados(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Vec<TareaAsignadoRow>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tarea_asignados(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_get_mis_tareas(
    state: State<'_, AppState>,
    args: MisTareasArgs,
) -> Result<Vec<MisTareasRow>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_mis_tareas(repo.as_ref(), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn tareas_create_tarea(
    state: State<'_, AppState>,
    args: CreateTareaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    // El Notifier va según el modo (SQLite en la Main, HTTP al worker en la Handy). `None` sólo si
    // todavía no hay modo ni base: entonces se crea la tarea sin avisar.
    let notifier = state.notifier().await.ok();
    Ok(uc::create_tarea(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_update_tarea(
    state: State<'_, AppState>,
    args: UpdateTareaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::update_tarea(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_set_asignaciones_tarea(
    state: State<'_, AppState>,
    args: SetAsignacionesTareaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::set_asignaciones(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_delete_tarea(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::delete_tarea(repo.as_ref(), args).await?)
}

/// Papelera (TAR-05). El borrado manda a la papelera; estos tres comandos son el resto del ciclo:
/// verla, sacar una tarea de ella y vaciarla (lo único que borra de verdad).
#[tauri::command]
pub async fn tareas_get_papelera(
    state: State<'_, AppState>,
) -> Result<Vec<TareaAdminRow>, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_papelera(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_restaurar_tarea(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::restaurar_tarea(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_vaciar_papelera(state: State<'_, AppState>) -> Result<i64, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::vaciar_papelera(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_marcar_tarea_finalizada(
    state: State<'_, AppState>,
    args: FinalizarTareaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.tareas_repo().await?;
    Ok(uc::marcar_finalizada(repo.as_ref(), args).await?)
}
