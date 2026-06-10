//! Comandos Tauri de proveedores (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::proveedores as uc;
use tpv_contracts::proveedores::{
    CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto, ProveedorSaveInput,
    ProveedoresCreateProductoInput, ProveedoresDeleteInput, ProveedoresGetProductosArgs,
    ProveedoresSetVinculosInput,
};
use crate::AppState;

#[tauri::command]
pub async fn proveedores_get_all(state: State<'_, AppState>) -> Result<Vec<ProveedorDto>, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_all(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn proveedores_get_productos(
    state: State<'_, AppState>,
    args: ProveedoresGetProductosArgs,
) -> Result<Vec<ProductoProveedorDto>, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_productos(repo.as_ref(), args.id_proveedor).await?)
}

#[tauri::command]
pub async fn proveedores_get_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaProveedorDto>, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_categorias(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn proveedores_get_productos_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProductoProveedorDto>, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_productos_all(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn proveedores_save(
    state: State<'_, AppState>,
    args: ProveedorSaveInput,
) -> Result<bool, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::guardar(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn proveedores_delete(
    state: State<'_, AppState>,
    args: ProveedoresDeleteInput,
) -> Result<bool, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::eliminar(repo.as_ref(), args.id_proveedor).await?)
}

#[tauri::command]
pub async fn proveedores_set_vinculos(
    state: State<'_, AppState>,
    args: ProveedoresSetVinculosInput,
) -> Result<bool, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::set_vinculos(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn proveedores_create_producto(
    state: State<'_, AppState>,
    args: ProveedoresCreateProductoInput,
) -> Result<i64, String> {
    let repo = state.proveedores_repo().await?;
    Ok(uc::crear_producto(repo.as_ref(), args).await?)
}
