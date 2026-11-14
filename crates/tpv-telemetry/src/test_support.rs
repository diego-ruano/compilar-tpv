//! Utilidades de pruebas de persistencia y transporte (sin subscriber global).
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use crate::context::Context;
use crate::event::SpoolEvent;

static SEQ: AtomicU64 = AtomicU64::new(0);
pub(crate) struct TestDir(pub PathBuf);
impl TestDir {
    /// Una carpeta nueva y vacía en el temporal del sistema. Windows reutiliza los PID, así que el
    /// PID y el contador no bastan: la de un proceso anterior que no llegó a borrarla (uno que se
    /// cortó a medias) puede llamarse igual. Lleva también la hora en nanosegundos y, si aun así ya
    /// existe, se prueba otro nombre: nunca se reutiliza una que ya estaba.
    pub(crate) fn new() -> Self {
        let pid = std::process::id();
        loop {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let path = std::env::temp_dir().join(format!("tpv-telemetry-{pid}-{nanos}-{n}"));
            match std::fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("no se pudo crear la carpeta temporal {}: {e}", path.display()),
            }
        }
    }
}
impl Drop for TestDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
pub(crate) fn event(message: &str) -> SpoolEvent {
    SpoolEvent::new("INFO", "tpv::test", message.into(), Default::default(), &Context::new("test".into(), "dev".into()))
}
