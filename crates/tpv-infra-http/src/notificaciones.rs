//! Adaptador HTTP de **notificaciones** (dominio `/v1/notificaciones` del worker). Implementa el
//! puerto de lectura/gestión (`NotificacionesRepository`) y el de emisión (`Notifier`) para el
//! modo Handy: sin BD local, todo va por REST a la nube y se propaga por WebSocket.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::notificaciones::{NotificacionesRepository, Notifier};
use tpv_contracts::notificaciones::NotificacionRow;
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::CloudClient;

pub struct HttpNotificacionesRepository {
    client: Arc<CloudClient>,
}

impl HttpNotificacionesRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[derive(Deserialize)]
struct CountResp {
    #[serde(default)]
    count: i64,
}

#[derive(Deserialize)]
struct CrearResp {
    id_notificacion: String,
}

#[derive(Deserialize)]
struct MarcarTodasResp {
    #[serde(default)]
    marcadas: i64,
}

#[async_trait]
impl NotificacionesRepository for HttpNotificacionesRepository {
    async fn listar(
        &self,
        id_usuario: &str,
        solo_no_leidas: bool,
    ) -> AppResult<Vec<NotificacionRow>> {
        self.client
            .get_query(
                "/v1/notificaciones",
                &[
                    ("usuario", id_usuario.to_string()),
                    ("solo_no_leidas", solo_no_leidas.to_string()),
                ],
            )
            .await
    }

    async fn contar_no_leidas(&self, id_usuario: &str) -> AppResult<i64> {
        let r: CountResp = self
            .client
            .get_query("/v1/notificaciones/count", &[("usuario", id_usuario.to_string())])
            .await?;
        Ok(r.count)
    }

    async fn marcar_leida(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        let body = json!({ "id_usuario": id_usuario });
        let _: JsonValue = self
            .client
            .post_json(&format!("/v1/notificaciones/{id_notificacion}/leer"), &body)
            .await?;
        Ok(true)
    }

    async fn marcar_todas_leidas(&self, id_usuario: &str) -> AppResult<i64> {
        let body = json!({ "id_usuario": id_usuario });
        let r: MarcarTodasResp = self
            .client
            .post_json("/v1/notificaciones/leer-todas", &body)
            .await?;
        Ok(r.marcadas)
    }

    async fn descartar(&self, id_notificacion: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .post_json(
                &format!("/v1/notificaciones/{id_notificacion}/descartar"),
                &json!({}),
            )
            .await?;
        Ok(true)
    }

    async fn listar_descartadas(&self, id_usuario: &str) -> AppResult<Vec<NotificacionRow>> {
        self.client
            .get_query(
                "/v1/notificaciones/papelera",
                &[("usuario", id_usuario.to_string())],
            )
            .await
    }

    async fn restaurar(&self, id_notificacion: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .post_json(
                &format!("/v1/notificaciones/{id_notificacion}/restaurar"),
                &json!({}),
            )
            .await?;
        Ok(true)
    }

    async fn eliminar(&self, id_notificacion: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/notificaciones/{id_notificacion}"))
            .await?;
        Ok(true)
    }
}

#[async_trait]
impl Notifier for HttpNotificacionesRepository {
    async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
        let (destino_tipo, destino_valor) = nueva.destino.to_columns();
        let body = json!({
            "tipo": nueva.tipo,
            "severidad": nueva.severidad.as_str(),
            "titulo": nueva.titulo,
            "cuerpo": nueva.cuerpo,
            "destino_tipo": destino_tipo,
            "destino_valor": destino_valor,
            "accion": nueva.accion,
            "payload": nueva.payload,
            "clave_dedupe": nueva.clave_dedupe,
            "expira_en": nueva.expira_en,
        });
        let r: CrearResp = self.client.post_json("/v1/notificaciones", &body).await?;
        Ok(r.id_notificacion)
    }

    async fn resolver_por_clave(&self, clave_dedupe: &str) -> AppResult<bool> {
        let body = json!({ "clave_dedupe": clave_dedupe });
        let _: JsonValue = self
            .client
            .post_json("/v1/notificaciones/resolver", &body)
            .await?;
        Ok(true)
    }
}
