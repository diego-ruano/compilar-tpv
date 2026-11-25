//! Adaptador HTTP del repositorio de mesas/comandas/cocina (dominio `/v1/mesas` del worker).
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesasMetaOut, ProductoVendibleOut, SalonInput, SalonOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles};

use crate::client::leer_campo;
use crate::CloudClient;

/// Lo que dice una Handy que intenta cobrar: el mismo texto que el worker (`cobro_solo_en_main` en
/// `lib/errorCodes.ts`), lo diga quien lo diga.
pub(crate) const COBRO_SOLO_EN_MAIN: &str = "Los cobros sólo se hacen desde el TPV principal.";

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

    /// Cobra sólo la Main, que es la que tiene impresora y cajón; el worker lo veta a una Handy
    /// (`soloLaMainCobra`). Aquí se dice lo mismo sin salir a la red (M-083).
    async fn cobrar_detalles(&self, _data: CobroDetalles) -> AppResult<String> {
        Err(AppError::conflict(COBRO_SOLO_EN_MAIN))
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

#[cfg(test)]
mod tests_cobro_solo_en_la_main {
    //! M-083: una Handy no cobra. Lo veta el worker (`soloLaMainCobra`), y el adaptador lo dice sin
    //! salir a la red, con el mismo texto: antes mandaba el cobro igualmente, a recibir un 403.

    use super::*;
    use crate::venta_rapida::HttpVentaRapidaRepository;
    use tpv_application::ports::venta_rapida::VentaRapidaRepository;
    use tpv_domain::dinero::Dinero;
    use tpv_domain::pago::MetodoPago;
    use tpv_domain::venta_rapida::CobroFraccionado;

    /// Un host que no existe: si algo saliera a la red, el error sería de red, no el del cobro.
    fn cliente() -> Arc<CloudClient> {
        Arc::new(CloudClient::new("http://127.0.0.1:1", std::env::temp_dir()).unwrap())
    }

    #[tokio::test]
    async fn cobrar_una_mesa_desde_la_handy_dice_lo_mismo_que_el_worker() {
        let e = HttpMesasRepository::new(cliente())
            .cobrar_detalles(CobroDetalles {
                todo: false,
                id_comanda: "c1".into(),
                metodo: MetodoPago::Efectivo,
                tipo: "fraccionado".into(),
                detalle_ids: vec!["d1".into()],
                id_usuario: Some("u1".into()),
                destinatario: None,
            })
            .await
            .unwrap_err();
        assert_eq!(e.to_string(), COBRO_SOLO_EN_MAIN);
    }

    #[tokio::test]
    async fn cobrar_en_la_barra_desde_la_handy_dice_lo_mismo_que_el_worker() {
        let e = HttpVentaRapidaRepository::new(cliente())
            .cobrar_fraccionado(CobroFraccionado {
                todo: false,
                id_pago: "p1".into(),
                id_comanda: "c1".into(),
                metodo: MetodoPago::Tarjeta,
                importe_total: Dinero::de_centimos(300),
                id_usuario_cobrador: Some("u1".into()),
                id_trabajador_cobrador: None,
                detalles: vec!["d1".into()],
                destinatario: None,
            })
            .await
            .unwrap_err();
        assert_eq!(e.to_string(), COBRO_SOLO_EN_MAIN);
    }

    #[test]
    fn el_texto_es_el_del_worker() {
        let worker = include_str!("../../../apps/cloud-worker-licensing/src/lib/errorCodes.ts");
        assert!(
            worker.contains(&format!("cobro_solo_en_main: \"{COBRO_SOLO_EN_MAIN}\"")),
            "el texto de `cobro_solo_en_main` del worker ya no es «{COBRO_SOLO_EN_MAIN}»"
        );
    }
}
