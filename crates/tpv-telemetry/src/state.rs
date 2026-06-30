//! Estado compartido entre la capa de captura (`ForwardLayer`, dentro del subscriber global) y el
//! worker en segundo plano. Contiene el contexto de correlación y el buffer de staging en memoria.
//!
//! El buffer de staging es un anillo ACOTADO con política *drop-oldest*: protege el hilo caliente
//! (emisión de eventos) de cualquier atasco de E/S sin crecer sin límite en memoria. Es sólo una
//! antesala: el worker lo vacía a la cola durable en disco constantemente, así que en la práctica
//! casi nunca se llena (y si lo hace, los eventos descartados siguen en el fichero local rotado).

use std::collections::VecDeque;
use std::sync::{Mutex, RwLock};

use crate::context::Context;
use crate::event::SpoolEvent;

pub(crate) struct TelemetryState {
    /// Etiquetas de correlación, actualizables en caliente (al emparejar/licenciar el dispositivo).
    pub(crate) context: RwLock<Context>,
    /// Antesala en memoria (drop-oldest) entre la captura y la persistencia en disco.
    staging: Mutex<VecDeque<SpoolEvent>>,
    /// Tope del anillo de staging (nº de eventos).
    staging_cap: usize,
}

impl TelemetryState {
    pub(crate) fn new(context: Context, staging_cap: usize) -> Self {
        Self {
            context: RwLock::new(context),
            staging: Mutex::new(VecDeque::with_capacity(256)),
            staging_cap,
        }
    }

    /// Snapshot barato del contexto actual (lectura concurrente).
    pub(crate) fn snapshot_context(&self) -> Context {
        self.context
            .read()
            .map(|c| c.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    /// Encola un evento en la antesala. Si el anillo está lleno, descarta el más antiguo
    /// (drop-oldest) para no bloquear nunca al emisor.
    pub(crate) fn push(&self, ev: SpoolEvent) {
        let mut q = match self.staging.lock() {
            Ok(q) => q,
            Err(p) => p.into_inner(),
        };
        while q.len() >= self.staging_cap {
            q.pop_front();
        }
        q.push_back(ev);
    }

    /// Extrae todos los eventos acumulados (los toma el worker para volcarlos a disco).
    pub(crate) fn drain(&self) -> Vec<SpoolEvent> {
        let mut q = match self.staging.lock() {
            Ok(q) => q,
            Err(p) => p.into_inner(),
        };
        q.drain(..).collect()
    }
}
