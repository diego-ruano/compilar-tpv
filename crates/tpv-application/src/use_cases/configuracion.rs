//! Casos de uso de configuración (Local-First).

use serde_json::Value as JsonValue;

use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};

use tpv_domain::configuracion::validate_iva_percent;

use crate::error::{AppError, AppResult};
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
    // Si el patch trae `iva_percent`, validarlo antes de persistir: un IVA fuera de
    // rango o no numérico corromperia el cálculo de todos los tickets y precios.
    if let Some(iva) = patch.get("iva_percent") {
        if !iva.is_null() {
            let v = iva
                .as_f64()
                .or_else(|| iva.as_str().and_then(|s| s.parse::<f64>().ok()))
                .ok_or_else(|| AppError::validation("IVA inválido: no es un número"))?;
            validate_iva_percent(v).map_err(AppError::validation)?;
        }
    }
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
    // RI-60: puede quedar vacío si no se envían pedidos, pero nunca guardar un correo inválido.
    if let Some(value) = patch.get("contact_email") {
        let email = value.as_str().ok_or_else(|| AppError::validation("Correo de contacto inválido"))?.trim();
        if !email.is_empty() && (email.len() > 254 || !tpv_domain::login::validate_email_basic(email)) {
            return Err(AppError::validation("Correo de contacto inválido"));
        }
    }
    repo.patch_contact(&patch).await?;
    Ok("OK".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;
    #[async_trait]
    impl ConfiguracionRepository for RepoQueNoDebeLlamarse {
        async fn get_business(&self) -> AppResult<BusinessSettings> {
            panic!("repo llamado")
        }
        async fn get_ticket(&self) -> AppResult<TicketSettings> {
            panic!("repo llamado")
        }
        async fn get_contact(&self) -> AppResult<ContactSettings> {
            panic!("repo llamado")
        }
        async fn patch_business(&self, _: &JsonValue) -> AppResult<()> {
            panic!("repo llamado")
        }
        async fn patch_ticket(&self, _: &JsonValue) -> AppResult<()> {
            panic!("repo llamado")
        }
        async fn patch_contact(&self, _: &JsonValue) -> AppResult<()> {
            panic!("repo llamado")
        }
    }

    #[tokio::test]
    async fn patch_contact_rechaza_correo_invalido_sin_persistir() {
        for email in [serde_json::json!("no-es-correo"), serde_json::json!(true)] {
            assert!(matches!(patch_contact(&RepoQueNoDebeLlamarse, serde_json::json!({"contact_email": email})).await, Err(AppError::Validation(_))));
        }
    }

    #[tokio::test]
    async fn patch_business_rechaza_iva_no_numerico_sin_persistir() {
        let patch = serde_json::json!({"iva_percent": "abc"});
        assert!(matches!(
            patch_business(&RepoQueNoDebeLlamarse, patch).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn patch_business_rechaza_iva_fuera_de_rango() {
        let patch = serde_json::json!({"iva_percent": 101});
        assert!(matches!(
            patch_business(&RepoQueNoDebeLlamarse, patch).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn patch_business_rechaza_iva_negativo_y_booleano() {
        for patch in [serde_json::json!({"iva_percent": -0.01}), serde_json::json!({"iva_percent": true})] {
            assert!(matches!(patch_business(&RepoQueNoDebeLlamarse, patch).await, Err(AppError::Validation(_))));
        }
    }

    #[tokio::test]
    async fn patch_business_rechaza_infinito_codificado_como_texto() {
        let patch = serde_json::json!({"iva_percent": "inf"});
        assert!(matches!(patch_business(&RepoQueNoDebeLlamarse, patch).await, Err(AppError::Validation(_))));
    }
}
