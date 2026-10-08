//! # tpv-telemetry
//!
//! Infraestructura de **logging/telemetría** del TPV. Pieza **HOJA** del workspace: no depende de
//! ninguna otra crate interna; el resto del backend sólo emite eventos con las macros estándar de
//! [`tracing`] (`info!`, `warn!`, `error!`, `#[instrument]`) sin saber a dónde van.
//!
//! Monta un subscriber `tracing` con tres destinos:
//! 1. **Consola** (sólo en desarrollo).
//! 2. **Fichero local rotado por días** (`<AppData>/logs/tpv.log`, se conservan 7 días). Es la
//!    fuente de verdad duradera para soporte, funcione o no la nube.
//! 3. **Cola durable en disco** (`<AppData>/telemetry-spool/`) que un worker en segundo plano sube
//!    por lotes al worker `tpv-api` (se activa en la Fase 4 rellenando [`IngestConfig`]).
//!
//! ## Uso desde el composition root
//! ```ignore
//! let _ = tpv_telemetry::init(tpv_telemetry::TelemetryConfig::local_only(app_data_dir, version));
//! tracing::info!(target: "tpv::startup", "app iniciada");
//! // en cuanto se conoce la identidad del dispositivo:
//! tpv_telemetry::set_device_context(device_id, "tpv");
//! tpv_telemetry::set_tenant(tenant_id);
//! ```
//!
//! `init` NUNCA debe tumbar la app: si falla, el shell registra el error y continúa sin telemetría.

mod context;
mod capture;
mod event;
mod forward;
mod scrub;
mod spool;
mod state;
mod worker;
#[cfg(target_os = "android")]
mod android;

#[cfg(test)]
mod test_support;
#[cfg(all(test, not(target_os = "android")))]
mod init_tests;

pub mod config;
pub mod sentry;

pub use config::{Environment, IngestConfig, IngestSigner, TelemetryConfig};
pub use sentry::{init_sentry, SentryConfig, SentryGuard};

use std::sync::OnceLock;

use context::Context;
use state::TelemetryState;

/// Tope del anillo de staging en memoria (nº de eventos). Antesala entre captura y disco; si se
/// llenara (atasco grave de E/S) se descartan los más antiguos, que de todos modos siguen en el
/// fichero local.
const STAGING_CAP: usize = 20_000;

/// Estado global (el logging es, por naturaleza, un singleton de proceso).
static STATE: OnceLock<std::sync::Arc<TelemetryState>> = OnceLock::new();
/// Guarda del appender no bloqueante; debe vivir durante todo el proceso para que el hilo de
/// escritura del fichero no se cierre.
static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

/// Error de inicialización de la telemetría. Es informativo: el shell lo registra y sigue.
#[derive(Debug)]
pub enum TelemetryError {
    Init(String),
}

impl std::fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TelemetryError::Init(msg) => write!(f, "telemetry init: {msg}"),
        }
    }
}

impl std::error::Error for TelemetryError {}

/// Diagnóstico previo a AppData/subscriber. Se llama desde JNI_OnLoad y run; idempotente.
/// En Android el mismo logger sirve primero Logcat y después el puente log → tracing.
pub fn init_platform_logging() {
    #[cfg(target_os = "android")]
    android::init();
}

/// Arranca la telemetría: monta el subscriber global y lanza el worker en segundo plano.
/// Idempotente de facto: una segunda llamada falla al fijar el subscriber global y devuelve error
/// (que el shell ignora).
pub fn init(config: TelemetryConfig) -> Result<(), TelemetryError> {
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{fmt, EnvFilter};

    init_platform_logging();

    let context = Context::new(
        config.app_version.clone(),
        config.environment.as_str().to_string(),
    );
    let state = std::sync::Arc::new(TelemetryState::new(context, STAGING_CAP));

    // ── Filtro de nivel (override por env `TPV_LOG`). En dev se baja a `debug`. ──
    let default_directive = if config.console { "debug" } else { "info" };
    let env_filter = EnvFilter::try_from_env("TPV_LOG")
        .unwrap_or_else(|_| EnvFilter::new(default_directive));

    // ── Capa 2: fichero local rotado por días (7 ficheros ≈ 7 días). ──
    let logs_dir = config.app_data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).ok();
    let appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("tpv")
        .filename_suffix("log")
        .max_log_files(7)
        .build(&logs_dir)
        .map_err(|e| TelemetryError::Init(format!("rolling appender: {e}")))?;
    let (file_writer, guard) = tracing_appender::non_blocking(appender);
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(file_writer);

    // ── Capa 1: consola (sólo dev). ──
    let console_layer = config
        .console
        .then(|| fmt::layer().with_ansi(true).with_writer(std::io::stderr));

    #[cfg(target_os = "android")]
    let logcat_layer = Some(fmt::layer().with_ansi(false).with_target(true)
        .with_writer(android::Logcat).with_filter(tracing_subscriber::filter::LevelFilter::INFO));
    #[cfg(not(target_os = "android"))]
    let logcat_layer = None::<tracing_subscriber::layer::Identity>;

    // ── Capa 3: reenvío a la cola durable de la nube. ──
    let forward_layer = forward::ForwardLayer::new(state.clone());

    // Capa puente tracing→Sentry: los eventos `error!` se convierten en eventos Sentry y el resto
    // en breadcrumbs. Es no-op si Sentry no está inicializado/está deshabilitado.
    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(console_layer)
        .with(logcat_layer)
        .with(forward_layer)
        .with(sentry_tracing::layer());
    // Registrar el subscriber y el logger por separado: try_init instala primero el
    // subscriber y luego falla si Android/otro componente ya posee el logger de log.
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| TelemetryError::Init(format!("set_global_default: {e}")))?;

    #[cfg(target_os = "android")]
    android::activate();
    #[cfg(not(target_os = "android"))]
    // Una fachada log ya instalada no invalida nuestros destinos tracing.
    let _ = tracing_log::LogTracer::init();

    // El guard y el estado deben sobrevivir todo el proceso.
    let _ = GUARD.set(guard);
    let _ = STATE.set(state.clone());

    // ── Worker en hilo propio (aislado del runtime de la app). ──
    let worker_cfg = worker::WorkerConfig {
        spool_dir: config.app_data_dir.join("telemetry-spool"),
        ingest: config.ingest,
        state,
    };
    std::thread::Builder::new()
        .name("tpv-telemetry".into())
        .spawn(move || worker::run(worker_cfg))
        .map_err(|e| TelemetryError::Init(format!("spawn worker: {e}")))?;

    Ok(())
}

/// Fija la identidad del dispositivo en el contexto de correlación (al emparejar/seleccionar modo).
/// Actualiza tanto la cola de logs (Axiom) como los tags de Sentry, de modo que ambos comparten las
/// mismas etiquetas. No-op si la telemetría/Sentry no están inicializados (nunca panica).
pub fn set_device_context(device_id: impl Into<String>, device_mode: impl Into<String>) {
    let device_id = device_id.into();
    let device_mode = device_mode.into();
    if let Some(state) = STATE.get() {
        if let Ok(mut c) = state.context.write() {
            c.device_id = device_id.clone();
            c.device_mode = device_mode.clone();
        }
    }
    // `::sentry` para referir a la crate externa (el módulo `crate::sentry` la sombrearía aquí).
    ::sentry::configure_scope(|scope| {
        scope.set_tag("device_id", &device_id);
        scope.set_tag("device_mode", &device_mode);
    });
}

/// Fija el `tenant_id` (restaurante) en el contexto de correlación + tags de Sentry cuando se conoce.
pub fn set_tenant(tenant_id: impl Into<String>) {
    let tenant_id = tenant_id.into();
    if let Some(state) = STATE.get() {
        if let Ok(mut c) = state.context.write() {
            c.tenant_id = tenant_id.clone();
        }
    }
    ::sentry::configure_scope(|scope| {
        scope.set_tag("tenant_id", &tenant_id);
    });
}
