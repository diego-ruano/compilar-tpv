//! Comandos Tauri de mesas / salón / comandas / cocina (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Nombres de invoke idénticos al monolito previo.

use std::collections::HashMap;

use tauri::State;

use tpv_application::use_cases::mesas as uc;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCerrarComandaInput,
    MesasCobrarDetallesInput, MesasCobrarVentaRapidaInput, MesasComandaSetTrabajadorInput,
    MesasCreateComandaBarraInput, MesasDeleteComandaBarraIfSafeInput, MesasDeleteDetalleInput,
    MesasGetOrCreateComandaBarraInput, MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs,
    MesasKitchenSetLineStateInput, MesasListComandasBarraArgs, MesasRemoveOnePendingDetalleInput,
    MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput,
    MesasUpdateDetalleNotaInput, ProductoVendibleOut, SalonOut,
};
use crate::AppState;

/* ===== LAYOUT ===== */

#[tauri::command]
pub async fn save_layout(
    state: State<'_, AppState>,
    args: MesasSaveLayoutInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::save_layout(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn load_layout(state: State<'_, AppState>) -> Result<Vec<SalonOut>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::load_layout(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn get_mesas_ocupadas(
    state: State<'_, AppState>,
) -> Result<HashMap<String, bool>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_mesas_ocupadas(repo.as_ref()).await?)
}

/* ===== RESERVAS ===== */

#[tauri::command]
pub async fn set_reserva_estado(
    state: State<'_, AppState>,
    args: MesasSetReservaEstadoInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::set_reserva_estado(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

/* ===== COMANDAS (mesa) ===== */

#[tauri::command]
pub async fn get_comanda_abierta_by_mesa(
    state: State<'_, AppState>,
    args: MesasIdMesaArgs,
) -> Result<Option<ComandaRow>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_comanda_abierta_by_mesa(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn abrir_comanda(
    state: State<'_, AppState>,
    args: MesasAbrirComandaInput,
) -> Result<Option<ComandaRow>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::abrir_comanda(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn comanda_set_trabajador_if_null(
    state: State<'_, AppState>,
    args: MesasComandaSetTrabajadorInput,
) -> Result<bool, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::comanda_set_trabajador_if_null(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cerrar_comanda(
    state: State<'_, AppState>,
    args: MesasCerrarComandaInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::cerrar_comanda(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn get_lineas_comanda(
    state: State<'_, AppState>,
    args: MesasIdComandaArgs,
) -> Result<Vec<MesaLineaComandaRow>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_lineas_comanda(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn add_linea_comanda(
    state: State<'_, AppState>,
    args: MesasAddLineaComandaInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::add_linea_comanda(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

/* ===== BARRA ===== */

#[tauri::command]
pub async fn get_or_create_mesa_barra(state: State<'_, AppState>) -> Result<i64, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_or_create_mesa_barra(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn get_or_create_comanda_barra(
    state: State<'_, AppState>,
    args: MesasGetOrCreateComandaBarraInput,
) -> Result<i64, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_or_create_comanda_barra(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cobrar_venta_rapida(
    state: State<'_, AppState>,
    args: MesasCobrarVentaRapidaInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::cobrar_venta_rapida(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn create_comanda_barra(
    state: State<'_, AppState>,
    args: MesasCreateComandaBarraInput,
) -> Result<i64, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::create_comanda_barra(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn list_comandas_barra(
    state: State<'_, AppState>,
    args: MesasListComandasBarraArgs,
) -> Result<Vec<ComandaBarraListItem>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::list_comandas_barra(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn delete_comanda_barra_if_safe(
    state: State<'_, AppState>,
    args: MesasDeleteComandaBarraIfSafeInput,
) -> Result<bool, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::delete_comanda_barra_if_safe(repo.as_ref(), args).await?)
}

/* ===== META + CATÁLOGO ===== */

#[tauri::command]
pub async fn mesas_meta_all(
    state: State<'_, AppState>,
) -> Result<HashMap<i64, MesaMetaOut>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::mesas_meta_all(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaVendibleOut>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::list_categorias_vendibles(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn list_productos_by_categoria(
    state: State<'_, AppState>,
    args: MesasIdCategoriaArgs,
) -> Result<Vec<ProductoVendibleOut>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::list_productos_by_categoria(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn search_productos_by_nombre(
    state: State<'_, AppState>,
    args: MesasSearchProductosArgs,
) -> Result<Vec<ProductoVendibleOut>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::search_productos_by_nombre(repo.as_ref(), args).await?)
}

/* ===== TICKET (detalles) ===== */

#[tauri::command]
pub async fn remove_one_pending_detalle(
    state: State<'_, AppState>,
    args: MesasRemoveOnePendingDetalleInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::remove_one_pending_detalle(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn delete_detalle(
    state: State<'_, AppState>,
    args: MesasDeleteDetalleInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::delete_detalle(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn update_detalle_nota(
    state: State<'_, AppState>,
    args: MesasUpdateDetalleNotaInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::update_detalle_nota(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
pub async fn cobrar_detalles(
    state: State<'_, AppState>,
    args: MesasCobrarDetallesInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::cobrar_detalles(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

/* ===== COCINA ===== */

#[tauri::command]
pub async fn kitchen_list_today_pending(
    state: State<'_, AppState>,
) -> Result<Vec<KitchenRow>, String> {
    let repo = state.mesas_repo().await?;
    Ok(uc::kitchen_list_today_pending(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn kitchen_set_line_state(
    state: State<'_, AppState>,
    args: MesasKitchenSetLineStateInput,
) -> Result<String, String> {
    let repo = state.mesas_repo().await?;
    uc::kitchen_set_line_state(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}
