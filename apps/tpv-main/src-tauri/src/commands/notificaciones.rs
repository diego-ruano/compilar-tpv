//! Comandos Tauri finos para **notificaciones**. Solo adaptan entrada/salida e invocan el caso de
//! uso. Local-First, modo Main (SQLite): las notificaciones se emiten/leen contra la BD local y se
//! replican por el outbox. En modo Handy el mismo comando cae en el repositorio HTTP
//! (`tpv-infra-http`), que habla con `/v1/notificaciones` — las firmas no cambian.
//!
//! AUD-26: el centro de notificaciones es de quien ha iniciado sesión. En los ocho comandos el
//! usuario sale de la sesión del backend, nunca de los argumentos: qué se ve, en nombre de quién
//! se marca leído y sobre qué actúa la papelera no lo decide la pantalla. Sin sesión fallan con el
//! `permiso_denegado` de siempre. Lo vigila
//! `lib.rs::atribuciones_de_servicio_salen_de_la_sesion`.

use tauri::State;

use tpv_application::use_cases::notificaciones as uc;
use tpv_contracts::notificaciones::{NoLeidasDto, NotificacionIdInput, NotificacionRow, NotificacionesListArgs};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_listar(
    state: State<'_, AppState>,
    args: NotificacionesListArgs,
) -> Result<Vec<NotificacionRow>, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::listar(repo.as_ref(), &id_usuario, args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_no_leidas(state: State<'_, AppState>) -> Result<NoLeidasDto, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::contar_no_leidas(repo.as_ref(), &id_usuario)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_marcar_leida(
    state: State<'_, AppState>,
    args: NotificacionIdInput,
) -> Result<bool, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::marcar_leida(repo.as_ref(), &id_usuario, args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_marcar_todas_leidas(
    state: State<'_, AppState>,
) -> Result<i64, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::marcar_todas_leidas(repo.as_ref(), &id_usuario)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_descartar(
    state: State<'_, AppState>,
    args: NotificacionIdInput,
) -> Result<bool, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::descartar(repo.as_ref(), &id_usuario, args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_papelera(
    state: State<'_, AppState>,
) -> Result<Vec<NotificacionRow>, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::listar_descartadas(repo.as_ref(), &id_usuario)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_restaurar(
    state: State<'_, AppState>,
    args: NotificacionIdInput,
) -> Result<bool, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::restaurar(repo.as_ref(), &id_usuario, args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn notificaciones_eliminar(
    state: State<'_, AppState>,
    args: NotificacionIdInput,
) -> Result<bool, AppErrorDto> {
    let id_usuario = state.sesion().await?.id_usuario;
    let repo = state.notificaciones_repo().await?;
    uc::eliminar(repo.as_ref(), &id_usuario, args)
        .await
        .map_err(AppErrorDto::from)
}
