//! Configuración de arranque de la telemetría y puerto de firma para la subida a la nube.
//!
//! El **composition root** (el shell Tauri en `main.rs`) construye un [`TelemetryConfig`] y se lo
//! pasa a [`crate::init`]. La telemetría NO sabe firmar peticiones (eso es cripto de pairing, que
//! vive en otra crate): para autenticar la subida al worker recibe un [`IngestSigner`] inyectado.
//! Así esta crate sigue siendo una HOJA sin dependencias de las demás.

use std::path::PathBuf;
use std::sync::Arc;

/// Entorno de ejecución. Se etiqueta en cada evento para poder separar métricas dev/prod.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Dev,
    Prod,
}

impl Environment {
    /// Heurística por defecto: build de debug ⇒ `Dev`, build de release ⇒ `Prod`. El shell puede
    /// sobreescribirlo (p. ej. para un canal "staging") fijando el campo directamente.
    pub fn detect() -> Self {
        if cfg!(debug_assertions) {
            Environment::Dev
        } else {
            Environment::Prod
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Environment::Dev => "dev",
            Environment::Prod => "prod",
        }
    }
}

/// Puerto de firma (inyectado por el shell) para autenticar la subida a `/v1/telemetry`.
///
/// Reutiliza el esquema device-proof del proyecto (token + ts + firma ed25519). Devuelve la lista
/// de cabeceras a adjuntar, o `None` si **todavía no se puede firmar** (dispositivo sin identidad
/// o sin licencia): en ese caso el worker de telemetría **retiene** los lotes en disco y reintenta
/// más tarde, sin perderlos.
pub trait IngestSigner: Send + Sync {
    fn sign(&self, method: &str, path: &str) -> Option<Vec<(String, String)>>;
}

/// Configuración de la subida a la nube (Fase 4). Mientras `enabled` sea `false` o no haya
/// `signer`, el worker sólo persiste en la cola local durable (no hace red).
#[derive(Clone)]
pub struct IngestConfig {
    /// URL completa del endpoint del worker (p. ej. `https://tpv-api…/v1/telemetry`).
    pub url: String,
    /// Ruta canónica que se firma (debe coincidir con el `pathname` del endpoint).
    pub path: String,
    /// Interruptor maestro de la subida. `false` ⇒ sólo cola local (Fase 1).
    pub enabled: bool,
    /// Firmante device-proof inyectado por el shell. `None` ⇒ no se sube (se retiene).
    pub signer: Option<Arc<dyn IngestSigner>>,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            path: "/v1/telemetry".to_string(),
            enabled: false,
            signer: None,
        }
    }
}

/// Parámetros de arranque de la telemetría.
#[derive(Clone)]
pub struct TelemetryConfig {
    /// Carpeta de datos del dispositivo (AppData). Bajo ella se crean `logs/` (fichero rotado) y
    /// `telemetry-spool/` (cola durable).
    pub app_data_dir: PathBuf,
    /// Versión instalada (p. ej. `app.package_info().version`). Se etiqueta en cada evento.
    pub app_version: String,
    /// Entorno (dev/prod/staging).
    pub environment: Environment,
    /// Mostrar logs por consola/stderr (típicamente sólo en desarrollo).
    pub console: bool,
    /// Subida a la nube (se rellena en la Fase 4).
    pub ingest: IngestConfig,
}

impl TelemetryConfig {
    /// Constructor mínimo para la fase de fundación: sólo consola (en dev) + fichero local, sin
    /// subida a la nube. La subida se activa rellenando `self.ingest` más adelante.
    pub fn local_only(app_data_dir: PathBuf, app_version: impl Into<String>) -> Self {
        let environment = Environment::detect();
        Self {
            app_data_dir,
            app_version: app_version.into(),
            console: environment == Environment::Dev,
            environment,
            ingest: IngestConfig::default(),
        }
    }
}
