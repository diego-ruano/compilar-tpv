//! Puerto de persistencia de mesas / salón / comandas / cocina.

use std::collections::HashMap;

use async_trait::async_trait;

use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};

use crate::error::AppResult;

#[async_trait]
pub trait MesasRepository: Send + Sync {
    /* Layout */
    async fn save_layout(&self, salons: Vec<SalonInput>) -> AppResult<()>;
    async fn load_layout(&self) -> AppResult<Vec<SalonOut>>;

    /* Reservas */
    async fn set_reserva_estado(&self, id_reserva: &str, estado: tpv_domain::estados::EstadoReserva) -> AppResult<()>;

    /* Comandas de mesa */
    async fn get_comanda_abierta_by_mesa(&self, id_mesa: &str) -> AppResult<Option<ComandaRow>>;
    async fn abrir_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaRow>>;
    /// Abrir o retomar la mesa: su comanda abierta —creada si no hay ninguna, como
    /// `abrir_comanda`, y con el trabajador puesto si le faltaba y aún no tiene líneas, como
    /// `comanda_set_trabajador_if_null`— y sus líneas. Lo mismo que esas tres llamadas seguidas,
    /// en una: en la Handy es un viaje en vez de cuatro. `None` si, aun así, la mesa no tiene una
    /// comanda abierta (la cobró otro equipo en ese instante).
    async fn abrir_o_retomar_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaConLineasOut>>;
    /// Pone el trabajador a una comanda abierta que no lo tiene y aún no tiene líneas. Si ya lo
    /// tiene, no escribe nada: una sentencia que no cambia nada también se replicaría.
    async fn comanda_set_trabajador_if_null(
        &self,
        id_comanda: &str,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<bool>;
    /// INC-20261030-007: la reserva pasa a la comanda abierta si no tiene ninguna.
    async fn comanda_set_reserva_if_null(&self, id_comanda: &str, id_reserva: &str) -> AppResult<bool>;
    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<MesaLineaComandaRow>>;
    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<Vec<MesaLineaComandaRow>>;

    /* Meta + catálogo */
    async fn mesas_meta_all(&self) -> AppResult<HashMap<String, MesaMetaOut>>;
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaVendibleOut>>;
    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoVendibleOut>>;
    async fn search_productos_by_nombre(&self, q: String) -> AppResult<Vec<ProductoVendibleOut>>;

    /* Detalles (ticket) */
    async fn remove_one_pending_detalle(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<()>;
    async fn delete_detalle(&self, id_detalle: &str) -> AppResult<()>;
    async fn update_detalle_nota(&self, id_detalle: &str, nota: Option<String>) -> AppResult<()>;
    /// Devuelve el **id del pago**: con él se pide su ticket (`ticket_de_pago`, RI-29), que se
    /// compone desde la base con el número y la factura que se guardaron con el pago.
    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<String>;

    /* Cocina */
    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>>;
    async fn kitchen_set_line_state(
        &self,
        id_detalle: &str,
        id_usuario_cocinero: &str,
        estado: tpv_domain::estados::EstadoCocina,
    ) -> AppResult<()>;
}
