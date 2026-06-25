//! Migraciones versionadas del esquema de la **BD local (SQLite/libsql)**.
//!
//! ## El problema que resuelve
//! `schema.sql` se aplica en cada arranque con `CREATE TABLE IF NOT EXISTS`. Eso crea tablas
//! nuevas en instalaciones ya existentes, pero **NO** modifica tablas que ya existen (añadir una
//! columna, cambiar algo…). Sin migraciones, una actualización que tocara una tabla existente
//! no llegaría a los clientes que ya tienen datos.
//!
//! ## Cómo funciona
//! Usamos `PRAGMA user_version` como número de versión del esquema instalado:
//!
//! - **Instalación nueva** (BD sin tablas de negocio): `schema.sql` ya deja el esquema completo
//!   más reciente, así que solo se **sella** a [`SCHEMA_VERSION`] sin correr ninguna migración.
//! - **Instalación existente**: se aplican en orden los pasos de [`MIGRATIONS`] cuya versión sea
//!   mayor que la `user_version` actual, y se sube `user_version` a medida que se aplican.
//!
//! Distinguir "nueva" de "existente" (ver [`db_is_fresh`]) es lo que evita que una instalación
//! nueva intente correr un `ALTER TABLE ADD COLUMN` de una columna que `schema.sql` ya creó
//! (lo que fallaría por "duplicate column").
//!
//! ## Cómo añadir un cambio de esquema en el futuro
//! 1. Edita `packages/database/schema.sql` para reflejar el estado final (instalaciones nuevas +
//!    aprovisionamiento de Turso lo siguen usando como fuente completa).
//! 2. Sube [`SCHEMA_VERSION`] en uno.
//! 3. Añade un paso `(nueva_version, "SQL")` al final de [`MIGRATIONS`].
//!
//! ## Reglas (para no romper nada en producción)
//! - **Solo aditivo y compatible hacia atrás**: `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`,
//!   `CREATE INDEX`. Evita renombrar/eliminar columnas mientras haya apps viejas conectadas.
//! - **Nunca edites un paso ya publicado**: añade siempre uno nuevo (los clientes ya aplicaron el
//!   anterior y no lo repetirán).
//! - Para una **tabla totalmente nueva** basta con ponerla en `schema.sql` (el `IF NOT EXISTS` la
//!   crea en todos lados); el paso de migración solo es imprescindible para tocar tablas que ya
//!   existen.
//! - Replica el mismo cambio en **Turso** (esquema compartido): ver `RELEASING.md`.

use libsql::{Connection, Error as LibsqlError, Value};

/// Versión actual del esquema. Empieza en 0 (solo el baseline de `schema.sql`, sin migraciones).
/// Incrementa en uno por cada cambio que toque una tabla existente.
pub const SCHEMA_VERSION: i64 = 0;

/// Pasos de migración para BDs **ya existentes**, en orden creciente de versión.
/// Cada entrada es `(version_destino, sql)`. El `sql` puede contener varias sentencias.
///
/// Ejemplo de un futuro cambio:
/// ```ignore
/// const MIGRATIONS: &[(i64, &str)] = &[
///     (1, "ALTER TABLE Productos ADD COLUMN Codigo_Barras TEXT;"),
///     (2, "CREATE INDEX IF NOT EXISTS idx_prod_barras ON Productos(Codigo_Barras);"),
/// ];
/// ```
const MIGRATIONS: &[(i64, &str)] = &[];

/// `true` si la BD es una instalación nueva (aún no tiene las tablas de negocio). Debe llamarse
/// **antes** de aplicar `schema.sql`. Detecta por la presencia de `Roles` (la primera tabla que
/// crea el esquema).
pub async fn db_is_fresh(conn: &Connection) -> Result<bool, LibsqlError> {
    let mut rows = conn
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Roles' LIMIT 1;",
            Vec::<Value>::new(),
        )
        .await?;
    Ok(rows.next().await?.is_none())
}

/// Lee `PRAGMA user_version` (0 si nunca se ha sellado).
pub async fn read_user_version(conn: &Connection) -> Result<i64, LibsqlError> {
    let mut rows = conn
        .query("PRAGMA user_version;", Vec::<Value>::new())
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(0);
    };
    Ok(match row.get_value(0)? {
        Value::Integer(n) => n,
        Value::Real(n) => n as i64,
        Value::Text(s) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

/// Fija `PRAGMA user_version`. `version` es una constante del código (no entrada externa), por eso
/// se interpola: PRAGMA no admite parámetros. Se ejecuta por `query` y se drena por si la versión
/// de libsql devolviera filas al fijarlo.
async fn set_user_version(conn: &Connection, version: i64) -> Result<(), LibsqlError> {
    let mut rows = conn
        .query(
            &format!("PRAGMA user_version = {version};"),
            Vec::<Value>::new(),
        )
        .await?;
    while rows.next().await?.is_some() {}
    Ok(())
}

/// Lleva el esquema al día. Debe llamarse **después** de aplicar `schema.sql`.
/// - `fresh = true`: instalación nueva → sella a [`SCHEMA_VERSION`] sin correr migraciones.
/// - `fresh = false`: aplica los pasos de [`MIGRATIONS`] pendientes y sella a [`SCHEMA_VERSION`].
pub async fn apply_migrations(conn: &Connection, fresh: bool) -> Result<(), LibsqlError> {
    if fresh {
        set_user_version(conn, SCHEMA_VERSION).await?;
        return Ok(());
    }

    let mut current = read_user_version(conn).await?;

    for (version, sql) in MIGRATIONS {
        if *version > current {
            eprintln!("[migrations] aplicando migración v{version}…");
            conn.execute_batch(sql).await?;
            set_user_version(conn, *version).await?;
            current = *version;
            eprintln!("[migrations] migración v{version} aplicada");
        }
    }

    // Sella a la última versión aunque no hubiera pasos (p. ej. un baseline existente en v0
    // la primera vez que se publica este sistema).
    if current < SCHEMA_VERSION {
        set_user_version(conn, SCHEMA_VERSION).await?;
    }

    Ok(())
}
