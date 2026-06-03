//! Puerto de persistencia de venta rápida (barra).

use async_trait::async_trait;

use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow,
};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::error::AppResult;

#[async_trait]
pub trait VentaRapidaRepository: Send + Sync {
    /* Lecturas */
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>>;
    async fn list_productos_by_categoria(&self, id_categoria: i64) -> AppResult<Vec<ProductoRow>>;
    async fn search_productos(&self, query: String, limit: i64) -> AppResult<Vec<ProductoRow>>;
    async fn list_comandas_barra(
        &self,
        include_pagadas: bool,
        limit: Option<i64>,
    ) -> AppResult<Vec<ComandaBarraRow>>;
    async fn get_lineas_comanda(&self, id_comanda: i64) -> AppResult<Vec<LineaComandaRow>>;
    async fn get_index_rows(&self, ids: Vec<i64>) -> AppResult<Vec<IndexRow>>;
    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: i64,
    ) -> AppResult<Vec<VerTicketsDetalleRow>>;

    /* Escrituras (Local-First, sin outbox) */
    /// Crea (o reutiliza si `get_or_create`) la comanda de barra. Devuelve su id.
    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<i64>,
        get_or_create: bool,
    ) -> AppResult<i64>;
    /// Añade una línea. Devuelve el id de detalle.
    async fn add_linea_comanda(
        &self,
        id_comanda: i64,
        id_producto: i64,
        cantidad: f64,
        precio_unitario: f64,
    ) -> AppResult<i64>;
    /// Elimina la última línea no pagada de ese producto en la comanda.
    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: i64,
        id_producto: i64,
    ) -> AppResult<bool>;
    /// Elimina una línea concreta si no está pagada.
    async fn delete_linea_if_unpaid(&self, id_comanda: i64, id_detalle: i64) -> AppResult<bool>;
    /// Actualiza la nota de un detalle. Error si no existe.
    async fn update_nota_detalle(&self, id_detalle: i64, nota: Option<String>) -> AppResult<bool>;
    /// Cobro fraccionado: descuenta stock FEFO + traza consumos en la misma transacción.
    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<bool>;
    /// Resta stock (FEFO) de las líneas dadas (sin trazabilidad por detalle).
    async fn restar_stock(&self, lineas: Vec<StockLinea>) -> AppResult<bool>;
    /// Borra una comanda si no tiene líneas pagadas. Error si tiene pagos o no existe.
    async fn delete_comanda_if_safe(&self, id_comanda: i64) -> AppResult<bool>;
}
