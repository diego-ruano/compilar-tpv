//! Comandos Tauri de tareas (capa fina hexagonal). Local-First: sin op_id ni outbox.

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::tareas as uc;
use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use tpv_infra_sqlite::tareas::SqliteTareasRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteTareasRepository {
    SqliteTareasRepository::new(conn)
}

/* Lecturas */

#[tauri::command]
pub async fn tareas_get_trabajadores(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorUI>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_trabajadores(&repo(conn)).await?)
}

#[tauri::command]
pub async fn tareas_get_tareas_admin(
    state: State<'_, AppState>,
) -> Result<Vec<TareaAdminRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_tareas_admin(&repo(conn)).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_by_id(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Option<TareaRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_tarea_by_id(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_get_tarea_asignados(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<Vec<TareaAsignadoRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_tarea_asignados(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_get_mis_tareas(
    state: State<'_, AppState>,
    args: MisTareasArgs,
) -> Result<Vec<MisTareasRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_mis_tareas(&repo(conn), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn tareas_create_tarea(
    state: State<'_, AppState>,
    args: CreateTareaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::create_tarea(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_update_tarea(
    state: State<'_, AppState>,
    args: UpdateTareaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_tarea(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_set_asignaciones_tarea(
    state: State<'_, AppState>,
    args: SetAsignacionesTareaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::set_asignaciones(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_delete_tarea(
    state: State<'_, AppState>,
    args: TareaIdArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_tarea(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn tareas_marcar_tarea_finalizada(
    state: State<'_, AppState>,
    args: FinalizarTareaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::marcar_finalizada(&repo(conn), args).await?)
}
