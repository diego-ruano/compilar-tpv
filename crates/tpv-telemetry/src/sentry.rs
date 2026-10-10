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
    pub build_variant: String,
    pub commit: Option<String>,
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
        // equipo), redactamos el CONTENIDO libre del evento, donde `send_default_pii=false` no llega.
        // Ver `scrub_event` para qué campos y por qué.
        before_send: Some(Arc::new(|mut event: sentry::protocol::Event<'static>| {
            event.user = None;
            event.server_name = None;
            scrub_event(&mut event);
            Some(event)
        })),
        ..Default::default()
    };

    let guard = sentry::init((dsn, options));
    sentry::configure_scope(|scope| {
        scope.set_tag("build_variant", cfg.build_variant);
        if let Some(commit) = cfg.commit { scope.set_tag("build_commit", commit); }
    });
    guard
}

/// Redacta el contenido libre de un evento Sentry antes de enviarlo (OBS-01). Reutiliza el mismo
/// filtro que la cola de Axiom.
///
/// No basta con el mensaje y las excepciones, porque los datos entran también sin que nadie los
/// escriba en un mensaje:
///
/// - la integración de `tracing` guarda los **campos** de un `error!` en `contexts` (y los que tienen
///   forma de etiqueta en `tags`), y los de un breadcrumb en su `data`;
/// - lo que reporta la Webview por el plugin llega con su contexto en `extra`;
/// - un `logentry` lleva sus parámetros aparte del mensaje.
///
/// Lo que no se toca son los contextos tipados que rellena el SDK (sistema, dispositivo, traza): no
/// llevan datos de nadie, y un identificador de traza redactado deja el evento inservible.
fn scrub_event(event: &mut sentry::protocol::Event<'static>) {
    use crate::scrub::{scrub, scrub_value, scrub_field, scrub_string_field};
    use sentry::protocol::Context;

    if let Some(msg) = event.message.as_mut() {
        if let Cow::Owned(value) = scrub(msg) { *msg = value; }
    }
    if let Some(le) = event.logentry.as_mut() {
        if let Cow::Owned(value) = scrub(&le.message) { le.message = value; }
        le.params.iter_mut().for_each(scrub_value);
    }
    for exc in event.exception.values.iter_mut() {
        if let Some(v) = exc.value.as_mut() {
            if let Cow::Owned(value) = scrub(v) { *v = value; }
        }
    }
    for bc in event.breadcrumbs.values.iter_mut() {
        if let Some(m) = bc.message.as_mut() {
            if let Cow::Owned(value) = scrub(m) { *m = value; }
        }
        for (key, value) in &mut bc.data { scrub_field(key, value); }
    }
    for (key, value) in &mut event.extra { scrub_field(key, value); }
    for (key, v) in &mut event.tags {
        if let Cow::Owned(value) = scrub_string_field(key, v) { *v = value; }
    }
    for ctx in event.contexts.values_mut() {
        if let Context::Other(campos) = ctx {
            for (key, value) in campos { scrub_field(key, value); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sentry::protocol::{Breadcrumb, Context, Event, Exception, LogEntry};
    use serde_json::Value;
    use std::collections::BTreeMap;

    #[test]
    fn el_evento_sale_sin_datos_personales_en_ninguno_de_sus_campos() {
        let mut campos_tracing = BTreeMap::new();
        campos_tracing.insert("dni".to_string(), Value::from("12.345.678-Z"));
        let mut contexts = BTreeMap::new();
        contexts.insert("Rust Tracing Fields".to_string(), Context::Other(campos_tracing));

        let mut datos_breadcrumb = BTreeMap::new();
        datos_breadcrumb.insert("iban".to_string(), Value::from("ES91 2100 0418 4502 0005 1332"));

        let mut extra = BTreeMap::new();
        extra.insert("destino".to_string(), serde_json::json!({ "correo": "ana@example.com" }));

        let mut tags = BTreeMap::new();
        tags.insert("clave".to_string(), "password=hunter2".to_string());

        let mut event = Event {
            message: Some("aviso a ana@example.com".into()),
            logentry: Some(LogEntry {
                message: "trabajador con DNI {}".into(),
                params: vec![Value::from("x1234567l")],
            }),
            exception: vec![Exception {
                ty: "AppError".into(),
                value: Some("NSS 28/12345678/40 duplicado".into()),
                ..Default::default()
            }]
            .into(),
            breadcrumbs: vec![Breadcrumb {
                message: Some("tel 612 345 678".into()),
                data: datos_breadcrumb,
                ..Default::default()
            }]
            .into(),
            extra,
            tags,
            contexts,
            ..Default::default()
        };

        scrub_event(&mut event);

        let todo = serde_json::to_string(&event).expect("el evento se serializa");
        for dato in [
            "ana@example.com",
            "12.345.678-Z",
            "x1234567l",
            "ES91 2100 0418 4502 0005 1332",
            "28/12345678/40",
            "612 345 678",
            "hunter2",
        ] {
            assert!(!todo.contains(dato), "«{dato}» sigue en el evento: {todo}");
        }
        // Lo que sirve para diagnosticar se queda.
        assert_eq!(event.exception.values[0].ty, "AppError");
        assert_eq!(event.exception.values[0].value.as_deref(), Some("NSS [nss] duplicado"));
        assert_eq!(event.logentry.as_ref().map(|l| l.message.as_str()), Some("trabajador con DNI {}"));
    }
}
