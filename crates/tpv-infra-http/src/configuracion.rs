//! Adaptador HTTP del repositorio de configuración (dominio `/v1/configuracion` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};

use crate::client::leer_campo;
use crate::CloudClient;

/// CFG-INC-02: los datos del negocio de una respuesta del worker, con la zona horaria del esquema si
/// no la trae. Un worker desplegado antes de que existiera no la devuelve, y sin ella la Handy no
/// leía ningún dato del negocio: la pantalla enseñaba los valores por defecto como si fueran los
/// guardados. Es el único campo así: es de sólo lectura (lo pone la Main) y su valor por defecto es
/// el que tendría una base en la que la Main todavía no lo ha escrito. Los que se editan no se
/// rellenan: un valor inventado en el formulario acabaría guardado encima del bueno.
///
/// Va aquí y no como `#[serde(default)]` en el DTO porque eso lo haría opcional en los tipos de la
/// pantalla, que siempre lo reciben.
fn negocio_de_la_respuesta(mut v: JsonValue) -> AppResult<BusinessSettings> {
    if let Some(o) = v.as_object_mut() {
        o.entry("zona_horaria")
            .or_insert_with(|| JsonValue::from(tpv_domain::reservas_web::ZONA_POR_DEFECTO));
    }
    leer_campo("bad_business_settings", &v)
}

pub struct HttpConfiguracionRepository {
    client: Arc<CloudClient>,
}

impl HttpConfiguracionRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ConfiguracionRepository for HttpConfiguracionRepository {
    async fn get_business(&self) -> AppResult<BusinessSettings> {
        negocio_de_la_respuesta(self.client.get_json("/v1/configuracion/business").await?)
    }

    async fn get_ticket(&self) -> AppResult<TicketSettings> {
        self.client.get_json("/v1/configuracion/ticket").await
    }

    async fn patch_business(&self, patch: &JsonValue) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .patch_json("/v1/configuracion/business", &json!({ "patch": patch }))
            .await?;
        Ok(())
    }

    async fn patch_ticket(&self, patch: &JsonValue) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .patch_json("/v1/configuracion/ticket", &json!({ "patch": patch }))
            .await?;
        Ok(())
    }

    async fn get_contact(&self) -> AppResult<ContactSettings> {
        self.client.get_json("/v1/configuracion/contact").await
    }

    async fn patch_contact(&self, patch: &JsonValue) -> AppResult<()> {
        let _: JsonValue = self
            .client
            .patch_json("/v1/configuracion/contact", &json!({ "patch": patch }))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests_negocio_sin_zona {
    use super::*;

    fn respuesta() -> JsonValue {
        json!({
            "business_name": "Bar", "logo_data_url": null, "direccion": "", "telefono": "", "cif": "",
            "mensaje_footer": "", "iva_percent": 10.0, "umbral_descuadre": 500, "razon_social": "",
            "descripcion_op": "x", "limite_simplif": 300000, "verifactu_entorno": "produccion",
            "reserva_duracion_min": 120, "reserva_solape": "avisar", "reserva_no_vino_min": 0,
        })
    }

    /// CFG-INC-02: un worker anterior a la zona horaria no la devuelve.
    #[test]
    fn sin_la_zona_horaria_se_leen_los_datos_con_la_del_esquema() {
        let negocio = negocio_de_la_respuesta(respuesta()).unwrap();
        assert_eq!(negocio.zona_horaria, "Europe/Madrid");
        assert_eq!(negocio.business_name, "Bar");
    }

    #[test]
    fn con_ella_manda_la_que_trae() {
        let mut v = respuesta();
        v["zona_horaria"] = json!("Atlantic/Canary");
        assert_eq!(negocio_de_la_respuesta(v).unwrap().zona_horaria, "Atlantic/Canary");
    }

    /// Un campo que se edita no se inventa: si falta, no se lee.
    #[test]
    fn sin_un_campo_que_se_edita_no_se_lee() {
        let mut v = respuesta();
        v.as_object_mut().unwrap().remove("telefono");
        assert!(negocio_de_la_respuesta(v).is_err());
    }
}
