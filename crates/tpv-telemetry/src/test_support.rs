//! Utilidades de pruebas de persistencia y transporte (sin subscriber global).
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use crate::context::Context;
use crate::event::SpoolEvent;

static SEQ: AtomicU64 = AtomicU64::new(0);
pub(crate) struct TestDir(pub PathBuf);
impl TestDir {
    pub(crate) fn new() -> Self {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("tpv-telemetry-{}-{n}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
pub(crate) fn event(message: &str) -> SpoolEvent {
    SpoolEvent::new("INFO", "tpv::test", message.into(), Default::default(), &Context::new("test".into(), "dev".into()))
}
