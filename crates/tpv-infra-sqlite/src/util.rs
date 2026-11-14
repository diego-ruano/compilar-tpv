//! Utilidades compartidas por los repositorios SQLite.

/// Genera un identificador único global (UUIDv7, ordenable por tiempo) como `String`.
/// Al ser único en todos los dispositivos, evita la divergencia de claves primarias entre
/// la BD local de la Main y la nube (RI-22).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Canal de una comanda (`Comandas.Canal`). 'MESA' = consumo en sala (lleva mesa);
/// 'BARRA' = venta rápida (sin mesa). Ver la nota de la tabla `Comandas` en
/// `packages/database/migrations/0001_inicial.sql`.
pub const CANAL_MESA: &str = "MESA";
pub const CANAL_BARRA: &str = "BARRA";

/// UUID FIJO del administrador inicial. DEBE ser idéntico en la Main (`seed_admin_if_empty`) y en
/// la nube (`sembrarAdminInicial`, en `tenantHub.alta.ts`): cada lado siembra su admin por
/// separado, así que si el id difiere acaban siendo usuarios distintos y cualquier fila de la Handy
/// que referencie al admin de la nube (fichajes, comandas…) revienta con FOREIGN KEY al aplicarse
/// en la Main.
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
