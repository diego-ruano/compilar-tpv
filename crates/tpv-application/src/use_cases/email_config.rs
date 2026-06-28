//! Casos de uso de configuración de correo.

use tpv_domain::email_config::EmailConfig;

use crate::error::{AppError, AppResult};
use crate::ports::email_config::EmailConfigRepository;

pub async fn get_config(repo: &dyn EmailConfigRepository) -> AppResult<EmailConfig> {
    repo.get().await
}

pub async fn patch_config(repo: &dyn EmailConfigRepository, config: EmailConfig) -> AppResult<()> {
    if config.modo != "managed" && config.modo != "smtp" {
        return Err(AppError::validation(format!(
            "modo inválido '{}': debe ser 'managed' o 'smtp'",
            config.modo
        )));
    }
    repo.patch(&config).await
}
