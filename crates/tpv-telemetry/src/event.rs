//! Forma serializable de un evento de log capturado, tal cual se persiste en la cola durable y se
//! sube al worker. El esquema (nombres de campo) se mantiene en paralelo con el paquete TS
//! compartido `@tpv/observability` para que nube y dispositivo hablen el mismo idioma.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::context::Context;

/// Un evento de log estructurado, ya enriquecido con el contexto de correlación del momento en que
/// se emitió.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpoolEvent {
    /// Marca temporal RFC3339 (UTC) de captura.
    pub ts: String,
    /// Severidad: `ERROR` | `WARN` | `INFO`.
    pub level: String,
    /// `target` del evento (módulo Rust que lo emitió).
    pub target: String,
    /// Mensaje principal (campo `message` de la macro `tracing`).
    pub message: String,
    /// Campos estructurados adicionales del evento.
    pub fields: Map<String, Value>,

    // ── Contexto de correlación (snapshot) ──
    pub device_id: String,
    pub device_mode: String,
    pub tenant_id: String,
    pub app_version: String,
    pub environment: String,
}

impl SpoolEvent {
    pub(crate) fn new(
        level: &'static str,
        target: &str,
        message: String,
        fields: Map<String, Value>,
        ctx: &Context,
    ) -> Self {
        Self {
            ts: chrono::Utc::now().to_rfc3339(),
            level: level.to_string(),
            target: target.to_string(),
            message,
            fields,
            device_id: ctx.device_id.clone(),
            device_mode: ctx.device_mode.clone(),
            tenant_id: ctx.tenant_id.clone(),
            app_version: ctx.app_version.clone(),
            environment: ctx.environment.clone(),
        }
    }
}
