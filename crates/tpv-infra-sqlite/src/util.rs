//! Utilidades compartidas por los repositorios SQLite.

use crate::recording::TrackedConnection as Connection;

use tpv_application::error::{AppError, AppResult};

use crate::mapping::v_i64;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Siguiente ID libre para `table.column` (= `MAX(col)+1`, mínimo 1).
/// Reemplaza el patrón `next_table_id` que estaba duplicado por módulo.
pub async fn next_table_id(conn: &Connection, table: &str, column: &str) -> AppResult<i64> {
    let sql = format!("SELECT COALESCE(MAX({column}), 0) + 1 FROM {table};");

    let mut rows = conn.query(&sql, ()).await.map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(1);
    };

    let v = row.get_value(0).map_err(db_err)?;
    Ok(v_i64(v).unwrap_or(1).max(1))
}

/// Epoch en milisegundos (para columnas `*_At_Ms`).
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}
