//! Adaptador HTTP del repositorio de login/auth/fichaje (dominio `/v1/login` del worker).
//!
//! El PIN viaja al worker, que lo verifica server-side (nunca expone el hash). Por eso las
//! operaciones gruesas del puerto encajan 1:1 con los endpoints del worker.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::login::LoginRepository;
use tpv_contracts::login::{LoginOk, PunchStatus, UserListItem};

use crate::CloudClient;

pub struct HttpLoginRepository {
    client: Arc<CloudClient>,
}

impl HttpLoginRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl LoginRepository for HttpLoginRepository {
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
        self.client.get_json("/v1/login/users").await
    }

    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus> {
        self.client
            .get_json(&format!("/v1/login/{id_usuario}/punch-status"))
            .await
    }

    async fn login(&self, id_usuario: &str, pin: &str) -> AppResult<LoginOk> {
        self.client
            .post_json("/v1/login/login", &json!({ "id_usuario": id_usuario, "pin": pin }))
            .await
    }

    async fn complete_initial_setup(
        &self,
        id_usuario: &str,
        pin_actual: &str,
        pin_nuevo: &str,
        email_nuevo: &str,
    ) -> AppResult<()> {
        let body = json!({
            "id_usuario": id_usuario,
            "pin_actual": pin_actual,
            "pin_nuevo": pin_nuevo,
            "email_nuevo": email_nuevo,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/login/complete-initial-setup", &body)
            .await?;
        Ok(())
    }

    async fn punch(
        &self,
        id_usuario: &str,
        pin: &str,
        tipo: &str,
        fecha: Option<String>,
        hora_evento: Option<String>,
    ) -> AppResult<PunchStatus> {
        let body = json!({
            "id_usuario": id_usuario,
            "pin": pin,
            "tipo": tipo,
            "fecha": fecha,
            "hora_evento": hora_evento,
        });
        self.client.post_json("/v1/login/punch", &body).await
    }

    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()> {
        let body = json!({
            "id_usuario": id_usuario,
            "turno_partido": turno_partido,
            "fecha": fecha,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/login/turno-partido", &body)
            .await?;
        Ok(())
    }
}
