//! Depuración de contenido (scrubbing) antes de enviar telemetría a **terceros** (Axiom vía el
//! spool, Sentry). Es la red de seguridad de OBS-01: `send_default_pii=false` sólo cubre el contexto
//! automático de Sentry (usuario/request), NO las cadenas que compone el desarrollador con
//! `tracing::error!`/`warn!` ni los campos estructurados. Aquí redactamos patrones sensibles
//! (emails, IBAN, DNI/NIE, teléfonos, JWT, secretos `clave=valor`, números tipo tarjeta) para que un
//! `error!("fallo SMTP para {email}: {pass}")` no salga en claro a un servicio externo.
//!
//! **Alcance:** sólo el camino a la nube. El fichero local rotado (`<AppData>/logs/tpv.log`) es la
//! fuente de verdad para soporte y conserva el detalle completo sin depurar (es el propio equipo del
//! usuario, no un tercero).
//!
//! **Coste:** las regex se compilan una vez (`OnceLock`) y sólo se aplican a cadenas; el scrubbing
//! corre en el hilo del worker de telemetría (fuera del hilo caliente que emite los eventos), de
//! modo que nunca penaliza al POS (OBS-03).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

/// Un patrón sensible y su reemplazo.
struct Rule {
    re: Regex,
    with: &'static str,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        // Orden importante: los más específicos (secreto clave=valor, JWT) antes que los genéricos.
        let mut v = Vec::new();

        // Cabecera de autorización: consume el valor entero, incluido el esquema (`Bearer <tok>`),
        // no sólo el primer token (si no, se redactaría "Bearer" y el token quedaría en claro).
        v.push(Rule {
            re: Regex::new(r"(?i)\b(authorization|auth)\b\s*[:=]\s*\S+(?:\s+\S+)?")
                .expect("regex cabecera authorization"),
            with: "$1=[redacted]",
        });

        // Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`) sin clave delante.
        v.push(Rule {
            re: Regex::new(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}")
                .expect("regex esquema bearer/basic"),
            with: "[redacted]",
        });

        // Secretos con forma `clave = valor` / `clave: valor` (password, token, api_key…). Se
        // preserva la clave y se redacta sólo el valor, para no perder la pista del "qué".
        v.push(Rule {
            re: Regex::new(
                r"(?i)\b(password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey)\b\s*[:=]\s*\S+",
            )
            .expect("regex secreto clave=valor"),
            with: "$1=[redacted]",
        });

        // JWT / tokens con forma header.payload.signature (base64url).
        v.push(Rule {
            re: Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
                .expect("regex jwt"),
            with: "[jwt]",
        });

        // Emails.
        v.push(Rule {
            re: Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").expect("regex email"),
            with: "[email]",
        });

        // IBAN (2 letras país + 2 dígitos control + 10..30 alfanum).
        v.push(Rule {
            re: Regex::new(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b").expect("regex iban"),
            with: "[iban]",
        });

        // Teléfonos: prefijo internacional opcional + 9..15 dígitos, admitiendo espacios/guiones.
        v.push(Rule {
            re: Regex::new(r"\+?\d(?:[\s\-]?\d){8,14}").expect("regex telefono/numero largo"),
            with: "[num]",
        });

        // DNI/NIE español (7-8 dígitos + letra, con prefijo X/Y/Z opcional para NIE).
        v.push(Rule {
            re: Regex::new(r"\b[XYZ]?\d{7,8}[A-Za-z]\b").expect("regex dni/nie"),
            with: "[id]",
        });

        v
    })
}

/// Redacta patrones sensibles de una cadena. Idempotente (los marcadores `[..]` no re-disparan).
pub(crate) fn scrub(input: &str) -> String {
    // Atajo barato para el caso común (cadenas cortas sin nada que redactar): sólo copiamos.
    let mut out = std::borrow::Cow::Borrowed(input);
    for rule in rules() {
        if rule.re.is_match(&out) {
            out = std::borrow::Cow::Owned(rule.re.replace_all(&out, rule.with).into_owned());
        }
    }
    out.into_owned()
}

/// Redacta en profundidad los valores de tipo cadena de un `serde_json::Value` (recorre objetos y
/// arrays). Los números/booleanos no se tocan.
pub(crate) fn scrub_value(value: &mut Value) {
    match value {
        Value::String(s) => {
            let scrubbed = scrub(s);
            if &scrubbed != s {
                *s = scrubbed;
            }
        }
        Value::Array(items) => {
            for it in items.iter_mut() {
                scrub_value(it);
            }
        }
        Value::Object(map) => scrub_map(map),
        _ => {}
    }
}

/// Redacta en profundidad los valores de un mapa JSON (los `fields` de un evento).
pub(crate) fn scrub_map(map: &mut Map<String, Value>) {
    for (_k, v) in map.iter_mut() {
        scrub_value(v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacta_email() {
        assert_eq!(scrub("cliente ana@example.com pidió"), "cliente [email] pidió");
    }

    #[test]
    fn redacta_secreto_clave_valor() {
        assert_eq!(scrub("SMTP password=Sup3rSecreta!"), "SMTP password=[redacted]");
        assert_eq!(scrub("contraseña: hunter2"), "contraseña=[redacted]");
        assert_eq!(
            scrub("Authorization: Bearer abc.def"),
            "Authorization=[redacted]"
        );
    }

    #[test]
    fn redacta_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nature_00";
        assert_eq!(scrub(&format!("token {jwt} ok")), "token [jwt] ok");
    }

    #[test]
    fn redacta_iban_y_telefono() {
        assert_eq!(scrub("IBAN ES9121000418450200051332"), "IBAN [iban]");
        assert_eq!(scrub("tel +34 612 345 678 fin"), "tel [num] fin");
    }

    #[test]
    fn deja_pasar_texto_inocuo() {
        let s = "op 12 aplicada seq=34 en 5ms";
        // No debe redactar identificadores/contadores cortos ni el texto normal.
        assert_eq!(scrub(s), s);
    }

    #[test]
    fn scrub_value_recorre_objetos_y_arrays() {
        let mut v = json!({
            "email": "b@c.io",
            "nota": "sin datos",
            "lista": ["x@y.es", 42],
            "n": 7
        });
        scrub_value(&mut v);
        assert_eq!(v["email"], json!("[email]"));
        assert_eq!(v["nota"], json!("sin datos"));
        assert_eq!(v["lista"][0], json!("[email]"));
        assert_eq!(v["lista"][1], json!(42));
        assert_eq!(v["n"], json!(7));
    }
}
