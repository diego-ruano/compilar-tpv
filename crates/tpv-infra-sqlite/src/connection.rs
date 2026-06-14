//! Conexión y arranque (schema + seed) de la base de datos **SQLite local (libsql)**.
//!
//! Antes vivía en el shell Tauri (`main.rs`). El shell ahora sólo aporta la ruta de
//! datos (AppData) y el contenido del `schema.sql`; este módulo abre la BD (`Db`: escritor
//! único + pool de lectura, WAL), aplica el esquema y siembra el administrador inicial si la
//! BD está vacía.

use std::path::Path;
use std::sync::Arc;

use libsql::{Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_domain::login::hash_pin;

use crate::db::Db;
use crate::util::new_id;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
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

/// Lee el `ID_Rol` (UUID en texto) del rol Administrador, sembrado por `schema.sql`.
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

/// Crea un usuario admin inicial (PIN `1234`, `Requiere_Setup`) **sólo** si la tabla
/// `Usuarios` está vacía. Los roles ya los siembra `schema.sql` con sus UUIDv7 fijos.
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
            Value::Text(new_id()),
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

/// Abre la BD local `data.db` dentro de `app_data_dir` (escritor único + pool de lectura, WAL),
/// aplica `schema` (el contenido de `schema.sql`) y siembra el administrador inicial.
pub async fn init_main_db(app_data_dir: &Path, schema: &str) -> AppResult<Arc<Db>> {
    let db_path = app_data_dir.join("data.db");
    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de BD inválida"))?;

    let db = Db::open(db_path_str, schema)
        .await
        .map_err(|e| AppError::repository(format!("Error abriendo la BD: {e}")))?;

    // El seed corre sobre la conexión de escritura (exclusiva) tras abrir.
    {
        let w = db.write().await;
        seed_admin_if_empty(w.raw()).await?;
    }

    Ok(db)
}
