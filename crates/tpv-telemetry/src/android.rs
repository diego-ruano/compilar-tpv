//! Un único logger global: Logcat durante el arranque y log → tracing después del subscriber.
//! Los eventos tracing llegan a Logcat por un writer directo, sin volver a la fachada log.

use std::io::{self, Write};
use std::sync::{Once, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use log::{Log, Level, LevelFilter, Metadata, Record};
use tracing_subscriber::fmt::MakeWriter;

struct PlatformLogger {
    android: android_logger::AndroidLogger,
    bridge: tracing_log::LogTracer,
    ready: AtomicBool,
}

fn logger() -> &'static PlatformLogger {
    static LOGGER: OnceLock<PlatformLogger> = OnceLock::new();
    LOGGER.get_or_init(|| PlatformLogger {
        android: android_logger::AndroidLogger::new(android_logger::Config::default()
            .with_max_level(LevelFilter::Info).with_tag("TPVRust")),
        bridge: tracing_log::LogTracer::new(),
        ready: AtomicBool::new(false),
    })
}

impl Log for PlatformLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        if self.ready.load(Ordering::Acquire) { self.bridge.enabled(metadata) }
        else { self.android.enabled(metadata) }
    }
    fn log(&self, record: &Record<'_>) {
        if self.ready.load(Ordering::Acquire) { self.bridge.log(record); }
        else { self.android.log(record); }
    }
    fn flush(&self) { self.android.flush(); }
}

pub(crate) fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Se ejecuta antes del primer JNI/arranque. Nunca intenta reemplazar otro logger.
        if log::set_logger(logger()).is_ok() { log::set_max_level(LevelFilter::Info); }
    });
}

pub(crate) fn activate() {
    logger().ready.store(true, Ordering::Release);
    // JNI emite miles de DEBUG/TRACE: no deben inundar ni Logcat ni la antesala.
    log::set_max_level(LevelFilter::Info);
}

pub(crate) struct Logcat;
pub(crate) struct Line { level: Level, buffer: Vec<u8> }

impl<'a> MakeWriter<'a> for Logcat {
    type Writer = Line;
    fn make_writer(&'a self) -> Line { Line { level: Level::Info, buffer: Vec::new() } }
    fn make_writer_for(&'a self, metadata: &tracing::Metadata<'_>) -> Line {
        let level = match *metadata.level() {
            tracing::Level::ERROR => Level::Error,
            tracing::Level::WARN => Level::Warn,
            tracing::Level::INFO => Level::Info,
            tracing::Level::DEBUG => Level::Debug,
            tracing::Level::TRACE => Level::Trace,
        };
        Line { level, buffer: Vec::new() }
    }
}

impl Write for Line {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if !self.buffer.is_empty() {
            logger().android.log(&Record::builder()
                .args(format_args!("{}", String::from_utf8_lossy(&self.buffer)))
                .level(self.level).target("tpv").build());
            self.buffer.clear();
        }
        Ok(())
    }
}
impl Drop for Line {
    fn drop(&mut self) { let _ = self.flush(); }
}
