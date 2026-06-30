//! Construcción del cliente Sentry (errores/crashes) del escritorio.
//!
//! El **cliente** se crea aquí (con el scrubbing de PII y los metadatos de release/entorno
//! centralizados), pero la **integración con Tauri** (registro del plugin + minidumps de crashes
//! nativos) la hace el shell en `main.rs`, porque necesita el `tauri::Builder`. El shell pasa el
//! guard que devuelve esta función al plugin `tauri-plugin-sentry`, de modo que Webview (JS) y Core
//! (Rust) comparten un único cliente.
//!
//! Si `dsn` es `None`/vacío, `sentry::init` devuelve un cliente DESHABILITADO (no-op): el cableado
//! es seguro aunque todavía no exista el proyecto en Sentry (sólo hay que rellenar el DSN al build).

use std::borrow::Cow;
use std::sync::Arc;

/// Guard del cliente Sentry. Debe vivir durante todo el proceso (lo retiene el shell).
pub type SentryGuard = sentry::ClientInitGuard;

/// Parámetros para inicializar Sentry en el escritorio.
pub struct SentryConfig {
    /// DSN público del proyecto de escritorio (embebido en el build). `None` ⇒ Sentry deshabilitado.
    pub dsn: Option<String>,
    /// Entorno (dev/prod/staging) para separar métricas.
    pub environment: String,
    /// Release (versión) para agrupar regresiones.
    pub release: Option<String>,
}

/// Inicializa Sentry y devuelve el guard. Instala además el hook de panics (feature `panic`).
pub fn init_sentry(cfg: SentryConfig) -> SentryGuard {
    let dsn = cfg.dsn.unwrap_or_default(); // "" ⇒ cliente deshabilitado.

    let options = sentry::ClientOptions {
        release: cfg.release.map(Cow::Owned),
        environment: Some(Cow::Owned(cfg.environment)),
        // Nunca PII por defecto (datos de clientes/ventas). GDPR.
        send_default_pii: false,
        // Scrubbing extra: fuera el usuario y el hostname (puede contener el nombre del equipo).
        before_send: Some(Arc::new(|mut event: sentry::protocol::Event<'static>| {
            event.user = None;
            event.server_name = None;
            Some(event)
        })),
        ..Default::default()
    };

    sentry::init((dsn, options))
}
