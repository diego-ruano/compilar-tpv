//! Comandos Tauri de login / auth / fichaje (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Mismos nombres de invoke que el monolito previo.

use tauri::State;

use tpv_application::use_cases::login as uc;
use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, SetupPendiente, UserListItem,
};

use crate::{AppState, Sesion};
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn list_login_users(state: State<'_, AppState>) -> Result<Vec<UserListItem>, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::list_login_users(repo.as_ref()).await?)
}

/// ¿Queda por elegir el PIN del primer arranque? Lo pregunta la app ANTES del login para saber
/// qué pantalla enseñar.
#[tauri::command]
#[specta::specta]
pub async fn setup_pendiente(state: State<'_, AppState>) -> Result<SetupPendiente, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::setup_pendiente(repo.as_ref()).await?)
}

/// Valida el PIN y **establece la sesión del backend** (SEC-01).
///
/// El rol que se guarda es el que devuelve el repositorio —SQLite en la Main, el worker en la
/// Handy—, nunca uno que venga en `args`: es todo el sentido del gate. Los dos modos pasan por
/// aquí, así que un comando gateado funciona igual en la Handy que en la Main.
#[tauri::command]
#[specta::specta]
pub async fn login_user(
    state: State<'_, AppState>,
    args: LoginUserArgs,
) -> Result<LoginOk, AppErrorDto> {
    let repo = state.login_repo().await?;
    let notifier = state.notifier().await.ok();
    let ok = uc::login_user(repo.as_ref(), notifier.as_deref(), args).await?;

    state
        .iniciar_sesion(Sesion {
            id_usuario: ok.id_usuario.clone(),
            id_trabajador: ok.id_trabajador.clone(),
            rol: ok.rol.clone(),
            iniciada_en: chrono::Utc::now().timestamp_millis(),
        })
        .await;

    Ok(ok)
}

/// Cierra la sesión del backend.
///
/// Lo llaman `useAuth.logout()` (y con él el cierre por inactividad) y el arranque del
/// frontend. Esto último no es cosmético: si el webview se recarga (F5), el store de Zustand se
/// vacía y la UI vuelve al login, pero la sesión de aquí seguiría puesta — quedaría una sesión
/// de administrador viva detrás de una pantalla de login.
///
/// No falla nunca ni exige haber iniciado sesión: cerrar lo que ya está cerrado es un no-op, y
/// un error aquí sólo serviría para que el frontend no se atreviera a llamarlo.
#[tauri::command]
#[specta::specta]
pub async fn logout(state: State<'_, AppState>) -> Result<(), AppErrorDto> {
    state.cerrar_sesion().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_today_punch_status(
    state: State<'_, AppState>,
    args: PunchStatusArgs,
) -> Result<PunchStatus, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::get_today_punch_status(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn set_turno_partido_hoy(
    state: State<'_, AppState>,
    args: SetTurnoPartidoInput,
) -> Result<String, AppErrorDto> {
    let repo = state.login_repo().await?;
    uc::set_turno_partido_hoy(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn complete_initial_setup(
    state: State<'_, AppState>,
    args: CompleteInitialSetupInput,
) -> Result<String, AppErrorDto> {
    let repo = state.login_repo().await?;
    uc::complete_initial_setup(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn punch(
    state: State<'_, AppState>,
    args: PunchInput,
) -> Result<PunchStatus, AppErrorDto> {
    let repo = state.login_repo().await?;
    Ok(uc::punch(repo.as_ref(), args).await?)
}
