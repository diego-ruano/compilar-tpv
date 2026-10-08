//! Comandos Tauri finos para pedidos a proveedores. Solo adaptan entrada/salida.

use tauri::State;

use tpv_application::use_cases::pedidos_proveedor as uc;
use tpv_contracts::pedidos_proveedor::{
    PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput, PedidosGetPageInput,
    PedidosPageDto,
};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn pedidos_proveedor_get_page(
    state: State<'_, AppState>,
    args: PedidosGetPageInput,
) -> Result<PedidosPageDto, AppErrorDto> {
    state.exigir_permiso("pedidos.gestionar").await?;
    let repo = state.pedidos_proveedor_repo().await?;
    uc::get_page(repo.as_ref(), args).await.map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn pedidos_proveedor_crear(
    state: State<'_, AppState>,
    args: PedidosCrearInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("pedidos.gestionar").await?;
    let repo = state.pedidos_proveedor_repo().await?;
    let notifier = state.notifier().await.ok();
    uc::crear(repo.as_ref(), notifier.as_deref(), args)
        .await
        .map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn pedidos_proveedor_actualizar(
    state: State<'_, AppState>,
    args: PedidosActualizarInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("pedidos.gestionar").await?;
    let repo = state.pedidos_proveedor_repo().await?;
    uc::actualizar(repo.as_ref(), args).await.map_err(AppErrorDto::from)
}

#[tauri::command]
#[specta::specta]
pub async fn pedidos_proveedor_cambiar_estado(
    state: State<'_, AppState>,
    args: PedidosCambiarEstadoInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("pedidos.gestionar").await?;
    let repo = state.pedidos_proveedor_repo().await?;
    let notifier = state.notifier().await.ok();
    uc::cambiar_estado(repo.as_ref(), notifier.as_deref(), args)
        .await
        .map_err(AppErrorDto::from)
}
