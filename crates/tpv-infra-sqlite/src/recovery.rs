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
/// Copias traídas de fuera (un USB, una carpeta de red). Llevan prefijo propio porque la
/// retención de las diarias NO debe alcanzarlas: las ha puesto ahí una persona a mano.
const IMPORT_PREFIX: &str = "import-";
const BACKUP_SUFFIX: &str = ".db";
const BACKUPS_A_CONSERVAR: usize = 7;
/// Copia que deja el paso de migraciones (`data.db.bak.<ms>`, ver `connection.rs`). Vive en la
/// raíz de AppData, no en `backups/`, así que la retención de las diarias nunca la vio.
const MIGRACION_PREFIX: &str = "data.db.bak.";
const MIGRACIONES_A_CONSERVAR: usize = 2;
/// Base que no se pudo ni abrir y se apartó para poder reconstruir en su sitio. No se lista como
/// copia restaurable: si SQLite no la abre, ofrecerla sería ofrecer el problema.
const ILEGIBLE_PREFIX: &str = "ilegible-";

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
    drop(w);
    db.bloquear_escrituras_de_negocio(true);
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
    drop(w);
    // El equipo vuelve a operar: se reabre el paso a las escrituras de negocio.
    db.bloquear_escrituras_de_negocio(false);
    Ok(())
}

fn parse_backup(path: &Path) -> Option<LocalBackupInfo> {
    let id = path.file_name()?.to_str()?.to_string();
    let (importada, resto) = match id.strip_prefix(BACKUP_PREFIX) {
        Some(r) => (false, r),
        None => (true, id.strip_prefix(IMPORT_PREFIX)?),
    };
    let stamp = resto.strip_suffix(BACKUP_SUFFIX)?.parse::<i64>().ok()?;
    let size_bytes = std::fs::metadata(path).ok()?.len().min(i64::MAX as u64) as i64;
    Some(LocalBackupInfo {
        id,
        created_at_ms: stamp,
        size_bytes,
        importada,
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
        // `VACUUM INTO` abre su propia transacción de LECTURA, así que en WAL produce una
        // instantánea coherente sin excluir al escritor. Va por el pool de lectura a propósito:
        // tomando el `WriteGuard` se bloquearían los cobros durante toda la copia, y este job
        // vence por reloj de pared, así que puede caer en plena cena.
        let r = db.read().await;
        r.conn()
            .execute("VACUUM INTO ?1;", vec![Value::Text(tmp_str)])
            .await
            .map_err(db_err)?;
    }

    if let Err(e) = validate_backup(&tmp).await {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &final_path).map_err(db_err)?;

    // La retención es la de las copias DIARIAS. Una importada la ha traído alguien a mano tras
    // perder el equipo: que caduque por antigüedad sería tirar justo lo que vino a salvar.
    let diarias = list_backups(app_data_dir)?
        .into_iter()
        .filter(|b| !b.importada)
        .collect::<Vec<_>>();
    for vieja in diarias.iter().skip(BACKUPS_A_CONSERVAR) {
        // Los ids proceden exclusivamente de `list_backups`, que sólo admite nuestro patrón.
        // Un borrado fallido (fichero en uso por un antivirus) NO invalida la copia recién hecha:
        // devolver `Err` marcaría el job como fallido y su backoff crearía otra copia enseguida.
        if let Err(e) = std::fs::remove_file(dir.join(&vieja.id)) {
            tracing::warn!(target: "tpv::recovery", copia = %vieja.id, error = %e, "no se pudo purgar una copia antigua");
        }
    }

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

/// Aparta una `data.db` que no se ha podido abrir, para poder crear una vacía en su sitio.
///
/// No la borra. Que SQLite no la abra no significa que no quede nada dentro: es lo único que queda
/// de las ventas que no llegaran a subir, y un técnico puede rescatar parte con otras herramientas.
///
/// Devuelve `None` si no había fichero (no es un error: es el caso de la base borrada).
pub fn archivar_base_ilegible(app_data_dir: &Path) -> AppResult<Option<PathBuf>> {
    let data = app_data_dir.join("data.db");
    if !data.exists() {
        return Ok(None);
    }

    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let sello = now_ms();
    let destino = dir.join(format!("{ILEGIBLE_PREFIX}{sello}{BACKUP_SUFFIX}"));
    std::fs::rename(&data, &destino).map_err(db_err)?;

    // Los sidecars se van con ella: un WAL huérfano de la base anterior no puede quedarse al lado
    // de la que vamos a crear, o SQLite intentaría aplicarlo sobre un fichero que no es el suyo.
    for suffix in ["-wal", "-shm"] {
        let sidecar = app_data_dir.join(format!("data.db{suffix}"));
        if sidecar.exists() {
            let _ = std::fs::rename(
                sidecar,
                dir.join(format!("{ILEGIBLE_PREFIX}{sello}{suffix}")),
            );
        }
    }

    Ok(Some(destino))
}

/// Copia un respaldo a una ruta de fuera del equipo (un USB, una carpeta de red).
///
/// Es la ÚNICA forma de sacar del equipo el `DNI`, el `IBAN` y el `Numero_Seguridad_Social` del
/// personal: van cifrados con una clave que nunca sube a la nube (TRAB-03), así que el volcado del
/// worker no los trae. Sin una copia fuera del disco, un disco muerto se los lleva para siempre.
pub async fn export_backup(app_data_dir: &Path, id: &str, destino: &Path) -> AppResult<()> {
    let source = resolve_backup(app_data_dir, id)?;
    // Validar ANTES de copiar: exportar una copia ilegible es peor que no exportar nada, porque
    // parece un respaldo y no lo es hasta el día que hace falta.
    validate_backup(&source).await?;

    if let Some(parent) = destino.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(db_err)?;
        }
    }
    std::fs::copy(&source, destino).map_err(db_err)?;
    Ok(())
}

/// Trae al almacén local una copia que estaba fuera, para poder restaurarla como cualquier otra.
///
/// Se valida igual que las nuestras, pero eso comprueba que sea una base sana **de este esquema**,
/// no que sea de este mismo negocio: hoy la BD no lleva ninguna marca del tenant con la que
/// distinguirlo. La pantalla lo advierte. El daño de equivocarse queda acotado a este equipo —
/// restaurar no llena el outbox, así que nada de eso se replica— y se deshace recuperando de la
/// nube.
pub async fn import_backup(app_data_dir: &Path, origen: &Path) -> AppResult<LocalBackupInfo> {
    if !origen.is_file() {
        return Err(AppError::not_found("El archivo seleccionado ya no existe"));
    }
    validate_backup(origen).await?;

    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;

    // Si el nombre es el de una copia nuestra se conserva su instante original: la fecha es lo
    // único por lo que se elige una copia, y sellarla con la hora de la importación convertiría
    // "la de anteayer" en "la de ahora mismo".
    let stamp = origen
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| {
            n.strip_prefix(BACKUP_PREFIX)
                .or_else(|| n.strip_prefix(IMPORT_PREFIX))
        })
        .and_then(|r| r.strip_suffix(BACKUP_SUFFIX))
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(now_ms);

    let final_path = dir.join(format!("{IMPORT_PREFIX}{stamp}{BACKUP_SUFFIX}"));
    let tmp = dir.join(format!(".import-{}.tmp", now_ms()));
    std::fs::copy(origen, &tmp).map_err(db_err)?;
    if let Err(e) = std::fs::rename(&tmp, &final_path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(db_err(e));
    }

    parse_backup(&final_path)
        .ok_or_else(|| AppError::internal("La copia importada no se pudo catalogar"))
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

/// Vacía `_Sync_Failed` en la copia que se va a instalar.
///
/// Una cuarentena (`Quarantined = 1`) no se borra nunca: es la constancia de que una operación de
/// la nube se rindió tras cinco intentos, y `recovery_complete` exige que no haya ninguna. Sin
/// esto, una cuarentena vieja viaja dentro de las siete copias diarias y deja **cualquier**
/// restauración local imposible de completar, en silencio y para siempre. Lo que registra esa
/// tabla son intentos contra un estado de la BD que estamos reemplazando, así que aquí no dice
/// nada; el volcado desde la nube la vacía por la misma razón (ver `sync.rs::bootstrap_restaurar`).
/// Las que no llegaron a cuarentena vuelven a ofrecerse en el catch-up con el contador a cero.
async fn limpiar_registro_de_fallos(db: &Db) -> AppResult<()> {
    let w = db.write().await;
    w.raw()
        .execute("DELETE FROM _Sync_Failed;", ())
        .await
        .map_err(db_err)?;
    Ok(())
}

/// Guardia de toda restauración: reemplazar el fichero se lleva por delante el outbox actual.
///
/// El camino real (una BD recién perdida) tiene el outbox vacío y no lo nota. Lo que para es el
/// accidente: llegar a la pantalla de recuperación con una BD sana —hoy basta un fallo de arranque
/// inesperado— y restaurar encima una copia de ayer, perdiendo las ventas que aún no habían
/// subido. Es la misma comprobación que ya hacía el volcado desde la nube.
///
/// Se exceptúa una BD que ya está bloqueada en reconciliación: no está vendiendo, y negarle la
/// única alternativa que le queda (otra copia, o la nube) sería dejarla en un callejón sin salida.
pub async fn asegurar_reemplazo_seguro(db: &Db) -> AppResult<()> {
    let r = db.read().await;
    let conn = r.conn();
    let pendiente = scalar_i64(
        conn,
        "SELECT Reconciliation_Pending FROM _Recovery_State WHERE Id = 1;",
    )
    .await?
        != 0;
    if pendiente {
        return Ok(());
    }
    // Y una base SIN USUARIOS tampoco está vendiendo: no se puede iniciar sesión, así que ninguna
    // operación suya puede ser una venta. Si tiene algo en el outbox, lo escribió algo que no
    // debería haber escrito (es lo que motivó el cerrojo de `db.rs`), y dejar que eso bloquee la
    // única salida cambia un dato que no existe por un equipo inservible. También es lo que
    // rescata a los equipos que ya se quedaron atascados antes de que el cerrojo existiera.
    if scalar_i64(conn, "SELECT COUNT(*) FROM Usuarios;").await? == 0 {
        return Ok(());
    }
    let outbox = scalar_i64(conn, "SELECT COUNT(*) FROM _Sync_Outbox;").await?;
    if outbox > 0 {
        return Err(AppError::conflict(format!(
            "Hay {outbox} operaciones de este equipo sin subir a la nube. Restaurar las borraría: espera a que se sincronicen antes de recuperar."
        )));
    }
    Ok(())
}

/// Ficheros que deja por el camino una restauración: la BD anterior (`pre-restore-*`), la copia
/// que no se pudo abrir (`failed-restore-*`) y los temporales a medio preparar.
///
/// No llevan el prefijo de las copias diarias, así que la retención de siete no los ve y cada
/// intento acumulaba una BD entera en AppData. Se conservan los dos más recientes de cada familia:
/// son la marcha atrás manual si alguien restaura la copia equivocada.
pub fn purge_restore_leftovers(app_data_dir: &Path) -> AppResult<()> {
    const FAMILIAS_A_CONSERVAR: usize = 2;
    const TMP_ANTIGUEDAD_MS: i64 = 60 * 60 * 1000;

    let dir = app_data_dir.join(BACKUP_DIR);
    if dir.exists() {
        for familia in ["pre-restore-", "failed-restore-", ILEGIBLE_PREFIX] {
            // El nombre lleva el instante justo detrás del prefijo; los sidecars (`-wal`/`-shm`)
            // comparten instante con su `.db` y se van con él, no por separado.
            let mut sellos: Vec<i64> = Vec::new();
            let mut ficheros: Vec<(i64, PathBuf)> = Vec::new();
            for entry in std::fs::read_dir(&dir).map_err(db_err)?.flatten() {
                let path = entry.path();
                let Some(nombre) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let Some(resto) = nombre.strip_prefix(familia) else {
                    continue;
                };
                let digitos: String = resto.chars().take_while(char::is_ascii_digit).collect();
                let Ok(sello) = digitos.parse::<i64>() else {
                    continue;
                };
                sellos.push(sello);
                ficheros.push((sello, path));
            }
            sellos.sort_unstable();
            sellos.dedup();
            let conservados: std::collections::HashSet<i64> = sellos
                .iter()
                .rev()
                .take(FAMILIAS_A_CONSERVAR)
                .copied()
                .collect();
            for (sello, path) in ficheros {
                if conservados.contains(&sello) {
                    continue;
                }
                if let Err(e) = std::fs::remove_file(&path) {
                    tracing::warn!(target: "tpv::recovery", ruta = ?path, error = %e, "no se pudo purgar un resto de restauración");
                }
            }
        }
    }

    // Los `data.restore.*.tmp` viven en la raíz de AppData porque el intercambio es un `rename`
    // dentro del mismo volumen. Sólo se borran los viejos: uno recién escrito puede ser el de una
    // restauración en curso.
    let ahora = now_ms();
    for entry in std::fs::read_dir(app_data_dir).map_err(db_err)?.flatten() {
        let path = entry.path();
        let Some(nombre) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !nombre.starts_with("data.restore.") {
            continue;
        }
        let sello: i64 = nombre
            .trim_start_matches("data.restore.")
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(ahora);
        if ahora.saturating_sub(sello) < TMP_ANTIGUEDAD_MS {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(target: "tpv::recovery", ruta = ?path, error = %e, "no se pudo purgar un temporal de restauración");
        }
    }

    // Copias previas a una migración (`data.db.bak.<ms>`). Son la marcha atrás de una
    // actualización con esquema nuevo, así que se conservan las dos últimas; sin esto cada
    // actualización dejaba una base de datos entera en AppData, para siempre.
    let mut migraciones: Vec<(i64, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(app_data_dir).map_err(db_err)?.flatten() {
        let path = entry.path();
        let Some(nombre) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(resto) = nombre.strip_prefix(MIGRACION_PREFIX) else {
            continue;
        };
        let Ok(sello) = resto.parse::<i64>() else {
            continue;
        };
        migraciones.push((sello, path));
    }
    migraciones.sort_unstable_by_key(|(sello, _)| std::cmp::Reverse(*sello));
    for (_, path) in migraciones.into_iter().skip(MIGRACIONES_A_CONSERVAR) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(target: "tpv::recovery", ruta = ?path, error = %e, "no se pudo purgar una copia de migración");
        }
    }

    Ok(())
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
        limpiar_registro_de_fallos(&db).await?;
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
    use crate::db::Writer;

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

    async fn cuenta(db: &Db, sql: &str) -> i64 {
        let r = db.read().await;
        scalar_i64(r.conn(), sql).await.unwrap()
    }

    async fn registrar_cuarentena(db: &Db) {
        let w = db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,                  Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms)                  VALUES ('op-vieja', 7, '[]', 5, 1, 'no such table', 1, 1);",
                (),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn una_cuarentena_vieja_no_viaja_dentro_de_la_copia_restaurada() {
        // Si viajara, `recovery_complete` (que exige cuarentena = 0) no podría desbloquear NUNCA,
        // y esa fila no se borra sola en ningún sitio.
        let dir = test_dir("cuarentena");
        let db = db_operativa(&dir).await;
        registrar_cuarentena(&db).await;

        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let origen = dir.join(BACKUP_DIR).join(&backup.id);
        let copia_sucia = Db::open(origen.to_str().unwrap()).await.unwrap();
        assert_eq!(
            cuenta(&copia_sucia, "SELECT COUNT(*) FROM _Sync_Failed;").await,
            1,
            "la copia refleja el estado del momento, cuarentena incluida"
        );
        drop(copia_sucia);

        let prepared = prepare_restore(&dir, &backup.id).await.unwrap();
        let lista = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert_eq!(
            cuenta(&lista, "SELECT COUNT(*) FROM _Sync_Failed;").await,
            0
        );

        drop(lista);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn no_se_restaura_encima_de_operaciones_sin_subir() {
        let dir = test_dir("outbox");
        let db = db_operativa(&dir).await;
        {
            // Una escritura normal (por `execute`, no `raw`) se captura en el outbox.
            let w = db.write().await;
            w.execute(
                "UPDATE Usuarios SET Nombre = 'Venta de hoy' WHERE ID_Usuario = ?1;",
                vec![Value::Text(crate::util::ADMIN_USUARIO_ID.to_string())],
            )
            .await
            .unwrap();
        }
        assert!(cuenta(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await > 0);

        let err = asegurar_reemplazo_seguro(&db).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict);

        // ...salvo si esa BD ya está bloqueada en reconciliación: entonces no está vendiendo y
        // negarle otra copia la dejaría sin ninguna salida.
        mark_reconciliation_pending(&db).await.unwrap();
        asegurar_reemplazo_seguro(&db).await.unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn los_restos_de_una_restauracion_no_se_acumulan() {
        let dir = test_dir("restos");
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for sello in [10, 20, 30] {
            std::fs::write(backups.join(format!("pre-restore-{sello}.db")), b"x").unwrap();
            std::fs::write(backups.join(format!("pre-restore-{sello}-wal")), b"x").unwrap();
        }
        std::fs::write(backups.join("failed-restore-5.db"), b"x").unwrap();
        // Una copia diaria de verdad: la retención de siete es la suya, aquí no se toca.
        std::fs::write(
            backups.join(format!("{BACKUP_PREFIX}99{BACKUP_SUFFIX}")),
            b"x",
        )
        .unwrap();
        // Un temporal recién escrito (una restauración en curso) y otro antiguo.
        std::fs::write(dir.join(format!("data.restore.{}.tmp", now_ms())), b"x").unwrap();
        std::fs::write(dir.join("data.restore.1.tmp"), b"x").unwrap();
        // Copias previas a una migración: se conservan las dos últimas (la marcha atrás de la
        // última actualización), no las de todas las versiones por las que ha pasado el equipo.
        for sello in [1, 2, 3] {
            std::fs::write(dir.join(format!("data.db.bak.{sello}")), b"x").unwrap();
        }

        purge_restore_leftovers(&dir).unwrap();

        assert!(backups.join("pre-restore-30.db").exists());
        assert!(backups.join("pre-restore-20.db").exists());
        assert!(
            !backups.join("pre-restore-10.db").exists(),
            "sobra el tercero"
        );
        assert!(
            !backups.join("pre-restore-10-wal").exists(),
            "el sidecar se va con su base"
        );
        assert!(backups.join("failed-restore-5.db").exists());
        assert!(backups
            .join(format!("{BACKUP_PREFIX}99{BACKUP_SUFFIX}"))
            .exists());
        assert!(!dir.join("data.restore.1.tmp").exists());
        assert!(dir.join("data.db.bak.3").exists());
        assert!(dir.join("data.db.bak.2").exists());
        assert!(
            !dir.join("data.db.bak.1").exists(),
            "la tercera copia de migración más reciente ya no hace de red"
        );
        assert_eq!(
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("data.restore."))
                .count(),
            1,
            "el temporal reciente puede ser el de una restauración en curso"
        );

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
    async fn una_copia_sale_del_equipo_y_vuelve() {
        // El caso real: el disco muere, se instala en otro equipo y lo único que queda es el USB.
        let dir = test_dir("exportar");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();

        let fuera = dir.join("usb").join("copia-del-bar.db");
        export_backup(&dir, &backup.id, &fuera).await.unwrap();
        assert!(fuera.is_file(), "la carpeta destino se crea si no existía");

        std::fs::remove_file(dir.join(BACKUP_DIR).join(&backup.id)).unwrap();
        assert!(list_backups(&dir).unwrap().is_empty());

        let vuelta = import_backup(&dir, &fuera).await.unwrap();
        assert!(vuelta.importada);
        let lista = list_backups(&dir).unwrap();
        assert_eq!(lista.len(), 1);
        assert!(lista[0].importada);
        // Y se puede restaurar como cualquier otra: es el mismo camino, no una segunda vía.
        let prepared = prepare_restore(&dir, &vuelta.id).await.unwrap();
        assert!(prepared.is_file());
        discard_prepared(&prepared);

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn una_bd_en_recuperacion_no_admite_escrituras_de_negocio() {
        let dir = test_dir("cerrojo");
        let db = db_operativa(&dir).await;
        let escribir_negocio = |texto: &'static str| {
            let db = db.clone();
            async move {
                let w = db.write().await;
                w.execute(
                    "UPDATE Usuarios SET Nombre = ?1 WHERE ID_Usuario = ?2;",
                    vec![
                        Value::Text(texto.to_string()),
                        Value::Text(crate::util::ADMIN_USUARIO_ID.to_string()),
                    ],
                )
                .await
            }
        };

        // Operativa: la escritura entra y se captura, como siempre.
        escribir_negocio("antes").await.unwrap();
        let outbox = cuenta(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await;
        assert!(outbox > 0);

        mark_reconciliation_pending(&db).await.unwrap();
        assert!(db.escrituras_de_negocio_bloqueadas());

        // En recuperación, no. Esto es exactamente lo que hacía el aviso de "actualización
        // disponible", y esa única fila dejaba el equipo sin poder restaurar.
        assert!(escribir_negocio("durante").await.is_err());
        assert_eq!(
            cuenta(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await,
            outbox,
            "una escritura rechazada no deja rastro en el outbox"
        );

        // La maquinaria de la recuperación va por `raw()` y sigue pasando.
        {
            let w = db.write().await;
            w.raw()
                .execute("UPDATE _Sync_State SET Last_Seq = 7 WHERE Id = 1;", ())
                .await
                .unwrap();
        }
        assert_eq!(cuenta(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, outbox);

        // Y al terminar, el equipo vuelve a escribir.
        complete_reconciliation(&db).await.unwrap();
        assert!(!db.escrituras_de_negocio_bloqueadas());
        escribir_negocio("despues").await.unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn una_bd_sin_usuarios_no_queda_bloqueada_por_su_propio_outbox() {
        // El equipo que ya se atascó antes de existir el cerrojo: sin usuarios no se puede iniciar
        // sesión, así que esa operación no es una venta y no puede cerrar la única salida.
        let dir = test_dir("sin_usuarios");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw().execute("DELETE FROM Usuarios;", ()).await.unwrap();
            w.raw()
                .execute(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-huerfana', 'main', '[]', 1);",
                    (),
                )
                .await
                .unwrap();
        }
        assert!(cuenta(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await > 0);

        asegurar_reemplazo_seguro(&db).await.unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn una_base_ilegible_se_aparta_en_vez_de_borrarse() {
        let dir = test_dir("ilegible");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("data.db"), b"paginas rotas").unwrap();
        std::fs::write(dir.join("data.db-wal"), b"wal").unwrap();

        let apartada = archivar_base_ilegible(&dir).unwrap().unwrap();
        assert!(apartada.is_file());
        assert!(
            !dir.join("data.db").exists(),
            "deja el sitio libre para la base nueva"
        );
        assert!(
            !dir.join("data.db-wal").exists(),
            "un WAL huérfano no puede quedarse al lado de la base nueva"
        );
        assert_eq!(
            std::fs::read(&apartada).unwrap(),
            b"paginas rotas",
            "no se borra: es lo único que queda de lo que no llegó a subir"
        );
        assert!(
            list_backups(&dir).unwrap().is_empty(),
            "no se ofrece como copia: si SQLite no la abre, no es una salida"
        );

        // Sin fichero no hay nada que apartar, y eso no es un error: es la base borrada.
        assert!(archivar_base_ilegible(&dir).unwrap().is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn no_se_importa_cualquier_fichero() {
        let dir = test_dir("importar_basura");
        std::fs::create_dir_all(&dir).unwrap();
        let basura = dir.join("fotos.db");
        std::fs::write(&basura, b"esto no es una base de datos").unwrap();

        let err = import_backup(&dir, &basura).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        assert!(list_backups(&dir).unwrap().is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn la_retencion_diaria_no_se_lleva_una_copia_importada() {
        // Una importada la ha traído una persona tras perder el equipo. Si contase para la
        // retención de siete, la siguiente copia diaria tiraría justo lo que vino a salvar.
        let dir = test_dir("retencion_importada");
        let db = db_operativa(&dir).await;
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::write(
            backups.join(format!("{IMPORT_PREFIX}1{BACKUP_SUFFIX}")),
            b"traida a mano",
        )
        .unwrap();
        for stamp in 1..=7 {
            std::fs::write(
                backups.join(format!("{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}")),
                b"antigua",
            )
            .unwrap();
        }

        create_backup(&db, &dir).await.unwrap().unwrap();

        let lista = list_backups(&dir).unwrap();
        assert!(
            lista.iter().any(|b| b.importada && b.created_at_ms == 1),
            "la importada más vieja sigue ahí"
        );
        assert_eq!(
            lista.iter().filter(|b| !b.importada).count(),
            BACKUPS_A_CONSERVAR
        );

        drop(db);
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
