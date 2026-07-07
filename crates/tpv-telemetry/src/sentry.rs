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
        // Scrubbing (OBS-01): además de anular usuario y hostname (que puede llevar el nombre del
        // equipo), redactamos el CONTENIDO libre que compone el desarrollador —mensajes de
        // excepción, breadcrumbs y logentry—, donde `send_default_pii=false` no llega. Así un
        // `error!`/panic con un email o una contraseña no sale en claro a Sentry.
        before_send: Some(Arc::new(|mut event: sentry::protocol::Event<'static>| {
            event.user = None;
            event.server_name = None;
            scrub_event(&mut event);
            Some(event)
        })),
        ..Default::default()
    };

    sentry::init((dsn, options))
}

/// Redacta el contenido libre de un evento Sentry antes de enviarlo (OBS-01): mensaje, valores de
/// excepción y mensajes de breadcrumb. Reutiliza el mismo scrubber que la cola de Axiom.
fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    if let Some(msg) = event.message.as_mut() {
        *msg = crate::scrub::scrub(msg);
    }
    if let Some(le) = event.logentry.as_mut() {
        le.message = crate::scrub::scrub(&le.message);
    }
    for exc in event.exception.values.iter_mut() {
        if let Some(v) = exc.value.as_mut() {
            *v = crate::scrub::scrub(v);
        }
    }
    for bc in event.breadcrumbs.values.iter_mut() {
        if let Some(m) = bc.message.as_mut() {
            *m = crate::scrub::scrub(m);
        }
    }
}
