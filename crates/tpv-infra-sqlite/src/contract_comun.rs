//! Piezas compartidas por los dos harness de contrato Main(Rust)↔worker(TS).
//!
//! Hay **dos** harness, y comparan cosas distintas a propósito:
//!
//! - **Escritura** (`contract_tests.rs`): mismo comando → **mismas filas** en la BD. La comparación
//!   es por multiconjunto, porque el orden en el que queden las filas de una tabla no es parte del
//!   contrato.
//! - **Lectura** (`contract_read_tests.rs`): mismas filas → **mismo resultado devuelto**. Ahí el
//!   orden **sí** es el contrato (una lista se pinta en la pantalla en ese orden), así que la
//!   comparación es por secuencia.
//!
//! Lo que sí es idéntico en los dos —abrir una BD temporal, sembrarla y decidir cuándo dos celdas
//! son "la misma"— vive aquí para que no se pueda desincronizar.

#![cfg(test)]

use std::path::PathBuf;
use std::sync::Arc;

use libsql::{Connection, Value};
use serde_json::Value as Json;

use crate::db::Db;

/// Tolerancia al comparar números (stock decimal, importes): absorbe el ruido de coma flotante.
pub const TOL: f64 = 1e-9;

/// Raíz de los ficheros del harness (`tests/contract/`), relativa a esta crate.
pub fn contract_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract")
}

/// BD libsql nueva en un directorio temporal propio. Cada test tiene la suya: abrir muchas en un
/// mismo test dispara un crash nativo intermitente en Windows (`STATUS_ACCESS_VIOLATION`).
pub async fn db_temporal() -> (Arc<Db>, PathBuf) {
    let dir = crate::test_temp::dir_temporal("contract");
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
    (db, dir)
}

/// Siembra el estado de partida del caso. Va por `raw()` a propósito: es el estado previo, no una
/// escritura de negocio, y no debe acabar en `_Sync_Outbox`.
pub async fn sembrar(db: &Arc<Db>, sentencias: &[Json]) {
    let w = db.write().await;
    let conn: &Connection = w.raw();
    for s in sentencias {
        let sql = s.as_str().expect("cada seed es un string SQL");
        conn.execute(sql, Vec::<Value>::new())
            .await
            .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
    }
}

/// `libsql::Value` → `serde_json::Value`. Los blobs no se replican, así que no aparecen aquí.
pub fn cell_to_json(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(i) => Json::from(i),
        Value::Real(f) => Json::from(f),
        Value::Text(s) => Json::String(s),
        Value::Blob(_) => Json::Null,
    }
}

/// Igualdad estructural de dos celdas: números con tolerancia; strings/null exactos.
///
/// Los números se comparan por valor y no por tipo porque los dos lados llegan de runtimes
/// distintos: SQLite puede devolver el mismo agregado como entero o como real, y el SqlStorage del
/// worker entrega los enteros grandes como `bigint`. Exigir el mismo tipo JSON marcaría como
/// divergencia un `0` frente a un `0.0`, que en la pantalla es el mismo cero.
pub fn cell_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Null, Json::Null) => true,
        (Json::Bool(x), Json::Bool(y)) => x == y,
        (Json::String(x), Json::String(y)) => x == y,
        (Json::Number(_), Json::Number(_)) => {
            (a.as_f64().unwrap_or(f64::NAN) - b.as_f64().unwrap_or(f64::NAN)).abs() < TOL
        }
        _ => false,
    }
}
