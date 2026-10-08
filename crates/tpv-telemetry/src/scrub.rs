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
//! **Coste:** regex/RegexSet compilados una vez (`OnceLock`), preselección de reglas y resultado
//! prestado si no cambia. El spool se filtra en su hilo propio; Sentry en su `before_send`.

use std::sync::OnceLock;

use std::borrow::Cow;
use regex::{Regex, RegexSet};
use serde_json::{Map, Value};

/// Un patrón sensible y su reemplazo.
struct Rule {
    re: Regex,
    with: &'static str,
}

struct Rules { rules: Vec<Rule>, set: RegexSet }

const SECRET_KEYS: &str = r"authorization|auth|password|passwd|pwd|contrase(?:n|ñ)a|secret|token|api[_-]?key|apikey|pin|otp|(?:access|refresh|id)[_-]?token|client[_-]?secret";
const SECRET_VALUE: &str = r#"(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}"']+)"#;
const SENSITIVE_RULES: usize = 6;

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let regla = |patron: &str, with: &'static str| Rule {
            re: Regex::new(patron).unwrap_or_else(|e| panic!("regex del filtro «{patron}»: {e}")),
            with,
        };
        // El orden importa: primero lo específico, para que una regla genérica no se quede media
        // coincidencia.
        let rules = vec![
            // Cabecera de autorización: consume el valor entero, incluido el esquema (`Bearer <tok>`),
            // no sólo el primer token (si no, se redactaría "Bearer" y el token quedaría en claro).
            regla(r"(?i)(?-u:\b)(authorization|auth)(?-u:\b)\s*[:=]\s*\S+(?:\s+\S+)?", "$1=[redacted]"),
            // Esquemas de credencial sueltos (`Bearer <tok>` / `Basic <tok>`) sin clave delante.
            regla(r"(?i)(?-u:\b)(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{4,}", "[redacted]"),
            // RI-42: claves JSON o entre comillas; consumir también valores con espacios/escapes.
            regla(&format!(r#"(?i)(["'])({SECRET_KEYS})["']\s*[:=]\s*{SECRET_VALUE}"#), "$1$2$1:$1[redacted]$1"),
            regla(&format!(r"(?i)(?-u:\b)({SECRET_KEYS})(?-u:\b)\s*[:=]\s*{SECRET_VALUE}"), "$1=[redacted]"),
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
        ];
        let set = RegexSet::new(rules.iter().map(|r| r.re.as_str())).expect("RegexSet del filtro");
        Rules { rules, set }
    })
}

/// RI-42: las credenciales y los correos se ocultan antes de proteger identificadores.
/// Los intervalos de diagnóstico se conservan; el resto sigue pasando por TODAS las reglas.
pub(crate) fn scrub(input: &str) -> Cow<'_, str> {
    let mut out = apply_rules(input, 0..SENSITIVE_RULES);
    let text = out.as_ref();
    let mut last = 0;
    let mut result: Option<String> = None;
    for protected in diagnostic().find_iter(text) {
        let fragment = scrub_fragment(&text[last..protected.start()]);
        if matches!(fragment, Cow::Owned(_)) {
            result.get_or_insert_with(|| text[..last].to_owned()).push_str(&fragment);
        } else if let Some(result) = result.as_mut() { result.push_str(&fragment); }
        if let Some(result) = result.as_mut() { result.push_str(protected.as_str()); }
        last = protected.end();
    }
    if last == 0 {
        if let Cow::Owned(fragment) = scrub_fragment(text) { out = Cow::Owned(fragment); }
        return out;
    }
    let fragment = scrub_fragment(&text[last..]);
    if matches!(fragment, Cow::Owned(_)) {
        result.get_or_insert_with(|| text[..last].to_owned()).push_str(&fragment);
    } else if let Some(result) = result.as_mut() { result.push_str(&fragment); }
    result.map(Cow::Owned).unwrap_or(out)
}

fn apply_rules(input: &str, range: std::ops::Range<usize>) -> Cow<'_, str> {
    let rules = rules();
    let matches = rules.set.matches(input);
    let mut out = Cow::Borrowed(input);
    for i in range {
        if matches.matched(i) {
            let rule = &rules.rules[i];
            if let Cow::Owned(replaced) = rule.re.replace_all(&out, rule.with) {
                out = Cow::Owned(replaced);
            }
        }
    }
    out
}

fn diagnostic() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(concat!(
        r"(?-u:\b)(?i:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?-u:\b)",
        r"|(?-u:\b)[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?(?-u:\b)",
        r"|(?-u:\b)(?i:[a-z_][a-z0-9_]*_ms|timestamp|epoch|ts)\s*[:=]\s*[0-9]{10,16}(?-u:\b)",
        r"|(?-u:\b)(?i:hash|huella|event(?:_id)?)\s*[:= ]\s*[A-Fa-f0-9]{16,128}(?-u:\b)"
    )).expect("regex de diagnóstico"))
}

fn scrub_fragment(input: &str) -> Cow<'_, str> {
    let mut out = apply_rules(input, SENSITIVE_RULES..rules().rules.len());
    static CARDS: OnceLock<Regex> = OnceLock::new();
    static PHONES: OnceLock<Regex> = OnceLock::new();
    let cards = CARDS.get_or_init(|| Regex::new(r"[0-9](?:[ .\-]?[0-9]){12,18}").unwrap());
    // Sólo españoles: nueve cifras, con +34, 0034, 34 o (+34) opcional.
    let phones = PHONES.get_or_init(|| Regex::new(r"(?:(?:\+34|0034|34)[ .\-]?|\(\+34\)[ ]?)?[6789](?:[ .\-]?[0-9]){8}").unwrap());
    if let Cow::Owned(replaced) = redact_numbers(&out, cards, true) { out = Cow::Owned(replaced); }
    if let Cow::Owned(replaced) = redact_numbers(&out, phones, false) { out = Cow::Owned(replaced); }
    out
}

fn redact_numbers<'a>(input: &'a str, re: &Regex, card: bool) -> Cow<'a, str> {
    let mut out = String::new();
    let mut last = 0;
    let matches: Vec<_> = re.find_iter(input).collect();
    let mut i = 0;
    while i < matches.len() {
        let start = i;
        // Dos teléfonos separados por espacios son dos candidatos, no un número mayor.
        // Se valida el grupo completo para no redactar fragmentos de un número incompleto.
        while !card && i + 1 < matches.len() {
            let gap = &input[matches[i].end()..matches[i + 1].start()];
            if gap.is_empty() || !gap.bytes().all(|b| b == b' ') { break; }
            i += 1;
        }
        let end = i;
        i += 1;
        let first = matches[start];
        let final_match = matches[end];
        let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let before = input.as_bytes()[..first.start()].last().copied();
        let after = input.as_bytes().get(final_match.end()).copied();
        if before.is_some_and(|b| word(b) || b == b'+') || after.is_some_and(word) { continue; }
        // No tomar un trozo de un número mayor separado por espacios, puntos o guiones.
        if input[..first.start()].trim_end_matches([' ', '.', '-']).as_bytes().last().is_some_and(u8::is_ascii_digit)
            || input[final_match.end()..].trim_start_matches([' ', '.', '-']).as_bytes().first().is_some_and(u8::is_ascii_digit) { continue; }
        if card && !luhn(first.as_str()) { continue; }
        for m in &matches[start..=end] {
            out.push_str(&input[last..m.start()]);
            out.push_str("[num]");
            last = m.end();
        }
    }
    if last == 0 { Cow::Borrowed(input) }
    else { out.push_str(&input[last..]); Cow::Owned(out) }
}

fn luhn(input: &str) -> bool {
    let mut sum = 0;
    for (i, b) in input.bytes().filter(u8::is_ascii_digit).rev().enumerate() {
        let mut n = u32::from(b - b'0');
        if i % 2 == 1 { n *= 2; if n > 9 { n -= 9; } }
        sum += n;
    }
    sum % 10 == 0
}

/// Un timestamp numérico convertido a texto conserva la semántica de su clave.
fn timestamp_value(key: &str, value: &str) -> bool {
    let key = key.to_ascii_lowercase();
    (key.ends_with("_ms") || matches!(key.as_str(), "timestamp" | "epoch" | "ts"))
        && (10..=16).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
}

fn secret_key(key: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"(?i)^({SECRET_KEYS})$")).unwrap()).is_match(key)
}

pub(crate) fn scrub_string_field<'a>(key: &str, input: &'a str) -> Cow<'a, str> {
    if secret_key(key) { return Cow::Owned("[redacted]".into()); }
    let hash = matches!(key.to_ascii_lowercase().as_str(), "hash" | "huella" | "event" | "event_id")
        && (16..=128).contains(&input.len()) && input.bytes().all(|b| b.is_ascii_hexdigit());
    if timestamp_value(key, input) || hash { Cow::Borrowed(input) } else { scrub(input) }
}

pub(crate) fn scrub_field(key: &str, value: &mut Value) {
    if secret_key(key) { *value = Value::String("[redacted]".into()); return; }
    if let Value::String(text) = value {
        if let Cow::Owned(result) = scrub_string_field(key, text) { *text = result; }
    } else { scrub_value(value); }
}

/// Redacta en profundidad los valores de tipo cadena de un `serde_json::Value` (recorre objetos y
/// arrays). Los números/booleanos no se tocan.
pub(crate) fn scrub_value(value: &mut Value) {
    match value {
        Value::String(s) => {
            let scrubbed = scrub(s);
            if let Cow::Owned(scrubbed) = scrubbed { *s = scrubbed; }
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
    for (k, v) in map.iter_mut() {
        scrub_field(k, v);
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

    #[test]
    fn filtra_los_objetos_de_la_tabla_compartida() {
        for pair in casos()["objetos"].as_array().unwrap() {
            let mut value = pair[0].clone();
            scrub_value(&mut value);
            assert_eq!(value, pair[1]);
            scrub_value(&mut value);
            assert_eq!(value, pair[1]);
        }
    }

    #[test]
    fn conserva_cadenas_prestadas_si_no_hay_reemplazos() {
        for text in casos()["no_toca"].as_array().unwrap() {
            assert!(matches!(scrub(texto(text)), Cow::Borrowed(_)), "{}", texto(text));
        }
    }
}
