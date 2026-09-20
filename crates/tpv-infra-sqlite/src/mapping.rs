//! Helpers de conversión entre `libsql::Value` y tipos Rust. Reutilizables por todos
//! los repositorios. Replican los antiguos helpers `v_*` que estaban duplicados por módulo.

use libsql::Value;
use tpv_domain::dinero::Dinero;

pub fn v_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

pub fn v_f64(v: Value) -> Option<f64> {
    match v {
        Value::Real(n) => Some(n),
        Value::Integer(n) => Some(n as f64),
        Value::Text(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub fn v_string(v: Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s),
        Value::Integer(n) => Some(n.to_string()),
        Value::Real(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Texto opcional normalizado: trim + descarta vacíos.
pub fn norm_opt_string(v: Value) -> Option<String> {
    v_string(v).and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// `Option<String>` -> `Value` (Text o Null) para parámetros de escritura.
pub fn opt_text(o: Option<String>) -> Value {
    match o {
        Some(s) => Value::Text(s),
        None => Value::Null,
    }
}

/// `Option<f64>` -> `Value` (Real o Null) para parámetros de escritura.
pub fn opt_real(o: Option<f64>) -> Value {
    match o {
        Some(n) => Value::Real(n),
        None => Value::Null,
    }
}

/// Lee una columna de DINERO. Son `INTEGER` de céntimos (ARQ-01), así que lo normal es el primer
/// brazo; los otros dos son la misma tolerancia que el resto de helpers, por si un valor llega
/// desde otro driver o desde el JSON de la replicación.
///
/// ⚠️ **Un `Real` se redondea, no se trunca.** `as i64` tira la parte decimal, así que un 1299.9999
/// —lo que deja un `SUM` de REAL cuando el dato viene de una base antigua— se habría convertido en
/// 12,99 € en vez de 13,00 €.
pub fn v_dinero(v: Value) -> Option<Dinero> {
    match v {
        Value::Integer(n) => Some(Dinero::de_centimos(n)),
        Value::Real(n) => Some(Dinero::de_centimos(n.round() as i64)),
        Value::Text(s) => s.parse::<i64>().ok().map(Dinero::de_centimos),
        _ => None,
    }
}

/// `Dinero` -> `Value` para enlazar como parámetro de escritura.
pub fn dinero_val(d: Dinero) -> Value {
    Value::Integer(d.centimos())
}

/// `Option<Dinero>` -> `Value` (Integer o Null).
pub fn opt_dinero(o: Option<Dinero>) -> Value {
    match o {
        Some(d) => Value::Integer(d.centimos()),
        None => Value::Null,
    }
}
