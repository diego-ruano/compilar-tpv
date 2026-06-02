//! Comandos Tauri de proveedores (capa fina hexagonal).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::proveedores as uc;
use tpv_contracts::proveedores::{
    CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto, ProveedorSaveInput,
    ProveedoresCreateProductoInput, ProveedoresDeleteInput, ProveedoresGetProductosArgs,
    ProveedoresSetVinculosInput,
};
use tpv_infra_sqlite::proveedores::SqliteProveedoresRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteProveedoresRepository {
    SqliteProveedoresRepository::new(conn)
}

#[tauri::command]
pub async fn proveedores_get_all(state: State<'_, AppState>) -> Result<Vec<ProveedorDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_all(&repo(conn)).await?)
}

#[tauri::command]
pub async fn proveedores_get_productos(
    state: State<'_, AppState>,
    args: ProveedoresGetProductosArgs,
) -> Result<Vec<ProductoProveedorDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_productos(&repo(conn), args.id_proveedor).await?)
}

#[tauri::command]
pub async fn proveedores_get_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaProveedorDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_categorias(&repo(conn)).await?)
}

#[tauri::command]
pub async fn proveedores_get_productos_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProductoProveedorDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_productos_all(&repo(conn)).await?)
}

#[tauri::command]
pub async fn proveedores_save(
    state: State<'_, AppState>,
    args: ProveedorSaveInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::guardar(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn proveedores_delete(
    state: State<'_, AppState>,
    args: ProveedoresDeleteInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::eliminar(&repo(conn), args.id_proveedor).await?)
}

#[tauri::command]
pub async fn proveedores_set_vinculos(
    state: State<'_, AppState>,
    args: ProveedoresSetVinculosInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::set_vinculos(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn proveedores_create_producto(
    state: State<'_, AppState>,
    args: ProveedoresCreateProductoInput,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;
    Ok(uc::crear_producto(&repo(conn), args).await?)
}
