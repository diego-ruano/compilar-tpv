//! Casos de uso de proveedores (Local-First).

use tpv_contracts::proveedores::{
    CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto, ProveedorSaveInput,
    ProveedoresCreateProductoInput, ProveedoresSetVinculosInput,
};
use tpv_domain::proveedores::{normalizar_producto_ids, ProductoNuevo, ProveedorValidado};

use crate::error::{AppError, AppResult};
use crate::ports::proveedores::ProveedoresRepository;

pub async fn get_all(repo: &dyn ProveedoresRepository) -> AppResult<Vec<ProveedorDto>> {
    repo.get_all().await
}

pub async fn get_productos(
    repo: &dyn ProveedoresRepository,
    id_proveedor: String,
) -> AppResult<Vec<ProductoProveedorDto>> {
    let id_proveedor = id_proveedor.trim();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    repo.get_productos(id_proveedor).await
}

pub async fn get_categorias(
    repo: &dyn ProveedoresRepository,
) -> AppResult<Vec<CategoriaProveedorDto>> {
    repo.get_categorias().await
}

pub async fn get_productos_all(
    repo: &dyn ProveedoresRepository,
) -> AppResult<Vec<ProductoProveedorDto>> {
    repo.get_productos_all().await
}

pub async fn guardar(
    repo: &dyn ProveedoresRepository,
    input: ProveedorSaveInput,
) -> AppResult<bool> {
    let proveedor = ProveedorValidado::validar(
        input.id_proveedor,
        input.nombre_empresa,
        input.contacto,
        input.telefono,
        input.email,
        input.cif,
        input.informacion_adicional,
        input.nombre_imagen,
        input.ruta_imagen,
    )
    .map_err(AppError::validation)?;
    repo.guardar(proveedor).await
}

pub async fn eliminar(repo: &dyn ProveedoresRepository, id_proveedor: String) -> AppResult<bool> {
    let id_proveedor = id_proveedor.trim();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    repo.eliminar(id_proveedor).await
}

pub async fn set_vinculos(
    repo: &dyn ProveedoresRepository,
    input: ProveedoresSetVinculosInput,
) -> AppResult<bool> {
    let id_proveedor = input.id_proveedor.trim().to_string();
    if id_proveedor.is_empty() {
        return Err(AppError::validation("ID_Proveedor inválido"));
    }
    let ids = normalizar_producto_ids(input.producto_ids);
    repo.set_vinculos(&id_proveedor, ids).await
}

pub async fn crear_producto(
    repo: &dyn ProveedoresRepository,
    input: ProveedoresCreateProductoInput,
) -> AppResult<String> {
    let producto = ProductoNuevo::validar(
        input.id_producto,
        input.id_categoria,
        input.id_proveedor,
        input.nombre,
        input.precio_venta,
        input.stock_actual,
        input.stock_minimo,
        input.unidad_medida,
    )
    .map_err(AppError::validation)?;
    repo.crear_producto(producto).await
}
