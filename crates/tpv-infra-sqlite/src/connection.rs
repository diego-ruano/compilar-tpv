//! Conexión y arranque (schema + seed) de la base de datos **SQLite local (libsql)**.
//!
//! Antes vivía en el shell Tauri (`main.rs`). El shell ahora sólo aporta la ruta de
//! datos (AppData); este módulo abre la BD (`Db`: escritor único + pool de lectura, WAL),
//! construye/actualiza el esquema aplicando las migraciones embebidas
//! (`packages/database/migrations/`, ver `migrations.rs`) y siembra el administrador inicial
//! si la BD está vacía.

use crate::util::ADMIN_USUARIO_ID;
use crate::consultas::{db_err};
use crate::util::now_ms;
use std::path::Path;
use std::sync::Arc;

use libsql::{Builder, Value};
use crate::ejecutor::Connection;

use tpv_application::error::{AppError, AppResult};
use tpv_domain::login::hash_pin;

use crate::db::Db;

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
///
/// `aprovisionado` es la guardia: dice que este dispositivo YA tiene licencia activada, es decir
/// que `Usuarios` vacía no significa "instalación nueva" sino "BD perdida" (borrada, corrupta,
/// restaurada a medias). Sembrar ahí sería fabricar un admin con el PIN público del seed y, peor,
/// habilitar la pantalla de setup: al completarla, el `UPDATE Usuarios` sale por el outbox y pisa
/// en la nube la credencial buena del admin real. La señal vive FUERA de la BD (`license_state.json`
/// + la clave del keyring), que es justo lo que sobrevive a perderla.
async fn seed_admin_if_empty(conn: &Connection, aprovisionado: bool) -> AppResult<()> {
    let users_count = query_single_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await?;
    if users_count > 0 {
        return Ok(());
    }

    if aprovisionado {
        // Sin admin, `setup_pendiente` devuelve `requiere_recuperacion` y la app entra en la
        // pantalla de recuperación (bootstrap desde la nube) en vez de en la de primer arranque.
        tracing::warn!(
            target: "tpv::startup",
            "BD sin usuarios en un dispositivo ya aprovisionado: no se siembra admin, hace falta recuperar desde la nube"
        );
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
    let path = db_path.to_owned();
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || rt.block_on(backup_antes_de_migrar(&path))).await.map_err(db_err)?
}

async fn backup_antes_de_migrar(db_path: &Path) -> AppResult<()> {
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
        Ok(bytes) => tracing::info!(
            target: "tpv::migrations",
            copia = %backup.file_name().unwrap_or_default().to_string_lossy(), bytes,
            "copia de seguridad previa a migrar creada"
        ),
        Err(e) => tracing::warn!(
            target: "tpv::migrations",
            copia = %backup.file_name().unwrap_or_default().to_string_lossy(), error = %e,
            "no se pudo crear la copia de seguridad previa a migrar"
        ),
    }

    Ok(())
}

/// Abre la BD local `data.db` dentro de `app_data_dir` (escritor único + pool de lectura, WAL),
/// construye/actualiza el esquema aplicando las migraciones embebidas y siembra el admin inicial.
///
/// `aprovisionado` lo decide el shell (es quien conoce la licencia): ver [`seed_admin_if_empty`].
pub async fn init_main_db(app_data_dir: &Path, aprovisionado: bool) -> AppResult<Arc<Db>> {
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
        seed_admin_if_empty(w.raw(), aprovisionado).await?;
        seed_contact_settings(w.raw()).await?;
    }

    // Una base sin usuarios (datos perdidos) o restaurada y aún sin reconciliar no puede admitir
    // escrituras de negocio: acabarían en `_Sync_Outbox`, que con la BD en recuperación no se
    // puede drenar —el socket está parado— ni ignorar —bloquea la restauración—. Va aquí, al
    // abrir, porque es el único punto por el que pasan los tres caminos: arranque, elección de
    // modo y sustitución por una copia restaurada.
    let estado = crate::recovery::status(&db).await?;
    db.bloquear_escrituras_de_negocio(
        estado.state != tpv_contracts::recovery::RecoveryState::Ready,
    );

    Ok(db)
}


