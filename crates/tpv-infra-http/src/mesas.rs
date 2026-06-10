//! Adaptador HTTP del repositorio de mesas/comandas/cocina (dominio `/v1/mesas` del worker).
//!
//! Los métodos de **barra** (`get_or_create_mesa_barra`, `get_or_create_comanda_barra`,
//! `cobrar_venta_rapida`, `create_comanda_barra`, `list_comandas_barra`,
//! `delete_comanda_barra_if_safe`) NO tienen endpoint en el dominio `mesas` del worker: la
//! barra se sirve bajo `venta_rapida`. Aquí devuelven un error explícito.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles, CobroVentaRapida};

use crate::CloudClient;

pub struct HttpMesasRepository {
    client: Arc<CloudClient>,
}

impl HttpMesasRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

fn barra_no_disponible(metodo: &str) -> AppError {
    AppError::external(format!(
        "endpoint_no_disponible_en_handy: mesas::{metodo} (la barra se sirve bajo venta_rapida)"
    ))
}

#[async_trait]
impl MesasRepository for HttpMesasRepository {
    /* Layout */
    async fn save_layout(&self, salons: Vec<SalonInput>) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .post_json("/v1/mesas/layout", &json!({ "salons": salons }))
            .await?;
        Ok(())
    }

    async fn load_layout(&self) -> AppResult<Vec<SalonOut>> {
        self.client.get_json("/v1/mesas/layout").await
    }

    async fn get_mesas_ocupadas(&self) -> AppResult<HashMap<String, bool>> {
        self.client.get_json("/v1/mesas/ocupadas").await
    }

    /* Reservas */
    async fn set_reserva_estado(&self, id_reserva: i64, estado: String) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .put_json(
                &format!("/v1/mesas/reservas/{id_reserva}/estado"),
                &json!({ "estado": estado }),
            )
            .await?;
        Ok(())
    }

    /* Comandas de mesa */
    async fn get_comanda_abierta_by_mesa(&self, id_mesa: i64) -> AppResult<Option<ComandaRow>> {
        self.client
            .get_json(&format!("/v1/mesas/comandas/mesa/{id_mesa}/abierta"))
            .await
    }

    async fn abrir_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaRow>> {
        let body = json!({
            "id_mesa": data.id_mesa,
            "id_trabajador": data.id_trabajador_o_usuario,
            "id_reserva": data.id_reserva,
        });
        self.client.post_json("/v1/mesas/comandas", &body).await
    }

    async fn comanda_set_trabajador_if_null(
        &self,
        id_comanda: i64,
        id_trab_o_usuario: Option<i64>,
    ) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_trabajador": id_trab_o_usuario });
        self.client
            .put_json("/v1/mesas/comandas/trabajador-if-null", &body)
            .await
    }

    async fn cerrar_comanda(&self, id_comanda: i64, total: f64) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .put_json(
                "/v1/mesas/comandas/cerrar",
                &json!({ "id_comanda": id_comanda, "total": total }),
            )
            .await?;
        Ok(())
    }

    async fn get_lineas_comanda(&self, id_comanda: i64) -> AppResult<Vec<MesaLineaComandaRow>> {
        self.client
            .get_json(&format!("/v1/mesas/comandas/{id_comanda}/lineas"))
            .await
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: i64,
        id_producto: i64,
        cantidad: f64,
        precio: f64,
        id_trab_o_usuario: Option<i64>,
    ) -> AppResult<()> {
        let body = json!({
            "id_comanda": id_comanda,
            "id_producto": id_producto,
            "cantidad": cantidad,
            "precio": precio,
            "id_trabajador": id_trab_o_usuario,
        });
        let _: JsonValue = self.client.post_json("/v1/mesas/lineas", &body).await?;
        Ok(())
    }

    /* Barra — sin endpoint en el dominio `mesas` del worker (lo cubre venta_rapida) */
    async fn get_or_create_mesa_barra(&self) -> AppResult<i64> {
        Err(barra_no_disponible("get_or_create_mesa_barra"))
    }

    async fn get_or_create_comanda_barra(&self, _id_trabajador: Option<i64>) -> AppResult<i64> {
        Err(barra_no_disponible("get_or_create_comanda_barra"))
    }

    async fn cobrar_venta_rapida(&self, _data: CobroVentaRapida) -> AppResult<()> {
        Err(barra_no_disponible("cobrar_venta_rapida"))
    }

    async fn create_comanda_barra(&self, _id_trabajador: Option<i64>) -> AppResult<i64> {
        Err(barra_no_disponible("create_comanda_barra"))
    }

    async fn list_comandas_barra(
        &self,
        _include_pagadas: bool,
        _limit: i64,
    ) -> AppResult<Vec<ComandaBarraListItem>> {
        Err(barra_no_disponible("list_comandas_barra"))
    }

    async fn delete_comanda_barra_if_safe(&self, _id_comanda: i64) -> AppResult<bool> {
        Err(barra_no_disponible("delete_comanda_barra_if_safe"))
    }

    /* Meta + catálogo */
    async fn mesas_meta_all(&self) -> AppResult<HashMap<i64, MesaMetaOut>> {
        self.client.get_json("/v1/mesas/meta").await
    }

    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaVendibleOut>> {
        self.client.get_json("/v1/mesas/categorias").await
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: i64,
    ) -> AppResult<Vec<ProductoVendibleOut>> {
        self.client
            .get_json(&format!("/v1/mesas/productos/{id_categoria}"))
            .await
    }

    async fn search_productos_by_nombre(&self, q: String) -> AppResult<Vec<ProductoVendibleOut>> {
        self.client
            .get_query("/v1/mesas/productos/search", &[("query", q)])
            .await
    }

    /* Detalles (ticket) */
    async fn remove_one_pending_detalle(
        &self,
        id_comanda: i64,
        id_producto: i64,
    ) -> AppResult<()> {
        let body = json!({ "id_comanda": id_comanda, "id_producto": id_producto });
        let _: JsonValue = self
            .client
            .post_json("/v1/mesas/lineas/remove-one-pending", &body)
            .await?;
        Ok(())
    }

    async fn delete_detalle(&self, id_detalle: i64) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/mesas/lineas/{id_detalle}"))
            .await?;
        Ok(())
    }

    async fn update_detalle_nota(&self, id_detalle: i64, nota: Option<String>) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .put_json(
                &format!("/v1/mesas/lineas/{id_detalle}/nota"),
                &json!({ "nota": nota }),
            )
            .await?;
        Ok(())
    }

    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<()> {
        let body = json!({
            "id_comanda": data.id_comanda,
            "metodo": data.metodo,
            "tipo": data.tipo,
            "detalle_ids": data.detalle_ids,
            "id_usuario": data.id_usuario,
        });
        let _: JsonValue = self.client.post_json("/v1/mesas/cobrar-detalles", &body).await?;
        Ok(())
    }

    /* Cocina */
    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>> {
        self.client.get_json("/v1/mesas/kitchen/today-pending").await
    }

    async fn kitchen_set_line_state(
        &self,
        id_detalle: i64,
        id_usuario_cocinero: i64,
        estado: String,
    ) -> AppResult<()> {
        let body = json!({
            "id_detalle": id_detalle,
            "id_usuario_cocinero": id_usuario_cocinero,
            "estado": estado,
        });
        let _: JsonValue = self
            .client
            .put_json("/v1/mesas/kitchen/line-state", &body)
            .await?;
        Ok(())
    }
}
