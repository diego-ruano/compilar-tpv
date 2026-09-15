//! Filtro de datos personales (scrubbing) antes de enviar telemetría a **terceros** (Axiom vía el
//! spool, Sentry). Es la red de seguridad de OBS-01: `send_default_pii=false` sólo cubre el contexto
//! automático de Sentry (usuario/request), NO las cadenas que compone el desarrollador con
//! `tracing::error!`/`warn!` ni los campos estructurados. Un registro de errores no necesita el DNI,
//! el IBAN, el número de la Seguridad Social, el teléfono ni el correo de nadie, así que lo que tenga
//! forma de dato personal —o de secreto— se sustituye por un marcador.
//!
//! **Tres copias.** Estas reglas existen también en la Webview
//! (`apps/tpv-main/src/shared/observability/scrub.ts`) y en el worker
//! (`apps/cloud-worker-licensing/src/observability/scrub.ts`), porque no pueden compartir código. Lo
//! que las mantiene iguales es `scrub_casos.json`, la tabla de casos que leen los tests de las tres:
//! si cambias una regla, añade ahí el caso y las otras copias fallarán hasta que las iguales.
//!
//! **Por qué `(?-u:\b)` y `[0-9]`.** Por defecto, en el crate `regex` `\b` y `\d` son de Unicode, y en
//! JavaScript son ASCII. La diferencia se nota justo donde no debe: en «nº12345678Z» la `º` es una
//! letra para Unicode, así que Rust no veía frontera y dejaba el DNI en claro mientras las copias de
//! TypeScript lo quitaban. Con la frontera ASCII las tres copias deciden igual.
//!
//! **Lo que no puede hacer:** reconocer un nombre o una dirección. Por eso un mensaje de error no se
//! compone con ellos; esto es la red, no la regla.
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
        let regla = |patron: &str, with: &'static str| Rule {
            re: Regex::new(patron).unwrap_or_else(|e| panic!("regex del filtro «{patron}»: {e}")),
            with,
        };
        // El orden importa: primero lo específico, para que una regla genérica no se quede media
        // coincidencia.
        vec![
            // Cabecera de autorización: consume el valor entero, incluido el esquema (`Bearer <tok>`),
            // no sólo el primer token (si no, se redactaría "Bearer" y el token quedaría en claro).
            regla(r"(?i)(?-u:\b)(authorization|auth)(?-u:\b)\s*[:=]\s*\S+(?:\s+\S+)?", "$1=[redacted]"),
            // Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`) sin clave delante.
            regla(r"(?i)(?-u:\b)(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}", "[redacted]"),
            // Secretos con forma `clave = valor` / `clave: valor`. Se preserva la clave, que dice «qué».
            regla(
                r"(?i)(?-u:\b)(password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey|pin|otp)(?-u:\b)\s*[:=]\s*\S+",
                "$1=[redacted]",
            ),
            // JWT / tokens con forma cabecera.carga.firma (base64url).
            regla(r"(?-u:\b)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[jwt]"),
            // Correos.
            regla(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", "[email]"),
            // IBAN español, en cualquier caja, junto o agrupado con espacios o guiones.
            regla(r"(?i)(?-u:\b)ES[0-9]{2}(?:[ \-]?[0-9]{4}){5}(?-u:\b)", "[iban]"),
            // IBAN de cualquier país, en mayúsculas. Sólo en mayúsculas a propósito: en minúsculas, un
            // hash o un identificador hexadecimal que empiece por dos letras tendría su forma.
            regla(
                r"(?-u:\b)[A-Z]{2}[0-9]{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?(?-u:\b)",
                "[iban]",
            ),
            // Número de afiliación a la Seguridad Social: 2 + 8 + 2 cifras, juntas o separadas.
            regla(r"(?-u:\b)[0-9]{2}[ /\-]?[0-9]{8}[ /\-]?[0-9]{2}(?-u:\b)", "[nss]"),
            // DNI y NIE, con puntos, guiones o espacios, en cualquier caja. Un CIF (letra delante y
            // cifras pegadas) no encaja a propósito: es de una empresa, no de una persona.
            regla(r"(?i)(?-u:\b)(?:[XYZ][ \-]?)?[0-9]{1,2}(?:[. ]?[0-9]{3}){2}[ \-]?[A-Z](?-u:\b)", "[id]"),
            // Teléfonos, tarjetas y cualquier otra secuencia de 9 a 19 cifras.
            regla(r"\+?[0-9](?:[ .\-]?[0-9]){8,18}", "[num]"),
        ]
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

    /// La tabla que comparten las tres copias del filtro.
    fn casos() -> Value {
        serde_json::from_str(include_str!("scrub_casos.json")).expect("scrub_casos.json no es JSON válido")
    }

    fn texto(v: &Value) -> &str {
        v.as_str().expect("un caso tiene que ser una cadena")
    }

    #[test]
    fn redacta_cada_caso_de_la_tabla_compartida() {
        let casos = casos();
        let pares = casos["redacta"].as_array().expect("falta «redacta»");
        assert!(!pares.is_empty());
        let mut fallos = Vec::new();
        for par in pares {
            let (entrada, salida) = (texto(&par[0]), texto(&par[1]));
            let obtenida = scrub(entrada);
            if obtenida != salida {
                fallos.push(format!("{entrada:?} → {obtenida:?}, esperaba {salida:?}"));
            }
        }
        assert!(fallos.is_empty(), "casos que no coinciden con las otras copias:\n{}", fallos.join("\n"));
    }

    #[test]
    fn deja_tal_cual_lo_que_hace_falta_para_diagnosticar() {
        let casos = casos();
        for t in casos["no_toca"].as_array().expect("falta «no_toca»") {
            assert_eq!(scrub(texto(t)), texto(t));
        }
    }

    #[test]
    fn aplicarlo_dos_veces_da_lo_mismo() {
        let casos = casos();
        for par in casos["redacta"].as_array().unwrap() {
            let una = scrub(texto(&par[0]));
            assert_eq!(scrub(&una), una, "{:?}", texto(&par[0]));
        }
    }

    #[test]
    fn scrub_value_recorre_objetos_y_arrays() {
        let mut v = json!({
            "email": "b@c.io",
            "nota": "sin datos",
            "lista": ["x@y.es", 42, {"dni": "12.345.678-Z"}],
            "n": 7
        });
        scrub_value(&mut v);
        assert_eq!(v["email"], json!("[email]"));
        assert_eq!(v["nota"], json!("sin datos"));
        assert_eq!(v["lista"][0], json!("[email]"));
        assert_eq!(v["lista"][1], json!(42));
        assert_eq!(v["lista"][2]["dni"], json!("[id]"));
        assert_eq!(v["n"], json!(7));
    }
}
