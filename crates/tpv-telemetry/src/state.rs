//! Estado compartido entre la capa de captura (`ForwardLayer`, dentro del subscriber global) y el
//! worker en segundo plano. Contiene el contexto de correlación y el buffer de staging en memoria.
//!
//! El buffer de staging es un anillo ACOTADO con política *drop-oldest*: protege el hilo caliente
//! (emisión de eventos) de cualquier atasco de E/S sin crecer sin límite en memoria. Es sólo una
//! antesala: el worker lo vacía a la cola durable en disco constantemente, así que en la práctica
//! casi nunca se llena (y si lo hace, los eventos descartados siguen en el fichero local rotado).

use std::collections::VecDeque;
use std::sync::{Mutex, RwLock};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Notify;

use crate::context::Context;
use crate::event::SpoolEvent;

const MAIN_MEMORY_BYTES: usize = 16 * 1024 * 1024;
const HANDY_MEMORY_BYTES: usize = 4 * 1024 * 1024;

struct QueuedEvent { event: Box<SpoolEvent>, bytes: usize }
struct Staging {
    queue: VecDeque<QueuedEvent>,
    // Incluye el evento extraído que sigue vivo durante la escritura.
    bytes: usize,
    in_flight: usize,
}

/// Reserva que vive hasta persistir o devolver el evento. No libera presupuesto al extraerlo.
pub(crate) struct PendingEvent<'a> {
    state: &'a TelemetryState,
    pending: Option<QueuedEvent>,
}

impl PendingEvent<'_> {
    pub(crate) fn event(&self) -> &SpoolEvent { &self.pending.as_ref().unwrap().event }

    pub(crate) fn retry(mut self) {
        let pending = self.pending.take().unwrap();
        let budget = self.state.budget();
        let mut staging = self.state.staging.lock().unwrap_or_else(|p| p.into_inner());
        staging.in_flight -= 1;
        staging.queue.push_front(pending);
        self.state.trim(&mut staging, budget, 0, 0);
        self.state.changed.notify_one();
    }
}

impl Drop for PendingEvent<'_> {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            let bytes = pending.bytes;
            drop(pending);
            let mut staging = self.state.staging.lock().unwrap_or_else(|p| p.into_inner());
            staging.bytes -= bytes;
            staging.in_flight -= 1;
        }
    }
}

pub(crate) struct TelemetryState {
    /// Etiquetas de correlación, actualizables en caliente (al emparejar/licenciar el dispositivo).
    pub(crate) context: RwLock<Context>,
    /// Antesala en memoria (drop-oldest) entre la captura y la persistencia en disco.
    staging: Mutex<Staging>,
    /// Tope del anillo de staging (nº de eventos).
    staging_cap: usize,
    table_bytes: usize,
    memory_limits: (usize, usize),
    pub(crate) changed: Notify,
    dropped: AtomicU64,
}

impl TelemetryState {
    pub(crate) fn new(context: Context, staging_cap: usize) -> Self {
        Self {
            context: RwLock::new(context),
            staging: Mutex::new(Staging { queue: VecDeque::with_capacity(staging_cap.min(256)), bytes: 0, in_flight: 0 }),
            staging_cap,
            // VecDeque crece a potencias de dos; reservar su máximo evita ignorar los huecos
            // que conserva al vaciarse. Los eventos van en Box para que cada hueco sea pequeño.
            table_bytes: staging_cap.checked_next_power_of_two().unwrap_or(usize::MAX)
                .saturating_mul(std::mem::size_of::<QueuedEvent>()),
            memory_limits: (MAIN_MEMORY_BYTES, HANDY_MEMORY_BYTES),
            changed: Notify::new(),
            dropped: AtomicU64::new(0),
        }
    }

    fn budget(&self) -> usize {
        let context = self.context.read().unwrap_or_else(|p| p.into_inner());
        let limit = if cfg!(target_os = "android") || context.device_mode == "handy" {
            self.memory_limits.1
        } else { self.memory_limits.0 };
        limit.saturating_sub(self.table_bytes)
    }

    fn trim(&self, staging: &mut Staging, budget: usize, extra_bytes: usize, extra_events: usize) {
        while staging.bytes.saturating_add(extra_bytes) > budget
            || staging.queue.len() + staging.in_flight + extra_events > self.staging_cap {
            let Some(oldest) = staging.queue.pop_front() else { break; };
            staging.bytes -= oldest.bytes;
            self.dropped.fetch_add(1, Ordering::Relaxed);
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
        let bytes = ev.memory_bytes();
        let budget = self.budget();
        if bytes > crate::capture::MAX_EVENT_MEMORY || bytes > budget || self.staging_cap == 0 {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.changed.notify_one();
            return;
        }
        let mut q = match self.staging.lock() {
            Ok(q) => q,
            Err(p) => p.into_inner(),
        };
        self.trim(&mut q, budget, bytes, 1);
        // El evento en escritura está protegido. Si ocupa todo el presupuesto, no encolar más.
        if q.bytes + bytes > budget || q.queue.len() + q.in_flight >= self.staging_cap {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            self.changed.notify_one();
            return;
        }
        let was_empty = q.queue.is_empty();
        q.bytes += bytes;
        q.queue.push_back(QueuedEvent { event: Box::new(ev), bytes });
        if was_empty {
            self.changed.notify_one();
        }
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.staging.lock().unwrap_or_else(|p| p.into_inner()).queue.len()
    }

    /// Extrae uno, manteniendo su cargo hasta que termina la escritura o el reintento.
    pub(crate) fn take(&self) -> Option<PendingEvent<'_>> {
        let budget = self.budget();
        let mut q = self.staging.lock().unwrap_or_else(|p| p.into_inner());
        self.trim(&mut q, budget, 0, 0);
        let pending = q.queue.pop_front()?;
        q.in_flight += 1;
        Some(PendingEvent { state: self, pending: Some(pending) })
    }

    /// Sólo para inspección de pruebas; el worker nunca crea una segunda cola de eventos.
    #[cfg(test)]
    pub(crate) fn drain(&self) -> Vec<SpoolEvent> {
        let mut q = match self.staging.lock() {
            Ok(q) => q,
            Err(p) => p.into_inner(),
        };
        let events: Vec<_> = q.queue.drain(..).collect();
        q.bytes -= events.iter().map(|e| e.bytes).sum::<usize>();
        events.into_iter().map(|e| *e.event).collect()
    }

    pub(crate) fn take_dropped(&self) -> u64 {
        self.dropped.swap(0, Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests;
