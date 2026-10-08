use super::*;
use crate::context::Context;
use std::sync::atomic::{AtomicUsize, Ordering};
use tracing_subscriber::prelude::*;

#[test]
fn la_captura_acota_texto_utf8_y_campos_antes_de_encolarlos() {
    let state = Arc::new(TelemetryState::new(Context::new("test".into(), "dev".into()), 10));
    let subscriber = tracing_subscriber::registry().with(ForwardLayer::new(state.clone()));
    let huge = "💶".repeat(100_000);
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(detalle = %huge, otro = huge.as_str(), "{}", huge);
    });
    let events = state.drain();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert!(event.message.len() <= capture::MESSAGE_BYTES);
    assert!(event.fields["detalle"].as_str().unwrap().len() <= capture::FIELD_BYTES);
    assert!(event.fields["otro"].as_str().unwrap().len() <= capture::FIELD_BYTES);
    assert_eq!(event.fields["telemetry_captura_recortada"], true);
    assert!(event.memory_bytes() <= capture::MAX_EVENT_MEMORY);
}

#[test]
fn un_debug_enorme_se_interrumpe_sin_construir_la_cadena_completa() {
    struct Huge<'a>(&'a AtomicUsize);
    impl std::fmt::Debug for Huge<'_> {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            for _ in 0..1_000_000 {
                self.0.fetch_add(1, Ordering::Relaxed);
                f.write_str("dato ")?;
            }
            Ok(())
        }
    }
    let written = AtomicUsize::new(0);
    let state = Arc::new(TelemetryState::new(Context::new("test".into(), "dev".into()), 10));
    let subscriber = tracing_subscriber::registry().with(ForwardLayer::new(state.clone()));
    tracing::subscriber::with_default(subscriber, || tracing::info!(detalle = ?Huge(&written), "diagnóstico"));
    assert!(written.load(Ordering::Relaxed) < 1000);
    assert_eq!(state.drain()[0].message, "diagnóstico");
}

#[test]
fn muchos_campos_se_acotan_en_conjunto_con_un_marcador() {
    let state = Arc::new(TelemetryState::new(Context::new("test".into(), "dev".into()), 10));
    let subscriber = tracing_subscriber::registry().with(ForwardLayer::new(state.clone()));
    let text = "x".repeat(capture::FIELD_BYTES);
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(a = text.as_str(), b = text.as_str(), c = text.as_str(), d = text.as_str(),
            e = text.as_str(), f = text.as_str(), g = text.as_str(), h = text.as_str(), "diagnóstico");
    });
    let events = state.drain();
    assert_eq!(events.len(), 1);
    assert!(events[0].fields.len() < 8);
    assert_eq!(events[0].fields["telemetry_captura_recortada"], true);
    assert!(events[0].memory_bytes() <= capture::MAX_EVENT_MEMORY);
}

#[test]
fn los_secretos_recortados_en_la_captura_no_llegan_al_spool_ni_a_la_subida() {
    let state = Arc::new(TelemetryState::new(Context::new("test".into(), "dev".into()), 10));
    let subscriber = tracing_subscriber::registry().with(ForwardLayer::new(state.clone()));
    let secret = format!("{{\"password\":\"{}\"}}", "hunter2".repeat(10_000));
    tracing::subscriber::with_default(subscriber, || tracing::info!(detalle = secret.as_str(), "{}", secret));
    let dir = crate::test_support::TestDir::new();
    let mut spool = crate::spool::Spool::open(&dir.0).unwrap();
    for event in state.drain() { spool.append(&event).unwrap(); }
    spool.seal().unwrap();
    let batch = spool.prepare(500).unwrap().unwrap();
    let body = String::from_utf8(batch.body).unwrap();
    assert!(!body.contains("hunter2"));
    assert!(body.contains("[redacted]"));
    for file in std::fs::read_dir(&dir.0).unwrap() {
        assert!(!std::fs::read_to_string(file.unwrap().path()).unwrap().contains("hunter2"));
    }
}
