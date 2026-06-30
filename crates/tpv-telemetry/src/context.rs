//! Contexto de correlación: las etiquetas globales que acompañan a cada evento (`tenant_id`,
//! `device_id`, `device_mode`, `app_version`, `environment`).
//!
//! El contexto vive en el [`crate::state::TelemetryState`] tras un `RwLock`. Al arrancar sólo se
//! conoce `app_version`/`environment`; el resto se rellena en cuanto el dispositivo se identifica
//! (pairing/licencia). Hasta entonces se usan marcadores (`unknown`/`unset`) para que el logging
//! del arranque NUNCA se bloquee por falta de identidad.

/// Snapshot inmutable que se adjunta a cada evento capturado.
#[derive(Debug, Clone)]
pub(crate) struct Context {
    pub app_version: String,
    pub environment: String,
    pub device_id: String,
    pub device_mode: String,
    pub tenant_id: String,
}

impl Context {
    pub(crate) fn new(app_version: String, environment: String) -> Self {
        Self {
            app_version,
            environment,
            device_id: "unknown".to_string(),
            device_mode: "unset".to_string(),
            tenant_id: "unknown".to_string(),
        }
    }
}
