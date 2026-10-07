//! nextest aísla cada prueba en su proceso: subscriber y logger son globales.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use crate::{TelemetryConfig, GUARD, STATE};
use crate::test_support::TestDir;

struct ExistingLogger(AtomicUsize);
impl log::Log for ExistingLogger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
    fn log(&self, _: &log::Record<'_>) { self.0.fetch_add(1, Ordering::Relaxed); }
    fn flush(&self) {}
}
static EXISTING: ExistingLogger = ExistingLogger(AtomicUsize::new(0));

fn start(dir: &TestDir) {
    let mut cfg = TelemetryConfig::local_only(dir.0.clone(), "test");
    cfg.console = false;
    crate::init(cfg).unwrap();
    assert!(GUARD.get().is_some());
    assert!(STATE.get().is_some());
}

fn wait_for_log(dir: &TestDir, message: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let found = std::fs::read_dir(dir.0.join("logs")).unwrap().any(|entry| {
            std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default().contains(message)
        });
        if found { return; }
        assert!(Instant::now() < deadline, "no llegó el mensaje al fichero local");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn un_logger_previo_no_deja_la_telemetria_a_medias() {
    log::set_logger(&EXISTING).unwrap();
    log::set_max_level(log::LevelFilter::Info);
    tracing::warn!("diagnóstico antes del subscriber");
    assert_eq!(EXISTING.0.load(Ordering::Relaxed), 1);
    let dir = TestDir::new();
    start(&dir);
    tracing::info!("subscriber y appender activos");
    wait_for_log(&dir, "subscriber y appender activos");
    let second = TelemetryConfig::local_only(dir.0.clone(), "test");
    assert!(crate::init(second).is_err());
    tracing::info!("el segundo init conserva el primer appender");
    wait_for_log(&dir, "el segundo init conserva el primer appender");
}

#[test]
fn log_de_dependencias_llega_a_los_destinos_de_tracing_en_escritorio() {
    let dir = TestDir::new();
    start(&dir);
    log::warn!(target: "tpv::test", "dependencia externa a tracing");
    wait_for_log(&dir, "dependencia externa a tracing");
    assert!(STATE.get().unwrap().drain().iter()
        .any(|event| event.message == "dependencia externa a tracing"));
}
