//! Adaptador HTTP del repositorio de mesas/comandas/cocina (dominio `/v1/mesas` del worker).
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesasMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};

use crate::client::leer_campo;
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
    async fn set_reserva_estado(&self, id_reserva: &str, estado: tpv_domain::estados::EstadoReserva) -> AppResult<()> {
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

    async fn abrir_o_retomar_comanda(
        &self,
        data: AbrirComandaData,
    ) -> AppResult<Option<ComandaConLineasOut>> {
        // Un viaje: antes eran la abierta, abrirla o ponerle el trabajador, y las líneas.
        let body = json!({
            "id_mesa": data.id_mesa,
            "id_trabajador": data.id_trabajador_o_usuario,
            "id_reserva": data.id_reserva,
        });
        self.client.post_json("/v1/mesas/comandas/abrir-o-retomar", &body).await
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

    async fn comanda_set_reserva_if_null(&self, id_comanda: &str, id_reserva: &str) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_reserva": id_reserva });
        self.client
            .put_json("/v1/mesas/comandas/reserva-if-null", &body)
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
        // AUD-28: sin el texto de serde, que cita el valor que no encaja.
        leer_campo("bad_lineas", &resp["lineas"])
    }

    /* Meta + catálogo */
    async fn mesas_meta_all(&self) -> AppResult<MesasMetaOut> {
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
        // AUD-27: lo que se escribe en un buscador va en el cuerpo, no en la URL.
        self.client
            .post_lectura("/v1/mesas/productos/search", &json!({ "query": q }))
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

    /// Los cambios van ya validados; el worker los vuelve a validar y les da la misma forma
    /// guardada que la Main.
    async fn update_detalle_ingredientes(
        &self,
        id_detalle: &str,
        cambios: &[tpv_domain::ingredientes::CambioIngrediente],
    ) -> AppResult<()> {
        let lista: Vec<JsonValue> = cambios
            .iter()
            .map(|c| json!({ "id_ingrediente": c.id, "nombre": c.nombre, "tipo": c.tipo }))
            .collect();
        let _: JsonValue = self
            .client
            .put_json(
                &format!("/v1/mesas/lineas/{id_detalle}/ingredientes"),
                &json!({ "cambios": lista }),
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
        estado: tpv_domain::estados::EstadoCocina,
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
