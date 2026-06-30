//! Cola DURABLE en disco: un directorio de ficheros-lote `*.jsonl` (un evento por línea).
//!
//! Diseño elegido (en vez de una segunda BD): es crash-safe (se escribe a `.tmp` y se renombra de
//! forma atómica), trivial de subir y borrar por lotes (un fichero = un lote ≤ N eventos) y se
//! acota solo podando los más antiguos. Una vez que un evento aterriza aquí, "no se pierde" hasta
//! que se sube con éxito (el fichero se borra sólo tras un 2xx del worker).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::event::SpoolEvent;

/// Nº máximo de eventos por fichero-lote (== tamaño de lote de subida).
pub(crate) const MAX_EVENTS_PER_BATCH: usize = 500;

/// Contador en proceso para desempatar nombres de fichero creados en el mismo milisegundo.
static SEQ: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Asegura que el directorio de spool existe.
pub(crate) fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

/// Persiste `events` en uno o más ficheros-lote (troceando en grupos de `MAX_EVENTS_PER_BATCH`).
pub(crate) fn write_events(dir: &Path, events: &[SpoolEvent]) -> std::io::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    ensure_dir(dir)?;
    for chunk in events.chunks(MAX_EVENTS_PER_BATCH) {
        write_one_batch(dir, chunk)?;
    }
    Ok(())
}

fn write_one_batch(dir: &Path, chunk: &[SpoolEvent]) -> std::io::Result<()> {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = format!("{:013}-{:08}", now_millis(), seq);
    let tmp = dir.join(format!("{stem}.jsonl.tmp"));
    let final_path = dir.join(format!("{stem}.jsonl"));

    {
        let mut f = fs::File::create(&tmp)?;
        for ev in chunk {
            // Si un evento no serializa (no debería), se omite en vez de tumbar el lote entero.
            if let Ok(line) = serde_json::to_string(ev) {
                f.write_all(line.as_bytes())?;
                f.write_all(b"\n")?;
            }
        }
        f.flush()?;
    }

    fs::rename(&tmp, &final_path)
}

/// Lista los ficheros-lote pendientes, ordenados de más antiguo a más reciente (el nombre empieza
/// por el timestamp, así que el orden lexicográfico == orden cronológico).
pub(crate) fn list_batches(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "jsonl").unwrap_or(false))
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files
}

/// Lee y parsea un fichero-lote. Las líneas corruptas se ignoran.
pub(crate) fn read_batch(path: &Path) -> std::io::Result<Vec<SpoolEvent>> {
    let txt = fs::read_to_string(path)?;
    let events = txt
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<SpoolEvent>(l).ok())
        .collect();
    Ok(events)
}

/// Poda de seguridad: si hay más de `max_files` ficheros-lote acumulados (dispositivo offline
/// mucho tiempo o subida rota), borra los más antiguos. El usuario eligió "no perder ninguno", así
/// que el tope es generoso; esto es sólo una red para no llenar el disco si algo va muy mal.
pub(crate) fn prune(dir: &Path, max_files: usize) {
    let files = list_batches(dir);
    if files.len() <= max_files {
        return;
    }
    let exceso = files.len() - max_files;
    for path in files.into_iter().take(exceso) {
        let _ = fs::remove_file(path);
    }
}
