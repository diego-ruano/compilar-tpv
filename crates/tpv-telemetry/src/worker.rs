//! RI-19: persistencia y red comparten el runtime privado, pero no la misma espera.
//! El drenado continúa durante un POST lento; en reposo no hay sondeo periódico ni read_dir.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

use crate::config::IngestConfig;
use crate::spool::{self, Spool, UploadBatch, MAX_EVENTS_PER_BATCH};
use crate::state::TelemetryState;

const DRAIN_INTERVAL: Duration = Duration::from_secs(1);
const UPLOAD_INTERVAL: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(300);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(20);
const MAIN_SPOOL_BYTES: u64 = 256 * 1024 * 1024;
const HANDY_SPOOL_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) struct WorkerConfig {
    pub spool_dir: PathBuf,
    pub ingest: IngestConfig,
    pub state: Arc<TelemetryState>,
}

pub(crate) fn run(cfg: WorkerConfig) {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(_) => return,
    };
    rt.block_on(loop_forever(cfg));
}

fn spool_limit(state: &TelemetryState) -> u64 {
    if cfg!(target_os = "android") || state.snapshot_context().device_mode == "handy" {
        HANDY_SPOOL_BYTES
    } else { MAIN_SPOOL_BYTES }
}

async fn loop_forever(cfg: WorkerConfig) {
    let mut spool = loop {
        match Spool::open(&cfg.spool_dir) {
            Ok(spool) => break spool,
            Err(e) => {
                spool::report_io("abrir", &e);
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        }
    };
    prune(&mut spool, &cfg.state, None);
    let client = reqwest::Client::builder().timeout(UPLOAD_TIMEOUT).build().ok();
    let mut drain_at = None;
    let mut next_upload = Instant::now();
    let mut backoff = BACKOFF_MIN;
    let mut max_events = MAX_EVENTS_PER_BATCH;
    let mut task: Option<tokio::task::JoinHandle<UploadOutcome>> = None;
    let mut in_flight: Option<UploadBatch> = None;
    let mut seal_retry = None;

    loop {
        let seal_at = seal_retry.or_else(|| spool.deadline());
        let upload_at = (cfg.ingest.enabled && client.is_some() && task.is_none() && spool.has_pending())
            .then_some(next_upload);
        tokio::select! {
            // Sólo notificamos al pasar de vacío a no vacío y coalescemos durante un segundo.
            _ = cfg.state.changed.notified(), if drain_at.is_none() => {
                drain_at = Some(Instant::now() + DRAIN_INTERVAL);
            }
            _ = wait_until(drain_at) => {
                drain_at = None;
                // Acotar la vuelta aunque lleguen eventos continuamente. No extraer todo el
                // anillo a otro Vec: el evento en escritura sigue contando dentro del presupuesto.
                for _ in 0..cfg.state.pending_len() {
                    let Some(event) = cfg.state.take() else { break; };
                    if let Err(e) = spool.append(event.event()) {
                        spool::report_io("escribir", &e);
                        event.retry();
                        drain_at = Some(Instant::now() + BACKOFF_MIN);
                        break;
                    }
                    drop(event);
                    prune(&mut spool, &cfg.state, in_flight.as_ref());
                }
                if drain_at.is_none() && cfg.state.pending_len() > 0 {
                    drain_at = Some(Instant::now() + DRAIN_INTERVAL);
                }
                let dropped = cfg.state.take_dropped();
                if dropped > 0 {
                    tracing::warn!(target: "tpv::telemetry", descartados = dropped, "antesala de telemetría llena");
                }
            }
            _ = wait_until(seal_at) => {
                match spool.seal() {
                    Ok(()) => seal_retry = None,
                    Err(e) => {
                        spool::report_io("sellar", &e);
                        seal_retry = Some(Instant::now() + BACKOFF_MIN);
                    }
                }
            }
            _ = wait_until(upload_at) => {
                match spool.prepare(max_events) {
                    Ok(Some(mut batch)) => {
                        let body = std::mem::take(&mut batch.body);
                        in_flight = Some(batch);
                        task = Some(tokio::spawn(upload(
                            client.as_ref().unwrap().clone(), cfg.ingest.clone(), body,
                        )));
                    }
                    Ok(None) => next_upload = Instant::now() + UPLOAD_INTERVAL,
                    Err(e) => {
                        spool::report_io("leer", &e);
                        next_upload = Instant::now() + BACKOFF_MIN;
                    }
                }
            }
            result = finish(&mut task), if task.is_some() => {
                task = None;
                let batch = in_flight.take().unwrap();
                match result {
                    UploadOutcome::Sent => {
                        if let Err(e) = spool.acknowledge(&batch) { spool::report_io("confirmar", &e); }
                        backoff = BACKOFF_MIN;
                        max_events = MAX_EVENTS_PER_BATCH;
                        next_upload = Instant::now() + jitter(UPLOAD_INTERVAL);
                    }
                    UploadOutcome::Rejected => {
                        // Sólo 400/413/422: dividir hasta aislar el evento inválido. Un 401/403,
                        // 429 o 5xx conserva TODOS los eventos y activa backoff.
                        if batch.events == 1 {
                            tracing::warn!(target: "tpv::telemetry", descartados = 1, "evento de telemetría rechazado permanentemente");
                            if let Err(e) = spool.acknowledge(&batch) { spool::report_io("aislar", &e); }
                            max_events = MAX_EVENTS_PER_BATCH;
                        } else { max_events = (batch.events / 2).max(1); }
                        next_upload = Instant::now() + jitter(UPLOAD_INTERVAL);
                    }
                    UploadOutcome::CannotSign => next_upload = Instant::now() + Duration::from_secs(60),
                    UploadOutcome::Failed => {
                        next_upload = Instant::now() + jitter(backoff);
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                    }
                }
                prune(&mut spool, &cfg.state, None);
            }
        }
    }
}

fn prune(spool: &mut Spool, state: &TelemetryState, batch: Option<&UploadBatch>) {
    match spool.prune(spool_limit(state), batch) {
        Ok(bytes) if bytes > 0 => tracing::warn!(
            target: "tpv::telemetry", bytes_descartados = bytes,
            "cola de telemetría podada al superar el presupuesto de disco"
        ),
        Err(e) => spool::report_io("podar", &e),
        _ => {}
    }
}

async fn wait_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
async fn finish(task: &mut Option<tokio::task::JoinHandle<UploadOutcome>>) -> UploadOutcome {
    match task.as_mut() {
        Some(task) => task.await.unwrap_or(UploadOutcome::Failed),
        None => std::future::pending().await,
    }
}

// Variación positiva de hasta 1 s, sin dependencia ni estado global aleatorio.
fn jitter(duration: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    duration + Duration::from_millis(u64::from(nanos % 1000))
}

#[derive(Debug, PartialEq, Eq)]
enum UploadOutcome { Sent, CannotSign, Rejected, Failed }

async fn upload(client: reqwest::Client, ingest: IngestConfig, body: Vec<u8>) -> UploadOutcome {
    let Some(signer) = ingest.signer.as_ref() else { return UploadOutcome::CannotSign; };
    let Some(headers) = signer.sign("POST", &ingest.path, &body) else { return UploadOutcome::CannotSign; };
    // FABLE-E: el cuerpo firmado es exactamente el que se envía.
    let mut request = client.post(&ingest.url)
        .header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
    for (k, v) in headers { request = request.header(k, v); }
    match request.send().await {
        Ok(response) if response.status().is_success() => UploadOutcome::Sent,
        Ok(response) if matches!(response.status().as_u16(), 400 | 413 | 422) => UploadOutcome::Rejected,
        _ => UploadOutcome::Failed,
    }
}

#[cfg(test)]
mod tests;
