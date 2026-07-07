//! Forma serializable de un evento de log capturado, tal cual se persiste en la cola durable y se
//! sube al worker.
//!
//! **Fuente única de verdad del esquema (OBS-05):** este struct deriva `ts_rs::TS` y **genera** el
//! tipo TypeScript `SpoolEvent` en `packages/contracts/src/generated/telemetry.ts` (re-exportado por
//! `@tpv/contracts`). El worker que ingiere estos eventos (`telemetry.routes.ts`) valida su `zod`
//! contra ese tipo generado, de modo que un cambio de campo aquí rompe la compilación allí en vez de
//! derivar en silencio. Regenerar con `cargo test -p tpv-telemetry export_bindings` (parte de
//! `pnpm generate-types`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::context::Context;
use crate::scrub;

/// Un evento de log estructurado, ya enriquecido con el contexto de correlación del momento en que
/// se emitió.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/telemetry.ts")]
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
    #[ts(type = "Record<string, unknown>")]
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

    /// Redacta (OBS-01) el contenido libre del evento —`message` y valores de `fields`— antes de
    /// que salga a un tercero. Los campos de correlación (device/tenant/version/entorno) son
    /// identificadores propios y no se tocan. Se aplica en el worker de subida (hilo aparte), no en
    /// el camino de emisión, para no penalizar al POS.
    pub(crate) fn scrub_in_place(&mut self) {
        self.message = scrub::scrub(&self.message);
        scrub::scrub_map(&mut self.fields);
    }
}
