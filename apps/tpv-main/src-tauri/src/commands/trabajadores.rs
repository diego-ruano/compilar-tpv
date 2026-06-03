//! Comandos Tauri de trabajadores / horarios (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::trabajadores as uc;
use tpv_contracts::trabajadores::{
    AsignacionCreateInput, AsignacionDeleteInput, AsignacionRow, AsignacionUpdateInput,
    CopySemanaInput, HorariosSemanaArgs, RolRow, SetPredeterminadoInput, TrabajadorCreateInput,
    TrabajadorDetailArgs, TrabajadorDetailRow, TrabajadorIdByUsuarioArgs, TrabajadorRow,
    TrabajadorUpdateInput, TurnoRow,
};
use tpv_infra_sqlite::trabajadores::SqliteTrabajadoresRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteTrabajadoresRepository {
    SqliteTrabajadoresRepository::new(conn)
}

/* Lecturas */

#[tauri::command]
pub async fn trabajadores_get_roles(state: State<'_, AppState>) -> Result<Vec<RolRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_roles(&repo(conn)).await?)
}

#[tauri::command]
pub async fn trabajadores_get_all(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_all(&repo(conn)).await?)
}

#[tauri::command]
pub async fn trabajadores_get_detail(
    state: State<'_, AppState>,
    args: TrabajadorDetailArgs,
) -> Result<Option<TrabajadorDetailRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_detail(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn trabajadores_get_trabajador_id_by_usuario(
    state: State<'_, AppState>,
    args: TrabajadorIdByUsuarioArgs,
) -> Result<Option<i64>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_trabajador_id_by_usuario(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn turnos_get_all(state: State<'_, AppState>) -> Result<Vec<TurnoRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::turnos_get_all(&repo(conn)).await?)
}

#[tauri::command]
pub async fn horarios_get_asignaciones_semana(
    state: State<'_, AppState>,
    args: HorariosSemanaArgs,
) -> Result<Vec<AsignacionRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_asignaciones_semana(&repo(conn), args).await?)
}

/* Alta / edición de trabajador */

#[tauri::command]
pub async fn trabajadores_create(
    state: State<'_, AppState>,
    args: TrabajadorCreateInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::create_trabajador(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn trabajadores_update(
    state: State<'_, AppState>,
    args: TrabajadorUpdateInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_trabajador(&repo(conn), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn horarios_create_asignacion(
    state: State<'_, AppState>,
    args: AsignacionCreateInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::create_asignacion(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn horarios_update_asignacion(
    state: State<'_, AppState>,
    args: AsignacionUpdateInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_asignacion(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn horarios_delete_asignacion(
    state: State<'_, AppState>,
    args: AsignacionDeleteInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_asignacion(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn horarios_copy_semana_asignaciones(
    state: State<'_, AppState>,
    args: CopySemanaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::copy_semana_asignaciones(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn horarios_set_predeterminado_desde_semana(
    state: State<'_, AppState>,
    args: SetPredeterminadoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::set_predeterminado_desde_semana(&repo(conn), args).await?)
}
