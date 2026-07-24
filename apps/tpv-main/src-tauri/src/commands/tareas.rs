//! Comandos Tauri de tareas (capa fina hexagonal). Local-First: sin op_id ni outbox.

use tauri::State;

use tpv_application::use_cases::tareas as uc;
use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use crate::AppState;

/* Lecturas */

#[tauri::command]
pub async fn tareas_get_trabajadores(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorUI>, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_trabajadores(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_get_tareas_admin(
    state: State<'_, AppState>,
) -> Result<Vec<TareaAdminRow>, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tareas_admin(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_by_id(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Option<TareaRow>, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tarea_by_id(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_asignados(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Vec<TareaAsignadoRow>, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_tarea_asignados(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_get_mis_tareas(
    state: State<'_, AppState>,
    args: MisTareasArgs,
) -> Result<Vec<MisTareasRow>, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::get_mis_tareas(repo.as_ref(), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn tareas_create_tarea(
    state: State<'_, AppState>,
    args: CreateTareaInput,
) -> Result<bool, String> {
    let repo = state.tareas_repo().await?;
    // El Notifier solo existe en modo Main (SQLite local); en Handy es `None` y no se emite localmente.
    let notifier = state.notifier().await.ok();
    Ok(uc::create_tarea(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_update_tarea(
    state: State<'_, AppState>,
    args: UpdateTareaInput,
) -> Result<bool, String> {
    let repo = state.tareas_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::update_tarea(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_set_asignaciones_tarea(
    state: State<'_, AppState>,
    args: SetAsignacionesTareaInput,
) -> Result<bool, String> {
    let repo = state.tareas_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::set_asignaciones(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn tareas_delete_tarea(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<bool, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::delete_tarea(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn tareas_marcar_tarea_finalizada(
    state: State<'_, AppState>,
    args: FinalizarTareaInput,
) -> Result<bool, String> {
    let repo = state.tareas_repo().await?;
    Ok(uc::marcar_finalizada(repo.as_ref(), args).await?)
}
