//! Comandos Tauri finos para **notificaciones**. Solo adaptan entrada/salida e invocan el caso de
//! uso. Local-First, modo Main (SQLite): las notificaciones se emiten/leen contra la BD local y se
//! replican por el outbox. En modo Handy aún no hay repositorio HTTP (se añadirá al cablear la
//! lectura desde la nube).

use tauri::State;

use tpv_application::use_cases::notificaciones as uc;
use tpv_contracts::notificaciones::{
    CrearNotificacionInput, MarcarLeidaInput, MarcarTodasLeidasInput, NotificacionRow,
    NotificacionesListArgs, NotificacionesUsuarioArgs,
};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
pub async fn notificaciones_listar(
    state: State<'_, AppState>,
    args: NotificacionesListArgs,
) -> Result<Vec<NotificacionRow>, AppErrorDto> {
    let repo = state.notificaciones_repo().await?;
    uc::listar(repo.as_ref(), args).await.map_err(AppErrorDto::from)
}

#[tauri::command]
pub async fn notificaciones_no_leidas(
    state: State<'_, AppState>,
    args: NotificacionesUsuarioArgs,
) -> Result<i64, AppErrorDto> {
    let repo = state.notificaciones_repo().await?;
    uc::contar_no_leidas(repo.as_ref(), args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
pub async fn notificaciones_marcar_leida(
    state: State<'_, AppState>,
    args: MarcarLeidaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.notificaciones_repo().await?;
    uc::marcar_leida(repo.as_ref(), args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
pub async fn notificaciones_marcar_todas_leidas(
    state: State<'_, AppState>,
    args: MarcarTodasLeidasInput,
) -> Result<i64, AppErrorDto> {
    let repo = state.notificaciones_repo().await?;
    uc::marcar_todas_leidas(repo.as_ref(), args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
pub async fn notificaciones_crear(
    state: State<'_, AppState>,
    args: CrearNotificacionInput,
) -> Result<String, AppErrorDto> {
    let notifier = state.notifier().await?;
    uc::crear(notifier.as_ref(), args)
        .await
        .map_err(AppErrorDto::from)
}
