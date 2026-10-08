//! RI-19: límites durante la captura, antes de copiar/formatear texto hacia la antesala.
use std::fmt::{self, Write};
use serde_json::Value;

pub(crate) const MESSAGE_BYTES: usize = 4000;
pub(crate) const FIELD_BYTES: usize = 4096;
pub(crate) const FIELDS_BYTES: usize = 32 * 1024;
pub(crate) const MAX_FIELDS: usize = 64;
pub(crate) const MAX_EVENT_MEMORY: usize = 64 * 1024;
// Cargo conservador para asignaciones de los nodos del mapa JSON (incluidos huecos).
pub(crate) const MAP_ENTRY_BYTES: usize = 1024;
pub(crate) const ALLOCATION_MARGIN: usize = 32;

pub(crate) fn prefix(input: &str, limit: usize) -> &str {
    let mut end = input.len().min(limit);
    while !input.is_char_boundary(end) { end -= 1; }
    &input[..end]
}

pub(crate) struct CapturedText {
    pub(crate) text: String,
    pub(crate) truncated: bool,
    limit: usize,
}

impl CapturedText {
    pub(crate) fn format(args: fmt::Arguments<'_>, limit: usize) -> Self {
        let mut output = Self { text: String::with_capacity(limit.min(256)), truncated: false, limit };
        // Un formateador normal propaga el error: no se construye primero la cadena completa.
        if fmt::write(&mut output, args).is_err() { output.truncated = true; }
        output.text.shrink_to_fit();
        output
    }
}

impl Write for CapturedText {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let part = prefix(text, self.limit.saturating_sub(self.text.len()));
        self.text.push_str(part);
        if part.len() < text.len() { self.truncated = true; Err(fmt::Error) } else { Ok(()) }
    }
}

pub(crate) fn value_memory(value: &Value) -> usize {
    match value {
        Value::String(text) => text.capacity() + ALLOCATION_MARGIN,
        Value::Array(items) => items.capacity() * std::mem::size_of::<Value>()
            + ALLOCATION_MARGIN + items.iter().map(value_memory).sum::<usize>(),
        Value::Object(map) => map.iter().map(|(key, value)|
            MAP_ENTRY_BYTES + key.capacity() + value_memory(value)
        ).sum(),
        _ => 0,
    }
}
