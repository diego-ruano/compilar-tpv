//! Puerto de persistencia de inventario.

use async_trait::async_trait;

use tpv_contracts::inventario::{
    AlergenoInvDto, CategoriaInvDto, InventarioResumenResponse, LoteDto, ProductDetailResponse,
    ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProveedorMiniDto,
};
use tpv_domain::inventario::{
    AjusteLote, AjusteSuelto, CategoriaUpsert, LoteNuevo, LoteUpdate, ProductoUpsert,
};

use crate::error::AppResult;

#[async_trait]
pub trait InventarioRepository: Send + Sync {
    // ── Lecturas ──
    async fn list_categorias(&self) -> AppResult<Vec<CategoriaInvDto>>;
    async fn list_proveedores_mini(&self) -> AppResult<Vec<ProveedorMiniDto>>;
    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoListDto>>;
    async fn resumen(&self, limit: i64) -> AppResult<InventarioResumenResponse>;
    async fn list_alergenos(&self) -> AppResult<Vec<AlergenoInvDto>>;
    async fn alergenos_producto(&self, id_producto: &str) -> AppResult<Vec<String>>;
    async fn get_producto(&self, id_producto: &str) -> AppResult<Option<ProductoBaseDto>>;
    async fn product_detail(&self, id_producto: &str) -> AppResult<ProductDetailResponse>;
    async fn producto_detalle(&self, id_producto: &str) -> AppResult<Option<ProductoDetalleDto>>;
    async fn list_lotes_by_producto(&self, id_producto: &str) -> AppResult<Vec<LoteDto>>;

    // ── Escrituras ──
    // Nota: el borrado con histórico (INV-05) se valida DENTRO de cada implementación de escritura
    // (atómico con el read, sin TOCTOU). En el adaptador SQLite se hace localmente; en el HTTP lo
    // valida el worker en sus rutas.
    async fn create_categoria(&self, cat: CategoriaUpsert) -> AppResult<()>;
    async fn set_alergenos_producto(&self, id_producto: &str, ids: Vec<String>) -> AppResult<()>;
    async fn delete_producto(&self, id_producto: &str) -> AppResult<()>;
    /// Upsert de producto + alérgenos. Devuelve el id de producto.
    ///
    /// El stock suelto sólo se escribe al **crear** (con su movimiento de alta); editando la ficha
    /// no se toca (RI-55).
    async fn upsert_producto(&self, producto: ProductoUpsert) -> AppResult<String>;
    async fn create_lote(&self, lote: LoteNuevo) -> AppResult<()>;
    /// Los datos de un lote, sin tocar sus existencias (RI-55).
    async fn update_lote(&self, lote: LoteUpdate) -> AppResult<()>;
    /// Ajusta las existencias de un lote y deja el movimiento. Si lo que hay ya no es
    /// `stock_visto`, no toca nada y devuelve `Conflict` (RI-55).
    async fn ajustar_lote(&self, ajuste: AjusteLote) -> AppResult<()>;
    /// Lo mismo para el stock suelto de un producto (RI-55).
    async fn ajustar_stock_suelto(&self, ajuste: AjusteSuelto) -> AppResult<()>;
}
