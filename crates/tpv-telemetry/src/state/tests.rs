use super::*;
use crate::context::Context;
use crate::test_support::event as sample_event;

fn event(message: &str) -> SpoolEvent {
    let mut event = sample_event(message);
    event.ts = "2026-10-08T10:00:00Z".into();
    event
}

fn state(cap: usize, bytes: usize) -> TelemetryState {
    let mut state = TelemetryState::new(Context::new("test".into(), "dev".into()), cap);
    state.memory_limits = (bytes, bytes);
    state
}

fn messages(state: &TelemetryState) -> Vec<String> {
    state.drain().into_iter().map(|e| e.message).collect()
}

#[test]
fn el_limite_por_bytes_descarta_lo_mas_antiguo_antes_del_limite_de_eventos() {
    let payload = "x".repeat(2000);
    let cost = event(&payload).memory_bytes();
    let table = state(10, usize::MAX).table_bytes;
    let state = state(10, table + 2 * cost);
    for _ in 0..3 { state.push(event(&payload)); }
    assert_eq!(state.pending_len(), 2);
    assert_eq!(state.take_dropped(), 1);
    assert_eq!(state.staging.lock().unwrap().bytes, 2 * cost);
}

#[test]
fn el_evento_extraido_sigue_contando_mientras_entran_nuevos() {
    let cost = event("antiguo").memory_bytes();
    let table = state(10, usize::MAX).table_bytes;
    let state = state(10, table + 2 * cost);
    state.push(event("antiguo"));
    state.push(event("segundo"));
    let active = state.take().unwrap();
    assert_eq!(state.staging.lock().unwrap().bytes, 2 * cost);
    state.push(event("tercero"));
    assert_eq!(active.event().message, "antiguo");
    assert!(state.staging.lock().unwrap().bytes <= state.budget());
    assert_eq!(state.take_dropped(), 1);
    drop(active);
    assert_eq!(messages(&state), ["tercero"]);
    assert_eq!(state.staging.lock().unwrap().bytes, 0);
}

#[test]
fn un_fallo_de_escritura_devuelve_el_evento_en_orden_sin_doblar_su_cargo() {
    let state = state(3, 1024 * 1024);
    state.push(event("primero"));
    state.push(event("segundo"));
    let before = state.staging.lock().unwrap().bytes;
    let active = state.take().unwrap();
    assert_eq!(state.staging.lock().unwrap().bytes, before);
    state.push(event("tercero"));
    let with_new = state.staging.lock().unwrap().bytes;
    active.retry();
    assert_eq!(state.staging.lock().unwrap().bytes, with_new);
    assert_eq!(messages(&state), ["primero", "segundo", "tercero"]);
    assert_eq!(state.staging.lock().unwrap().bytes, 0);
    assert_eq!(state.take_dropped(), 0);
}

#[cfg(not(target_os = "android"))]
#[test]
fn cambiar_a_handy_y_reintentar_poda_sin_superar_su_presupuesto() {
    let cost = event("primero").memory_bytes();
    let mut state = state(3, usize::MAX);
    state.memory_limits = (state.table_bytes + 3 * cost, state.table_bytes + 2 * cost);
    for name in ["primero", "segundo", "tercero"] { state.push(event(name)); }
    let active = state.take().unwrap();
    state.context.write().unwrap().device_mode = "handy".into();
    active.retry();
    assert_eq!(state.take_dropped(), 1);
    assert!(state.staging.lock().unwrap().bytes <= state.budget());
    assert_eq!(messages(&state), ["segundo", "tercero"]);
}

#[test]
fn el_tope_por_evento_y_una_cola_deshabilitada_no_crecen_ni_se_bloquean() {
    let state = state(10, 1024 * 1024);
    state.push(event(&"x".repeat(crate::capture::MAX_EVENT_MEMORY * 2)));
    assert_eq!(state.pending_len(), 0);
    assert_eq!(state.take_dropped(), 1);
    let disabled = super::TelemetryState::new(Context::new("test".into(), "dev".into()), 0);
    disabled.push(event("descartar"));
    assert_eq!(disabled.pending_len(), 0);
    assert_eq!(disabled.take_dropped(), 1);
}

#[tokio::test]
async fn tambien_respeta_el_maximo_de_eventos_y_no_pierde_las_notificaciones() {
    let state = state(2, 1024 * 1024);
    for name in ["primero", "segundo", "tercero"] { state.push(event(name)); }
    assert_eq!(state.take_dropped(), 1);
    state.changed.notified().await;
    assert_eq!(messages(&state), ["segundo", "tercero"]);
    state.push(event("nuevo"));
    assert_eq!(state.pending_len(), 1);
    // Notify conserva el permiso aun si el worker todavía no estaba esperando.
    assert!(tokio::time::timeout(std::time::Duration::from_millis(100), state.changed.notified()).await.is_ok());
}

#[test]
fn productores_concurrentes_respetan_la_reserva_durante_el_reintento() {
    let state = state(100, 64 * 1024);
    state.push(event("en escritura"));
    let active = state.take().unwrap();
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..100 { state.push(event(&"x".repeat(2000))); }
            });
        }
    });
    {
        let q = state.staging.lock().unwrap();
        assert_eq!(q.bytes, active.pending.as_ref().unwrap().bytes + q.queue.iter().map(|e| e.bytes).sum::<usize>());
        assert!(q.bytes <= state.budget());
        assert!(q.queue.len() + q.in_flight <= state.staging_cap);
    }
    active.retry();
    assert!(state.take_dropped() > 0);
    assert_eq!(state.staging.lock().unwrap().in_flight, 0);
    assert_eq!(messages(&state)[0], "en escritura");
}

#[test]
fn handy_y_android_tienen_el_presupuesto_reducido_incluso_sin_identidad() {
    let state = TelemetryState::new(Context::new("test".into(), "dev".into()), 20_000);
    let initial = if cfg!(target_os = "android") { HANDY_MEMORY_BYTES } else { MAIN_MEMORY_BYTES };
    assert_eq!(state.budget() + state.table_bytes, initial);
    state.context.write().unwrap().device_mode = "handy".into();
    assert_eq!(state.budget() + state.table_bytes, HANDY_MEMORY_BYTES);
}
