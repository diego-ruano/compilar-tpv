//! Comandos Tauri de proveedores (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::proveedores as uc;
use tpv_contracts::proveedores::{
    CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto, ProveedorSaveInput,
    ProveedoresDeleteInput, ProveedoresGetProductosArgs,
    ProveedoresSetVinculosInput,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn proveedores_get_all(state: State<'_, AppState>) -> Result<Vec<ProveedorDto>, AppErrorDto> {
    state.sesion().await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_all(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_get_productos(
    state: State<'_, AppState>,
    args: ProveedoresGetProductosArgs,
) -> Result<Vec<ProductoProveedorDto>, AppErrorDto> {
    state.sesion().await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_productos(repo.as_ref(), args.id_proveedor).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_get_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaProveedorDto>, AppErrorDto> {
    state.sesion().await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_categorias(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_get_productos_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProductoProveedorDto>, AppErrorDto> {
    state.sesion().await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::get_productos_all(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_save(
    state: State<'_, AppState>,
    args: ProveedorSaveInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("proveedores.gestionar").await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::guardar(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_delete(
    state: State<'_, AppState>,
    args: ProveedoresDeleteInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("proveedores.gestionar").await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::eliminar(repo.as_ref(), args.id_proveedor).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn proveedores_set_vinculos(
    state: State<'_, AppState>,
    args: ProveedoresSetVinculosInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("proveedores.gestionar").await?;
    let repo = state.proveedores_repo().await?;
    Ok(uc::set_vinculos(repo.as_ref(), args).await?)
}
