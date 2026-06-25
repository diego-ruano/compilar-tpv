//! Puerto de persistencia de configuración de correo.

use async_trait::async_trait;

use tpv_domain::email_config::EmailConfig;

use crate::error::AppResult;

#[async_trait]
pub trait EmailConfigRepository: Send + Sync {
    async fn get(&self) -> AppResult<EmailConfig>;
    async fn patch(&self, config: &EmailConfig) -> AppResult<()>;
}
