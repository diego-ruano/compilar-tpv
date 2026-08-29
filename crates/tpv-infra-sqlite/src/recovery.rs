//! Copias locales y estado persistente de recuperación de la Main.
//!
//! Las copias se crean con `VACUUM INTO`: SQLite produce un fichero autocontenido y coherente
//! aunque la base viva use WAL. Restaurar es reemplazar el fichero completo, no copiar sólo las
//! tablas de negocio; así también sobreviven el outbox, el checkpoint y la PII cifrada que nunca
//! se sube a la nube.

use std::path::{Path, PathBuf};

use libsql::{Builder, Connection, Value};
use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::recovery::{LocalBackupInfo, RecoveryState, RecoveryStatus};

use crate::db::Db;

const BACKUP_DIR: &str = "backups";
const BACKUP_PREFIX: &str = "data-";
const BACKUP_SUFFIX: &str = ".db";
const BACKUPS_A_CONSERVAR: usize = 7;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn corrupta(e: impl std::fmt::Display) -> AppError {
    AppError::coded(ErrorCode::BackupCorrupt, e.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX)
}

fn valor_i64(value: Value) -> Option<i64> {
    match value {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse().ok(),
        _ => None,
    }
}

async fn scalar_i64(conn: &Connection, sql: &str) -> AppResult<i64> {
    let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };
    Ok(valor_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0))
}

pub async fn status(db: &Db) -> AppResult<RecoveryStatus> {
    let r = db.read().await;
    let conn = r.conn();
    let pending = scalar_i64(
        conn,
        "SELECT Reconciliation_Pending FROM _Recovery_State WHERE Id = 1;",
    )
    .await?
        != 0;
    let users = scalar_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await?;

    let state = if pending {
        RecoveryState::ReconciliationPending
    } else if users == 0 {
        RecoveryState::DataMissing
    } else {
        RecoveryState::Ready
    };
    Ok(RecoveryStatus { state })
}

/// Mantiene bloqueado el login hasta que el ciclo online confirme la convergencia.
pub async fn mark_reconciliation_pending(db: &Db) -> AppResult<()> {
    let w = db.write().await;
    w.raw()
        .execute(
            "UPDATE _Recovery_State SET Reconciliation_Pending = 1 WHERE Id = 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    Ok(())
}

pub async fn complete_reconciliation(db: &Db) -> AppResult<()> {
    let w = db.write().await;
    w.raw()
        .execute(
            "UPDATE _Recovery_State SET Reconciliation_Pending = 0 WHERE Id = 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    Ok(())
}

fn parse_backup(path: &Path) -> Option<LocalBackupInfo> {
    let id = path.file_name()?.to_str()?.to_string();
    let stamp = id
        .strip_prefix(BACKUP_PREFIX)?
        .strip_suffix(BACKUP_SUFFIX)?
        .parse::<i64>()
        .ok()?;
    let size_bytes = std::fs::metadata(path).ok()?.len().min(i64::MAX as u64) as i64;
    Some(LocalBackupInfo {
        id,
        created_at_ms: stamp,
        size_bytes,
    })
}

pub fn list_backups(app_data_dir: &Path) -> AppResult<Vec<LocalBackupInfo>> {
    let dir = app_data_dir.join(BACKUP_DIR);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut out = std::fs::read_dir(dir)
        .map_err(db_err)?
        .filter_map(Result::ok)
        .filter_map(|entry| parse_backup(&entry.path()))
        .collect::<Vec<_>>();
    out.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(out)
}

async fn validate_backup(path: &Path) -> AppResult<()> {
    let path_str = path
        .to_str()
        .ok_or_else(|| corrupta("La ruta de la copia no es válida"))?;
    let database = Builder::new_local(path_str)
        .build()
        .await
        .map_err(|e| corrupta(format!("No se puede abrir la copia: {e}")))?;
    let conn = database
        .connect()
        .map_err(|e| corrupta(format!("No se puede leer la copia: {e}")))?;

    let mut rows = conn
        .query("PRAGMA quick_check;", ())
        .await
        .map_err(|e| corrupta(format!("Comprobación de integridad fallida: {e}")))?;
    let mut vio_ok = false;
    while let Some(row) = rows.next().await.map_err(|e| corrupta(e.to_string()))? {
        match row.get_value(0).map_err(|e| corrupta(e.to_string()))? {
            Value::Text(s) if s.eq_ignore_ascii_case("ok") => vio_ok = true,
            Value::Text(s) => return Err(corrupta(format!("SQLite informa: {s}"))),
            _ => return Err(corrupta("Respuesta de integridad ilegible")),
        }
    }
    if !vio_ok {
        return Err(corrupta("La copia no superó la comprobación de integridad"));
    }

    let users = scalar_i64(&conn, "SELECT COUNT(*) FROM Usuarios;")
        .await
        .map_err(|e| corrupta(format!("La copia no contiene el esquema esperado: {e}")))?;
    if users == 0 {
        return Err(corrupta("La copia no contiene ningún usuario"));
    }
    Ok(())
}

/// Crea una copia si la BD está operativa. En recuperación devuelve `Ok(None)`: una base vacía o
/// todavía sin reconciliar no debe desplazar de la retención a una copia buena.
pub async fn create_backup(db: &Db, app_data_dir: &Path) -> AppResult<Option<LocalBackupInfo>> {
    if status(db).await?.state != RecoveryState::Ready {
        return Ok(None);
    }

    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let stamp = now_ms();
    let tmp = dir.join(format!(".backup-{stamp}.tmp"));
    let final_path = dir.join(format!("{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}"));
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta temporal de backup inválida"))?
        .to_string();

    {
        // `VACUUM INTO` toma una instantánea consistente. El escritor único impide que una
        // operación local se confirme a mitad del proceso; las lecturas pueden seguir trabajando.
        let w = db.write().await;
        w.raw()
            .execute("VACUUM INTO ?1;", vec![Value::Text(tmp_str)])
            .await
            .map_err(db_err)?;
    }

    if let Err(e) = validate_backup(&tmp).await {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &final_path).map_err(db_err)?;

    let mut backups = list_backups(app_data_dir)?;
    for vieja in backups.iter().skip(BACKUPS_A_CONSERVAR) {
        // Los ids proceden exclusivamente de `list_backups`, que sólo admite nuestro patrón.
        std::fs::remove_file(dir.join(&vieja.id)).map_err(db_err)?;
    }
    backups.truncate(BACKUPS_A_CONSERVAR);

    parse_backup(&final_path)
        .map(Some)
        .ok_or_else(|| AppError::internal("La copia creada no se pudo volver a catalogar"))
}

fn resolve_backup(app_data_dir: &Path, id: &str) -> AppResult<PathBuf> {
    let candidate = Path::new(id);
    if candidate.components().count() != 1 {
        return Err(AppError::validation("Identificador de copia no válido"));
    }
    let path = app_data_dir.join(BACKUP_DIR).join(candidate);
    if parse_backup(&path).is_none() || !path.is_file() {
        return Err(AppError::not_found(
            "La copia local seleccionada ya no existe",
        ));
    }
    Ok(path)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn discard_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
}

/// Copia y valida el respaldo en un fichero temporal independiente. Además lo marca pendiente de
/// reconciliación ANTES del intercambio, para que ni un crash entre pasos pueda abrir el login.
pub async fn prepare_restore(app_data_dir: &Path, id: &str) -> AppResult<PathBuf> {
    let source = resolve_backup(app_data_dir, id)?;
    validate_backup(&source).await?;

    let prepared = app_data_dir.join(format!("data.restore.{}.tmp", now_ms()));
    std::fs::copy(source, &prepared).map_err(db_err)?;

    let result = async {
        let prepared_str = prepared
            .to_str()
            .ok_or_else(|| AppError::internal("Ruta temporal de restauración inválida"))?;
        let db = Db::open(prepared_str)
            .await
            .map_err(|e| corrupta(format!("No se puede preparar la copia: {e}")))?;
        mark_reconciliation_pending(&db).await?;
        {
            let w = db.write().await;
            let _ = w.raw().query("PRAGMA wal_checkpoint(TRUNCATE);", ()).await;
        }
        drop(db);
        validate_backup(&prepared).await
    }
    .await;
    if let Err(e) = result {
        discard_prepared(&prepared);
        return Err(e);
    }
    // `Db::open` trabaja en WAL. El checkpoint deja el contenido en el fichero principal y estos
    // sidecars ya no pertenecen a ningún proceso; no deben quedar acumulándose en AppData.
    discard_sidecars(&prepared);
    Ok(prepared)
}

#[derive(Debug)]
pub struct InstalledRestore {
    pub previous: Option<PathBuf>,
}

/// Intercambia ficheros con la BD ya cerrada. La anterior se mueve a `backups/pre-restore-*`, de
/// modo que un fallo al reabrir se puede revertir sin pérdida.
pub fn install_prepared(app_data_dir: &Path, prepared: &Path) -> AppResult<InstalledRestore> {
    let data = app_data_dir.join("data.db");
    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let previous = if data.exists() {
        let p = dir.join(format!("pre-restore-{}.db", now_ms()));
        std::fs::rename(&data, &p).map_err(db_err)?;
        Some(p)
    } else {
        None
    };

    // Un WAL de la base anterior no puede acompañar al fichero restaurado. Se aparta ANTES de
    // instalar el nuevo archivo, de modo que a partir del `rename(prepared, data)` ya no queda
    // ningún paso falible que pueda devolver un estado ambiguo al llamador.
    for suffix in ["-wal", "-shm"] {
        let sidecar = app_data_dir.join(format!("data.db{suffix}"));
        if sidecar.exists() {
            let archived = dir.join(format!("pre-restore-{}{}", now_ms(), suffix));
            if let Err(e) = std::fs::rename(sidecar, archived) {
                if let Some(ref p) = previous {
                    let _ = std::fs::rename(p, &data);
                }
                return Err(db_err(e));
            }
        }
    }

    if let Err(e) = std::fs::rename(prepared, &data) {
        if let Some(ref p) = previous {
            let _ = std::fs::rename(p, &data);
        }
        return Err(db_err(e));
    }

    Ok(InstalledRestore { previous })
}

pub fn rollback_install(app_data_dir: &Path, installed: InstalledRestore) -> AppResult<()> {
    let data = app_data_dir.join("data.db");
    if data.exists() {
        let failed = app_data_dir
            .join(BACKUP_DIR)
            .join(format!("failed-restore-{}.db", now_ms()));
        std::fs::rename(&data, failed).map_err(db_err)?;
    }
    // `init_main_db` pudo crear sidecars antes de descubrir que la copia no era utilizable.
    // Apartarlos evita que SQLite los interprete como WAL de la base anterior que restauramos.
    for suffix in ["-wal", "-shm"] {
        let sidecar = app_data_dir.join(format!("data.db{suffix}"));
        if sidecar.exists() {
            let failed = app_data_dir.join(BACKUP_DIR).join(format!(
                "failed-restore-{}{}",
                now_ms(),
                suffix
            ));
            std::fs::rename(sidecar, failed).map_err(db_err)?;
        }
    }
    if let Some(previous) = installed.previous {
        std::fs::rename(previous, data).map_err(db_err)?;
    }
    Ok(())
}

pub fn discard_prepared(path: &Path) {
    let _ = std::fs::remove_file(path);
    discard_sidecars(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(nombre: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "tpv_recovery_{nombre}_{}_{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ))
    }

    async fn db_operativa(dir: &Path) -> std::sync::Arc<Db> {
        std::fs::create_dir_all(dir).unwrap();
        crate::connection::init_main_db(dir, false).await.unwrap()
    }

    #[tokio::test]
    async fn backup_es_integro_y_conserva_el_contenido_local() {
        let dir = test_dir("contenido");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "UPDATE Usuarios SET Nombre = 'Nombre sólo local' WHERE ID_Usuario = ?1;",
                    vec![Value::Text(crate::util::ADMIN_USUARIO_ID.to_string())],
                )
                .await
                .unwrap();
        }

        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let path = dir.join(BACKUP_DIR).join(backup.id);
        validate_backup(&path).await.unwrap();

        let database = Builder::new_local(path.to_str().unwrap())
            .build()
            .await
            .unwrap();
        let conn = database.connect().unwrap();
        let mut rows = conn
            .query(
                "SELECT Nombre FROM Usuarios WHERE ID_Usuario = ?1;",
                vec![Value::Text(crate::util::ADMIN_USUARIO_ID.to_string())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(
            row.get_value(0).unwrap(),
            Value::Text("Nombre sólo local".into())
        );

        drop(rows);
        drop(conn);
        drop(database);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn preparar_una_copia_deja_el_login_bloqueado() {
        let dir = test_dir("pending");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id).await.unwrap();

        let restored = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert_eq!(
            status(&restored).await.unwrap().state,
            RecoveryState::ReconciliationPending
        );

        drop(restored);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn una_copia_corrupta_se_rechaza_antes_de_tocar_data_db() {
        let dir = test_dir("corrupta");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rota.db");
        std::fs::write(&path, b"esto no es sqlite").unwrap();

        let err = validate_backup(&path).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn la_retencion_conserva_solo_las_siete_mas_recientes() {
        let dir = test_dir("retencion");
        let db = db_operativa(&dir).await;
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for stamp in 1..=7 {
            std::fs::write(
                backups.join(format!("{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}")),
                b"antigua",
            )
            .unwrap();
        }

        create_backup(&db, &dir).await.unwrap().unwrap();
        let list = list_backups(&dir).unwrap();
        assert_eq!(list.len(), BACKUPS_A_CONSERVAR);
        assert!(list.iter().all(|b| b.created_at_ms != 1));

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}
