//! Comandos Tauri de venta rápida (barra). Capa fina hexagonal. Local-First: sin op_id ni outbox.

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::venta_rapida as uc;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, VerTicketsDetalleRow,
    VrAddLineaComandaInput, VrCobrarFraccionadoInput, VrCreateComandaBarraInput,
    VrDeleteComandaIfSafeInput, VrDeleteLineaIfUnpaidInput, VrIdCategoriaArgs, VrIdComandaArgs,
    VrIdsArgs, VrListComandasArgs, VrRemoveLastUnpaidLineaInput, VrRestarStockInput,
    VrSearchProductosArgs, VrUpdateNotaDetalleInput,
};
use tpv_infra_sqlite::venta_rapida::SqliteVentaRapidaRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteVentaRapidaRepository {
    SqliteVentaRapidaRepository::new(conn)
}

/* Lecturas */

#[tauri::command]
pub async fn vr_list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::list_categorias_vendibles(&repo(conn)).await?)
}

#[tauri::command]
pub async fn vr_list_productos_by_categoria(
    state: State<'_, AppState>,
    args: VrIdCategoriaArgs,
) -> Result<Vec<ProductoRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::list_productos_by_categoria(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_search_productos(
    state: State<'_, AppState>,
    args: VrSearchProductosArgs,
) -> Result<Vec<ProductoRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::search_productos(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_list_comandas_barra(
    state: State<'_, AppState>,
    args: VrListComandasArgs,
) -> Result<Vec<ComandaBarraRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::list_comandas_barra(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_get_lineas_comanda(
    state: State<'_, AppState>,
    args: VrIdComandaArgs,
) -> Result<Vec<LineaComandaRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_lineas_comanda(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_get_index_rows(
    state: State<'_, AppState>,
    args: VrIdsArgs,
) -> Result<Vec<IndexRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_index_rows(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_get_detalles_ver_ticket(
    state: State<'_, AppState>,
    args: VrIdComandaArgs,
) -> Result<Vec<VerTicketsDetalleRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_detalles_ver_ticket(&repo(conn), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn vr_create_comanda_barra(
    state: State<'_, AppState>,
    args: VrCreateComandaBarraInput,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;
    Ok(uc::create_comanda_barra(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_add_linea_comanda(
    state: State<'_, AppState>,
    args: VrAddLineaComandaInput,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;
    Ok(uc::add_linea_comanda(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_remove_last_unpaid_linea(
    state: State<'_, AppState>,
    args: VrRemoveLastUnpaidLineaInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::remove_last_unpaid_linea(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_delete_linea_if_unpaid(
    state: State<'_, AppState>,
    args: VrDeleteLineaIfUnpaidInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_linea_if_unpaid(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_update_nota_detalle(
    state: State<'_, AppState>,
    args: VrUpdateNotaDetalleInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_nota_detalle(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_cobrar_fraccionado(
    state: State<'_, AppState>,
    args: VrCobrarFraccionadoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::cobrar_fraccionado(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_restar_stock(
    state: State<'_, AppState>,
    args: VrRestarStockInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::restar_stock(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn vr_delete_comanda_if_safe(
    state: State<'_, AppState>,
    args: VrDeleteComandaIfSafeInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_comanda_if_safe(&repo(conn), args).await?)
}
