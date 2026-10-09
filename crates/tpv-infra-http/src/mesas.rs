//! Adaptador HTTP del repositorio de mesas/comandas/cocina (dominio `/v1/mesas` del worker).
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};

use crate::CloudClient;

pub struct HttpMesasRepository {
    client: Arc<CloudClient>,
}

impl HttpMesasRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
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

    /* Reservas */
    async fn set_reserva_estado(&self, id_reserva: &str, estado: String) -> AppResult<()> {
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
    async fn get_comanda_abierta_by_mesa(&self, id_mesa: &str) -> AppResult<Option<ComandaRow>> {
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
        id_comanda: &str,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_trabajador": id_trab_o_usuario });
        self.client
            .put_json("/v1/mesas/comandas/trabajador-if-null", &body)
            .await
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<MesaLineaComandaRow>> {
        self.client
            .get_json(&format!("/v1/mesas/comandas/{id_comanda}/lineas"))
            .await
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<Vec<MesaLineaComandaRow>> {
        let body = json!({
            "id_comanda": id_comanda,
            "id_producto": id_producto,
            "cantidad": cantidad,
            "id_trabajador": id_trab_o_usuario,
        });
        let resp: JsonValue = self.client.post_json("/v1/mesas/lineas", &body).await?;
        serde_json::from_value(resp["lineas"].clone())
            .map_err(|e| AppError::external(format!("bad_lineas: {e}")))
    }

    /* Meta + catálogo */
    async fn mesas_meta_all(&self) -> AppResult<HashMap<String, MesaMetaOut>> {
        self.client.get_json("/v1/mesas/meta").await
    }

    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaVendibleOut>> {
        self.client.get_json("/v1/mesas/categorias").await
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
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
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<()> {
        let body = json!({ "id_comanda": id_comanda, "id_producto": id_producto });
        let _: JsonValue = self
            .client
            .post_json("/v1/mesas/lineas/remove-one-pending", &body)
            .await?;
        Ok(())
    }

    async fn delete_detalle(&self, id_detalle: &str) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/mesas/lineas/{id_detalle}"))
            .await?;
        Ok(())
    }

    async fn update_detalle_nota(&self, id_detalle: &str, nota: Option<String>) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .put_json(
                &format!("/v1/mesas/lineas/{id_detalle}/nota"),
                &json!({ "nota": nota }),
            )
            .await?;
        Ok(())
    }

    /// El worker rechaza el cobro desde un Handy (solo cobra la Main, que es la que tiene
    /// impresora y cajón), así que esta llamada devuelve 403 y nunca llega a un pago. Se
    /// mantiene el camino por si algún día se retoma.
    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<String> {
        let body = json!({
            "id_comanda": data.id_comanda,
            "metodo": data.metodo,
            "tipo": data.tipo,
            "detalle_ids": data.detalle_ids,
            "id_usuario": data.id_usuario,
        });
        let _: JsonValue = self.client.post_json("/v1/mesas/cobrar-detalles", &body).await?;
        Ok(String::new())
    }

    /* Cocina */
    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>> {
        self.client.get_json("/v1/mesas/kitchen/today-pending").await
    }

    async fn kitchen_set_line_state(
        &self,
        id_detalle: &str,
        id_usuario_cocinero: &str,
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
