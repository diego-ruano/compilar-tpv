//! Puerto de persistencia de venta rápida (barra).

use async_trait::async_trait;

use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow,
    VerTicketsDetalleRow, VrLineaAnadida, CobroPendienteDto, ResolverCobroPendienteInput,
};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::error::AppResult;

#[async_trait]
pub trait VentaRapidaRepository: Send + Sync {
    /* Lecturas */
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>>;
    async fn list_productos_by_categoria(&self, id_categoria: &str) -> AppResult<Vec<ProductoRow>>;
    async fn search_productos(&self, query: String, limit: i64) -> AppResult<Vec<ProductoRow>>;
    /// Los tickets de barra con líneas, cobrados o no, de más reciente a más antiguo.
    async fn list_comandas_barra(&self, limit: Option<i64>) -> AppResult<Vec<ComandaBarraRow>>;
    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<LineaComandaRow>>;
    async fn get_index_rows(&self, ids: Vec<String>) -> AppResult<Vec<IndexRow>>;
    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: &str,
    ) -> AppResult<Vec<VerTicketsDetalleRow>>;

    /* Escrituras (Local-First, sin outbox) */
    /// Crea (o reutiliza si `get_or_create`) la comanda de barra. Devuelve su id.
    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<String>,
        get_or_create: bool,
    ) -> AppResult<String>;
    /// Añade una línea al precio del catálogo (RI-27). Devuelve su id y ese precio.
    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
    ) -> AppResult<VrLineaAnadida>;
    /// Elimina la última línea no pagada de ese producto en la comanda.
    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<bool>;
    /// Elimina una línea concreta si no está pagada.
    async fn delete_linea_if_unpaid(&self, id_comanda: &str, id_detalle: &str) -> AppResult<bool>;
    /// Actualiza la nota de un detalle. Error si no existe.
    async fn update_nota_detalle(&self, id_detalle: &str, nota: Option<String>) -> AppResult<bool>;
    /// Cobro fraccionado: descuenta stock FEFO + traza consumos en la misma transacción.
    /// Devuelve el **número de ticket** que ha reservado el cobro. Lo necesita quien imprime: sin
    /// él, el papel saldría sin número o habría que volver a consultarlo. Y guardarlo con el pago
    /// es lo que permite que una reimpresión saque el mismo.
    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<String>;
    /// Recuperación de cobros de la Main, compartida por operadores con permiso de vender.
    async fn guardar_cobro_pendiente(&self, _data: CobroFraccionado) -> AppResult<()> {
        Err(crate::error::AppError::validation("Los cobros se preparan en la Main"))
    }
    async fn listar_cobros_pendientes(&self) -> AppResult<Vec<CobroPendienteDto>> { Ok(vec![]) }
    async fn resolver_cobro_pendiente(&self, _input: ResolverCobroPendienteInput) -> AppResult<String> {
        Err(crate::error::AppError::validation("Los cobros se resuelven en la Main"))
    }
    async fn cancelar_cobro_pendiente(&self, _id_pago: &str) -> AppResult<bool> { Ok(false) }
    /// Borra una comanda si no tiene líneas pagadas. Error si tiene pagos o no existe.
    async fn delete_comanda_if_safe(&self, id_comanda: &str) -> AppResult<bool>;
}
