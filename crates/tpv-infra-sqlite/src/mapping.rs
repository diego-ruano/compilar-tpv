//! Helpers de conversión entre `libsql::Value` y tipos Rust. Reutilizables por todos
//! los repositorios. Replican los antiguos helpers `v_*` que estaban duplicados por módulo.

use libsql::Value;

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
