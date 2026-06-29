//! Casos de uso de configuración (Local-First).

use serde_json::Value as JsonValue;

use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};

use crate::error::AppResult;
use crate::ports::configuracion::ConfiguracionRepository;

pub async fn get_business(repo: &dyn ConfiguracionRepository) -> AppResult<BusinessSettings> {
    repo.get_business().await
}

pub async fn get_ticket(repo: &dyn ConfiguracionRepository) -> AppResult<TicketSettings> {
    repo.get_ticket().await
}

pub async fn patch_business(
    repo: &dyn ConfiguracionRepository,
    patch: JsonValue,
) -> AppResult<String> {
    repo.patch_business(&patch).await?;
    Ok("OK".to_string())
}

pub async fn patch_ticket(
    repo: &dyn ConfiguracionRepository,
    patch: JsonValue,
) -> AppResult<String> {
    repo.patch_ticket(&patch).await?;
    Ok("OK".to_string())
}

pub async fn get_contact(repo: &dyn ConfiguracionRepository) -> AppResult<ContactSettings> {
    repo.get_contact().await
}

pub async fn patch_contact(
    repo: &dyn ConfiguracionRepository,
    patch: JsonValue,
) -> AppResult<String> {
    repo.patch_contact(&patch).await?;
    Ok("OK".to_string())
}
