//! Comandos Tauri de inventario (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::inventario as uc;
use tpv_contracts::inventario::{
    AjusteLoteInput, AjusteStockSueltoInput, AlergenoInvDto, CatalogoIngredientesDto, CategoriaInvDto,
    CreateLoteInput, GuardarCategoriaIngredienteInput, GuardarIngredienteInput, IdCategoriaArgs,
    IdCategoriaIngredienteArgs, IdIngredienteArgs,
    IdProductoArgs, InventarioResumenResponse, LoteDto, ProductDetailResponse, ProductoListDto, ProveedorMiniDto, SummaryArgs,
    UpdateLoteInput, UpsertCategoriaInput, UpsertProductoInput, UpsertProductoResult,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn inventario_list_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaInvDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_categorias(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_create_categoria(
    state: State<'_, AppState>,
    args: UpsertCategoriaInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::create_categoria(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_list_proveedores_mini(
    state: State<'_, AppState>,
) -> Result<Vec<ProveedorMiniDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_proveedores_mini(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_list_productos_by_categoria(
    state: State<'_, AppState>,
    args: IdCategoriaArgs,
) -> Result<Vec<ProductoListDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_productos_by_categoria(repo.as_ref(), args.id_categoria).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_get_resumen(
    state: State<'_, AppState>,
    args: SummaryArgs,
) -> Result<InventarioResumenResponse, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::get_resumen(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_list_alergenos(
    state: State<'_, AppState>,
) -> Result<Vec<AlergenoInvDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_alergenos(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_get_product_detail(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<ProductDetailResponse, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::get_product_detail(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_delete_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.borrar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::delete_producto(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_upsert_producto(
    state: State<'_, AppState>,
    args: UpsertProductoInput,
) -> Result<UpsertProductoResult, AppErrorDto> {
    let (sesion, permisos) = state.exigir_permiso_con_contexto("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::upsert_producto(repo.as_ref(), &sesion.id_usuario, args, &permisos).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_list_lotes_by_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Vec<LoteDto>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::list_lotes_by_producto(repo.as_ref(), args.id_producto).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_create_lote(
    state: State<'_, AppState>,
    args: CreateLoteInput,
) -> Result<String, AppErrorDto> {
    let sesion = state.exigir_permiso("stock.recibir").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::create_lote(repo.as_ref(), &sesion.id_usuario, args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_update_lote(
    state: State<'_, AppState>,
    args: UpdateLoteInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("stock.editar_lotes").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::update_lote(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_ajustar_lote(
    state: State<'_, AppState>,
    args: AjusteLoteInput,
) -> Result<String, AppErrorDto> {
    let sesion = state.exigir_permiso("stock.ajustar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::ajustar_lote(repo.as_ref(), &sesion.id_usuario, args).await?)
}

/// RI-55: el stock suelto de un producto se cambia aquí, con su movimiento, y no al guardar la ficha.
#[tauri::command]
#[specta::specta]
pub async fn inventario_ajustar_stock_suelto(
    state: State<'_, AppState>,
    args: AjusteStockSueltoInput,
) -> Result<String, AppErrorDto> {
    let sesion = state.exigir_permiso("stock.ajustar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::ajustar_stock_suelto(repo.as_ref(), &sesion.id_usuario, args).await?)
}

/* ── Ingredientes ── */

/// Las categorías de ingredientes y los ingredientes. Sin gate: la ventana de una línea los lee a
/// mitad de servicio.
#[tauri::command]
#[specta::specta]
pub async fn inventario_catalogo_ingredientes(
    state: State<'_, AppState>,
) -> Result<CatalogoIngredientesDto, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::catalogo_ingredientes(repo.as_ref()).await?)
}

/// Los ids de los ingredientes que lleva un producto (la ficha y la ventana de una línea).
#[tauri::command]
#[specta::specta]
pub async fn inventario_ingredientes_de_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Vec<String>, AppErrorDto> {
    let repo = state.inventario_repo().await?;
    Ok(uc::ingredientes_de_producto(repo.as_ref(), args.id_producto).await?)
}

/// Crea o renombra una categoría de ingredientes; devuelve su id.
#[tauri::command]
#[specta::specta]
pub async fn inventario_guardar_categoria_ingrediente(
    state: State<'_, AppState>,
    args: GuardarCategoriaIngredienteInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::guardar_categoria_ingrediente(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_borrar_categoria_ingrediente(
    state: State<'_, AppState>,
    args: IdCategoriaIngredienteArgs,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    uc::borrar_categoria_ingrediente(repo.as_ref(), args.id_categoria_ingrediente).await?;
    Ok("OK".to_string())
}

/// Crea, renombra o cambia de categoría un ingrediente; devuelve su id.
#[tauri::command]
#[specta::specta]
pub async fn inventario_guardar_ingrediente(
    state: State<'_, AppState>,
    args: GuardarIngredienteInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    Ok(uc::guardar_ingrediente(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn inventario_borrar_ingrediente(
    state: State<'_, AppState>,
    args: IdIngredienteArgs,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("catalogo.editar").await?;
    let repo = state.inventario_repo().await?;
    uc::borrar_ingrediente(repo.as_ref(), args.id_ingrediente).await?;
    Ok("OK".to_string())
}
