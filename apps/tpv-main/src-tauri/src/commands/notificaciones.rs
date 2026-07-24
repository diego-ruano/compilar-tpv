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

#[tauri::command]
pub async fn notificaciones_listar(
    state: State<'_, AppState>,
    args: NotificacionesListArgs,
) -> Result<Vec<NotificacionRow>, String> {
    let repo = state.notificaciones_repo().await?;
    uc::listar(repo.as_ref(), args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notificaciones_no_leidas(
    state: State<'_, AppState>,
    args: NotificacionesUsuarioArgs,
) -> Result<i64, String> {
    let repo = state.notificaciones_repo().await?;
    uc::contar_no_leidas(repo.as_ref(), args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notificaciones_marcar_leida(
    state: State<'_, AppState>,
    args: MarcarLeidaInput,
) -> Result<bool, String> {
    let repo = state.notificaciones_repo().await?;
    uc::marcar_leida(repo.as_ref(), args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notificaciones_marcar_todas_leidas(
    state: State<'_, AppState>,
    args: MarcarTodasLeidasInput,
) -> Result<i64, String> {
    let repo = state.notificaciones_repo().await?;
    uc::marcar_todas_leidas(repo.as_ref(), args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notificaciones_crear(
    state: State<'_, AppState>,
    args: CrearNotificacionInput,
) -> Result<String, String> {
    let notifier = state.notifier().await?;
    uc::crear(notifier.as_ref(), args)
        .await
        .map_err(|e| e.to_string())
}
