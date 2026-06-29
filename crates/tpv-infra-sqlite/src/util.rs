//! Utilidades compartidas por los repositorios SQLite.

use tpv_application::error::{AppError, AppResult};

use crate::db::Reader;
use crate::mapping::v_i64;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Siguiente ID libre para `table.column` (= `MAX(col)+1`, mínimo 1).
/// Reemplaza el patrón `next_table_id` que estaba duplicado por módulo.
pub async fn next_table_id<C: Reader>(conn: &C, table: &str, column: &str) -> AppResult<i64> {
    let sql = format!("SELECT COALESCE(MAX({column}), 0) + 1 FROM {table};");

    let mut rows = conn.query(&sql, ()).await.map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(1);
    };

    let v = row.get_value(0).map_err(db_err)?;
    Ok(v_i64(v).unwrap_or(1).max(1))
}

/// Genera un identificador único global (UUIDv7, ordenable por tiempo) como `String`.
/// Sustituye a `next_table_id` (MAX+1) para las claves primarias: al ser único en todos los
/// dispositivos, evita la divergencia de ids entre la BD local de la Main y la nube.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// UUID fijos de los seeds (idénticos en local y nube). Ver `packages/database/schema.sql`.
/// La mesa/zona BARRA usa un id fijo para que la venta rápida cuadre entre dispositivos.
pub const BARRA_MESA_ID: &str = "00000000-0000-7000-8000-000000000401";
pub const BARRA_ZONA_ID: &str = "00000000-0000-7000-8000-000000000303";

/// UUID FIJO del administrador inicial. DEBE ser idéntico en la Main (`seed_admin_if_empty`) y en
/// la nube (`ensureTenantInitialAdmin`): cada lado siembra su admin por separado, así que si el id
/// difiere acaban siendo usuarios distintos y cualquier fila de la Handy que referencie al admin de
/// la nube (fichajes, comandas…) revienta con FOREIGN KEY al aplicarse en la Main.
pub const ADMIN_USUARIO_ID: &str = "00000000-0000-7000-8000-000000000501";

/// Epoch en milisegundos (para columnas `*_At_Ms`).
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => i64::MAX,
    }
}

/// Fecha-hora local del dispositivo `YYYY-MM-DD HH:MM:SS` (mismo formato que `datetime('now')`).
pub fn now_local_datetime() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Fecha local del dispositivo `YYYY-MM-DD` (mismo formato que `date('now')`).
pub fn now_local_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
