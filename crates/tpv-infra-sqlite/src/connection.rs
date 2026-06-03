//! Conexión y arranque (schema + seed) de la base de datos **SQLite local (libsql)**.
//!
//! Antes vivía en el shell Tauri (`main.rs`). El shell ahora sólo aporta la ruta de
//! datos (AppData) y el contenido del `schema.sql`; este módulo construye la conexión a
//! `data.db`, aplica el esquema y siembra el administrador inicial si la BD está vacía.

use std::path::Path;

use libsql::{Builder, Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_domain::login::hash_pin;

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

/// Crea el rol Administrador y un usuario admin inicial (PIN `1234`, `Requiere_Setup`)
/// **sólo** si la tabla `Usuarios` está vacía.
async fn seed_admin_if_empty(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO Roles (Nombre_Rol) VALUES ('Administrador');",
        Vec::<Value>::new(),
    )
    .await
    .map_err(db_err)?;

    let users_count = query_single_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await?;
    if users_count > 0 {
        return Ok(());
    }

    let id_admin = query_single_i64(
        conn,
        "SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador' LIMIT 1;",
    )
    .await?;

    if id_admin <= 0 {
        return Err(AppError::repository(
            "No se pudo resolver ID_Rol de Administrador",
        ));
    }

    let hash = hash_pin("1234").map_err(AppError::internal)?;

    conn.execute(
        r#"
        INSERT INTO Usuarios (
            ID_Rol, Email, Password_Hash, Nombre, Apellido, Estado, Requiere_Setup
        )
        VALUES (?1, ?2, ?3, ?4, ?5, 'Activo', 1);
        "#,
        vec![
            Value::Integer(id_admin),
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

/// Construye la conexión local a `data.db` dentro de `app_data_dir`, aplica `schema`
/// (el contenido de `schema.sql`) y siembra el administrador inicial.
pub async fn init_main_db(app_data_dir: &Path, schema: &str) -> AppResult<Connection> {
    let db_path = app_data_dir.join("data.db");
    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de BD inválida"))?;

    let db = Builder::new_local(db_path_str)
        .build()
        .await
        .map_err(db_err)?;

    let c = db.connect().map_err(db_err)?;

    c.execute_batch(schema)
        .await
        .map_err(|e| AppError::repository(format!("Error ejecutando schema.sql: {e}")))?;

    seed_admin_if_empty(&c).await?;

    Ok(c)
}
