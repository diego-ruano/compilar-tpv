//! Comandos Tauri de login / auth / fichaje (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.

use tauri::State;

use tpv_application::use_cases::login as uc;
use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, UserListItem,
};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/// Hash de un PIN. Síncrono y sin estado (lo usa también el arranque en main.rs).
#[tauri::command]
pub fn hash_password(pin: String) -> Result<String, AppErrorDto> {
    Ok(uc::hash_password(&pin)?)
}

#[tauri::command]
pub async fn list_login_users(state: State<'_, AppState>) -> Result<Vec<UserListItem>, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::list_login_users(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn login_user(
    state: State<'_, AppState>,
    args: LoginUserArgs,
) -> Result<LoginOk, AppErrorDto> {
    let repo = state.login_repo().await?;
    let notifier = state.notifier().await.ok();
    Ok(uc::login_user(repo.as_ref(), notifier.as_deref(), args).await?)
}

#[tauri::command]
pub async fn get_today_punch_status(
    state: State<'_, AppState>,
    args: PunchStatusArgs,
) -> Result<PunchStatus, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::get_today_punch_status(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn set_turno_partido_hoy(
    state: State<'_, AppState>,
    args: SetTurnoPartidoInput,
) -> Result<String, AppErrorDto> {
    let repo = state.login_repo().await?;
    uc::set_turno_partido_hoy(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn complete_initial_setup(
    state: State<'_, AppState>,
    args: CompleteInitialSetupInput,
) -> Result<String, AppErrorDto> {
    let repo = state.login_repo().await?;
    uc::complete_initial_setup(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn punch(
    state: State<'_, AppState>,
    args: PunchInput,
) -> Result<PunchStatus, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::punch(repo.as_ref(), args).await?)
}
