//! Comandos Tauri de inventario (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::inventario as uc;
use tpv_contracts::inventario::{
    AjusteLoteInput, AlergenoInvDto, CategoriaInvDto, CreateLoteInput, IdCategoriaArgs,
    IdProductoArgs, InventarioResumenResponse, LoteDto, ProductDetailResponse, ProductoListDto, ProveedorMiniDto, SummaryArgs,
    UpdateLoteInput, UpsertCategoriaInput, UpsertProductoInput, UpsertProductoResult,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
pub async fn inventario_list_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaInvDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_categorias(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn inventario_create_categoria(
    state: State<'_, AppState>,
    args: UpsertCategoriaInput,
) -> Result<String, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::create_categoria(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn inventario_list_proveedores_mini(
    state: State<'_, AppState>,
) -> Result<Vec<ProveedorMiniDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_proveedores_mini(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn inventario_list_productos_by_categoria(
    state: State<'_, AppState>,
    args: IdCategoriaArgs,
) -> Result<Vec<ProductoListDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_productos_by_categoria(repo.as_ref(), args.id_categoria).await?)
}

#[tauri::command]
pub async fn inventario_get_resumen(
    state: State<'_, AppState>,
    args: SummaryArgs,
) -> Result<InventarioResumenResponse, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::get_resumen(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn inventario_list_alergenos(
    state: State<'_, AppState>,
) -> Result<Vec<AlergenoInvDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_alergenos(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn inventario_get_product_detail(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<ProductDetailResponse, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::get_product_detail(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
pub async fn inventario_delete_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<String, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::delete_producto(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
pub async fn inventario_upsert_producto(
    state: State<'_, AppState>,
    args: UpsertProductoInput,
) -> Result<UpsertProductoResult, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::upsert_producto(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn inventario_list_lotes_by_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Vec<LoteDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_lotes_by_producto(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
pub async fn inventario_create_lote(
    state: State<'_, AppState>,
    args: CreateLoteInput,
) -> Result<String, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::create_lote(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn inventario_update_lote(
    state: State<'_, AppState>,
    args: UpdateLoteInput,
) -> Result<String, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::update_lote(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn inventario_ajustar_lote(
    state: State<'_, AppState>,
    args: AjusteLoteInput,
) -> Result<String, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::ajustar_lote(repo.as_ref(), args).await?)
}
