//! RI-19: segmentos JSONL en disco, inventario en memoria y confirmación por offset.
//! Sin fsync: recuperamos tras una caída del proceso, sin garantía ante cortes de corriente.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

use crate::event::SpoolEvent;

pub(crate) const MAX_EVENTS_PER_BATCH: usize = 500;
// Incluye envoltorio y comas del JSON; la mitad del MiB que admite el servidor (AUD-32).
pub(crate) const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_EVENT_BYTES: usize = 128 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const SEGMENT_AGE: Duration = Duration::from_secs(60);
static SEQ: AtomicU64 = AtomicU64::new(0);

struct PendingFile { bytes: u64, offset: u64, ack_bytes: u64 }
struct ActiveFile { path: PathBuf, file: File, bytes: u64, events: usize, since: Instant }

pub(crate) struct UploadBatch {
    pub body: Vec<u8>,
    pub events: usize,
    consumed: Vec<(PathBuf, u64)>,
}
impl UploadBatch {
    pub(crate) fn contains(&self, path: &Path) -> bool {
        self.consumed.iter().any(|(p, _)| p == path)
    }
}

pub(crate) struct Spool {
    dir: PathBuf,
    pending: BTreeMap<PathBuf, PendingFile>,
    active: Option<ActiveFile>,
    bytes: u64,
}

impl Spool {
    /// Único inventario. Adopta también el temporal (`.jsonl.tmp`) que dejó un proceso interrumpido.
    pub(crate) fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let mut entries = fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|e| e.path());
        let mut spool = Self { dir: dir.to_path_buf(), pending: BTreeMap::new(), active: None, bytes: 0 };
        for entry in &entries {
            let mut path = entry.path();
            if !entry.file_type()?.is_file() { continue; }
            if path.to_string_lossy().ends_with(".jsonl.tmp") {
                let len = complete_prefix(&path)?;
                OpenOptions::new().write(true).open(&path)?.set_len(len)?;
                let mut ready = path.with_extension("");
                if ready.exists() {
                    let (p, file) = unique_file(dir, "jsonl")?;
                    drop(file);
                    ready = p;
                }
                fs::rename(&path, &ready)?;
                path = ready;
            }
            if path.extension().is_some_and(|e| e == "jsonl") {
                let bytes = fs::metadata(&path)?.len();
                let (offset, ack_bytes) = match fs::read(ack_path(&path)) {
                    Ok(raw) => match <[u8; 8]>::try_from(raw.as_slice()) {
                        Ok(raw) if u64::from_le_bytes(raw) <= bytes => (u64::from_le_bytes(raw), 8),
                        _ => {
                            tracing::warn!(target: "tpv::telemetry", "cursor de telemetría corrupto: se reenvía el segmento completo");
                            (0, raw.len() as u64)
                        }
                    },
                    Err(e) if e.kind() == io::ErrorKind::NotFound => (0, 0),
                    Err(e) => return Err(e),
                };
                spool.bytes += bytes + ack_bytes;
                spool.pending.insert(path, PendingFile { bytes, offset, ack_bytes });
            }
        }
        for entry in &entries {
            let path = entry.path();
            if (path.extension().is_some_and(|e| e == "ack") && !path.with_extension("jsonl").exists())
                || path.to_string_lossy().ends_with(".ack.tmp") {
                remove_if_exists(&path)?;
            }
        }
        Ok(spool)
    }

    pub(crate) fn deadline(&self) -> Option<Instant> {
        self.active.as_ref().map(|a| a.since + SEGMENT_AGE)
    }
    pub(crate) fn has_pending(&self) -> bool { !self.pending.is_empty() }

    pub(crate) fn append(&mut self, event: &SpoolEvent) -> io::Result<()> {
        let line = encode_event(event)?;
        if self.active.as_ref().is_some_and(|a|
            a.events >= MAX_EVENTS_PER_BATCH || a.bytes + line.len() as u64 + 16 > MAX_BODY_BYTES as u64
        ) { self.seal()?; }
        if self.active.is_none() {
            let (path, file) = unique_file(&self.dir, "jsonl.tmp")?;
            self.active = Some(ActiveFile { path, file, bytes: 0, events: 0, since: Instant::now() });
        }
        let active = self.active.as_mut().unwrap();
        // File sin BufWriter: cada línea llega al kernel. Rollback del fragmento si falla.
        if let Err(e) = active.file.write_all(&line) {
            active.file.set_len(active.bytes)?;
            active.file.seek(SeekFrom::End(0))?;
            return Err(e);
        }
        active.bytes += line.len() as u64;
        active.events += 1;
        self.bytes += line.len() as u64;
        if active.events == MAX_EVENTS_PER_BATCH || active.bytes + 16 >= MAX_BODY_BYTES as u64 {
            // La línea ya está persistida; un fallo al sellar no debe devolverla a la antesala.
            if let Err(e) = self.seal() { report_io("sellar", &e); }
        }
        Ok(())
    }

    pub(crate) fn seal(&mut self) -> io::Result<()> {
        let Some(active) = self.active.as_mut() else { return Ok(()); };
        active.file.flush()?;
        let ActiveFile { path, file, bytes, events, since } = self.active.take().unwrap();
        // Cerrar primero el handle para Windows.
        drop(file);
        let ready = path.with_extension("");
        if let Err(e) = fs::rename(&path, &ready) {
            let file = OpenOptions::new().append(true).open(&path)?;
            self.active = Some(ActiveFile { path, file, bytes, events, since });
            return Err(e);
        }
        self.pending.insert(ready, PendingFile { bytes, offset: 0, ack_bytes: 0 });
        Ok(())
    }

    /// Agrupa ficheros pequeños y divide los grandes sin modificar sus datos. Los offsets
    /// persistidos evitan reenviar la parte ya confirmada después de reiniciar.
    pub(crate) fn prepare(&mut self, max_events: usize) -> io::Result<Option<UploadBatch>> {
        let mut body = b"{\"events\":[".to_vec();
        let mut count = 0;
        let mut consumed = Vec::new();
        let mut corrupt = 0;
        'files: for (path, meta) in &self.pending {
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(meta.offset))?;
            let mut reader = BufReader::new(file);
            let mut offset = meta.offset;
            loop {
                let (raw, bytes) = read_line(&mut reader)?;
                if bytes == 0 { break; }
                let end = offset + bytes;
                let line = match serde_json::from_slice::<SpoolEvent>(&raw) {
                    Ok(event) => encode_event(&event)?,
                    Err(_) => { corrupt += 1; offset = end; continue; }
                };
                let json = &line[..line.len() - 1];
                if count == max_events || body.len() + json.len() + usize::from(count > 0) + 2 > MAX_BODY_BYTES {
                    if offset > meta.offset { consumed.push((path.clone(), offset)); }
                    break 'files;
                }
                if count > 0 { body.push(b','); }
                body.extend_from_slice(json);
                count += 1;
                offset = end;
            }
            consumed.push((path.clone(), offset));
        }
        if corrupt > 0 {
            tracing::warn!(target: "tpv::telemetry", descartados = corrupt, "líneas corruptas o excesivas en la cola de telemetría");
        }
        body.extend_from_slice(b"]}");
        let batch = UploadBatch { body, events: count, consumed };
        if count == 0 {
            self.acknowledge(&batch)?;
            return Ok(None);
        }
        Ok(Some(batch))
    }

    pub(crate) fn acknowledge(&mut self, batch: &UploadBatch) -> io::Result<()> {
        for (path, offset) in &batch.consumed {
            let Some(meta) = self.pending.get(path) else { continue; };
            if *offset >= meta.bytes {
                fs::remove_file(path)?;
                self.bytes -= meta.bytes + meta.ack_bytes;
                self.pending.remove(path);
                remove_if_exists(&ack_path(path))?;
            } else {
                let ack = ack_path(path);
                let tmp = ack.with_extension("ack.tmp");
                fs::write(&tmp, offset.to_le_bytes())?;
                fs::rename(tmp, ack)?;
                let meta = self.pending.get_mut(path).unwrap();
                self.bytes = self.bytes - meta.ack_bytes + 8;
                meta.ack_bytes = 8;
                meta.offset = *offset;
            }
        }
        Ok(())
    }

    /// Poda por bytes sólo tras escribir (y al arrancar), sin recorrer el directorio.
    /// El POST en vuelo queda protegido; el segmento activo ocupa como máximo 512 KiB.
    pub(crate) fn prune(&mut self, limit: u64, in_flight: Option<&UploadBatch>) -> io::Result<u64> {
        let mut removed = 0;
        while self.bytes > limit {
            let candidate = self.pending.keys().find(|p| !in_flight.is_some_and(|b| b.contains(p))).cloned();
            let Some(path) = candidate else { break; };
            fs::remove_file(&path)?;
            let meta = self.pending.remove(&path).unwrap();
            self.bytes -= meta.bytes + meta.ack_bytes;
            removed += meta.bytes + meta.ack_bytes;
            remove_if_exists(&ack_path(&path))?;
        }
        Ok(removed)
    }
}

fn unique_file(dir: &Path, extension: &str) -> io::Result<(PathBuf, File)> {
    loop {
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{ms:013}-{seq:08}.{extension}"));
        if extension == "jsonl.tmp" && path.with_extension("").exists() { continue; }
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
}
fn ack_path(path: &Path) -> PathBuf { path.with_extension("ack") }
fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// Memoria acotada incluso si un fichero heredado contiene una línea enorme.
fn read_line(reader: &mut impl BufRead) -> io::Result<(Vec<u8>, u64)> {
    let mut line = Vec::new();
    let mut total = 0;
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() { break; }
        let n = chunk.iter().position(|b| *b == b'\n').map_or(chunk.len(), |i| i + 1);
        let finished = chunk[n - 1] == b'\n';
        total += n as u64;
        if !oversized && total <= MAX_LINE_BYTES as u64 { line.extend_from_slice(&chunk[..n]); }
        else { oversized = true; line.clear(); }
        reader.consume(n);
        if finished { break; }
    }
    Ok((line, total))
}
fn complete_prefix(path: &Path) -> io::Result<u64> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut offset = 0;
    let mut complete = 0;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() { break; }
        if let Some(i) = chunk.iter().rposition(|b| *b == b'\n') { complete = offset + i as u64 + 1; }
        let n = chunk.len();
        offset += n as u64;
        reader.consume(n);
    }
    Ok(complete)
}
fn truncate(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes { return; }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) { end -= 1; }
    text.truncate(end);
}
fn encode_event(event: &SpoolEvent) -> io::Result<Vec<u8>> {
    let mut event = event.clone();
    event.scrub_in_place();
    truncate(&mut event.message, 4000);
    truncate(&mut event.target, 256);
    truncate(&mut event.ts, 64);
    truncate(&mut event.level, 16);
    truncate(&mut event.device_mode, 16);
    truncate(&mut event.app_version, 64);
    truncate(&mut event.environment, 32);
    let mut line = serde_json::to_vec(&event)?;
    if line.len() > MAX_EVENT_BYTES {
        event.fields.clear();
        event.fields.insert("telemetry_fields_omitidos".into(), true.into());
        event.tenant_id.clear();
        event.device_id.clear();
        line = serde_json::to_vec(&event)?;
    }
    line.push(b'\n');
    Ok(line)
}
pub(crate) fn report_io(operation: &str, error: &io::Error) {
    tracing::warn!(target: "tpv::telemetry", operacion = operation, error = %error, "fallo de E/S en la cola de telemetría");
}

#[cfg(test)]
mod tests;
