//! Comandos Tauri de login / auth / fichaje (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::login as uc;
use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, UserListItem,
};
use tpv_infra_sqlite::login::SqliteLoginRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteLoginRepository {
    SqliteLoginRepository::new(conn)
}

/// Hash de un PIN. Síncrono y sin estado (lo usa también el arranque en main.rs).
#[tauri::command]
pub fn hash_password(pin: String) -> Result<String, String> {
    Ok(uc::hash_password(&pin)?)
}

#[tauri::command]
pub async fn list_login_users(state: State<'_, AppState>) -> Result<Vec<UserListItem>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::list_login_users(&repo(conn)).await?)
}

#[tauri::command]
pub async fn login_user(
    state: State<'_, AppState>,
    args: LoginUserArgs,
) -> Result<LoginOk, String> {
    let conn = get_db(&state).await?;
    Ok(uc::login_user(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn get_today_punch_status(
    state: State<'_, AppState>,
    args: PunchStatusArgs,
) -> Result<PunchStatus, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_today_punch_status(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn set_turno_partido_hoy(
    state: State<'_, AppState>,
    args: SetTurnoPartidoInput,
) -> Result<String, String> {
    let conn = get_db(&state).await?;
    uc::set_turno_partido_hoy(&repo(conn), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn complete_initial_setup(
    state: State<'_, AppState>,
    args: CompleteInitialSetupInput,
) -> Result<String, String> {
    let conn = get_db(&state).await?;
    uc::complete_initial_setup(&repo(conn), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn punch(
    state: State<'_, AppState>,
    args: PunchInput,
) -> Result<PunchStatus, String> {
    let conn = get_db(&state).await?;
    Ok(uc::punch(&repo(conn), args).await?)
}
