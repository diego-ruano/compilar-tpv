//! Worker de telemetría: corre en un **hilo propio** con su mini-runtime tokio, aislado del runtime
//! de la app (la telemetría jamás debe competir con la UI del POS).
//!
//! Ciclo:
//! 1. Vacía la antesala en memoria → cola durable en disco (cada `DRAIN_INTERVAL`).
//! 2. Poda de seguridad de la cola.
//! 3. Si la subida está activa: sube **un lote (≤500) cada `UPLOAD_INTERVAL`** (throttling que evita
//!    el "efecto DDoS" al reconectar tras estar offline), con **backoff exponencial** ante fallos.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::config::IngestConfig;
use crate::spool;
use crate::state::TelemetryState;

/// Cada cuánto se vacía la antesala en memoria a disco.
const DRAIN_INTERVAL: Duration = Duration::from_secs(1);
/// Cadencia normal de subida: un lote (≤500 eventos) cada 10 s. Mantiene el goteo controlado.
const UPLOAD_INTERVAL: Duration = Duration::from_secs(10);
/// Backoff inicial y techo ante fallos de subida (offline, 5xx…).
const BACKOFF_MIN: Duration = Duration::from_secs(10);
const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// Tope de ficheros-lote en disco (≈ 500 eventos por fichero). Red de seguridad anti-llenado.
const MAX_SPOOL_FILES: usize = 4000;
/// Timeout de cada POST de subida.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct WorkerConfig {
    pub spool_dir: PathBuf,
    pub ingest: IngestConfig,
    pub state: Arc<TelemetryState>,
}

/// Punto de entrada del hilo: monta un runtime current-thread y corre el ciclo para siempre.
pub(crate) fn run(cfg: WorkerConfig) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return, // sin runtime no hay worker; el fichero local sigue funcionando igual.
    };
    rt.block_on(loop_forever(cfg));
}

async fn loop_forever(cfg: WorkerConfig) {
    let _ = spool::ensure_dir(&cfg.spool_dir);

    let client = reqwest::Client::builder()
        .timeout(UPLOAD_TIMEOUT)
        .build()
        .ok();

    let mut next_upload = Instant::now();
    let mut backoff = BACKOFF_MIN;

    loop {
        // 1) Antesala → disco (durable) + poda. Depuramos el contenido (OBS-01) aquí, en el hilo
        //    del worker (fuera del camino de emisión), ANTES de persistir/subir: así el fichero de
        //    spool y la subida a la nube ya salen redactados y nunca penalizamos al POS.
        let mut drained = cfg.state.drain();
        if !drained.is_empty() {
            for ev in drained.iter_mut() {
                ev.scrub_in_place();
            }
            let _ = spool::write_events(&cfg.spool_dir, &drained);
        }
        spool::prune(&cfg.spool_dir, MAX_SPOOL_FILES);

        // 2) Subida (si procede y toca según el throttling).
        if cfg.ingest.enabled && Instant::now() >= next_upload {
            if let Some(client) = client.as_ref() {
                match try_upload_one(client, &cfg.ingest, &cfg.spool_dir).await {
                    UploadOutcome::Sent => {
                        backoff = BACKOFF_MIN;
                        next_upload = Instant::now() + UPLOAD_INTERVAL;
                    }
                    // Nada que subir o aún no se puede firmar: reintento tranquilo.
                    UploadOutcome::Empty | UploadOutcome::CannotSign => {
                        next_upload = Instant::now() + UPLOAD_INTERVAL;
                    }
                    UploadOutcome::Failed => {
                        next_upload = Instant::now() + backoff;
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                    }
                }
            }
        }

        tokio::time::sleep(DRAIN_INTERVAL).await;
    }
}

enum UploadOutcome {
    Sent,
    Empty,
    CannotSign,
    Failed,
}

/// Sube el lote pendiente más antiguo. Sólo borra el fichero tras un 2xx (entrega confirmada).
async fn try_upload_one(
    client: &reqwest::Client,
    ingest: &IngestConfig,
    spool_dir: &std::path::Path,
) -> UploadOutcome {
    let batches = spool::list_batches(spool_dir);
    let Some(file) = batches.into_iter().next() else {
        return UploadOutcome::Empty;
    };

    let events = match spool::read_batch(&file) {
        Ok(e) if !e.is_empty() => e,
        // Fichero vacío o ilegible: lo retiramos para no atascar la cola.
        _ => {
            let _ = std::fs::remove_file(&file);
            return UploadOutcome::Empty;
        }
    };

    // Firma device-proof inyectada por el shell. Si aún no se puede firmar, retenemos el lote.
    let Some(signer) = ingest.signer.as_ref() else {
        return UploadOutcome::CannotSign;
    };

    // El cuerpo se serializa una vez: se firma y se envía tal cual (FABLE-E). Si fallara la
    // serialización el lote es basura, así que se descarta en vez de atascar la cola.
    let body = serde_json::json!({ "events": events });
    let Ok(body_bytes) = serde_json::to_vec(&body) else {
        let _ = std::fs::remove_file(&file);
        return UploadOutcome::Empty;
    };

    let Some(headers) = signer.sign("POST", &ingest.path, &body_bytes) else {
        return UploadOutcome::CannotSign;
    };

    let mut req = client
        .post(&ingest.url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body_bytes);
    for (k, v) in headers {
        req = req.header(k, v);
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let _ = std::fs::remove_file(&file);
            UploadOutcome::Sent
        }
        _ => UploadOutcome::Failed,
    }
}
