//! Comandos Tauri de reservas (capa fina hexagonal).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::reservas as uc;
use tpv_contracts::reservas::{
    ReservaDeleteInput, ReservaDto, ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use tpv_infra_sqlite::reservas::SqliteReservasRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteReservasRepository {
    SqliteReservasRepository::new(conn)
}

#[tauri::command]
pub async fn reservas_get_meta(state: State<'_, AppState>) -> Result<ReservasMetaDto, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_meta(&repo(conn)).await?)
}

#[tauri::command]
pub async fn reservas_get_mes(
    state: State<'_, AppState>,
    args: ReservasGetMesArgs,
) -> Result<Vec<ReservaDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_mes(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn reservas_save(
    state: State<'_, AppState>,
    args: ReservaSaveInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::guardar(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn reservas_delete(
    state: State<'_, AppState>,
    args: ReservaDeleteInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::eliminar(&repo(conn), args).await?)
}
