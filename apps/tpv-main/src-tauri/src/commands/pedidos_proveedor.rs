//! Comandos Tauri finos para pedidos a proveedores. Solo adaptan entrada/salida.

use tauri::State;

use tpv_application::use_cases::pedidos_proveedor as uc;
use tpv_contracts::pedidos_proveedor::{
    PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput, PedidosGetPageInput,
    PedidosPageDto,
};

use crate::AppState;

#[tauri::command]
pub async fn pedidos_proveedor_get_page(
    state: State<'_, AppState>,
    args: PedidosGetPageInput,
) -> Result<PedidosPageDto, String> {
    let repo = state.pedidos_proveedor_repo().await?;
    uc::get_page(repo.as_ref(), args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pedidos_proveedor_crear(
    state: State<'_, AppState>,
    args: PedidosCrearInput,
) -> Result<String, String> {
    let repo = state.pedidos_proveedor_repo().await?;
    let notifier = state.notifier().await.ok();
    uc::crear(repo.as_ref(), notifier.as_deref(), args)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pedidos_proveedor_actualizar(
    state: State<'_, AppState>,
    args: PedidosActualizarInput,
) -> Result<bool, String> {
    let repo = state.pedidos_proveedor_repo().await?;
    uc::actualizar(repo.as_ref(), args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pedidos_proveedor_cambiar_estado(
    state: State<'_, AppState>,
    args: PedidosCambiarEstadoInput,
) -> Result<bool, String> {
    let repo = state.pedidos_proveedor_repo().await?;
    uc::cambiar_estado(repo.as_ref(), args).await.map_err(|e| e.to_string())
}
