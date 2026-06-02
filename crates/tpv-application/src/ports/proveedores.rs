//! Puerto de persistencia de proveedores.

use async_trait::async_trait;

use tpv_contracts::proveedores::{CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto};
use tpv_domain::proveedores::{ProductoNuevo, ProveedorValidado};

use crate::error::AppResult;

#[async_trait]
pub trait ProveedoresRepository: Send + Sync {
    async fn get_all(&self) -> AppResult<Vec<ProveedorDto>>;
    async fn get_productos(&self, id_proveedor: i64) -> AppResult<Vec<ProductoProveedorDto>>;
    async fn get_categorias(&self) -> AppResult<Vec<CategoriaProveedorDto>>;
    async fn get_productos_all(&self) -> AppResult<Vec<ProductoProveedorDto>>;

    /// Upsert de proveedor. Devuelve `true`.
    async fn guardar(&self, proveedor: ProveedorValidado) -> AppResult<bool>;
    /// Elimina proveedor (desvinculando lotes/productos). Devuelve `true` si borró fila.
    async fn eliminar(&self, id_proveedor: i64) -> AppResult<bool>;
    /// Reasigna el conjunto de productos vinculados al proveedor.
    async fn set_vinculos(&self, id_proveedor: i64, producto_ids: Vec<i64>) -> AppResult<bool>;
    /// Crea/upserta un producto y, si hay stock inicial, su lote. Devuelve el id de producto.
    async fn crear_producto(&self, producto: ProductoNuevo) -> AppResult<i64>;
}
