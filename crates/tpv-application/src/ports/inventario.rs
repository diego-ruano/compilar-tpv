//! Puerto de persistencia de inventario.

use async_trait::async_trait;

use tpv_contracts::inventario::{
    AlergenoInvDto, CatalogoIngredientesDto, CategoriaInvDto, InventarioResumenResponse, LoteDto, ProductDetailResponse,
    ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProveedorMiniDto,
};
use tpv_domain::ingredientes::{CategoriaIngredienteGuardar, IngredienteGuardar};
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
    async fn get_producto(&self, id_producto: &str) -> AppResult<Option<ProductoBaseDto>>;
    async fn product_detail(&self, id_producto: &str) -> AppResult<ProductDetailResponse>;
    async fn producto_detalle(&self, id_producto: &str) -> AppResult<Option<ProductoDetalleDto>>;
    async fn list_lotes_by_producto(&self, id_producto: &str) -> AppResult<Vec<LoteDto>>;

    // ── Escrituras ──
    // Nota: el borrado con histórico (INV-05) se valida DENTRO de cada implementación de escritura
    // (atómico con el read, sin TOCTOU). En el adaptador SQLite se hace localmente; en el HTTP lo
    // valida el worker en sus rutas.
    async fn create_categoria(&self, cat: CategoriaUpsert) -> AppResult<()>;
    async fn delete_producto(&self, id_producto: &str) -> AppResult<()>;
    /// Borra una categoría con sus productos: cada uno se archiva si tiene historia (y se queda sin
    /// categoría) o se borra si no. Nada, si alguno está en una comanda abierta.
    async fn borrar_categoria(&self, id_categoria: &str) -> AppResult<()>;
    /// Upsert de producto + alérgenos, con los límites de la sesión: `precios` deja tocar el precio y
    /// `recibir`, dar de alta existencias. SQLite valida bajo su cerrojo. Devuelve el id de producto.
    ///
    /// El stock suelto sólo se escribe al **crear** (con su movimiento de alta); editando la ficha
    /// no se toca (RI-55).
    async fn upsert_producto_autorizado(&self, actor: &str, producto: ProductoUpsert, precios: bool, recibir: bool) -> AppResult<String>;
    async fn create_lote(&self, id_usuario: &str, lote: LoteNuevo) -> AppResult<()>;
    /// Los datos de un lote, sin tocar sus existencias (RI-55).
    async fn update_lote(&self, lote: LoteUpdate) -> AppResult<()>;
    /// Ajusta las existencias de un lote y deja el movimiento. Si lo que hay ya no es
    /// `stock_visto`, no toca nada y devuelve `Conflict` (RI-55).
    async fn ajustar_lote(&self, id_usuario: &str, ajuste: AjusteLote) -> AppResult<()>;
    /// Lo mismo para el stock suelto de un producto (RI-55).
    async fn ajustar_stock_suelto(&self, id_usuario: &str, ajuste: AjusteSuelto) -> AppResult<()>;

    // ── Ingredientes (sin cantidades, stock ni precio) ──
    /// Todas las categorías de ingredientes y todos los ingredientes.
    async fn catalogo_ingredientes(&self) -> AppResult<CatalogoIngredientesDto>;
    /// Los ids de los ingredientes que lleva un producto.
    async fn ingredientes_de_producto(&self, id_producto: &str) -> AppResult<Vec<String>>;
    /// Crea o renombra una categoría de ingredientes; devuelve su id.
    async fn guardar_categoria_ingrediente(&self, categoria: CategoriaIngredienteGuardar) -> AppResult<String>;
    /// Borra una categoría con sus ingredientes, y los quita de los productos que los llevaban. Lo
    /// ya pedido no cambia: cada línea guarda el nombre.
    async fn borrar_categoria_ingrediente(&self, id_categoria_ingrediente: &str) -> AppResult<()>;
    /// Crea, renombra o cambia de categoría un ingrediente; devuelve su id.
    async fn guardar_ingrediente(&self, ingrediente: IngredienteGuardar) -> AppResult<String>;
    /// Borra un ingrediente y lo quita de los productos que lo llevaban.
    async fn borrar_ingrediente(&self, id_ingrediente: &str) -> AppResult<()>;
}
