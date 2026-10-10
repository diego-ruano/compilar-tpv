//! Copias locales y estado persistente de recuperación de la Main.
//!
//! Las copias se crean con `VACUUM INTO`: SQLite produce un fichero autocontenido y coherente
//! aunque la base viva use WAL. Restaurar es reemplazar el fichero completo, no copiar sólo las
//! tablas de negocio; así también sobreviven el outbox y el checkpoint, que no están en la nube.
//!
//! RI-41: las copias se guardan **comprimidas con gzip** (`*.db.gz`). Son siete diarias completas
//! más las importadas, y los registros de facturación no se purgan nunca, así que sin comprimir
//! crecían sin techo en el mismo disco. Lo que se valida y lo que se restaura es siempre la base
//! descomprimida en un fichero aparte. Una copia sin comprimir (`*.db`: las de antes, o una
//! `data.db` sacada a mano de otro equipo) se sigue aceptando: el formato se reconoce por el
//! contenido, no por el nombre.

use std::io::{BufReader, BufWriter, Read, Write};
use crate::consultas::db_err;
use crate::util::now_ms;
use std::path::{Path, PathBuf};

use libsql::{Builder, Value};
use crate::ejecutor::Connection;
use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::recovery::{LocalBackupInfo, RecoveryState, RecoveryStatus};

use crate::db::Db;

const BACKUP_DIR: &str = "backups";
const BACKUP_PREFIX: &str = "data-";
/// Copias traídas de fuera (un USB, una carpeta de red). Llevan prefijo propio porque la
/// retención de las diarias NO debe alcanzarlas: las ha puesto ahí una persona a mano.
const IMPORT_PREFIX: &str = "import-";
/// Las copias que hacemos (diarias, importadas, la de antes de un traslado): comprimidas.
const BACKUP_SUFFIX: &str = ".db.gz";
/// Una base tal cual: las copias de antes de comprimirlas, y los ficheros que sólo se apartan con
/// un `rename` (la base ilegible, la anterior a una restauración), que no se reescriben.
const SUFIJO_SIN_COMPRIMIR: &str = ".db";
const BACKUPS_A_CONSERVAR: usize = 7;
/// Los temporales de una copia a medias (`backups/.backup-*.tmp`, `.import-*`, `.validar-*`…). Si
/// el proceso muere entre medias se quedan; el job los recoge pasada una hora.
const TMP_ANTIGUEDAD_MS: i64 = 60 * 60 * 1000;
/// Copia que deja el paso de migraciones (`data.db.bak.<ms>`, ver `connection.rs`). Vive en la
/// raíz de AppData, no en `backups/`, así que la retención de las diarias nunca la vio.
const MIGRACION_PREFIX: &str = "data.db.bak.";
const MIGRACIONES_A_CONSERVAR: usize = 2;
/// Base que no se pudo ni abrir y se apartó para poder reconstruir en su sitio. No se lista como
/// copia restaurable: si SQLite no la abre, ofrecerla sería ofrecer el problema.
const ILEGIBLE_PREFIX: &str = "ilegible-";
/// La base que había antes de reconstruir tras un traslado de licencia. No se lista como copia
/// restaurable —es justo lo que no vale—, pero se guarda: puede tener operaciones que nunca
/// llegaron a la nube.
const ANTES_DE_TRASLADO_PREFIX: &str = "antes-de-traslado-";
/// Marca en AppData de que la licencia se ha trasladado a este equipo y su base todavía no se ha
/// reconstruido desde la nube. Vive FUERA de `data.db` a propósito: restaurar una copia local
/// no puede borrarla, porque esa copia también es de antes del traslado.
const MARCA_TRASLADO: &str = "traslado-pendiente";

fn corrupta(e: impl std::fmt::Display) -> AppError {
    AppError::coded(ErrorCode::BackupCorrupt, e.to_string())
}

fn valor_i64(value: Value) -> Option<i64> {
    match value {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse().ok(),
        _ => None,
    }
}

/// Corre `f` en un hilo de bloqueo, fuera del runtime async.
///
/// RI-41 (y RI-16): libsql local es `async` en la firma pero ejecuta SQLite en el hilo que lo
/// llama, sin ceder. `VACUUM INTO` y `PRAGMA quick_check` de una base grande, o copiar la base
/// entera a un USB, tardan segundos; en un hilo del runtime dejan a la interfaz sin uno de sus
/// pocos hilos (un TPV tiene 2–4 núcleos) todo ese rato.
async fn en_hilo_aparte<T, F, Fut>(f: F) -> AppResult<T>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = AppResult<T>>,
    T: Send + 'static,
{
    let rt = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || rt.block_on(f()))
        .await
        .map_err(|e| AppError::internal(format!("La tarea de la copia se interrumpió: {e}")))?
}

/// `std::fs::copy` en un hilo de bloqueo (ver [`en_hilo_aparte`]).
async fn copiar_fichero(origen: &Path, destino: &Path) -> AppResult<()> {
    let (origen, destino) = (origen.to_path_buf(), destino.to_path_buf());
    en_hilo_aparte(move || async move {
        std::fs::copy(&origen, &destino).map(|_| ()).map_err(db_err)
    })
    .await
}

/// Los dos primeros bytes de todo fichero gzip (RFC 1952). Una base SQLite empieza por
/// `SQLite format 3\0`, así que no hay confusión posible.
const MAGIA_GZIP: [u8; 2] = [0x1f, 0x8b];

fn es_gzip(path: &Path) -> std::io::Result<bool> {
    let mut cabecera = [0u8; 2];
    let mut f = std::fs::File::open(path)?;
    match f.read_exact(&mut cabecera) {
        Ok(()) => Ok(cabecera == MAGIA_GZIP),
        // Un fichero de menos de dos bytes no es gzip; que no sea una base lo dirá la validación.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e),
    }
}

/// Comprime `origen` en `destino`, en un hilo de bloqueo.
async fn comprimir(origen: &Path, destino: &Path) -> AppResult<()> {
    let (origen, destino) = (origen.to_path_buf(), destino.to_path_buf());
    en_hilo_aparte(move || async move {
        let mut entrada = BufReader::new(std::fs::File::open(&origen).map_err(db_err)?);
        let salida = BufWriter::new(std::fs::File::create(&destino).map_err(db_err)?);
        let mut gz = flate2::write::GzEncoder::new(salida, flate2::Compression::default());
        std::io::copy(&mut entrada, &mut gz).map_err(db_err)?;
        gz.finish()
            .and_then(|mut w| w.flush())
            .map_err(db_err)?;
        Ok(())
    })
    .await
}

/// Deja en `destino` la base que hay en `origen`, esté comprimida o no, en un hilo de bloqueo.
///
/// Un gzip truncado o con el CRC mal es una copia estropeada (`BackupCorrupt`), igual que una
/// base que no pasa `quick_check`: la pantalla lo dice y deja elegir otra.
pub(crate) async fn descomprimir(origen: &Path, destino: &Path) -> AppResult<()> {
    let (origen, destino) = (origen.to_path_buf(), destino.to_path_buf());
    en_hilo_aparte(move || async move {
        if !es_gzip(&origen).map_err(db_err)? {
            return std::fs::copy(&origen, &destino).map(|_| ()).map_err(db_err);
        }
        let entrada = BufReader::new(std::fs::File::open(&origen).map_err(db_err)?);
        let mut gz = flate2::read::GzDecoder::new(entrada);
        let mut salida = BufWriter::new(std::fs::File::create(&destino).map_err(db_err)?);
        // `io::copy` no distingue si falló leer o escribir: lo que dice el tipo de error sí. Un
        // disco lleno no es una copia corrupta.
        std::io::copy(&mut gz, &mut salida).map_err(|e| match e.kind() {
            std::io::ErrorKind::InvalidData
            | std::io::ErrorKind::InvalidInput
            | std::io::ErrorKind::UnexpectedEof => {
                corrupta(format!("La copia comprimida está dañada: {e}"))
            }
            _ => db_err(e),
        })?;
        salida.flush().map_err(db_err)?;
        Ok(())
    })
    .await
}

/// Un temporal junto a las copias. Empieza por `.` para que `list_backups` no lo tome por una.
fn temporal(dir: &Path, que: &str) -> PathBuf {
    dir.join(format!(".{que}-{}-{}.tmp", now_ms(), uuid::Uuid::new_v4().simple()))
}

/// Comprime `base` (un temporal sin comprimir, ya validado) en `destino` pasando por otro temporal,
/// para que `destino` aparezca entero o no aparezca. Los temporales se borran pase lo que pase.
async fn guardar_comprimida(base: &Path, destino: &Path) -> AppResult<()> {
    let dir = destino.parent().unwrap_or(Path::new("."));
    let gz = temporal(dir, "comprimir");
    let r = async {
        comprimir(base, &gz).await?;
        std::fs::rename(&gz, destino).map_err(db_err)
    }
    .await;
    discard_prepared(base);
    let _ = std::fs::remove_file(&gz);
    r
}

/// Valida una copia del almacén, comprimida o no, descomprimiéndola en un temporal que se borra.
async fn validar_guardada(path: &Path) -> AppResult<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = temporal(dir, "validar");
    let r = async {
        descomprimir(path, &tmp).await?;
        validate_backup(&tmp).await
    }
    .await;
    discard_prepared(&tmp);
    r
}

/// `VACUUM INTO destino` por una conexión del pool de lectura, en un hilo de bloqueo. El guard
/// viaja con la tarea: la conexión vuelve al pool cuando termina la copia, no antes.
async fn vacuum_into(db: &Db, destino: &Path) -> AppResult<()> {
    let destino_str = destino
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de copia inválida"))?
        .to_string();
    let r = db.read().await;
    en_hilo_aparte(move || async move {
        r.conn()
            .execute("VACUUM INTO ?1;", vec![Value::Text(destino_str)])
            .await
            .map(|_| ())
            .map_err(db_err)
    })
    .await
}

async fn scalar_i64(conn: &Connection, sql: &str) -> AppResult<i64> {
    let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };
    Ok(valor_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0))
}

pub async fn status(db: &Db) -> AppResult<RecoveryStatus> {
    // Un traslado manda sobre todo lo demás: da igual que la base tenga usuarios o esté a medio
    // reconciliar, lo que tiene es de antes y no se trabaja con ello.
    if hay_traslado_pendiente(db.carpeta()) {
        return Ok(RecoveryStatus {
            state: RecoveryState::TransferPending,
        });
    }

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

/// Deja constancia de que la licencia se ha trasladado a este equipo desde otro.
///
/// A partir de aquí la Main no trabaja con su base: `status` dice `TransferPending`, la aplicación
/// entra en la pantalla de recuperación (sólo con la nube), el outbox no sube (lo que tiene es de
/// antes y pisaría lo que hizo el otro equipo) y la reconstrucción desde la nube quita la marca.
/// Es el mismo camino que sigue un equipo nuevo tras un traslado; la diferencia es que éste tiene
/// datos, y sin la marca los habría seguido usando.
pub fn marcar_traslado(app_data_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(app_data_dir).map_err(db_err)?;
    std::fs::write(app_data_dir.join(MARCA_TRASLADO), now_ms().to_string()).map_err(db_err)
}

pub fn hay_traslado_pendiente(app_data_dir: &Path) -> bool {
    app_data_dir.join(MARCA_TRASLADO).exists()
}

/// La quita la reconstrucción desde la nube, al terminar.
pub(crate) fn quitar_marca_traslado(app_data_dir: &Path) -> AppResult<()> {
    match std::fs::remove_file(app_data_dir.join(MARCA_TRASLADO)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(db_err(e)),
        _ => Ok(()),
    }
}

/// Guarda la base de antes del traslado en `backups/antes-de-traslado-*`, antes de reemplazarla.
pub(crate) async fn guardar_base_de_antes_del_traslado(db: &Db) -> AppResult<PathBuf> {
    let dir = db.carpeta().join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let destino = dir.join(format!("{ANTES_DE_TRASLADO_PREFIX}{}{BACKUP_SUFFIX}", now_ms()));
    // Por el pool de lectura, como las copias diarias: `VACUUM INTO` hace su propia instantánea.
    let tmp = temporal(&dir, "traslado");
    if let Err(e) = vacuum_into(db, &tmp).await {
        discard_prepared(&tmp);
        return Err(e);
    }
    guardar_comprimida(&tmp, &destino).await?;
    Ok(destino)
}

/// Mantiene bloqueado el login hasta que el ciclo online confirme la convergencia.
///
/// Y aprovecha para **volver a encolar los registros de facturación** (FISCAL-01). Es el sitio
/// correcto porque lo llaman todos los caminos de restauración —la nube y la copia local— y porque
/// es el primer momento en que los registros ya están en la base.
///
/// Hace falta porque `Registros_Facturacion` se replica y vuelve, pero `_Verifactu_Envios` **no**:
/// es estado local del equipo. Sin esto, tras restaurar el panel diría «0 pendientes» y el job no
/// mandaría nada — incluidos los registros que nunca llegaron a la AEAT. Ver
/// `verifactu::resembrar_cola_de_envio` para por qué se reenvía en vez de preguntar.
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

    // Best-effort y por una razón: si esto fallara, lo que NO puede es impedir que el equipo
    // recupere sus datos. Un registro sin encolar se arregla en el arranque siguiente (se vuelve a
    // llamar aquí); un equipo que no puede restaurar no tiene salida.
    if let Err(e) = crate::verifactu::resembrar_cola_de_envio(db).await {
        tracing::warn!(
            target: "tpv::verifactu",
            error = %e,
            "no se pudo reencolar los registros de facturación tras restaurar; se reintentará"
        );
    }

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

/// El instante de `<ms>.db.gz` o de `<ms>.db` (una copia de antes de comprimirlas).
fn sello_de(resto: &str) -> Option<i64> {
    resto
        .strip_suffix(BACKUP_SUFFIX)
        .or_else(|| resto.strip_suffix(SUFIJO_SIN_COMPRIMIR))?
        .parse::<i64>()
        .ok()
}

fn parse_backup(path: &Path) -> Option<LocalBackupInfo> {
    let id = path.file_name()?.to_str()?.to_string();
    let (importada, resto) = match id.strip_prefix(BACKUP_PREFIX) {
        Some(r) => (false, r),
        None => (true, id.strip_prefix(IMPORT_PREFIX)?),
    };
    let stamp = sello_de(resto)?;
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

/// Comprueba que la copia abre, pasa `quick_check` y tiene usuarios. En un hilo de bloqueo: el
/// `quick_check` recorre la base entera (ver [`en_hilo_aparte`]).
async fn validate_backup(path: &Path) -> AppResult<()> {
    let path = path.to_path_buf();
    en_hilo_aparte(move || async move { validar_copia(&path).await }).await
}

async fn validar_copia(path: &Path) -> AppResult<()> {
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

    let mut usuarios = conn.query("SELECT COUNT(*) FROM Usuarios;", ()).await.map_err(db_err)?;
    let users = usuarios.next().await.map_err(db_err)?.ok_or_else(|| corrupta("Sin respuesta de usuarios"))?.get::<i64>(0)
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
    let tmp = temporal(&dir, "backup");
    let final_path = dir.join(format!("{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}"));

    // `VACUUM INTO` abre su propia transacción de LECTURA, así que en WAL produce una
    // instantánea coherente sin excluir al escritor. Va por el pool de lectura a propósito:
    // tomando el `WriteGuard` se bloquearían los cobros durante toda la copia, y este job
    // vence por reloj de pared, así que puede caer en plena cena.
    let r = async {
        vacuum_into(db, &tmp).await?;
        // Se valida la base tal cual, antes de comprimirla: comprimir no la cambia, y el gzip
        // lleva su propio CRC para lo que pueda estropearse después en el disco.
        validate_backup(&tmp).await
    }
    .await;
    if let Err(e) = r {
        discard_prepared(&tmp);
        return Err(e);
    }
    guardar_comprimida(&tmp, &final_path).await?;

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
    let destino = dir.join(format!("{ILEGIBLE_PREFIX}{sello}{SUFIJO_SIN_COMPRIMIR}"));
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
/// RI-41: la PII del personal (`DNI`, `IBAN`, `Numero_Seguridad_Social`) no depende de esta copia:
/// viaja cifrada por el outbox y vuelve con el volcado de la nube, y la DEK con la activación
/// (TRAB-03). Lo que sólo salva esta copia es lo que nunca llegó a subir.
///
/// Sale tal como está guardada: comprimida (un `.db.gz`, que también abre 7-Zip).
pub async fn export_backup(app_data_dir: &Path, id: &str, destino: &Path) -> AppResult<()> {
    let source = resolve_backup(app_data_dir, id)?;
    // Validar ANTES de copiar: exportar una copia ilegible es peor que no exportar nada, porque
    // parece un respaldo y no lo es hasta el día que hace falta.
    validar_guardada(&source).await?;

    if let Some(parent) = destino.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(db_err)?;
        }
    }
    copiar_fichero(&source, destino).await?;
    Ok(())
}

/// Trae al almacén local una copia que estaba fuera, para poder restaurarla como cualquier otra.
///
/// Se valida igual que las nuestras, pero eso comprueba que sea una base sana **de este esquema**,
/// no que sea de este mismo negocio: hoy la BD no lleva ninguna marca del tenant con la que
/// distinguirlo. La pantalla lo advierte. El daño de equivocarse queda acotado a este equipo —
/// restaurar no llena el outbox, así que nada de eso se replica— y se deshace recuperando de la
/// nube.
///
/// Acepta una copia comprimida (lo que saca «Guardar fuera…») o una base tal cual: una copia de
/// antes de comprimirlas, o una `data.db` rescatada a mano de otro equipo. Se guarda comprimida.
pub async fn import_backup(app_data_dir: &Path, origen: &Path) -> AppResult<LocalBackupInfo> {
    if !origen.is_file() {
        return Err(AppError::not_found("El archivo seleccionado ya no existe"));
    }

    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;

    // Se trae primero a un temporal (descomprimida si venía comprimida) y se valida ahí: es la
    // base que se va a guardar, y validar en el USB obligaría a descomprimir dos veces.
    let tmp = temporal(&dir, "import");
    let r = async {
        descomprimir(origen, &tmp).await?;
        validate_backup(&tmp).await
    }
    .await;
    if let Err(e) = r {
        discard_prepared(&tmp);
        return Err(e);
    }

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
        .and_then(sello_de)
        .unwrap_or_else(now_ms);

    let final_path = dir.join(format!("{IMPORT_PREFIX}{stamp}{BACKUP_SUFFIX}"));
    guardar_comprimida(&tmp, &final_path).await?;

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
    // SYNC-20: esto cuenta el outbox ENTERO, apartadas incluidas, y es deliberado. Para el drenado
    // una operación en cuarentena ya no está en camino; para esta guardia sigue siendo exactamente
    // lo que protege: un dato de este equipo que la nube NO tiene. Restaurar vacía las tablas y las
    // rellena con lo que hay arriba, así que descontarlas aquí convertiría el arreglo del atasco en
    // una forma nueva de perder datos — y en silencio, que es peor.
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

    let dir = app_data_dir.join(BACKUP_DIR);
    if dir.exists() {
        // Los temporales de una copia que no terminó (`.backup-*.tmp`, `.import-*.tmp`…). Por la
        // fecha del fichero y no por el nombre: uno reciente puede ser el de una copia en curso.
        for entry in std::fs::read_dir(&dir).map_err(db_err)?.flatten() {
            let path = entry.path();
            let Some(nombre) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !(nombre.starts_with('.') && nombre.contains(".tmp")) {
                continue;
            }
            let viejo = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|edad| edad.as_millis() >= TMP_ANTIGUEDAD_MS as u128);
            if !viejo {
                continue;
            }
            if let Err(e) = std::fs::remove_file(&path) {
                tracing::warn!(target: "tpv::recovery", ruta = ?path, error = %e, "no se pudo purgar un temporal de copia");
            }
        }

        for familia in ["pre-restore-", "failed-restore-", ILEGIBLE_PREFIX, ANTES_DE_TRASLADO_PREFIX] {
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
    // Tras un traslado, cualquier copia de este equipo es de antes: restaurarla sería volver a
    // trabajar con lo que el traslado deja atrás. La pantalla ya no la ofrece; esto es la red.
    if hay_traslado_pendiente(app_data_dir) {
        return Err(AppError::conflict(
            "La licencia viene de otro equipo: los datos tienen que traerse de la nube. Una copia de este ordenador es de antes del traslado.",
        ));
    }
    let source = resolve_backup(app_data_dir, id)?;

    // La copia se descomprime directamente en el temporal que se va a instalar, y se valida ahí:
    // es exactamente la base que acabará siendo `data.db`.
    let prepared = app_data_dir.join(format!("data.restore.{}.tmp", now_ms()));
    let result = async {
        descomprimir(&source, &prepared).await?;
        validate_backup(&prepared).await?;
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
        db.cerrar().await.map_err(db_err)?;
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
        crate::test_temp::dir_temporal(&format!("recovery_{nombre}"))
    }

    async fn db_operativa(dir: &Path) -> std::sync::Arc<Db> {
        std::fs::create_dir_all(dir).unwrap();
        crate::connection::init_main_db(dir, false).await.unwrap()
    }

    /// La copia `id` descomprimida en un fichero aparte, para abrirla con SQLite.
    async fn abrible(dir: &Path, id: &str) -> PathBuf {
        let destino = dir.join(format!("abierta-{id}.db"));
        descomprimir(&dir.join(BACKUP_DIR).join(id), &destino)
            .await
            .unwrap();
        destino
    }

    /// Tras un traslado de licencia la base es de antes, esté como esté: tenga usuarios o esté a
    /// medio reconciliar, no se trabaja con ella hasta reconstruirla desde la nube.
    #[tokio::test]
    async fn un_traslado_manda_sobre_el_estado_de_la_base() {
        let dir = test_dir("traslado_estado");
        let db = db_operativa(&dir).await;
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::Ready);

        marcar_traslado(&dir).unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::TransferPending);

        mark_reconciliation_pending(&db).await.unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::TransferPending);

        quitar_marca_traslado(&dir).unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);
        // Quitar una marca que ya no está no es un error: la reconstrucción puede repetirse.
        quitar_marca_traslado(&dir).unwrap();

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Un equipo que se abre con el traslado pendiente arranca con las escrituras de negocio
    /// cerradas: nada de lo que se escribiera podría subir, y bloquearía la reconstrucción.
    #[tokio::test]
    async fn abrir_una_base_con_traslado_pendiente_cierra_las_escrituras() {
        let dir = test_dir("traslado_abrir");
        let db = db_operativa(&dir).await;
        db.cerrar().await.unwrap();
        drop(db);

        marcar_traslado(&dir).unwrap();
        let db = crate::connection::init_main_db(&dir, true).await.unwrap();
        assert!(db.escrituras_de_negocio_bloqueadas());

        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una copia de este ordenador también es de antes del traslado: restaurarla sería volver a
    /// trabajar con lo que el traslado deja atrás. La pantalla no la ofrece y esto lo impide.
    #[tokio::test]
    async fn tras_un_traslado_no_se_restaura_una_copia_local() {
        let dir = test_dir("traslado_copia");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();

        marcar_traslado(&dir).unwrap();
        let err = prepare_restore(&dir, &backup.id).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict);

        quitar_marca_traslado(&dir).unwrap();
        let preparada = prepare_restore(&dir, &backup.id).await.unwrap();
        discard_prepared(&preparada);

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
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
        let path = abrible(&dir, &backup.id).await;
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
        let origen = abrible(&dir, &backup.id).await;
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
        // Temporales de una copia: el de una que murió a medias hace horas, y el de una en curso.
        let huerfano = backups.join(".backup-1-a.tmp");
        std::fs::write(&huerfano, b"x").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&huerfano)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600))
            .unwrap();
        let en_curso = backups.join(".comprimir-2-b.tmp");
        std::fs::write(&en_curso, b"x").unwrap();

        purge_restore_leftovers(&dir).unwrap();

        assert!(!huerfano.exists(), "el temporal de una copia que no terminó no se queda");
        assert!(en_curso.exists(), "uno reciente puede ser el de una copia en curso");

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

    /// Prepara un directorio con una `data.db` de contenido reconocible y su copia lista.
    /// Estas dos funciones sólo mueven ficheros, así que el contenido puede ser texto: lo que se
    /// comprueba es QUÉ fichero acaba en cada sitio, no que SQLite lo entienda.
    fn escenario_de_intercambio(nombre: &str) -> (PathBuf, PathBuf) {
        let dir = test_dir(nombre);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("data.db"), b"la de antes").unwrap();
        let preparada = dir.join("data.restore.1.tmp");
        std::fs::write(&preparada, b"la restaurada").unwrap();
        (dir, preparada)
    }

    fn contenido(p: &Path) -> String {
        String::from_utf8(std::fs::read(p).unwrap()).unwrap()
    }

    fn familia(dir: &Path, prefijo: &str) -> Vec<PathBuf> {
        std::fs::read_dir(dir.join(BACKUP_DIR))
            .map(|d| {
                d.flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with(prefijo))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn el_intercambio_instala_la_copia_y_guarda_la_anterior() {
        let (dir, preparada) = escenario_de_intercambio("instalar");

        let instalada = install_prepared(&dir, &preparada).unwrap();

        assert_eq!(contenido(&dir.join("data.db")), "la restaurada");
        assert!(!preparada.exists(), "la preparada se mueve, no se copia");
        let previa = instalada.previous.expect("la anterior se guarda");
        assert_eq!(
            contenido(&previa),
            "la de antes",
            "es la red de rollback: no puede perderse"
        );
        assert_eq!(familia(&dir, "pre-restore-").len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn el_wal_de_la_base_anterior_no_se_queda_junto_a_la_nueva() {
        // Si se quedara, SQLite intentaría aplicar un WAL que pertenece a OTRO fichero sobre la
        // base recién restaurada. Se apartan antes de instalar, no después.
        let (dir, preparada) = escenario_de_intercambio("sidecars");
        std::fs::write(dir.join("data.db-wal"), b"wal viejo").unwrap();
        std::fs::write(dir.join("data.db-shm"), b"shm viejo").unwrap();

        install_prepared(&dir, &preparada).unwrap();

        assert!(!dir.join("data.db-wal").exists());
        assert!(!dir.join("data.db-shm").exists());
        assert_eq!(
            familia(&dir, "pre-restore-").len(),
            3,
            "la base anterior y sus dos sidecars quedan archivados"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sin_base_previa_no_hay_nada_que_apartar() {
        // El camino real de una BD borrada: no existe `data.db`, así que no hay rollback posible
        // y `previous` viene vacío. Instalar tiene que funcionar igual.
        let dir = test_dir("sin_previa");
        std::fs::create_dir_all(&dir).unwrap();
        let preparada = dir.join("data.restore.1.tmp");
        std::fs::write(&preparada, b"la restaurada").unwrap();

        let instalada = install_prepared(&dir, &preparada).unwrap();

        assert!(instalada.previous.is_none());
        assert_eq!(contenido(&dir.join("data.db")), "la restaurada");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn si_la_copia_no_abre_se_deshace_el_intercambio() {
        // Lo que hace `recovery_restore_backup` cuando `init_main_db` falla sobre la copia ya
        // instalada: la base de antes vuelve a su sitio y la que no sirvió queda apartada para
        // poder mirarla, no borrada.
        let (dir, preparada) = escenario_de_intercambio("rollback");
        let instalada = install_prepared(&dir, &preparada).unwrap();
        // `init_main_db` pudo dejar sidecars antes de descubrir que la copia no era utilizable.
        std::fs::write(dir.join("data.db-wal"), b"wal de la fallida").unwrap();

        rollback_install(&dir, instalada).unwrap();

        assert_eq!(
            contenido(&dir.join("data.db")),
            "la de antes",
            "el equipo se queda como estaba"
        );
        assert!(!dir.join("data.db-wal").exists());
        let fallidas = familia(&dir, "failed-restore-");
        assert_eq!(fallidas.len(), 2, "la copia fallida y su sidecar");
        assert!(fallidas.iter().any(|p| contenido(p) == "la restaurada"));
        assert!(
            familia(&dir, "pre-restore-").is_empty(),
            "la anterior ya no está archivada: ha vuelto a su sitio"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deshacer_sin_base_previa_deja_el_equipo_sin_base() {
        // Restaurar sobre una BD ya perdida y que la copia tampoco abra: no hay a dónde volver.
        // Lo importante es que no falle, porque el arranque siguiente tiene que poder entrar en
        // recuperación en vez de quedarse a medias.
        let dir = test_dir("rollback_sin_previa");
        std::fs::create_dir_all(&dir).unwrap();
        let preparada = dir.join("data.restore.1.tmp");
        std::fs::write(&preparada, b"la restaurada").unwrap();
        let instalada = install_prepared(&dir, &preparada).unwrap();

        rollback_install(&dir, instalada).unwrap();

        assert!(!dir.join("data.db").exists());
        assert_eq!(familia(&dir, "failed-restore-").len(), 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn una_copia_sale_del_equipo_y_vuelve() {
        // El caso real: el disco muere, se instala en otro equipo y lo único que queda es el USB.
        let dir = test_dir("exportar");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();

        let fuera = dir.join("usb").join("copia-del-bar.db.gz");
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
    /// RI-41: las copias se guardan comprimidas, y lo que se restaura es la base descomprimida.
    #[tokio::test]
    async fn las_copias_se_guardan_comprimidas() {
        let dir = test_dir("comprimidas");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();

        assert!(backup.id.ends_with(BACKUP_SUFFIX));
        let guardada = dir.join(BACKUP_DIR).join(&backup.id);
        assert!(es_gzip(&guardada).unwrap());
        assert_eq!(
            backup.size_bytes,
            std::fs::metadata(&guardada).unwrap().len() as i64,
            "el tamaño que se enseña es el que ocupa en el disco"
        );

        let prepared = prepare_restore(&dir, &backup.id).await.unwrap();
        assert!(!es_gzip(&prepared).unwrap(), "lo que se instala es la base, no el gzip");
        validate_backup(&prepared).await.unwrap();
        discard_prepared(&prepared);

        // Y no quedan temporales: ni el de `VACUUM INTO`, ni el de comprimir, ni el de validar.
        let restos = std::fs::read_dir(dir.join(BACKUP_DIR))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(restos, 0);

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una base tal cual (una copia de antes de comprimirlas, o una `data.db` sacada a mano de
    /// otro equipo) se sigue aceptando: en el almacén y al importarla.
    #[tokio::test]
    async fn una_copia_sin_comprimir_se_sigue_aceptando() {
        let dir = test_dir("sin_comprimir");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let base = abrible(&dir, &backup.id).await;

        // En el almacén, con el nombre de antes.
        let vieja = dir.join(BACKUP_DIR).join(format!("{BACKUP_PREFIX}1{SUFIJO_SIN_COMPRIMIR}"));
        std::fs::copy(&base, &vieja).unwrap();
        let listada = list_backups(&dir)
            .unwrap()
            .into_iter()
            .find(|b| b.created_at_ms == 1)
            .expect("la copia sin comprimir se lista");
        let prepared = prepare_restore(&dir, &listada.id).await.unwrap();
        discard_prepared(&prepared);
        export_backup(&dir, &listada.id, &dir.join("usb").join("vieja.db"))
            .await
            .unwrap();

        // Traída de fuera: se importa y se guarda comprimida.
        let importada = import_backup(&dir, &base).await.unwrap();
        assert!(importada.id.ends_with(BACKUP_SUFFIX));
        assert!(es_gzip(&dir.join(BACKUP_DIR).join(&importada.id)).unwrap());

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Un gzip estropeado en el disco es una copia corrupta, igual que una base que no pasa
    /// `quick_check`: se rechaza diciendo por qué y sin dejar el temporal a medias.
    #[tokio::test]
    async fn un_gzip_estropeado_es_una_copia_corrupta() {
        let dir = test_dir("gzip_roto");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let guardada = dir.join(BACKUP_DIR).join(&backup.id);
        let bytes = std::fs::read(&guardada).unwrap();
        std::fs::write(&guardada, &bytes[..bytes.len() / 2]).unwrap();

        let err = prepare_restore(&dir, &backup.id).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        let err = export_backup(&dir, &backup.id, &dir.join("usb").join("rota.db.gz"))
            .await
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        assert!(
            !std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("data.restore.")),
            "la restauración que no pudo prepararse no deja su temporal"
        );

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}


