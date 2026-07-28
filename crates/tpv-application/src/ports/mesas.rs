//! Puerto de persistencia de mesas / salón / comandas / cocina.

use std::collections::HashMap;

use async_trait::async_trait;

use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles, CobroVentaRapida};

use crate::error::AppResult;

#[async_trait]
pub trait MesasRepository: Send + Sync {
    /* Layout */
    async fn save_layout(&self, salons: Vec<SalonInput>) -> AppResult<()>;
    async fn load_layout(&self) -> AppResult<Vec<SalonOut>>;
    async fn get_mesas_ocupadas(&self) -> AppResult<HashMap<String, bool>>;

    /* Reservas */
    async fn set_reserva_estado(&self, id_reserva: &str, estado: String) -> AppResult<()>;

    /* Comandas de mesa */
    async fn get_comanda_abierta_by_mesa(&self, id_mesa: &str) -> AppResult<Option<ComandaRow>>;
    async fn abrir_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaRow>>;
    async fn comanda_set_trabajador_if_null(
        &self,
        id_comanda: &str,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<bool>;
    async fn cerrar_comanda(&self, id_comanda: &str, total: f64) -> AppResult<()>;
    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<MesaLineaComandaRow>>;
    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        precio: f64,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<Vec<MesaLineaComandaRow>>;

    /* Barra */
    async fn get_or_create_comanda_barra(&self, id_trabajador: Option<String>)
        -> AppResult<String>;
    async fn cobrar_venta_rapida(&self, data: CobroVentaRapida) -> AppResult<()>;
    async fn create_comanda_barra(&self, id_trabajador: Option<String>) -> AppResult<String>;
    async fn list_comandas_barra(
        &self,
        include_pagadas: bool,
        limit: i64,
    ) -> AppResult<Vec<ComandaBarraListItem>>;
    async fn delete_comanda_barra_if_safe(&self, id_comanda: &str) -> AppResult<bool>;

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
    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<()>;

    /* Cocina */
    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>>;
    async fn kitchen_set_line_state(
        &self,
        id_detalle: &str,
        id_usuario_cocinero: &str,
        estado: String,
    ) -> AppResult<()>;
}
