//! Puerto de persistencia de configuración (business + ticket settings).

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use tpv_contracts::configuracion::{BusinessSettings, TicketSettings};

use crate::error::AppResult;

#[async_trait]
pub trait ConfiguracionRepository: Send + Sync {
    async fn get_business(&self) -> AppResult<BusinessSettings>;
    async fn get_ticket(&self) -> AppResult<TicketSettings>;
    /// Aplica un patch parcial a los ajustes de negocio.
    async fn patch_business(&self, patch: &JsonValue) -> AppResult<()>;
    /// Aplica un patch parcial a los ajustes de ticket.
    async fn patch_ticket(&self, patch: &JsonValue) -> AppResult<()>;
}
