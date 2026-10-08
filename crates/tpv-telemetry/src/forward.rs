//! Capa `tracing` que captura los eventos hacia la cola de la nube.
//!
//! Es deliberadamente barata: extrae los campos del evento, toma un snapshot del contexto y empuja
//! a la antesala en memoria (drop-oldest). Toda la E/S real (disco, red) la hace el worker en otro
//! hilo. Sólo se reenvían a la nube eventos `INFO`/`WARN`/`ERROR`; `DEBUG`/`TRACE` se quedan en el
//! fichero local (no tiene sentido pagar ancho de banda por ruido de depuración).

use std::sync::Arc;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context as LayerContext;
use tracing_subscriber::Layer;

use crate::event::SpoolEvent;
use crate::state::TelemetryState;
use crate::capture::{self, CapturedText};

pub(crate) struct ForwardLayer {
    state: Arc<TelemetryState>,
}

impl ForwardLayer {
    pub(crate) fn new(state: Arc<TelemetryState>) -> Self {
        Self { state }
    }
}

/// Recolector de los campos del evento. El campo `message` se trata aparte (es el cuerpo del log);
/// el resto se serializan como un objeto JSON.
struct FieldVisitor {
    message: String,
    fields: Map<String, Value>,
    bytes: usize,
    truncated: bool,
}

impl FieldVisitor {
    fn new() -> Self {
        Self {
            message: String::new(),
            fields: Map::new(),
            bytes: 0,
            truncated: false,
        }
    }

    fn put(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            if let Value::String(s) = value {
                self.message = s;
            } else {
                self.message = value.to_string();
            }
        } else {
            let bytes = capture::MAP_ENTRY_BYTES + field.name().len() + capture::value_memory(&value);
            if field.name().len() > 256 || self.fields.len() >= capture::MAX_FIELDS
                || self.bytes + bytes > capture::FIELDS_BYTES {
                self.truncated = true;
                return;
            }
            self.bytes += bytes;
            self.fields.insert(field.name().to_string(), value);
        }
    }

    fn text(&mut self, field: &Field, args: std::fmt::Arguments<'_>) {
        let limit = if field.name() == "message" { capture::MESSAGE_BYTES } else { capture::FIELD_BYTES };
        let captured = CapturedText::format(args, limit);
        self.truncated |= captured.truncated;
        self.put(field, Value::String(captured.text));
    }
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.text(field, format_args!("{value:?}"));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.text(field, format_args!("{value}"));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::Bool(value));
    }
}

fn level_str(level: &Level) -> Option<&'static str> {
    match *level {
        Level::ERROR => Some("ERROR"),
        Level::WARN => Some("WARN"),
        Level::INFO => Some("INFO"),
        // DEBUG/TRACE no se reenvían a la nube (sólo quedan en el fichero local).
        Level::DEBUG | Level::TRACE => None,
    }
}

impl<S: Subscriber> Layer<S> for ForwardLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>) {
        let meta = event.metadata();
        // RI-19: los avisos de la propia cola quedan en el log local; reenviarlos realimentaría
        // una cola llena o un disco averiado con más eventos por cada fallo.
        if meta.target() == "tpv::telemetry" {
            return;
        }
        let Some(level) = level_str(meta.level()) else {
            return;
        };

        let mut visitor = FieldVisitor::new();
        event.record(&mut visitor);
        if visitor.truncated {
            visitor.fields.insert("telemetry_captura_recortada".into(), true.into());
        }

        let ctx = self.state.snapshot_context();
        let ev = SpoolEvent::new(level, meta.target(), visitor.message, visitor.fields, &ctx);
        self.state.push(ev);
    }
}

#[cfg(test)]
mod tests;
