//! Conexión y arranque (schema + seed) de la base de datos **SQLite local (libsql)**.
//!
//! Antes vivía en el shell Tauri (`main.rs`). El shell ahora sólo aporta la ruta de
//! datos (AppData); este módulo abre la BD (`Db`: escritor único + pool de lectura, WAL),
//! construye/actualiza el esquema aplicando las migraciones embebidas
//! (`packages/database/migrations/`, ver `migrations.rs`) y siembra el administrador inicial
//! si la BD está vacía.

use std::path::Path;
use std::sync::Arc;

use libsql::{Builder, Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_domain::login::hash_pin;

use crate::db::Db;
use crate::util::ADMIN_USUARIO_ID;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Marca de tiempo (ms desde epoch) para nombrar la copia de seguridad de la BD.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX)
}

fn value_to_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

async fn query_single_i64(conn: &Connection, sql: &str) -> AppResult<i64> {
    let mut rows = conn.query(sql, Vec::<Value>::new()).await.map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };

    let v = row.get_value(0).map_err(db_err)?;
    Ok(value_to_i64(v).unwrap_or(0))
}

/// Lee el `ID_Rol` (UUID en texto) del rol Administrador, sembrado por la migración inicial (`0001`).
async fn query_admin_role_id(conn: &Connection) -> AppResult<Option<String>> {
    let mut rows = conn
        .query(
            "SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador' LIMIT 1;",
            Vec::<Value>::new(),
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };

    match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => Ok(Some(s)),
        _ => Ok(None),
    }
}

/// Garantiza que existe la fila singleton `Email_Settings (ID=1)`.
async fn seed_email_settings(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO Email_Settings (ID) VALUES (1);",
        Vec::<Value>::new(),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Garantiza que existe la fila singleton `Contact_Settings (ID=1)`.
async fn seed_contact_settings(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO Contact_Settings (ID) VALUES (1);",
        Vec::<Value>::new(),
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Crea un usuario admin inicial (PIN `1234`, `Requiere_Setup`) **sólo** si la tabla
/// `Usuarios` está vacía. Los roles ya los siembra la migración inicial (`0001`) con sus UUIDv7 fijos.
async fn seed_admin_if_empty(conn: &Connection) -> AppResult<()> {
    let users_count = query_single_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await?;
    if users_count > 0 {
        return Ok(());
    }

    let id_admin = query_admin_role_id(conn).await?.ok_or_else(|| {
        AppError::repository("No se pudo resolver ID_Rol de Administrador")
    })?;

    let hash = hash_pin("1234").map_err(AppError::internal)?;

    conn.execute(
        r#"
        INSERT INTO Usuarios (
            ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado, Requiere_Setup
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Activo', 1);
        "#,
        vec![
            // UUID FIJO (no aleatorio): debe coincidir con el admin que siembra la nube, o la
            // Handy referenciaría un admin que la Main no tiene → FOREIGN KEY al sincronizar.
            Value::Text(ADMIN_USUARIO_ID.to_string()),
            Value::Text(id_admin),
            Value::Text("admin@local".to_string()),
            Value::Text(hash),
            Value::Text("Admin".to_string()),
            Value::Text("TPV".to_string()),
        ],
    )
    .await
    .map_err(db_err)?;

    Ok(())
}

/// Red de seguridad: si la BD ya tiene datos y hay migraciones pendientes (es decir, al abrir se le
/// van a aplicar), hace una **copia del fichero antes** de migrar. Las migraciones son solo
/// aditivas, pero migrar es el único paso irreversible del sistema, así que la copia es un seguro
/// barato.
///
/// Es best-effort: si la copia falla, se avisa por log pero NO se bloquea el arranque (mejor que
/// dejar la app sin abrir). La comprobación usa una conexión efímera que se cierra antes de copiar.
async fn backup_if_migration_pending(db_path: &Path) -> AppResult<()> {
    // Instalación nueva: no hay nada que respaldar (la creará `Db::open`).
    if !db_path.exists() {
        return Ok(());
    }

    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de BD inválida"))?;

    let database = Builder::new_local(db_path_str).build().await.map_err(db_err)?;
    let conn = database.connect().map_err(db_err)?;

    let pending = crate::migrations::has_pending(&conn).await.map_err(db_err)?;

    // Ya está al día (o BD nueva sin datos): no se migrará nada → no hace falta copia.
    if !pending {
        return Ok(());
    }

    // Volcar el WAL al fichero principal para que la copia esté completa, y cerrar la conexión
    // efímera antes de copiar (Windows bloquea el fichero mientras está abierto).
    let _ = conn
        .query("PRAGMA wal_checkpoint(TRUNCATE);", Vec::<Value>::new())
        .await;
    drop(conn);
    drop(database);

    let backup = db_path.with_file_name(format!("data.db.bak.{}", now_ms()));
    match std::fs::copy(db_path, &backup) {
        Ok(_) => eprintln!("[migrations] copia de seguridad creada: {:?}", backup),
        Err(e) => eprintln!("[migrations] aviso: no se pudo crear copia de seguridad: {e}"),
    }

    Ok(())
}

/// Abre la BD local `data.db` dentro de `app_data_dir` (escritor único + pool de lectura, WAL),
/// construye/actualiza el esquema aplicando las migraciones embebidas y siembra el admin inicial.
pub async fn init_main_db(app_data_dir: &Path) -> AppResult<Arc<Db>> {
    let db_path = app_data_dir.join("data.db");
    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de BD inválida"))?;

    // Antes de abrir (lo que dispara las migraciones), respaldar si hay migraciones pendientes.
    backup_if_migration_pending(&db_path).await?;

    let db = Db::open(db_path_str)
        .await
        .map_err(|e| AppError::repository(format!("Error abriendo la BD: {e}")))?;

    // El seed corre sobre la conexión de escritura (exclusiva) tras abrir.
    {
        let w = db.write().await;
        seed_admin_if_empty(w.raw()).await?;
        seed_email_settings(w.raw()).await?;
        seed_contact_settings(w.raw()).await?;
    }

    Ok(db)
}
