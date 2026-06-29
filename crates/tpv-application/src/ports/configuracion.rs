//! Puerto de persistencia de configuración (business + ticket settings).

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};

use crate::error::AppResult;

#[async_trait]
pub trait ConfiguracionRepository: Send + Sync {
    async fn get_business(&self) -> AppResult<BusinessSettings>;
    async fn get_ticket(&self) -> AppResult<TicketSettings>;
    async fn get_contact(&self) -> AppResult<ContactSettings>;
    async fn patch_business(&self, patch: &JsonValue) -> AppResult<()>;
    async fn patch_ticket(&self, patch: &JsonValue) -> AppResult<()>;
    async fn patch_contact(&self, patch: &JsonValue) -> AppResult<()>;
}
