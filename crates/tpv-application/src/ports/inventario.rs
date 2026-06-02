//! Puerto de persistencia de inventario.

use async_trait::async_trait;

use tpv_contracts::inventario::{
    AlergenoInvDto, CategoriaInvDto, InventarioResumenResponse, LoteDto, ProductDetailResponse,
    ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProveedorMiniDto,
};
use tpv_domain::inventario::{AjusteLote, CategoriaUpsert, LoteNuevo, ProductoUpsert};

use crate::error::AppResult;

#[async_trait]
pub trait InventarioRepository: Send + Sync {
    // ── Lecturas ──
    async fn list_categorias(&self) -> AppResult<Vec<CategoriaInvDto>>;
    async fn list_proveedores_mini(&self) -> AppResult<Vec<ProveedorMiniDto>>;
    async fn list_productos_by_categoria(
        &self,
        id_categoria: i64,
    ) -> AppResult<Vec<ProductoListDto>>;
    async fn resumen(&self, limit: i64) -> AppResult<InventarioResumenResponse>;
    async fn list_alergenos(&self) -> AppResult<Vec<AlergenoInvDto>>;
    async fn alergenos_producto(&self, id_producto: i64) -> AppResult<Vec<i64>>;
    async fn get_producto(&self, id_producto: i64) -> AppResult<Option<ProductoBaseDto>>;
    async fn product_detail(&self, id_producto: i64) -> AppResult<ProductDetailResponse>;
    async fn producto_detalle(&self, id_producto: i64) -> AppResult<Option<ProductoDetalleDto>>;
    async fn list_lotes_by_producto(&self, id_producto: i64) -> AppResult<Vec<LoteDto>>;

    // ── Escrituras ──
    async fn create_categoria(&self, cat: CategoriaUpsert) -> AppResult<()>;
    async fn set_alergenos_producto(&self, id_producto: i64, ids: Vec<i64>) -> AppResult<()>;
    async fn delete_producto(&self, id_producto: i64) -> AppResult<()>;
    /// Upsert de producto + alérgenos. Devuelve el id de producto.
    async fn upsert_producto(&self, producto: ProductoUpsert) -> AppResult<i64>;
    async fn create_lote(&self, lote: LoteNuevo) -> AppResult<()>;
    async fn ajustar_lote(&self, ajuste: AjusteLote) -> AppResult<()>;
}
