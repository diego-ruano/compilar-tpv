//! Adaptador HTTP del repositorio de configuración (dominio `/v1/configuracion` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_contracts::configuracion::{BusinessSettings, TicketSettings};

use crate::CloudClient;

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
        self.client.get_json("/v1/configuracion/business").await
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
}
