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

use crate::ejecutor::{Connection, ErrorSql, Value};
use tpv_application::error::{AppError, AppResult};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::recovery::{CopiaExportada, DondeQuedaLaCopia, LocalBackupInfo, RecoveryState, RecoveryStatus};

use crate::db::Db;
use tpv_application::ports::licensing::BaseDelEquipo;
use tpv_domain::licensing::{procedencia, que_hacer_con_la_base, Procedencia, QueHacerConLaBase, Sello};

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
/// AUD-19 · La copia restaurada que se sustituyó por la nube antes de reconciliarse (una copia
/// anterior a lo que guarda la nube). Tampoco se lista como restaurable: su outbox, que no se sube,
/// queda aquí por si hiciera falta mirarlo.
const ANTES_DE_LA_NUBE_PREFIX: &str = "antes-de-la-nube-";
/// Marca en AppData de que la licencia se ha trasladado a este equipo y su base todavía no se ha
/// reconstruido desde la nube. Vive FUERA de `data.db` a propósito: restaurar una copia local
/// no puede borrarla, porque esa copia también es de antes del traslado.
const MARCA_TRASLADO: &str = "traslado-pendiente";
/// SYNC-32 · Marca en AppData de que la base de este equipo es anterior a lo que la nube ya ha
/// purgado (se cambió por fuera del programa: una imagen de disco, una `data.db` copiada a mano) y
/// todavía no se ha reconstruido desde la nube. La pone la réplica al verlo en una sesión normal
/// (`use_cases::replicacion`, `FinDeSesion::AnteriorAlLog`) y la quita esa reconstrucción. Como la
/// del traslado, vive FUERA de `data.db`: cambiar la base otra vez, o restaurar una copia, no la
/// borra.
const MARCA_ANTERIOR_A_LA_NUBE: &str = "anterior-a-la-nube";
/// AUD-06 · Marca en AppData de un cambio de negocio pendiente: se ha activado la licencia de otro
/// negocio que el de la base, guardada como pendiente, y el TPV se reinicia. Lleva el negocio
/// activado y se escribe entera o no se escribe. Mientras está, el proceso que la puso sigue siendo
/// del negocio de la base. Sólo la quita el arranque, cuando ya ha apartado la base y aplicado lo
/// pendiente (`tpv_application::use_cases::licensing::aplicar_cambio_de_negocio_pendiente`).
const MARCA_CAMBIO_DE_NEGOCIO: &str = "cambio-de-negocio";
/// AUD-06 · Dentro de una carpeta `negocio-anterior-<ms>/`, la marca de que el apartado no ha
/// terminado. Se escribe al empezar y se quita al terminar; lleva el negocio cuyas copias selladas se
/// quedan (vacío si no se queda ninguna).
const APARTADO_EN_CURSO: &str = "apartado-en-curso";
/// AUD-06 · Donde se aparta, dentro de `backups/`, todo lo que había en el equipo de otro negocio
/// (`apartar_lo_de_otro_negocio`). Una carpeta por vez, con la hora; dentro, lo apartado tiene la
/// misma forma que en AppData. No es una familia de restos: la purga no entra, y nada de lo que hay
/// dentro se ofrece para restaurar ni se deja importar.
const NEGOCIO_ANTERIOR_PREFIX: &str = "negocio-anterior-";
/// AUD-06 · Lo que un negocio tiene en la raíz de AppData, fuera de la base y de `backups/`: las
/// copias previas a una migración y los temporales de una restauración (por prefijo), la cola de
/// imágenes por subir y su temporal, la carpeta de imágenes, la carpeta
/// con el PDF de sus facturas, la de un traslado y la de una base anterior a la nube. Lo que es del
/// equipo (la licencia, el modo, los interruptores, la telemetría) no.
const DEL_NEGOCIO_EN_APPDATA: [&str; 6] = [
    "image_uploads.json",
    "image_uploads.json.tmp",
    "images",
    "facturas",
    MARCA_TRASLADO,
    MARCA_ANTERIOR_A_LA_NUBE,
];
const DEL_NEGOCIO_EN_APPDATA_POR_PREFIJO: [&str; 2] = [MIGRACION_PREFIX, "data.restore."];

/// Lo que se le dice a quien elige, para traerlo, un archivo que no es una copia (un PDF, una foto).
pub const MSG_NO_ES_UNA_COPIA: &str =
    "Ese archivo no es una copia de seguridad del TPV. Elige uno guardado con «Guardar fuera…» (.db.gz).";

/// Lo que se le dice cuando una copia no pasa la validación, sea por lo que sea.
pub const MSG_COPIA_DANADA: &str = "La copia está dañada y no se puede usar.";

/// Una copia que no se puede usar. Lo que se enseña es una frase; el detalle técnico (el error del
/// motor, en inglés: «file is not a database») va sólo al registro, que es donde le sirve a soporte.
fn corrupta(detalle: impl std::fmt::Display) -> AppError {
    tracing::warn!(target: "tpv::recovery", %detalle, "copia de seguridad que no se puede usar");
    AppError::coded(ErrorCode::BackupCorrupt, MSG_COPIA_DANADA)
}

/// Lo que se dice cuando la copia, sana, trae el esquema de otra versión del programa.
pub const MSG_COPIA_DE_OTRA_VERSION: &str =
    "Esta copia es de otra versión del programa y no se puede restaurar en esta.";

/// Lo que se dice cuando el disco de este equipo no deja preparar la copia para restaurarla.
pub const MSG_SIN_DISCO_PARA_PREPARARLA: &str = "No se pudo preparar la copia: el disco de este ordenador no deja escribir (puede que esté lleno). La copia no se ha tocado: libera espacio y vuelve a intentarlo.";

/// Lo que se dice cuando la copia no se pudo preparar por algo que no es ni ella ni el disco.
pub const MSG_NO_SE_PUDO_PREPARAR: &str =
    "No se pudo preparar la copia para restaurarla. La copia no se ha tocado: vuelve a intentarlo.";

/// Por qué no se pudo abrir y poner al día la copia que se va a restaurar, que ya ha pasado la
/// validación.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FalloAlPreparar {
    /// El motor dice que el fichero está roto.
    Danada,
    /// Sus migraciones no son las de este programa: una ya aplicada es distinta, o una pendiente no
    /// se le puede aplicar.
    OtraVersion,
    /// El disco de este equipo: lleno, sin permiso, un error de lectura o escritura.
    Disco,
    /// Otra cosa.
    Otro,
}

/// El código de SQLite de un error de la cadena, venga del ejecutor o de rusqlite.
fn codigo_sqlite(e: &(dyn std::error::Error + 'static)) -> Option<i32> {
    if let Some(ErrorSql::SqliteFailure(codigo, _)) = e.downcast_ref::<ErrorSql>() {
        return Some(*codigo);
    }
    match e.downcast_ref::<rusqlite::Error>()? {
        rusqlite::Error::SqliteFailure(c, _) => Some(c.extended_code),
        rusqlite::Error::SqlInputError { error, .. } => Some(error.extended_code),
        _ => None,
    }
}

/// Clasifica el fallo al abrir la copia preparada recorriendo la cadena de errores: el disco y una
/// base rota mandan sobre la migración en la que ocurrieron (un disco lleno a mitad de migrar es el
/// disco, no la versión).
fn fallo_al_preparar(e: &(dyn std::error::Error + 'static)) -> FalloAlPreparar {
    use rusqlite::ffi;
    let mut de_una_migracion = false;
    let mut actual = Some(e);
    while let Some(error) = actual {
        if let Some(codigo) = codigo_sqlite(error) {
            match codigo & 0xff {
                ffi::SQLITE_FULL
                | ffi::SQLITE_IOERR
                | ffi::SQLITE_CANTOPEN
                | ffi::SQLITE_READONLY
                | ffi::SQLITE_PERM => return FalloAlPreparar::Disco,
                ffi::SQLITE_CORRUPT | ffi::SQLITE_NOTADB => return FalloAlPreparar::Danada,
                _ => {}
            }
        }
        if error.is::<std::io::Error>() {
            return FalloAlPreparar::Disco;
        }
        if error.is::<crate::migrations::MigracionAlterada>() || error.is::<crate::migrations::MigracionFallida>() {
            de_una_migracion = true;
        }
        actual = error.source();
    }
    if de_una_migracion {
        FalloAlPreparar::OtraVersion
    } else {
        FalloAlPreparar::Otro
    }
}

/// El error que se enseña cuando no se pudo abrir y poner al día la copia preparada. Antes todo era
/// «la copia está dañada», y con eso se podía tirar una copia buena de otra versión o que sólo
/// había topado con un disco lleno. El detalle técnico va sólo al registro.
fn al_preparar_la_copia(e: &(dyn std::error::Error + 'static)) -> AppError {
    let fallo = fallo_al_preparar(e);
    tracing::warn!(target: "tpv::recovery", detalle = %e, ?fallo, "no se pudo preparar la copia para restaurarla");
    match fallo {
        FalloAlPreparar::Danada => AppError::coded(ErrorCode::BackupCorrupt, MSG_COPIA_DANADA),
        FalloAlPreparar::OtraVersion => AppError::validation(MSG_COPIA_DE_OTRA_VERSION),
        FalloAlPreparar::Disco => AppError::external(MSG_SIN_DISCO_PARA_PREPARARLA),
        FalloAlPreparar::Otro => AppError::internal(MSG_NO_SE_PUDO_PREPARAR),
    }
}

/// Un archivo que no es una copia: ni una base de SQLite ni un gzip.
fn no_es_una_copia() -> AppError {
    AppError::validation(MSG_NO_ES_UNA_COPIA)
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
/// RI-41 (y RI-16): SQLite trabaja sin ceder. `VACUUM INTO` y `PRAGMA quick_check` de una base
/// grande, o copiar la base entera a un USB, tardan segundos; en un hilo del runtime dejan a la
/// interfaz sin uno de sus pocos hilos (un TPV tiene 2–4 núcleos) todo ese rato.
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
/// La cabecera con la que empieza toda base de SQLite.
const CABECERA_SQLITE: &[u8; 16] = b"SQLite format 3\0";

/// ¿Empieza `path` como una base de SQLite? Un fichero más corto que la cabecera no lo es.
fn es_base_sqlite(path: &Path) -> std::io::Result<bool> {
    let mut cabecera = [0u8; 16];
    let mut f = std::fs::File::open(path)?;
    match f.read_exact(&mut cabecera) {
        Ok(()) => Ok(&cabecera == CABECERA_SQLITE),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e),
    }
}

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
/// AUD-06: y que sea del negocio de la licencia (`comprobar_procedencia_de_copia`).
async fn validar_guardada(path: &Path, licencia: Option<&str>) -> AppResult<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = temporal(dir, "validar");
    let r = async {
        descomprimir(path, &tmp).await?;
        validate_backup(&tmp).await?;
        comprobar_procedencia_de_copia(&tmp, licencia)
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
    // SYNC-32: lo mismo con una base anterior a lo que guarda la nube.
    if hay_base_anterior_a_la_nube(db.carpeta()) {
        return Ok(RecoveryStatus {
            state: RecoveryState::OlderThanCloud,
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

/// SYNC-32 · Deja constancia de que la base de este equipo es anterior a lo que la nube ya ha
/// purgado, y cierra las escrituras de negocio de la base abierta.
///
/// Es el camino del traslado: `status` dice `OlderThanCloud`, la aplicación entra en la pantalla de
/// recuperación (sólo con la nube), el outbox no sube (lo de antes del cambio de base que el equipo
/// de entonces ya subió volvería a aplicarse) y la reconstrucción desde la nube guarda antes la base
/// entera, con lo pendiente, y quita la marca.
pub fn marcar_anterior_a_la_nube(db: &Db) -> AppResult<()> {
    let carpeta = db.carpeta();
    std::fs::create_dir_all(carpeta).map_err(db_err)?;
    std::fs::write(carpeta.join(MARCA_ANTERIOR_A_LA_NUBE), now_ms().to_string()).map_err(db_err)?;
    db.bloquear_escrituras_de_negocio(true);
    Ok(())
}

/// SYNC-32 · ¿La base de este equipo es anterior a lo que guarda la nube y aún no se ha reconstruido?
pub fn hay_base_anterior_a_la_nube(app_data_dir: &Path) -> bool {
    app_data_dir.join(MARCA_ANTERIOR_A_LA_NUBE).exists()
}

/// SYNC-32 · La quita la reconstrucción desde la nube, después del `COMMIT`.
pub(crate) fn quitar_marca_anterior_a_la_nube(app_data_dir: &Path) -> AppResult<()> {
    match std::fs::remove_file(app_data_dir.join(MARCA_ANTERIOR_A_LA_NUBE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(db_err(e)),
        _ => Ok(()),
    }
}

/// AUD-06 · El turno entre publicar la marca del cambio de negocio y cada borrado de una retención
/// (`purgar`). Publicar espera a que termine el borrado que esté en curso, y todo borrado posterior
/// ve la marca: no hay hueco entre mirar que no está y borrar en el que pueda aparecer.
static MARCA_Y_PURGA: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn turno_de_marca_y_purga() -> std::sync::MutexGuard<'static, ()> {
    MARCA_Y_PURGA.lock().unwrap_or_else(|e| e.into_inner())
}

/// AUD-06 · Deja anotado, de forma duradera, que se ha activado la licencia de `negocio` sobre una base
/// de otro negocio (o que no se sabe de quién es). Temporal y `rename`: se escribe entera o no se
/// escribe. El `rename` va con el turno de `purgar` tomado.
pub fn marcar_cambio_de_negocio(app_data_dir: &Path, negocio: &str) -> AppResult<()> {
    std::fs::create_dir_all(app_data_dir).map_err(db_err)?;
    let tmp = app_data_dir.join(format!("{MARCA_CAMBIO_DE_NEGOCIO}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(db_err)?;
        f.write_all(negocio.trim().as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(db_err)?;
    }
    let _turno = turno_de_marca_y_purga();
    std::fs::rename(&tmp, app_data_dir.join(MARCA_CAMBIO_DE_NEGOCIO)).map_err(db_err)
}

/// AUD-06 · ¿Hay un cambio de negocio pendiente de reinicio? Si no se puede saber, se da por que sí:
/// con él no se activa nada, no se abre ninguna base en caliente y no se purga nada.
pub fn hay_cambio_de_negocio_pendiente(app_data_dir: &Path) -> bool {
    !matches!(app_data_dir.join(MARCA_CAMBIO_DE_NEGOCIO).try_exists(), Ok(false))
}

/// AUD-06 · Borra `ruta` de una retención, salvo con un cambio de negocio pendiente: entonces la
/// retención se suspende hasta que el arranque lo aparte todo, y no se borra nada del equipo. Mirar
/// la marca y borrar van juntos, con el turno que también toma quien la publica
/// (`marcar_cambio_de_negocio`): la marca no puede aparecer entre las dos cosas.
fn purgar(app_data_dir: &Path, ruta: &Path) -> std::io::Result<()> {
    let _turno = turno_de_marca_y_purga();
    if hay_cambio_de_negocio_pendiente(app_data_dir) {
        return Ok(());
    }
    #[cfg(test)]
    tests::tras_mirar_la_marca();
    std::fs::remove_file(ruta)
}

/// Las entradas de `carpeta`. Una carpeta que no existe no tiene ninguna; cualquier otro error al
/// abrirla o al recorrerla se devuelve: no se decide nada con una lista a medias.
fn entradas_de(carpeta: &Path) -> AppResult<Vec<std::fs::DirEntry>> {
    match std::fs::read_dir(carpeta) {
        Ok(entradas) => entradas.map(|e| e.map_err(db_err)).collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(db_err(e)),
    }
}

/// AUD-06 · El negocio del cambio pendiente, si lo hay. Una marca que no se deja leer sigue siendo
/// un cambio pendiente, de un negocio que no se sabe (vacío).
pub fn cambio_de_negocio_pendiente(app_data_dir: &Path) -> Option<String> {
    match std::fs::read_to_string(app_data_dir.join(MARCA_CAMBIO_DE_NEGOCIO)) {
        Ok(negocio) => Some(negocio.trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => Some(String::new()),
    }
}

/// AUD-06 · Quita la marca del cambio. Sólo desde el arranque (ver la marca).
pub fn quitar_cambio_de_negocio(app_data_dir: &Path) -> AppResult<()> {
    match std::fs::remove_file(app_data_dir.join(MARCA_CAMBIO_DE_NEGOCIO)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(db_err(e)),
        _ => Ok(()),
    }
}

/// Guarda la base de antes del traslado en `backups/antes-de-traslado-*`, antes de reemplazarla.
pub(crate) async fn guardar_base_de_antes_del_traslado(db: &Db) -> AppResult<PathBuf> {
    guardar_base_apartada(db, ANTES_DE_TRASLADO_PREFIX, "traslado").await
}

/// AUD-06 · La base local de este equipo, vista desde la activación de una licencia
/// (`tpv_application::ports::licensing::BaseDelEquipo`). `db` es `None` si no hay base abierta:
/// entonces el sello se lee del fichero, y sellar se deja para cuando se abra
/// (`connection::init_main_db`), que aplica la misma regla.
pub struct BaseLocal {
    carpeta: PathBuf,
    db: Option<std::sync::Arc<Db>>,
}

impl BaseLocal {
    pub fn new(app_data_dir: &Path, db: Option<std::sync::Arc<Db>>) -> Self {
        Self { carpeta: app_data_dir.to_path_buf(), db }
    }
}

#[async_trait::async_trait]
impl BaseDelEquipo for BaseLocal {
    async fn sello(&self) -> AppResult<Sello> {
        match &self.db {
            Some(db) => Ok(Sello::leido(crate::sello::leer(&db.read().await).await?.as_deref())),
            None => crate::sello::del_fichero(&self.carpeta.join("data.db")),
        }
    }

    async fn sellar(&self, negocio: &str) -> AppResult<()> {
        if let Some(db) = &self.db {
            let w = db.write().await;
            crate::sello::escribir(w.raw(), negocio).await?;
        }
        Ok(())
    }

    async fn marcar_traslado(&self) -> AppResult<()> {
        marcar_traslado(&self.carpeta)?;
        if let Some(db) = &self.db {
            db.bloquear_escrituras_de_negocio(true);
        }
        Ok(())
    }

    async fn marcar_cambio_de_negocio(&self, negocio: &str) -> AppResult<()> {
        marcar_cambio_de_negocio(&self.carpeta, negocio)
    }

    async fn cambio_de_negocio_pendiente(&self) -> AppResult<Option<String>> {
        Ok(cambio_de_negocio_pendiente(&self.carpeta))
    }

    async fn apartar_si_no_es_de(&self, negocio: &str) -> AppResult<()> {
        // Con la base abierta no se mueve nada: esto es del arranque.
        if self.db.is_some() {
            return Err(AppError::internal("La base sólo se aparta al arrancar, con ella cerrada."));
        }
        apartar_para_el_cambio_de_negocio(&self.carpeta, negocio).map(|_| ())
    }

    async fn quitar_cambio_de_negocio(&self) -> AppResult<()> {
        quitar_cambio_de_negocio(&self.carpeta)
    }
}

/// AUD-06 · ¿Es `db` la base del negocio `negocio`? Lo que sube o baja algo de la nube en nombre de
/// ese negocio sin pasar por la base (las imágenes) lo pregunta antes.
pub async fn base_del_negocio(db: &Db, negocio: &str) -> AppResult<bool> {
    let sello = Sello::leido(crate::sello::leer(&db.read().await).await?.as_deref());
    Ok(procedencia(&sello, negocio) == Procedencia::Suya)
}

/// AUD-06 · Lo que se resuelve al abrir la base (`connection::init_main_db`), ANTES de abrir nada, que
/// es el arranque: ninguna tarea del negocio anterior sigue en marcha y nadie usa sus ficheros.
///
/// 1. Un apartado que se quedó a medias se termina primero, sea cual sea la licencia: lo que ya se
///    movió es de un negocio que no es el de la base que quede, y lo que falta es suyo.
/// 2. La regla (`que_hacer_con_la_base`) con `licencia`: una base de otro negocio, o que no se deja
///    leer, se aparta con todo lo de su negocio.
///
/// La marca de un cambio de negocio pendiente no la toca: sólo la quita el arranque, cuando ya ha
/// aplicado lo pendiente. Si algo no se puede mover, devuelve el error: no se abre la base, y la
/// siguiente apertura lo repite. Sin licencia no hay con qué comparar (sólo se termina lo que
/// estuviera a medias). Devuelve dónde ha quedado lo apartado, si se ha apartado algo.
pub fn resolver_al_abrir(app_data_dir: &Path, licencia: Option<&str>) -> AppResult<Option<PathBuf>> {
    let mut apartado = terminar_apartados_en_curso(app_data_dir)?;
    if let Some(negocio) = licencia {
        let sello = crate::sello::del_fichero(&app_data_dir.join("data.db"))?;
        if que_hacer_con_la_base(&sello, negocio, false) == QueHacerConLaBase::Apartar {
            // Con una base ilegible no se sabe de quién es lo demás, salvo las copias que lo dicen:
            // las selladas con la licencia son de este negocio y se quedan (son con las que se
            // recupera una base dañada). Con una de otro negocio, todo es de ése.
            let conservar = (sello == Sello::Ilegible).then_some(negocio);
            apartado = Some(apartar_lo_de_otro_negocio(app_data_dir, conservar)?);
        }
    }
    Ok(apartado)
}

/// AUD-06 · El paso (a) de un cambio de negocio pendiente, al arrancar
/// (`tpv_application::use_cases::licensing::aplicar_cambio_de_negocio_pendiente`): se termina un
/// apartado a medias y después se aparta **todo** lo que haya en el equipo de un negocio (la base si
/// la hay, todas las familias de copias y bases guardadas, las de antes de una migración, los
/// temporales de una restauración, las imágenes y su cola), haya o no `data.db` y diga lo que diga
/// su sello: una restauración cortada entre sus dos `rename` deja el equipo sin `data.db` y con todo
/// lo demás. Lo único que se queda es una base ya sellada con `negocio`, que no puede darse antes de
/// aplicarlo. Repetible: si no queda nada, no crea ninguna carpeta. Devuelve dónde ha quedado.
pub fn apartar_para_el_cambio_de_negocio(app_data_dir: &Path, negocio: &str) -> AppResult<Option<PathBuf>> {
    let mut apartado = terminar_apartados_en_curso(app_data_dir)?;
    let sello = crate::sello::del_fichero(&app_data_dir.join("data.db"))?;
    if procedencia(&sello, negocio) == Procedencia::Suya {
        return Ok(apartado);
    }
    if hay_algo_de_un_negocio(app_data_dir)? {
        apartado = Some(apartar_lo_de_otro_negocio(app_data_dir, None)?);
    }
    Ok(apartado)
}

/// ¿Queda en el equipo algo de un negocio (lo que `apartar_en` se llevaría)?
fn hay_algo_de_un_negocio(app_data_dir: &Path) -> AppResult<bool> {
    for nombre in ["data.db", "data.db-wal", "data.db-shm"] {
        if app_data_dir.join(nombre).try_exists().map_err(db_err)? {
            return Ok(true);
        }
    }
    for entrada in entradas_de(&app_data_dir.join(BACKUP_DIR))? {
        if !entrada.file_name().to_string_lossy().starts_with(NEGOCIO_ANTERIOR_PREFIX) {
            return Ok(true);
        }
    }
    for entrada in entradas_de(app_data_dir)? {
        if es_del_negocio_en_appdata(&entrada.file_name().to_string_lossy()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn es_del_negocio_en_appdata(nombre: &str) -> bool {
    DEL_NEGOCIO_EN_APPDATA.contains(&nombre) || DEL_NEGOCIO_EN_APPDATA_POR_PREFIJO.iter().any(|p| nombre.starts_with(p))
}

/// ¿`carpeta` es un apartado que no ha terminado? Tiene la marca y le falta la base, que es lo
/// último que se mueve: con la marca y la base, lo único que no llegó a hacerse es quitar la marca.
fn apartado_a_medias(carpeta: &Path) -> AppResult<bool> {
    Ok(carpeta.join(APARTADO_EN_CURSO).try_exists().map_err(db_err)?
        && !carpeta.join("data.db").try_exists().map_err(db_err)?)
}

/// Las carpetas `backups/negocio-anterior-*`. Un error al abrir o recorrer `backups/` se devuelve
/// (`entradas_de`): sólo una carpeta que no existe cuenta como vacía.
fn carpetas_apartadas(app_data_dir: &Path) -> AppResult<Vec<PathBuf>> {
    let mut carpetas = Vec::new();
    for entrada in entradas_de(&app_data_dir.join(BACKUP_DIR))? {
        let es_apartado = entrada.file_name().to_string_lossy().starts_with(NEGOCIO_ANTERIOR_PREFIX);
        if es_apartado && entrada.file_type().map_err(db_err)?.is_dir() {
            carpetas.push(entrada.path());
        }
    }
    carpetas.sort();
    Ok(carpetas)
}

/// AUD-06 · ¿Hay un apartado a medias? Mientras lo haya no se restaura ninguna copia: restaurarla
/// pondría una base en el sitio de la que falta por apartar, y al terminar se iría con lo demás.
pub fn hay_apartado_a_medias(app_data_dir: &Path) -> AppResult<bool> {
    for carpeta in carpetas_apartadas(app_data_dir)? {
        if apartado_a_medias(&carpeta)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Termina los apartados que se quedaron a medias, cada uno en su carpeta. Devuelve la última. Un
/// error al mirar una carpeta o su marca para aquí, con las marcas puestas.
fn terminar_apartados_en_curso(app_data_dir: &Path) -> AppResult<Option<PathBuf>> {
    let mut terminado = None;
    for carpeta in carpetas_apartadas(app_data_dir)? {
        let marca = carpeta.join(APARTADO_EN_CURSO);
        if !marca.try_exists().map_err(db_err)? {
            continue;
        }
        if carpeta.join("data.db").try_exists().map_err(db_err)? {
            // Terminó: sólo faltó quitar la marca.
            std::fs::remove_file(&marca).map_err(db_err)?;
            continue;
        }
        let conservar = std::fs::read_to_string(&marca).map_err(db_err)?;
        let conservar = Some(conservar.trim()).filter(|c| !c.is_empty());
        apartar_en(app_data_dir, &carpeta, conservar)?;
        terminado = Some(carpeta);
    }
    Ok(terminado)
}

/// Un nombre libre en `carpeta` para `nombre`: el mismo si no existe, y si existe, con un número
/// detrás. Lo apartado nunca pisa nada.
fn destino_libre(carpeta: &Path, nombre: &std::ffi::OsStr) -> PathBuf {
    let primero = carpeta.join(nombre);
    if !primero.exists() {
        return primero;
    }
    let nombre = nombre.to_string_lossy();
    (2..)
        .map(|n| carpeta.join(format!("{nombre}.{n}")))
        .find(|ruta| !ruta.exists())
        .expect("siempre hay un nombre libre")
}

/// AUD-28 — lo que se registra de un fichero o una carpeta de AppData: su nombre. La ruta entera
/// lleva el usuario de Windows, y lo que se registra sale del equipo (Axiom).
pub(crate) fn nombre_de(ruta: &Path) -> String {
    ruta.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// El error de un fichero que no se deja apartar. Sólo el nombre: la ruta entera lleva el usuario
/// de Windows.
fn no_se_pudo_apartar(nombre: &str, e: impl std::fmt::Display) -> AppError {
    tracing::warn!(target: "tpv::recovery", fichero = %nombre, error = %e, "no se pudo apartar un fichero del negocio anterior");
    AppError::conflict(format!(
        "No se pudo apartar «{nombre}», de los datos del negocio anterior: puede que esté abierto en otro programa. Cierra el TPV y vuelve a abrirlo."
    ))
}

fn mover(origen: &Path, carpeta: &Path) -> AppResult<()> {
    std::fs::create_dir_all(carpeta).map_err(db_err)?;
    let nombre = origen.file_name().unwrap_or_default().to_os_string();
    let destino = destino_libre(carpeta, &nombre);
    std::fs::rename(origen, &destino).map_err(|e| no_se_pudo_apartar(&nombre.to_string_lossy(), e))
}

/// ¿La copia `ruta` (de `backups/`) lleva el sello de `negocio`? Se descomprime en un temporal para
/// mirarlo. Ante cualquier duda, no: se aparta.
fn copia_sellada_con(ruta: &Path, negocio: &str) -> bool {
    let nombre = ruta.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    if !(nombre.starts_with(BACKUP_PREFIX) || nombre.starts_with(IMPORT_PREFIX)) {
        return false;
    }
    let dir = ruta.parent().unwrap_or(Path::new("."));
    let tmp = temporal(dir, "sello");
    let leido = (|| -> AppResult<Sello> {
        let mut entrada: Box<dyn Read> = if es_gzip(ruta).map_err(db_err)? {
            Box::new(flate2::read::GzDecoder::new(BufReader::new(std::fs::File::open(ruta).map_err(db_err)?)))
        } else {
            Box::new(BufReader::new(std::fs::File::open(ruta).map_err(db_err)?))
        };
        let mut salida = BufWriter::new(std::fs::File::create(&tmp).map_err(db_err)?);
        std::io::copy(&mut entrada, &mut salida).map_err(db_err)?;
        salida.flush().map_err(db_err)?;
        drop(salida);
        crate::sello::del_fichero(&tmp)
    })();
    discard_prepared(&tmp);
    matches!(leido, Ok(sello) if procedencia(&sello, negocio) == Procedencia::Suya)
}

/// AUD-06 · Aparta TODO lo que hay en este equipo de un negocio que no es el de la licencia: la base,
/// todas sus copias y bases guardadas (`backups/`, sean de la familia que sean), las copias previas a
/// una migración, la carpeta de imágenes y su cola, y sus marcas. Va a `backups/negocio-anterior-<ms>/`,
/// con la misma forma que tenía en AppData, sin borrar ni pisar nada. Devuelve la carpeta.
///
/// `conservar`: el negocio cuyas copias selladas se quedan (sólo cuando la base no se deja leer).
///
/// Se llama con la base CERRADA, al abrirla (`resolver_al_abrir`). La carpeta lleva la marca de
/// apartado en curso desde el principio hasta el final, y la base va la última: es lo que dice de
/// quién es todo lo demás. Si algo no se puede mover, se para ahí y devuelve el error; la siguiente
/// apertura lo termina en la misma carpeta, antes que nada.
pub fn apartar_lo_de_otro_negocio(app_data_dir: &Path, conservar: Option<&str>) -> AppResult<PathBuf> {
    let copias = app_data_dir.join(BACKUP_DIR);
    let destino = (now_ms()..)
        .map(|ms| copias.join(format!("{NEGOCIO_ANTERIOR_PREFIX}{ms}")))
        .find(|ruta| !ruta.exists())
        .expect("siempre hay un instante libre");
    std::fs::create_dir_all(&destino).map_err(db_err)?;
    let marca = destino.join(APARTADO_EN_CURSO);
    {
        let mut f = std::fs::File::create(&marca).map_err(db_err)?;
        f.write_all(conservar.unwrap_or_default().as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(db_err)?;
    }
    apartar_en(app_data_dir, &destino, conservar)?;
    Ok(destino)
}

/// El apartado en sí, en `destino` (que ya lleva su marca de en curso). Repetible: lo que ya se
/// movió no está, y lo que quede va a la misma carpeta, sin pisar nada.
fn apartar_en(app_data_dir: &Path, destino: &Path, conservar: Option<&str>) -> AppResult<()> {
    // Un error al abrir o recorrer una carpeta para aquí, con la marca puesta: nada se da por
    // apartado con una lista a medias.
    for entrada in entradas_de(&app_data_dir.join(BACKUP_DIR))? {
        let nombre = entrada.file_name();
        if nombre.to_string_lossy().starts_with(NEGOCIO_ANTERIOR_PREFIX) {
            continue;
        }
        if conservar.is_some_and(|negocio| copia_sellada_con(&entrada.path(), negocio)) {
            continue;
        }
        mover(&entrada.path(), &destino.join(BACKUP_DIR))?;
    }

    for entrada in entradas_de(app_data_dir)? {
        if es_del_negocio_en_appdata(&entrada.file_name().to_string_lossy()) {
            mover(&entrada.path(), destino)?;
        }
    }

    // La base: antes, lo que tenga en el WAL al fichero, para que se aparte entera aunque no viajen
    // juntos (si se deja: una base ilegible se mueve con su WAL tal cual). Después sus ficheros
    // auxiliares, haya base o no (una restauración cortada puede dejarlos sin ella, y junto a la base
    // nueva serían su WAL), y ella la última.
    let base = app_data_dir.join("data.db");
    let hay_base = base.try_exists().map_err(db_err)?;
    if hay_base && crate::sello::del_fichero(&base)? != Sello::Ilegible {
        let conn = crate::ejecutor::abrir(&base).map_err(|e| no_se_pudo_apartar("data.db", e))?;
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |_| Ok(()))
            .map_err(|e| no_se_pudo_apartar("data.db", ErrorSql::from(e)))?;
        drop(conn);
    }
    for sufijo in ["-wal", "-shm"] {
        let auxiliar = app_data_dir.join(format!("data.db{sufijo}"));
        if auxiliar.try_exists().map_err(db_err)? {
            mover(&auxiliar, destino)?;
        }
    }
    if hay_base {
        mover(&base, destino)?;
    }
    match std::fs::remove_file(destino.join(APARTADO_EN_CURSO)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(db_err(e)),
        _ => Ok(()),
    }
}

/// AUD-06 · ¿`origen` es de lo que la aplicación apartó (`backups/antes-de-traslado-*` o
/// `backups/negocio-anterior-*/…`)? Se comparan rutas ya resueltas, sin enlaces ni `..`. Es la red
/// de las copias sin sello (anteriores a los sellos), que el sello no puede rechazar.
fn es_de_lo_apartado(app_data_dir: &Path, origen: &Path) -> bool {
    let (Ok(copias), Ok(origen)) = (
        app_data_dir.join(BACKUP_DIR).canonicalize(),
        origen.canonicalize(),
    ) else {
        return false;
    };
    let Ok(dentro) = origen.strip_prefix(&copias) else {
        return false;
    };
    dentro
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .is_some_and(|nombre| {
            nombre.starts_with(ANTES_DE_TRASLADO_PREFIX) || nombre.starts_with(NEGOCIO_ANTERIOR_PREFIX)
        })
}

/// AUD-06 · Una copia (ya descomprimida) sólo vale para la licencia de su negocio.
///
/// SYNC-33: y una sin sello, tampoco. No dice de quién es: la de otra instalación con el sello
/// quitado sería indistinguible de una propia, y al restaurarla el equipo adoptaría sus usuarios y
/// su outbox. Toda base se sella al abrirse con la licencia, así que una copia de este negocio
/// siempre lo lleva; sin sello sólo queda una de antes de activar la licencia, que no tiene nada
/// que recuperar.
fn comprobar_procedencia_de_copia(copia: &Path, licencia: Option<&str>) -> AppResult<()> {
    let sello = crate::sello::del_fichero(copia)?;
    let Some(negocio) = licencia else {
        return Err(AppError::validation(
            "Activa la licencia de este ordenador antes de restaurar una copia: sin ella no se puede comprobar que la copia sea de su negocio.",
        ));
    };
    match procedencia(&sello, negocio) {
        Procedencia::Suya => Ok(()),
        Procedencia::SinSello => Err(AppError::validation(MSG_COPIA_SIN_SELLO)),
        Procedencia::DeOtroNegocio | Procedencia::Desconocida => Err(AppError::validation(
            "Esa copia es de otro negocio, no del de la licencia activada en este ordenador, y no se puede restaurar aquí.",
        )),
    }
}

/// SYNC-33 · Lo que se dice de una copia sin sello.
const MSG_COPIA_SIN_SELLO: &str = "Esa copia no dice de qué negocio es (se hizo antes de activar la licencia, o la ha cambiado otro programa), así que no se puede usar aquí. Elige otra copia o recupera el estado actual de la nube.";

/// AUD-19 · Guarda en `backups/antes-de-la-nube-*` la copia restaurada que se reemplaza por la nube
/// sin haberse reconciliado, con su outbox, que no se sube (ver `bootstrap_restaurar`).
pub(crate) async fn guardar_base_de_antes_de_la_nube(db: &Db) -> AppResult<PathBuf> {
    guardar_base_apartada(db, ANTES_DE_LA_NUBE_PREFIX, "nube").await
}

async fn guardar_base_apartada(db: &Db, prefijo: &str, que: &str) -> AppResult<PathBuf> {
    let dir = db.carpeta().join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;
    let destino = dir.join(format!("{prefijo}{}{BACKUP_SUFFIX}", now_ms()));
    // Por el pool de lectura, como las copias diarias: `VACUUM INTO` hace su propia instantánea.
    let tmp = temporal(&dir, que);
    if let Err(e) = vacuum_into(db, &tmp).await {
        discard_prepared(&tmp);
        return Err(e);
    }
    guardar_comprimida(&tmp, &destino).await?;
    Ok(destino)
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
    en_hilo_aparte(move || async move { validar_copia(&path) }).await
}

fn validar_copia(path: &Path) -> AppResult<()> {
    // Los errores del motor se dicen con los mismos textos que en el resto de la crate.
    let sql = ErrorSql::from;
    let conn = crate::ejecutor::abrir(path)
        .map_err(|e| corrupta(format!("No se puede abrir la copia: {e}")))?;

    let mut integridad = conn
        .prepare("PRAGMA quick_check;")
        .map_err(|e| corrupta(format!("Comprobación de integridad fallida: {}", sql(e))))?;
    let mut filas = integridad
        .query([])
        .map_err(|e| corrupta(format!("Comprobación de integridad fallida: {}", sql(e))))?;
    let mut vio_ok = false;
    while let Some(fila) = filas.next().map_err(|e| corrupta(sql(e).to_string()))? {
        match fila.get::<_, Value>(0).map_err(|e| corrupta(sql(e).to_string()))? {
            Value::Text(s) if s.eq_ignore_ascii_case("ok") => vio_ok = true,
            Value::Text(s) => return Err(corrupta(format!("SQLite informa: {s}"))),
            _ => return Err(corrupta("Respuesta de integridad ilegible")),
        }
    }
    if !vio_ok {
        return Err(corrupta("La copia no superó la comprobación de integridad"));
    }

    let mut usuarios = conn.prepare("SELECT COUNT(*) FROM Usuarios;").map_err(|e| db_err(sql(e)))?;
    let mut filas = usuarios.query([]).map_err(|e| db_err(sql(e)))?;
    let users = filas
        .next()
        .map_err(|e| db_err(sql(e)))?
        .ok_or_else(|| corrupta("Sin respuesta de usuarios"))?
        .get::<_, i64>(0)
        .map_err(|e| corrupta(format!("La copia no contiene el esquema esperado: {}", sql(e))))?;
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
        // AUD-06: con un cambio de negocio pendiente no se borra ninguna (`purgar`).
        if let Err(e) = purgar(app_data_dir, &dir.join(&vieja.id)) {
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
///
/// REC-INC-01: dice dónde ha quedado la copia (ver [`DondeQuedaLaCopia`]). El diálogo deja
/// guardarla en cualquier carpeta, y una copia que sigue dentro del ordenador (el mismo disco, otra
/// partición, otro disco interno) no protege de lo que protege una de fuera; la pantalla decía
/// «Ya tienes un respaldo fuera de este ordenador» igual.
pub async fn export_backup(
    app_data_dir: &Path,
    id: &str,
    destino: &Path,
    licencia: Option<&str>,
) -> AppResult<CopiaExportada> {
    let source = resolve_backup(app_data_dir, id)?;
    // Validar ANTES de copiar: exportar una copia ilegible es peor que no exportar nada, porque
    // parece un respaldo y no lo es hasta el día que hace falta.
    // AUD-06: una copia de otro negocio que siga en el almacén (con su licencia ya cambiada, antes
    // de apartarla) tampoco sale del equipo.
    validar_guardada(&source, licencia).await?;

    if let Some(parent) = destino.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(db_err)?;
        }
    }
    copiar_fichero(&source, destino).await?;
    let donde = donde_queda(mismo_volumen(app_data_dir, destino), tipo_de_unidad(destino));
    Ok(CopiaExportada { donde })
}

/// REC-INC-01 · Qué clase de unidad es la de una ruta, según el sistema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TipoDeUnidad {
    /// Un disco de dentro del ordenador (o una partición de uno).
    Fija,
    /// Una unidad que se desconecta: un USB, una tarjeta, un disco externo.
    Extraible,
    /// Una carpeta compartida de otro equipo.
    Red,
    /// No se ha podido saber.
    Desconocida,
}

/// REC-INC-01 · Dónde ha quedado la copia. Sólo sale de este equipo lo que se sabe que está en una
/// unidad extraíble o en la red: otra partición del mismo disco, otro disco interno o lo que no se
/// puede saber siguen en este ordenador, y el aviso prudente es «no te protege de una avería», no
/// «estás a salvo».
fn donde_queda(mismo_volumen: bool, tipo_del_destino: TipoDeUnidad) -> DondeQuedaLaCopia {
    if mismo_volumen {
        return DondeQuedaLaCopia::EnEsteEquipo;
    }
    match tipo_del_destino {
        TipoDeUnidad::Extraible => DondeQuedaLaCopia::Extraible,
        TipoDeUnidad::Red => DondeQuedaLaCopia::EnLaRed,
        TipoDeUnidad::Fija | TipoDeUnidad::Desconocida => DondeQuedaLaCopia::EnEsteEquipo,
    }
}

/// REC-INC-01 · El tipo de la unidad en la que está `ruta`, que tiene que existir.
///
/// En Unix (la Main no corre en Android: las copias son de la Main) no se mira: sale
/// `Desconocida`, que es «en este equipo».
fn tipo_de_unidad(ruta: &Path) -> TipoDeUnidad {
    #[cfg(windows)]
    {
        let Some(raiz) = std::fs::canonicalize(ruta).ok().and_then(|r| raiz_del_volumen(&r)) else {
            return TipoDeUnidad::Desconocida;
        };
        let tipo = unidades_windows::tipo_de_unidad(&raiz);
        // Un disco externo por USB se presenta como fijo: lo delata el bus por el que va.
        let bus = (tipo == unidades_windows::DRIVE_FIXED)
            .then(|| unidades_windows::bus_de_la_unidad(&raiz))
            .flatten();
        clasificar_unidad_windows(tipo, bus)
    }
    #[cfg(not(windows))]
    {
        let _ = ruta;
        TipoDeUnidad::Desconocida
    }
}

/// REC-INC-01 · Lo que dicen de una unidad `GetDriveTypeW` y, para una fija, el bus por el que va
/// (`STORAGE_BUS_TYPE`, si se ha podido leer). Pura, para poder probarla con cualquier unidad.
#[cfg_attr(not(windows), allow(dead_code))]
fn clasificar_unidad_windows(tipo: u32, bus: Option<u32>) -> TipoDeUnidad {
    // `GetDriveTypeW`: 2 extraíble, 3 fija, 4 de red, 5 CD/DVD, 6 disco en memoria; 0 y 1, no se sabe.
    // `STORAGE_BUS_TYPE`: 4 FireWire, 7 USB. El de una tarjeta (12 SD, 13 MMC) no cuenta: es también
    // el del disco eMMC de dentro de muchos terminales, y una tarjeta en su lector ya sale extraíble.
    match tipo {
        2 | 5 => TipoDeUnidad::Extraible,
        4 => TipoDeUnidad::Red,
        3 => match bus {
            Some(4 | 7) => TipoDeUnidad::Extraible,
            _ => TipoDeUnidad::Fija,
        },
        6 => TipoDeUnidad::Fija,
        _ => TipoDeUnidad::Desconocida,
    }
}

/// REC-INC-01 · Las dos preguntas a Windows sobre una unidad, por FFI como en `printing.rs`.
#[cfg(windows)]
mod unidades_windows {
    use std::ffi::c_void;

    pub(super) const DRIVE_FIXED: u32 = 3;
    const INVALID_HANDLE_VALUE: isize = -1;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const OPEN_EXISTING: u32 = 3;
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;
    /// Posición de `BusType` en `STORAGE_DEVICE_DESCRIPTOR`.
    const OFFSET_BUS_TYPE: usize = 28;

    /// `STORAGE_PROPERTY_QUERY` con `StorageDeviceProperty` y `PropertyStandardQuery` (los dos, 0).
    #[repr(C)]
    struct ConsultaDePropiedad {
        property_id: u32,
        query_type: u32,
        additional_parameters: [u8; 1],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(lprootpathname: *const u16) -> u32;
        fn CreateFileW(
            lpfilename: *const u16,
            dwdesiredaccess: u32,
            dwsharemode: u32,
            lpsecurityattributes: *mut c_void,
            dwcreationdisposition: u32,
            dwflagsandattributes: u32,
            htemplatefile: isize,
        ) -> isize;
        fn DeviceIoControl(
            hdevice: isize,
            dwiocontrolcode: u32,
            lpinbuffer: *const c_void,
            ninbuffersize: u32,
            lpoutbuffer: *mut c_void,
            noutbuffersize: u32,
            lpbytesreturned: *mut u32,
            lpoverlapped: *mut c_void,
        ) -> i32;
        fn CloseHandle(hobject: isize) -> i32;
    }

    fn ancha(texto: &str) -> Vec<u16> {
        texto.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `GetDriveTypeW` de la raíz (`C:` o `\\servidor\carpeta`, sin la barra final).
    pub(super) fn tipo_de_unidad(raiz: &str) -> u32 {
        let raiz = ancha(&format!("{raiz}\\"));
        // SAFETY: cadena terminada en cero que vive durante la llamada.
        unsafe { GetDriveTypeW(raiz.as_ptr()) }
    }

    /// El bus por el que va el disco de una unidad con letra (`C:`), o `None` si no se puede saber
    /// (un recurso de red, un disco sin permiso para preguntarle). Se abre sin pedir acceso, que es
    /// lo único que necesita esta consulta y no exige ser administrador.
    pub(super) fn bus_de_la_unidad(raiz: &str) -> Option<u32> {
        if raiz.len() != 2 || !raiz.ends_with(':') {
            return None;
        }
        let dispositivo = ancha(&format!(r"\\.\{raiz}"));
        // SAFETY: cadena terminada en cero; el handle se cierra antes de salir.
        let handle = unsafe {
            CreateFileW(
                dispositivo.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let consulta = ConsultaDePropiedad { property_id: 0, query_type: 0, additional_parameters: [0] };
        // Alineado a 4 bytes: la respuesta es una estructura de `u32`.
        let mut respuesta = [0u32; 256];
        let mut devueltos: u32 = 0;
        // SAFETY: los dos búferes viven durante la llamada y se pasan con su tamaño.
        let ok = unsafe {
            let ok = DeviceIoControl(
                handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                &consulta as *const ConsultaDePropiedad as *const c_void,
                std::mem::size_of::<ConsultaDePropiedad>() as u32,
                respuesta.as_mut_ptr() as *mut c_void,
                std::mem::size_of_val(&respuesta) as u32,
                &mut devueltos,
                std::ptr::null_mut(),
            );
            CloseHandle(handle);
            ok
        };
        if ok == 0 || (devueltos as usize) < OFFSET_BUS_TYPE + 4 {
            return None;
        }
        Some(respuesta[OFFSET_BUS_TYPE / 4])
    }
}

/// REC-INC-01 · ¿Están `a` y `b` en el mismo volumen? Las dos rutas tienen que existir. Si no se
/// puede saber, sí: el aviso prudente es «no te protege de una avería», no «estás a salvo».
///
/// En Unix se compara el dispositivo. En Windows, la raíz del volumen: la unidad (`C:`, `E:`, la
/// del USB) o el recurso de red (`\\servidor\carpeta`). Un volumen montado en una carpeta de otro
/// sale como el mismo disco, que es el lado bueno de equivocarse. Que no sea el mismo volumen no
/// basta para que la copia esté fuera: eso lo dice el tipo de la unidad ([`donde_queda`]).
fn mismo_volumen(a: &Path, b: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) else {
        return true;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(&a), std::fs::metadata(&b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev(),
            _ => true,
        }
    }
    #[cfg(not(unix))]
    {
        match (raiz_del_volumen(&a), raiz_del_volumen(&b)) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        }
    }
}

/// La raíz del volumen de una ruta de Windows, normalizada (`C:`, `\\servidor\carpeta`), o `None`
/// si la ruta no la lleva.
#[cfg_attr(unix, allow(dead_code))]
fn raiz_del_volumen(ruta: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    match ruta.components().next()? {
        Component::Prefix(p) => Some(match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => format!("{}:", (d as char).to_ascii_uppercase()),
            Prefix::UNC(servidor, carpeta) | Prefix::VerbatimUNC(servidor, carpeta) => format!(
                r"\\{}\{}",
                servidor.to_string_lossy().to_lowercase(),
                carpeta.to_string_lossy().to_lowercase()
            ),
            _ => p.as_os_str().to_string_lossy().to_lowercase(),
        }),
        _ => None,
    }
}

/// Trae al almacén local una copia que estaba fuera, para poder restaurarla como cualquier otra.
///
/// Se valida igual que las nuestras: que sea una base sana de este esquema y, AUD-06, que si lleva
/// sello sea el del negocio de la licencia (`licencia`). Una copia sin sello (anterior a los sellos)
/// no dice de quién es: se acepta, y la pantalla lo advierte. El daño de equivocarse con una de ésas
/// queda acotado a este equipo —restaurar no llena el outbox, así que nada de eso se replica— y se
/// deshace recuperando de la nube.
///
/// Acepta una copia comprimida (lo que saca «Guardar fuera…») o una base tal cual: una copia de
/// antes de comprimirlas, o una `data.db` rescatada a mano de otro equipo. Se guarda comprimida.
pub async fn import_backup(
    app_data_dir: &Path,
    origen: &Path,
    licencia: Option<&str>,
) -> AppResult<LocalBackupInfo> {
    if !origen.is_file() {
        return Err(AppError::not_found("El archivo seleccionado ya no existe"));
    }
    // AUD-06: lo que se apartó no vuelve por aquí, lleve sello o no.
    if es_de_lo_apartado(app_data_dir, origen) {
        return Err(AppError::validation(
            "Ese archivo es de los datos que el programa guardó aparte, de antes de un cambio de licencia o de otro negocio, y no se puede restaurar aquí.",
        ));
    }

    let dir = app_data_dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&dir).map_err(db_err)?;

    // Se trae primero a un temporal (descomprimida si venía comprimida) y se valida ahí: es la
    // base que se va a guardar, y validar en el USB obligaría a descomprimir dos veces.
    // Lo primero, que sea una copia: comprimida (gzip) o una base tal cual. Si no, el motor lo
    // diría en inglés y como si la copia estuviera estropeada.
    if !(es_gzip(origen).map_err(db_err)? || es_base_sqlite(origen).map_err(db_err)?) {
        return Err(no_es_una_copia());
    }

    let tmp = temporal(&dir, "import");
    let r = async {
        descomprimir(origen, &tmp).await?;
        // Un gzip que no lleva dentro una base tampoco es una copia.
        if !es_base_sqlite(&tmp).map_err(db_err)? {
            return Err(no_es_una_copia());
        }
        validate_backup(&tmp).await?;
        // AUD-06: una copia de otro negocio no entra en el almacén de éste.
        comprobar_procedencia_de_copia(&tmp, licencia)
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

/// AUD-18 · Deja `_Sync_Failed` de la copia que se va a instalar coherente con su checkpoint.
///
/// - **Lo que va por encima** del checkpoint de la copia se borra: el catch-up de la
///   reconciliación lo vuelve a traer desde ahí y lo intenta otra vez, en orden, con el contador a
///   cero. Lo que registraba eran intentos contra un estado que se está reemplazando.
/// - **El marcador de `_Sync_Applied_Ops` de lo que se borra** depende de quién lo puso:
///   - Si lo puso una **cuarentena que no llegó a mover el checkpoint** (una copia anterior a que
///     la cuarentena fuera atómica, `sync::anotar_fallo`), se borra: con él, el gate daría por
///     aplicado un cambio que esta base nunca aplicó. Se reconoce porque la cuarentena va tras el
///     último intento (`Attempts` agotados) y su marcador lleva la hora de ese momento, posterior
///     al último fallo.
///   - Si es el **anti-eco de una operación propia**, se queda: la operación ya está aplicada en
///     esta base (se escribió aquí), y lo que falló fue mover el checkpoint al volver su eco. Se
///     puso al escribirla, antes de subirla y de que su eco pudiera fallar; y con la cuarentena
///     atómica, lo que queda por encima del checkpoint nunca tiene los intentos agotados. Sin él,
///     el catch-up la aplicaría otra vez (un `Stock - 1` dos veces).
/// - **Lo que va por debajo y está en cuarentena se conserva**: el checkpoint ya pasó por encima,
///   así que el catch-up no lo traerá nunca y esta copia no tiene ese cambio. Borrarlo lo
///   escondería y le abriría a `verificar_nube` la puerta de borrar o pisar arriba lo que ese
///   cambio hizo. Con él, el desbloqueo (`commands::recovery::completar`, que exige cuarentena = 0)
///   no llega con esta copia: la salida es otra copia o la nube, que es lo que dice la pantalla al
///   quedar bloqueada.
/// - Lo que va por debajo **sin** cuarentena (una copia anterior a AUD-18, cuando el checkpoint
///   podía saltarse un fallo) pasa a estarlo, porque es lo que es: un cambio que el checkpoint dejó
///   atrás y que no volverá.
async fn ajustar_registro_de_fallos(db: &Db) -> AppResult<()> {
    use crate::db::Writer;
    let w = db.write().await;
    let conn: &Connection = w.raw();
    conn.transaccion(async {
        // DO-SUBIDA: la subida completa que tuviera la copia era de una base que ya no es ésta. Si la
        // nube la sigue pidiendo, la primera sesión normal empieza otra con lo que hay ahora.
        crate::subida_completa::vaciar(conn).await?;
        conn.execute(
            "DELETE FROM _Sync_Applied_Ops \
              WHERE EXISTS (SELECT 1 FROM _Sync_Failed f \
                             WHERE f.Op_Id = _Sync_Applied_Ops.Op_Id \
                               AND f.Seq > (SELECT Last_Seq FROM _Sync_State WHERE Id = 1) \
                               AND f.Attempts >= ?1 \
                               AND _Sync_Applied_Ops.Applied_At_Ms >= f.Last_Failed_At_Ms);",
            vec![Value::Integer(crate::sync::MAX_APPLY_ATTEMPTS)],
        )
        .await
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM _Sync_Failed \
              WHERE Seq > (SELECT Last_Seq FROM _Sync_State WHERE Id = 1);",
            (),
        )
        .await
        .map_err(db_err)?;
        conn.execute(
            "UPDATE _Sync_Failed SET Quarantined = 1 WHERE Quarantined = 0;",
            (),
        )
        .await
        .map_err(db_err)?;
        Ok(())
    })
    .await
}

/// Vacía el resumen diario de las estadísticas de la copia que se va a instalar y deja por calcular
/// todos sus días con cobros (`estadisticas_diarias::reiniciar`).
async fn reiniciar_resumen_de_estadisticas(db: &Db) -> AppResult<()> {
    use crate::db::Writer;
    let w = db.write().await;
    let conn: &Connection = w.raw();
    conn.transaccion(crate::estadisticas_diarias::reiniciar(conn)).await
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
///
/// AUD-06: con un cambio de negocio pendiente no se borra nada (`purgar`, antes de cada borrado):
/// todo eso es del negocio que se aparta al arrancar.
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
            if let Err(e) = purgar(app_data_dir, &path) {
                tracing::warn!(target: "tpv::recovery", fichero = %nombre_de(&path), error = %e, "no se pudo purgar un temporal de copia");
            }
        }

        for familia in ["pre-restore-", "failed-restore-", ILEGIBLE_PREFIX, ANTES_DE_TRASLADO_PREFIX, ANTES_DE_LA_NUBE_PREFIX] {
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
                if let Err(e) = purgar(app_data_dir, &path) {
                    tracing::warn!(target: "tpv::recovery", fichero = %nombre_de(&path), error = %e, "no se pudo purgar un resto de restauración");
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
        if let Err(e) = purgar(app_data_dir, &path) {
            tracing::warn!(target: "tpv::recovery", fichero = %nombre_de(&path), error = %e, "no se pudo purgar un temporal de restauración");
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
        if let Err(e) = purgar(app_data_dir, &path) {
            tracing::warn!(target: "tpv::recovery", fichero = %nombre_de(&path), error = %e, "no se pudo purgar una copia de migración");
        }
    }

    Ok(())
}

/// Copia y valida el respaldo en un fichero temporal independiente. Además lo marca pendiente de
/// reconciliación ANTES del intercambio, para que ni un crash entre pasos pueda abrir el login.
pub async fn prepare_restore(app_data_dir: &Path, id: &str, licencia: Option<&str>) -> AppResult<PathBuf> {
    // Tras un traslado, cualquier copia de este equipo es de antes: restaurarla sería volver a
    // trabajar con lo que el traslado deja atrás. La pantalla ya no la ofrece; esto es la red.
    if hay_traslado_pendiente(app_data_dir) {
        return Err(AppError::conflict(
            "La licencia viene de otro equipo: los datos tienen que traerse de la nube. Una copia de este ordenador es de antes del traslado.",
        ));
    }
    // SYNC-32: lo mismo con una base anterior a lo que guarda la nube. Las copias de este ordenador
    // son de esa base o de antes (una imagen de disco las trae con ella): la salida es la nube.
    if hay_base_anterior_a_la_nube(app_data_dir) {
        return Err(AppError::conflict(
            "Los datos de este ordenador son anteriores a lo que guarda la nube: hay que traer el estado actual de la nube. Una copia de este ordenador no sirve.",
        ));
    }
    // AUD-06: tampoco sobre una base de otro negocio que la licencia (sin apartar porque algo no se
    // dejó mover), ni con un apartado a medias: ésa se aparta entera antes de poner nada en su sitio.
    // Restaurar la movería sola y dejaría lo demás de su negocio (sus imágenes, su cola) junto a la
    // base restaurada. Con un cambio de negocio pendiente sí se restaura: la licencia vigente sigue
    // siendo la de la base, y la marca no se toca (el arranque aparta lo que haya).
    let de_otro_negocio = match licencia {
        Some(negocio) => matches!(
            procedencia(&crate::sello::del_fichero(&app_data_dir.join("data.db"))?, negocio),
            Procedencia::DeOtroNegocio | Procedencia::Desconocida
        ),
        None => false,
    };
    if de_otro_negocio || hay_apartado_a_medias(app_data_dir)? {
        return Err(AppError::conflict(
            "Los datos de este ordenador son de otro negocio y hay que apartarlos antes de restaurar nada. Cierra el TPV y vuelve a abrirlo.",
        ));
    }
    let source = resolve_backup(app_data_dir, id)?;

    // La copia se descomprime directamente en el temporal que se va a instalar, y se valida ahí:
    // es exactamente la base que acabará siendo `data.db`.
    let prepared = app_data_dir.join(format!("data.restore.{}.tmp", now_ms()));
    let result = async {
        descomprimir(&source, &prepared).await?;
        validate_backup(&prepared).await?;
        // AUD-06: la red de la misma regla, por si una copia de otro negocio llegó al almacén.
        comprobar_procedencia_de_copia(&prepared, licencia)?;
        let prepared_str = prepared
            .to_str()
            .ok_or_else(|| AppError::internal("Ruta temporal de restauración inválida"))?;
        let db = Db::open(prepared_str).await.map_err(|e| al_preparar_la_copia(e.as_ref()))?;
        mark_reconciliation_pending(&db).await?;
        if id.starts_with(IMPORT_PREFIX) {
            vaciar_lo_pendiente_de_subir(&db).await?;
        }
        ajustar_registro_de_fallos(&db).await?;
        // El resumen diario de las estadísticas que trae la copia se rehace entero: es una caché,
        // y así no depende de con qué versión se hizo la copia.
        reiniciar_resumen_de_estadisticas(&db).await?;
        // El PDF de las facturas que la copia da por guardado en el equipo puede no estar en esta
        // carpeta (una base traída de otro equipo): el job las vuelve a documentar.
        crate::facturas_pdf::olvidar_los_pdf_locales(&db).await?;
        {
            let w = db.write().await;
            let _ = w.raw().query("PRAGMA wal_checkpoint(TRUNCATE);", ()).await;
        }
        db.cerrar().await.map_err(db_err)?;
        drop(db);
        // AUD-22: ya migrada, sus disparadores y vistas son los de este programa, ni uno más.
        let ruta = prepared.clone();
        en_hilo_aparte(move || async move { comprobar_disparadores_y_vistas(&ruta) }).await?;
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

/// AUD-22 · Una copia traída de fuera (`import-*`) no sube lo que tenía pendiente.
///
/// Su outbox lo escribió otro equipo, o alguien con un editor de SQLite: subirlo sería mandar a la
/// nube, como operaciones de esta Main, sentencias que nadie ha hecho aquí. Las filas se quedan en la
/// base; lo que la nube no tenga lo repara por estado el contraste (`verificar_nube`). Las copias
/// que hace este equipo conservan su outbox: son suyas. `_Sync_Applied_Ops` no se toca: es lo que
/// evita aplicar dos veces el eco de lo propio.
async fn vaciar_lo_pendiente_de_subir(db: &Db) -> AppResult<()> {
    let w = db.write().await;
    let quitadas = w.raw().execute("DELETE FROM _Sync_Outbox;", ()).await.map_err(db_err)?;
    if quitadas > 0 {
        tracing::warn!(
            target: "tpv::recovery",
            operaciones = quitadas,
            "la copia traída de fuera tenía operaciones sin subir: no se suben, las repara el contraste"
        );
    }
    Ok(())
}

/// AUD-22 · Lo que se dice de una copia con disparadores o vistas que este programa no crea.
pub const MSG_COPIA_RETOCADA: &str =
    "Esta copia no es como las que hace el programa: se ha cambiado con otro programa y no se puede restaurar.";

/// AUD-22 · Los disparadores y vistas de la copia, ya migrada, son exactamente los que crean las
/// migraciones de este programa. Un disparador que ninguna migración crea sobrevive a todas y se
/// dispara con las escrituras normales (p. ej., llenando el outbox de lo que nadie ha hecho).
fn comprobar_disparadores_y_vistas(copia: &Path) -> AppResult<()> {
    fn objetos(conn: &rusqlite::Connection) -> AppResult<std::collections::BTreeSet<(String, String, String)>> {
        let mut stmt = conn
            .prepare("SELECT type, name, COALESCE(sql, '') FROM sqlite_master WHERE type IN ('trigger', 'view');")
            .map_err(|e| db_err(ErrorSql::from(e)))?;
        let filas = stmt
            .query_map([], |f| Ok((f.get::<_, String>(0)?, f.get::<_, String>(1)?, f.get::<_, String>(2)?)))
            .map_err(|e| db_err(ErrorSql::from(e)))?;
        let mut out = std::collections::BTreeSet::new();
        for fila in filas {
            let (tipo, nombre, sql) = fila.map_err(|e| db_err(ErrorSql::from(e)))?;
            out.insert((tipo, nombre, sql.split_whitespace().collect::<Vec<_>>().join(" ")));
        }
        Ok(out)
    }
    let limpia = crate::ejecutor::abrir(":memory:").map_err(db_err)?;
    crate::migrations::run(&limpia).map_err(|e| AppError::internal(format!("No se pudo preparar el esquema de referencia: {e}")))?;
    let esperados = objetos(&limpia)?;
    let conn = crate::ejecutor::abrir(copia).map_err(|e| corrupta(format!("No se puede abrir la copia: {e}")))?;
    let tiene = objetos(&conn)?;
    let ajenos: Vec<&str> = tiene.difference(&esperados).map(|(_, nombre, _)| nombre.as_str()).collect();
    let faltan: Vec<&str> = esperados.difference(&tiene).map(|(_, nombre, _)| nombre.as_str()).collect();
    if ajenos.is_empty() && faltan.is_empty() {
        return Ok(());
    }
    tracing::warn!(
        target: "tpv::recovery",
        ajenos = ?ajenos,
        faltan = ?faltan,
        "copia con disparadores o vistas distintos de los de las migraciones"
    );
    Err(AppError::coded(ErrorCode::BackupCorrupt, MSG_COPIA_RETOCADA))
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

    /// La base de un equipo con la licencia de `negocio-de-prueba`: con su admin y sellada, como
    /// la deja la activación. Sus copias llevan el sello, que es lo que deja restaurarlas (SYNC-33).
    async fn db_operativa(dir: &Path) -> std::sync::Arc<Db> {
        let db = db_sin_sello(dir).await;
        sellar(&db, "negocio-de-prueba").await;
        db
    }

    /// La base de un equipo antes de activar la licencia: con su admin y sin sello.
    async fn db_sin_sello(dir: &Path) -> std::sync::Arc<Db> {
        std::fs::create_dir_all(dir).unwrap();
        crate::connection::init_main_db(dir, None).await.unwrap()
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

    /// SYNC-32: una base anterior a lo que guarda la nube no se usa, tenga usuarios o esté a medio
    /// reconciliar, hasta reconstruirla desde la nube. Un traslado manda sobre ella (también es
    /// «sólo la nube», y su pantalla lo explica). Marcarla cierra las escrituras al momento.
    #[tokio::test]
    async fn una_base_anterior_a_la_nube_no_se_usa_hasta_traer_la_nube() {
        let dir = test_dir("anterior_estado");
        let db = db_operativa(&dir).await;
        assert!(!db.escrituras_de_negocio_bloqueadas());

        marcar_anterior_a_la_nube(&db).unwrap();
        assert!(db.escrituras_de_negocio_bloqueadas());
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::OlderThanCloud);
        mark_reconciliation_pending(&db).await.unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::OlderThanCloud);
        marcar_traslado(&dir).unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::TransferPending);
        quitar_marca_traslado(&dir).unwrap();

        quitar_marca_anterior_a_la_nube(&dir).unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::ReconciliationPending);
        quitar_marca_anterior_a_la_nube(&dir).unwrap();

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
        let db = crate::connection::init_main_db(&dir, Some("negocio-de-prueba")).await.unwrap();
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
        let err = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict);

        quitar_marca_traslado(&dir).unwrap();
        let preparada = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();
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

        let conn = crate::ejecutor::abrir(&path).unwrap();
        let nombre = conn
            .query_row(
                "SELECT Nombre FROM Usuarios WHERE ID_Usuario = ?1;",
                [crate::util::ADMIN_USUARIO_ID],
                |fila| fila.get::<_, Value>(0),
            )
            .unwrap();
        assert_eq!(nombre, Value::Text("Nombre sólo local".into()));

        drop(conn);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una copia sana con el esquema de otra versión (una migración aplicada que no es la de este
    /// programa) no es una copia dañada: decirlo así invitaba a tirar una copia buena.
    #[tokio::test]
    async fn una_copia_de_otra_version_no_se_da_por_danada() {
        let dir = test_dir("otra_version");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw()
                .execute("UPDATE _migrations SET hash = 'de-otra-version' WHERE name = '0001_inicial.sql';", ())
                .await
                .unwrap();
        }
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();

        let err = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::Validation);
        assert_eq!(err.to_string(), MSG_COPIA_DE_OTRA_VERSION);
        let temporales = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("data.restore."))
            .count();
        assert_eq!(temporales, 0, "el temporal se descarta");

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo que el motor dice al abrir la copia preparada decide la frase: el disco y una base rota
    /// mandan sobre la migración en la que pasaron.
    #[test]
    fn el_fallo_al_preparar_la_copia_dice_lo_que_ha_pasado() {
        use crate::migrations::{MigracionAlterada, MigracionFallida};
        use rusqlite::ffi;
        let del_motor = |codigo: i32| -> Box<dyn std::error::Error + Send + Sync> {
            Box::new(rusqlite::Error::SqliteFailure(ffi::Error::new(codigo), None))
        };
        let en_migracion = |causa: Box<dyn std::error::Error + Send + Sync>| -> Box<dyn std::error::Error + Send + Sync> {
            Box::new(MigracionFallida { nombre: "0002_x.sql".into(), causa })
        };
        let clase = |e: Box<dyn std::error::Error + Send + Sync>| fallo_al_preparar(e.as_ref());

        assert_eq!(clase(Box::new(MigracionAlterada { nombre: "0001_inicial.sql".into() })), FalloAlPreparar::OtraVersion);
        assert_eq!(clase(en_migracion(del_motor(ffi::SQLITE_ERROR))), FalloAlPreparar::OtraVersion, "no such column");
        assert_eq!(clase(en_migracion(del_motor(ffi::SQLITE_FULL))), FalloAlPreparar::Disco, "disco lleno al migrar");
        assert_eq!(clase(en_migracion(del_motor(ffi::SQLITE_IOERR_WRITE))), FalloAlPreparar::Disco, "código extendido");
        assert_eq!(
            clase(Box::new(ErrorSql::SqliteFailure(ffi::SQLITE_CANTOPEN, "unable to open database file".into()))),
            FalloAlPreparar::Disco,
            "del ejecutor, al abrir"
        );
        assert_eq!(clase(Box::new(std::io::Error::other("sin espacio"))), FalloAlPreparar::Disco);
        assert_eq!(clase(del_motor(ffi::SQLITE_NOTADB)), FalloAlPreparar::Danada);
        assert_eq!(clase(en_migracion(del_motor(ffi::SQLITE_CORRUPT))), FalloAlPreparar::Danada);
        assert_eq!(clase("otra cosa".into()), FalloAlPreparar::Otro);

        let mensaje = |e: Box<dyn std::error::Error + Send + Sync>| al_preparar_la_copia(e.as_ref()).to_string();
        assert_eq!(mensaje(del_motor(ffi::SQLITE_FULL)), MSG_SIN_DISCO_PARA_PREPARARLA);
        assert_eq!(mensaje(del_motor(ffi::SQLITE_NOTADB)), MSG_COPIA_DANADA);
        assert_eq!(mensaje("otra cosa".into()), MSG_NO_SE_PUDO_PREPARAR);
    }

    #[tokio::test]
    async fn preparar_una_copia_deja_el_login_bloqueado() {
        let dir = test_dir("pending");
        let db = db_operativa(&dir).await;
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();

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

    #[tokio::test]
    async fn preparar_una_copia_deja_por_rehacer_el_resumen_de_las_estadisticas() {
        // El resumen diario es una caché: el que trae la copia no se usa, venga de la versión que
        // venga. Se vacía y quedan apuntados todos los días con cobros de la copia.
        let dir = test_dir("resumen-estadisticas");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'BARRA', '2026-03-02 12:00:00', 'Pagada');
                     INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p1', 'c1', '2026-03-02 13:00:00', 'Efectivo', 500, 'total');
                     DELETE FROM _Estad_Dias_Sucios;
                     INSERT INTO _Estad_Producto_Dia VALUES ('2025-01-01', 'p-viejo', 'Viejo', 9);",
                )
                .await
                .unwrap();
        }
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();

        let restored = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert_eq!(cuenta(&restored, "SELECT COUNT(*) FROM _Estad_Producto_Dia;").await, 0);
        assert_eq!(
            cuenta(&restored, "SELECT COUNT(*) FROM _Estad_Dias_Sucios WHERE Dia = '2026-03-02';").await,
            1
        );
        assert_eq!(cuenta(&restored, "SELECT COUNT(*) FROM _Estad_Dias_Sucios;").await, 1);

        drop(restored);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn preparar_una_copia_deja_por_documentar_el_pdf_de_las_facturas() {
        // La copia trae `_Facturas_Pdf` con lo que tenía el equipo que la hizo, y esta carpeta
        // puede no tener esos PDF (una data.db traída de otro equipo). Se olvida lo local y se
        // conserva que la nube lo tiene, para bajarlo de ella.
        let dir = test_dir("pdf-facturas");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Facturas_Pdf (ID_Registro, Ruta, Origen, Generado_Ms, Subido_Ms, Intentos, Ultimo_Error, Proximo_Intento_Ms, Apartado)
                       VALUES ('00000000-0000-7000-8000-0000000000f1', 'facturas/x.pdf', 'generado', 5, 6, 2, 'fallo', 99, 1);",
                )
                .await
                .unwrap();
        }
        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();

        let restored = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert_eq!(
            cuenta(
                &restored,
                "SELECT COUNT(*) FROM _Facturas_Pdf WHERE Ruta IS NULL AND Origen IS NULL AND Generado_Ms IS NULL \
                   AND Subido_Ms = 6 AND Intentos = 0 AND Ultimo_Error IS NULL AND Proximo_Intento_Ms IS NULL \
                   AND Apartado = 0;"
            )
            .await,
            1
        );

        drop(restored);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una base con el checkpoint en 10 y tres fallos de bajada: una cuarentena por debajo (7), un
    /// fallo sin cuarentena por debajo (5, como los que dejaba el checkpoint al saltarse un fallo
    /// antes de AUD-18) y otro por encima (12), en el que la bajada está detenida.
    async fn registrar_fallos_de_bajada(db: &Db) {
        let w = db.write().await;
        w.raw()
            .execute_batch(
                "UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
                 INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
                   Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms)
                 VALUES ('op-apartada', 7, '[]', 5, 1, 'no such table', 1, 1),
                        ('op-saltada', 5, '[]', 1, 0, 'FOREIGN KEY constraint failed', 1, 1),
                        ('op-detenida', 12, '[]', 2, 0, 'UNIQUE constraint failed', 1, 1);",
            )
            .await
            .unwrap();
    }

    async fn fallos(db: &Db) -> Vec<(String, i64)> {
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query("SELECT Op_Id, Quarantined FROM _Sync_Failed ORDER BY Seq;", ())
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(f) = rows.next().await.unwrap() {
            let op = match f.get_value(0).unwrap() {
                Value::Text(s) => s,
                v => panic!("{v:?}"),
            };
            out.push((op, crate::mapping::v_i64(f.get_value(1).unwrap()).unwrap_or(-1)));
        }
        out
    }

    /// AUD-18: restaurar una copia deja `_Sync_Failed` coherente con el checkpoint de la copia.
    /// Lo que va por encima lo vuelve a traer el catch-up (y a intentar); la cuarentena de debajo
    /// se conserva, porque esa copia no tiene ese cambio y el catch-up no lo traerá; y un fallo de
    /// debajo sin cuarentena pasa a estarlo, que es lo que es.
    #[tokio::test]
    async fn la_copia_restaurada_deja_los_fallos_de_bajada_coherentes_con_su_checkpoint() {
        let dir = test_dir("cuarentena");
        let db = db_operativa(&dir).await;
        registrar_fallos_de_bajada(&db).await;

        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let origen = abrible(&dir, &backup.id).await;
        let copia = Db::open(origen.to_str().unwrap()).await.unwrap();
        assert_eq!(fallos(&copia).await.len(), 3, "la copia refleja el estado del momento");
        drop(copia);

        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();
        let lista = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert_eq!(
            fallos(&lista).await,
            vec![("op-saltada".to_string(), 1), ("op-apartada".to_string(), 1)],
        );
        assert_eq!(cuenta(&lista, "SELECT Last_Seq FROM _Sync_State WHERE Id = 1;").await, 10);

        drop(lista);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-18: una copia tomada cuando la cuarentena eran tres commits sueltos pudo fotografiar el
    /// marcador de `_Sync_Applied_Ops` (con la marca de cuarentena o sin ella) y no el avance del
    /// checkpoint. Al restaurarla, el fallo de encima del checkpoint se borra y se lleva su
    /// marcador: cuando el catch-up trae el cambio, se aplica de verdad en vez de darse por
    /// aplicado y quedar atrás para siempre.
    #[tokio::test]
    async fn la_copia_con_la_cuarentena_a_medias_no_da_por_aplicado_lo_que_nunca_se_aplico() {
        use tpv_application::ports::sync::SyncRepository;
        use tpv_contracts::sync::{SqlStatement, SyncChange};

        let dir = test_dir("cuarentena_a_medias");
        let db = db_operativa(&dir).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
                     INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
                       Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms)
                     VALUES ('op-solo-marcador', 12, '[]', 5, 0, 'no such table', 1, 1),
                            ('op-sin-checkpoint', 13, '[]', 5, 1, 'no such table', 1, 1);
                     INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms)
                     VALUES ('op-solo-marcador', 12, 1), ('op-sin-checkpoint', 13, 1);",
                )
                .await
                .unwrap();
        }

        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();
        let lista = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert!(fallos(&lista).await.is_empty());
        assert_eq!(
            cuenta(
                &lista,
                "SELECT COUNT(*) FROM _Sync_Applied_Ops \
                  WHERE Op_Id IN ('op-solo-marcador', 'op-sin-checkpoint');",
            )
            .await,
            0,
            "el fallo descartado se lleva su marcador"
        );

        // El catch-up los trae desde el checkpoint de la copia, y ahora entran de verdad.
        let zona = |op: &str, seq: i64, id: &str| SyncChange {
            op_id: op.into(),
            seq,
            statements: vec![SqlStatement {
                sql: format!("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('{id}', '{id}');"),
                args: vec![],
            }],
        };
        let repo = crate::sync::SqliteSyncRepository::new(lista.clone());
        let r = repo
            .apply_changes(vec![
                zona("op-solo-marcador", 12, "z-12"),
                zona("op-sin-checkpoint", 13, "z-13"),
            ])
            .await
            .unwrap();
        assert_eq!(r.aplicadas, vec!["op-solo-marcador".to_string(), "op-sin-checkpoint".to_string()]);
        assert_eq!((r.last_seq, r.detenida.is_none()), (13, true));
        assert_eq!(
            cuenta(&lista, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z-12', 'z-13');").await,
            2
        );

        drop(repo);
        drop(lista);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-18 (Codex, tercera revisión bis, 1): el eco de una venta propia, ya aplicada aquí, no
    /// pudo mover el checkpoint, y la copia se tomó entonces: su fallo va por encima del checkpoint y
    /// su marcador es el anti-eco. Restaurar no puede llevárselo: el catch-up la aplicaría otra vez.
    /// Tampoco el de una copia vieja en la que ese eco agotó sus intentos y la cuarentena no llegó a
    /// mover el checkpoint: el anti-eco es de antes de cualquier fallo de su eco.
    #[tokio::test]
    async fn restaurar_conserva_el_anti_eco_de_lo_propio_y_no_lo_aplica_dos_veces() {
        use tpv_application::ports::sync::SyncRepository;
        use tpv_contracts::sync::{SqlStatement, SyncChange};

        let dir = test_dir("eco_propio");
        let db = db_operativa(&dir).await;
        {
            // Stock 9: la venta propia ya se descontó aquí. Su eco es el 12.
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c-1', 'Bebidas');
                     INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Stock_Suelto)
                     VALUES ('p-1', 'c-1', 'Agua', 9), ('p-2', 'c-1', 'Zumo', 4);
                     UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
                     INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms)
                     VALUES ('op-venta', 12, 1000), ('op-venta-vieja', 13, 1000);
                     INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
                       Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms)
                     VALUES ('op-venta', 12, '[]', 1, 0, 'database is locked', 2000, 2000),
                            ('op-venta-vieja', 13, '[]', 5, 1, 'database is locked', 1500, 2000);",
                )
                .await
                .unwrap();
        }

        let backup = create_backup(&db, &dir).await.unwrap().unwrap();
        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();
        let lista = Db::open(prepared.to_str().unwrap()).await.unwrap();
        assert!(fallos(&lista).await.is_empty());
        assert_eq!(
            cuenta(
                &lista,
                "SELECT COUNT(*) FROM _Sync_Applied_Ops WHERE Op_Id IN ('op-venta', 'op-venta-vieja');"
            )
            .await,
            2,
            "los anti-ecos se quedan"
        );

        // El catch-up trae el eco: el gate lo salta y el stock no se descuenta otra vez.
        let repo = crate::sync::SqliteSyncRepository::new(lista.clone());
        let eco = |op: &str, seq: i64, producto: &str| SyncChange {
            op_id: op.into(),
            seq,
            statements: vec![SqlStatement {
                sql: format!(
                    "UPDATE Productos SET Stock_Suelto = Stock_Suelto - 1 WHERE ID_Producto = '{producto}';"
                ),
                args: vec![],
            }],
        };
        let r = repo
            .apply_changes(vec![eco("op-venta", 12, "p-1"), eco("op-venta-vieja", 13, "p-2")])
            .await
            .unwrap();
        assert!(r.aplicadas.is_empty());
        assert_eq!((r.last_seq, r.detenida.is_none()), (13, true));
        assert_eq!(
            cuenta(&lista, "SELECT CAST(Stock_Suelto AS INTEGER) FROM Productos WHERE ID_Producto = 'p-1';")
                .await,
            9
        );
        assert_eq!(
            cuenta(&lista, "SELECT CAST(Stock_Suelto AS INTEGER) FROM Productos WHERE ID_Producto = 'p-2';")
                .await,
            4
        );
        assert!(fallos(&lista).await.is_empty());

        drop(repo);
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
        let exportada = export_backup(&dir, &backup.id, &fuera, Some("negocio-de-prueba")).await.unwrap();
        assert!(fuera.is_file(), "la carpeta destino se crea si no existía");
        // REC-INC-01: la «USB» de la prueba es una carpeta del mismo disco, y se dice.
        assert_eq!(
            exportada.donde,
            DondeQuedaLaCopia::EnEsteEquipo,
            "una carpeta junto a los datos sigue en este equipo"
        );

        std::fs::remove_file(dir.join(BACKUP_DIR).join(&backup.id)).unwrap();
        assert!(list_backups(&dir).unwrap().is_empty());

        let vuelta = import_backup(&dir, &fuera, Some("negocio-de-prueba")).await.unwrap();
        assert!(vuelta.importada);
        let lista = list_backups(&dir).unwrap();
        assert_eq!(lista.len(), 1);
        assert!(lista[0].importada);
        // Y se puede restaurar como cualquier otra: es el mismo camino, no una segunda vía.
        let prepared = prepare_restore(&dir, &vuelta.id, Some("negocio-de-prueba")).await.unwrap();
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

        let err = import_backup(&dir, &basura, Some("negocio-de-prueba")).await.unwrap_err();
        // No es una copia estropeada: no es una copia (se mira la cabecera antes de abrirla).
        assert_eq!(err.code(), ErrorCode::Validation);
        assert_eq!(err.to_string(), MSG_NO_ES_UNA_COPIA);
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

        let prepared = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap();
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
        let prepared = prepare_restore(&dir, &listada.id, Some("negocio-de-prueba")).await.unwrap();
        discard_prepared(&prepared);
        export_backup(&dir, &listada.id, &dir.join("usb").join("vieja.db"), Some("negocio-de-prueba"))
            .await
            .unwrap();

        // Traída de fuera: se importa y se guarda comprimida.
        let importada = import_backup(&dir, &base, Some("negocio-de-prueba")).await.unwrap();
        assert!(importada.id.ends_with(BACKUP_SUFFIX));
        assert!(es_gzip(&dir.join(BACKUP_DIR).join(&importada.id)).unwrap());

        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Restaurar un archivo que no es una copia (un PDF, o un gzip con otra cosa dentro) se rechaza
    /// diciendo qué elegir, no con el error del motor en inglés («file is not a database»).
    #[tokio::test]
    async fn un_archivo_que_no_es_una_copia_se_rechaza_diciendo_que_elegir() {
        let dir = test_dir("no_es_copia");
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = dir.join("factura.pdf");
        std::fs::write(&pdf, b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n").unwrap();
        let pdf_comprimido = dir.join("factura.db.gz");
        {
            let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&pdf_comprimido).unwrap(), flate2::Compression::default());
            gz.write_all(&std::fs::read(&pdf).unwrap()).unwrap();
            gz.finish().unwrap();
        }
        let vacio = dir.join("vacio.db");
        std::fs::write(&vacio, b"").unwrap();

        for archivo in [&pdf, &pdf_comprimido, &vacio] {
            let err = import_backup(&dir, archivo, Some("negocio-de-prueba")).await.unwrap_err();
            assert_eq!(err.code(), ErrorCode::Validation, "{archivo:?}");
            assert_eq!(err.to_string(), MSG_NO_ES_UNA_COPIA, "{archivo:?}");
        }
        assert!(MSG_NO_ES_UNA_COPIA.contains("«Guardar fuera…»"), "el texto del botón de Configuración");
        assert!(list_backups(&dir).unwrap().is_empty(), "no entra nada en el almacén");

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una base que empieza como una de SQLite pero está estropeada es una copia dañada, con una
    /// frase en español; el detalle del motor queda en el registro.
    #[tokio::test]
    async fn una_copia_estropeada_lo_dice_sin_el_error_del_motor() {
        let dir = test_dir("copia_estropeada");
        std::fs::create_dir_all(&dir).unwrap();
        let rota = dir.join("rota.db");
        let mut bytes = CABECERA_SQLITE.to_vec();
        bytes.extend(std::iter::repeat_n(0xAB, 8192));
        std::fs::write(&rota, &bytes).unwrap();

        let err = import_backup(&dir, &rota, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        assert_eq!(err.to_string(), MSG_COPIA_DANADA);

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

        let err = prepare_restore(&dir, &backup.id, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        let err = export_backup(&dir, &backup.id, &dir.join("usb").join("rota.db.gz"), Some("negocio-de-prueba"))
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

    // ── AUD-06 · el sello de la base ────────────────────────────────────────────

    async fn sellar(db: &Db, negocio: &str) {
        let w = db.write().await;
        crate::sello::escribir(w.raw(), negocio).await.unwrap();
    }

    /// AUD-22 · Lo que una copia traída de fuera tenía pendiente de subir no sube como de esta Main;
    /// una copia de este equipo sí conserva lo suyo.
    #[tokio::test]
    async fn una_copia_traida_de_fuera_no_sube_su_outbox() {
        let dir = test_dir("aud22_outbox");
        let db = db_operativa(&dir).await;
        db.write()
            .await
            .raw()
            .execute_batch(
                r#"INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-ajena', 'main_op', '[{"sql":"DELETE FROM Clientes;","args":[]}]', 1);"#,
            )
            .await
            .unwrap();
        let copia = create_backup(&db, &dir).await.unwrap().unwrap().id;
        let fuera = dir.join("usb").join("copia.db.gz");
        export_backup(&dir, &copia, &fuera, Some("negocio-de-prueba")).await.unwrap();
        let importada = import_backup(&dir, &fuera, Some("negocio-de-prueba")).await.unwrap();

        for (id, outbox) in [(&importada.id, 0), (&copia, 1)] {
            let preparada = prepare_restore(&dir, id, Some("negocio-de-prueba")).await.unwrap();
            let conn = crate::ejecutor::abrir(&preparada).unwrap();
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM _Sync_Outbox;", [], |f| f.get(0)).unwrap();
            assert_eq!(n, outbox, "{id}");
            drop(conn);
            discard_prepared(&preparada);
        }
        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-22 · Una copia con un disparador (o una vista) que ninguna migración crea no se restaura:
    /// sobreviviría a todas y se dispararía con las escrituras normales.
    #[tokio::test]
    async fn una_copia_con_un_disparador_ajeno_no_se_restaura() {
        let dir = test_dir("aud22_trigger");
        let db = db_operativa(&dir).await;
        let buena = create_backup(&db, &dir).await.unwrap().unwrap().id;
        db.write()
            .await
            .raw()
            .execute_batch(
                r#"CREATE TRIGGER t_ajeno AFTER INSERT ON Zonas BEGIN INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-' || NEW.ID_Zona, 'main_op', '[]', 3); END;"#,
            )
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let retocada = create_backup(&db, &dir).await.unwrap().unwrap().id;

        let preparada = prepare_restore(&dir, &buena, Some("negocio-de-prueba")).await.unwrap();
        discard_prepared(&preparada);
        let err = prepare_restore(&dir, &retocada, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::BackupCorrupt);
        assert_eq!(err.to_string(), MSG_COPIA_RETOCADA);

        // Y una vista que no crea nadie, tampoco.
        db.write().await.raw().execute_batch("DROP TRIGGER t_ajeno; CREATE VIEW v_ajena AS SELECT 1;").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let con_vista = create_backup(&db, &dir).await.unwrap().unwrap().id;
        let err = prepare_restore(&dir, &con_vista, Some("negocio-de-prueba")).await.unwrap_err();
        assert_eq!(err.to_string(), MSG_COPIA_RETOCADA);

        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una copia es la base entera, así que lleva su sello, y sólo vale para la licencia de su
    /// negocio: ni se restaura ni se importa con la de otro. SYNC-33: una sin sello no dice de quién
    /// es, así que tampoco, con ninguna licencia.
    #[tokio::test]
    async fn una_copia_sellada_solo_se_restaura_o_importa_con_la_licencia_de_su_negocio() {
        // Las copias, hechas en el equipo del negocio A: una de antes de los sellos y otra sellada.
        let de_a = test_dir("sello_de_las_copias_a");
        let db_a = db_sin_sello(&de_a).await;
        let sin_sello = create_backup(&db_a, &de_a).await.unwrap().unwrap().id;
        sellar(&db_a, "negocio-a").await;
        // Otro instante: las copias se nombran por su milisegundo.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let sellada = create_backup(&db_a, &de_a).await.unwrap().unwrap().id;
        assert_ne!(sin_sello, sellada);
        assert_eq!(
            crate::sello::del_fichero(&abrible(&de_a, &sellada).await).unwrap(),
            Sello::De("negocio-a".into())
        );
        assert_eq!(crate::sello::del_fichero(&abrible(&de_a, &sin_sello).await).unwrap(), Sello::Ninguno);

        // Llevadas a un equipo cuya base no dice de quién es (recién instalado), con cada licencia.
        let dir = test_dir("sello_de_las_copias");
        let db = db_sin_sello(&dir).await;
        let fuera = dir.join("usb");
        std::fs::create_dir_all(&fuera).unwrap();
        std::fs::create_dir_all(dir.join(BACKUP_DIR)).unwrap();
        for copia in [&sin_sello, &sellada] {
            std::fs::copy(de_a.join(BACKUP_DIR).join(copia), dir.join(BACKUP_DIR).join(copia)).unwrap();
            std::fs::copy(de_a.join(BACKUP_DIR).join(copia), fuera.join(copia)).unwrap();
        }
        for (copia, licencia, vale) in [
            (&sin_sello, Some("negocio-x"), false),
            (&sin_sello, Some("negocio-a"), false),
            (&sin_sello, None, false),
            (&sellada, Some("negocio-a"), true),
            (&sellada, Some("negocio-x"), false),
            (&sellada, None, false),
        ] {
            match prepare_restore(&dir, copia, licencia).await {
                Ok(preparada) => {
                    assert!(vale, "{copia} con {licencia:?} se restauraría");
                    discard_prepared(&preparada);
                }
                Err(e) => assert!(!vale, "{copia} con {licencia:?}: {e}"),
            }
            assert_eq!(
                import_backup(&dir, &fuera.join(copia), licencia).await.is_ok(),
                vale,
                "{copia} importada con {licencia:?}"
            );
        }
        let err = prepare_restore(&dir, &sellada, Some("negocio-x")).await.unwrap_err();
        assert_eq!(err.code(), ErrorCode::Validation);
        assert!(err.to_string().contains("Esa copia es de otro negocio"), "{err}");
        let err = import_backup(&dir, &fuera.join(&sellada), None).await.unwrap_err();
        assert!(err.to_string().contains("Activa la licencia"), "{err}");
        // SYNC-33: la sin sello, con la licencia que sea, dice por qué.
        for licencia in ["negocio-a", "negocio-x"] {
            let err = prepare_restore(&dir, &sin_sello, Some(licencia)).await.unwrap_err();
            assert_eq!(err.code(), ErrorCode::Validation);
            assert_eq!(err.to_string(), MSG_COPIA_SIN_SELLO);
            let err = import_backup(&dir, &fuera.join(&sin_sello), Some(licencia)).await.unwrap_err();
            assert_eq!(err.to_string(), MSG_COPIA_SIN_SELLO);
        }

        // Y en el equipo de A, con la licencia de X ya vigente y la base de A sin apartar (porque algo
        // no se dejó mover), no se restaura ninguna: ni la de antes de los sellos.
        for copia in [&sin_sello, &sellada] {
            let err = prepare_restore(&de_a, copia, Some("negocio-x")).await.unwrap_err();
            assert!(err.to_string().contains("hay que apartarlos antes"), "{copia}: {err}");
        }
        assert!(prepare_restore(&de_a, &sellada, Some("negocio-a")).await.is_ok(), "con la suya, sí");
        // Ni se saca del equipo a un USB: sólo con la licencia de su negocio.
        let usb = de_a.join("usb");
        let err = export_backup(&de_a, &sellada, &usb.join("x.db.gz"), Some("negocio-x")).await.unwrap_err();
        assert!(err.to_string().contains("Esa copia es de otro negocio"), "{err}");
        assert!(!usb.join("x.db.gz").exists());
        export_backup(&de_a, &sellada, &usb.join("a.db.gz"), Some("negocio-a")).await.unwrap();
        // Ni la sin sello: no dice de quién es.
        let err = export_backup(&de_a, &sin_sello, &usb.join("antigua.db.gz"), Some("negocio-a")).await.unwrap_err();
        assert_eq!(err.to_string(), MSG_COPIA_SIN_SELLO);
        assert!(!usb.join("antigua.db.gz").exists());

        for (db, d) in [(db, dir), (db_a, de_a)] {
            db.cerrar().await.unwrap();
            drop(db);
            let _ = std::fs::remove_dir_all(d);
        }
    }

    /// Con un cambio de negocio pendiente (se ha activado la licencia de otro negocio, guardada como
    /// pendiente, y el TPV se reinicia) la base sigue siendo la del negocio vigente hasta el reinicio:
    /// operativa, con sus copias y sus escrituras. La marca se escribe entera o no se escribe, y ni
    /// abrir la base ni restaurar una copia en caliente la quitan: sólo el arranque.
    #[tokio::test]
    async fn un_cambio_de_negocio_pendiente_no_cambia_nada_hasta_el_arranque() {
        let dir = test_dir("cambio_pendiente");
        let db = db_sin_sello(&dir).await;
        sellar(&db, "negocio-a").await;
        let copia = create_backup(&db, &dir).await.unwrap().unwrap().id;

        let base = BaseLocal::new(&dir, Some(db.clone()));
        base.marcar_cambio_de_negocio("negocio-x").await.unwrap();

        assert_eq!(std::fs::read_to_string(dir.join(MARCA_CAMBIO_DE_NEGOCIO)).unwrap(), "negocio-x");
        assert!(!dir.join(format!("{MARCA_CAMBIO_DE_NEGOCIO}.tmp")).exists());
        assert_eq!(base.cambio_de_negocio_pendiente().await.unwrap().as_deref(), Some("negocio-x"));
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::Ready);
        assert!(!db.escrituras_de_negocio_bloqueadas());
        assert!(base_del_negocio(&db, "negocio-a").await.unwrap());
        assert!(create_backup(&db, &dir).await.unwrap().is_some());
        // Con la base abierta no se aparta nada.
        assert!(base.apartar_si_no_es_de("negocio-x").await.is_err());
        db.cerrar().await.unwrap();
        drop(db);

        // Restaurar en caliente una copia de A, con la licencia vigente de A: se puede, y la marca
        // sigue.
        let preparada = prepare_restore(&dir, &copia, Some("negocio-a")).await.unwrap();
        install_prepared(&dir, &preparada).unwrap();
        let db = crate::connection::init_main_db(&dir, Some("negocio-a")).await.unwrap();
        assert!(hay_cambio_de_negocio_pendiente(&dir), "ni restaurar ni abrir quitan la marca");
        assert!(carpetas_apartadas(&dir).unwrap().is_empty());
        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo de otro negocio se aparta ENTERO —la base y todas sus familias de copias y bases
    /// guardadas, no sólo las diarias e importadas— con la forma que tenía en AppData, a una
    /// carpeta en la que la purga no entra. Lo que es del equipo se queda, y un apartado anterior,
    /// terminado, no se toca.
    #[tokio::test]
    async fn se_aparta_todo_lo_de_otro_negocio_y_la_purga_no_entra() {
        let dir = test_dir("apartar_otro_negocio");
        let db = db_sin_sello(&dir).await;
        sellar(&db, "negocio-a").await;
        let diaria = create_backup(&db, &dir).await.unwrap().unwrap().id;
        db.cerrar().await.unwrap();
        drop(db);

        let copias = dir.join(BACKUP_DIR);
        let familias = [
            "import-2.db.gz", "pre-restore-3.db", "pre-restore-3-wal", "failed-restore-4.db",
            "ilegible-5.db", "antes-de-la-nube-6.db.gz", "antes-de-traslado-7.db.gz", ".backup-8.tmp",
        ];
        for nombre in familias {
            std::fs::write(copias.join(nombre), "de A").unwrap();
        }
        let del_negocio = [
            "data.db.bak.9", "data.db.bak.10", "data.restore.11.tmp", "image_uploads.json",
            "image_uploads.json.tmp", "traslado-pendiente", "anterior-a-la-nube",
        ];
        for nombre in del_negocio {
            std::fs::write(dir.join(nombre), "de A").unwrap();
        }
        std::fs::create_dir_all(dir.join("images").join("logo")).unwrap();
        std::fs::write(dir.join("images").join("logo").join("logo.png"), "logo de A").unwrap();
        std::fs::create_dir_all(dir.join("facturas")).unwrap();
        std::fs::write(dir.join("facturas").join("f.pdf"), "factura de A").unwrap();
        let del_equipo = ["license_state.json", "device_config.json", "interruptores.json"];
        for nombre in del_equipo {
            std::fs::write(dir.join(nombre), "del equipo").unwrap();
        }
        let anterior = copias.join("negocio-anterior-1");
        std::fs::create_dir_all(&anterior).unwrap();
        std::fs::write(anterior.join("data.db"), "de otro, apartado antes").unwrap();

        // Con la licencia del mismo negocio, o sin licencia, no se toca nada.
        assert_eq!(resolver_al_abrir(&dir, Some("negocio-a")).unwrap(), None);
        assert_eq!(resolver_al_abrir(&dir, None).unwrap(), None);
        assert!(dir.join("data.db").exists());

        marcar_cambio_de_negocio(&dir, "negocio-x").unwrap();
        let carpeta = resolver_al_abrir(&dir, Some("negocio-x")).unwrap().expect("apartado");

        assert_ne!(carpeta, anterior, "un apartado terminado no se reutiliza");
        assert!(!carpeta.join(APARTADO_EN_CURSO).exists(), "terminado");
        assert!(hay_cambio_de_negocio_pendiente(&dir), "la marca no es cosa de apartar");
        // El arranque la quita después; con ella puesta no se purgaría nada.
        quitar_cambio_de_negocio(&dir).unwrap();
        assert_eq!(crate::sello::del_fichero(&carpeta.join("data.db")).unwrap(), Sello::De("negocio-a".into()));
        let mut esperadas: Vec<String> = familias.iter().map(|f| f.to_string()).collect();
        esperadas.push(diaria.clone());
        esperadas.sort();
        let mut movidas: Vec<String> = std::fs::read_dir(carpeta.join(BACKUP_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        movidas.sort();
        assert_eq!(movidas, esperadas);
        for nombre in del_negocio {
            assert!(carpeta.join(nombre).exists(), "{nombre} apartado");
            assert!(!dir.join(nombre).exists(), "{nombre} ya no está en AppData");
        }
        assert_eq!(std::fs::read_to_string(carpeta.join("images").join("logo").join("logo.png")).unwrap(), "logo de A");
        assert!(!dir.join("images").exists());
        assert_eq!(std::fs::read_to_string(carpeta.join("facturas").join("f.pdf")).unwrap(), "factura de A");
        assert!(!dir.join("facturas").exists());
        assert!(!dir.join("data.db").exists());
        for nombre in del_equipo {
            assert!(dir.join(nombre).exists(), "{nombre} es del equipo y se queda");
        }
        assert_eq!(std::fs::read_to_string(anterior.join("data.db")).unwrap(), "de otro, apartado antes");
        assert!(list_backups(&dir).unwrap().is_empty());

        // La purga de restos no entra en lo apartado, ni con copias nuevas de todas las familias.
        for nombre in ["pre-restore-20.db", "pre-restore-21.db", "pre-restore-22.db", "antes-de-traslado-20.db.gz",
                       "antes-de-traslado-21.db.gz", "antes-de-traslado-22.db.gz"] {
            std::fs::write(copias.join(nombre), "de X").unwrap();
        }
        std::fs::write(dir.join("data.db.bak.30"), "de X").unwrap();
        std::fs::write(dir.join("data.db.bak.31"), "de X").unwrap();
        std::fs::write(dir.join("data.db.bak.32"), "de X").unwrap();
        purge_restore_leftovers(&dir).unwrap();
        let mut despues: Vec<String> = std::fs::read_dir(carpeta.join(BACKUP_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        despues.sort();
        assert_eq!(despues, esperadas);
        assert!(carpeta.join("data.db.bak.9").exists() && carpeta.join("data.db.bak.10").exists());
        assert!(!copias.join("pre-restore-20.db").exists(), "la purga sigue haciendo su trabajo fuera");

        // Y nada de lo apartado vuelve por «Restaurar desde un archivo».
        let err = import_backup(&dir, &carpeta.join(BACKUP_DIR).join(&diaria), Some("negocio-a")).await.unwrap_err();
        assert!(err.to_string().contains("guardó aparte"), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }


    /// AUD-06 · Una base que no se deja leer no dice de quién es: con una licencia guardada se aparta
    /// entera, como si fuera de otro negocio, con sus imágenes, su cola y las copias de otros o sin
    /// sello. Nunca se da por «sin sello». Lo único que se queda son las copias selladas con la
    /// licencia, que dicen ser de este negocio: son con las que se recupera una base dañada.
    #[tokio::test]
    async fn una_base_ilegible_se_aparta_entera_salvo_las_copias_selladas_con_la_licencia() {
        let dir = test_dir("base_ilegible");
        let db = db_sin_sello(&dir).await;
        let sin_sello = create_backup(&db, &dir).await.unwrap().unwrap().id;
        sellar(&db, "negocio-a").await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let de_a = create_backup(&db, &dir).await.unwrap().unwrap().id;
        // Una copia de otro negocio: el sello se cambia por debajo, que sellar no lo sustituye nunca.
        db.write().await.raw().execute_batch("UPDATE _Negocio SET ID_Negocio = 'negocio-otro';").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let de_otro = create_backup(&db, &dir).await.unwrap().unwrap().id;
        db.cerrar().await.unwrap();
        drop(db);
        for sufijo in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(dir.join(format!("data.db{sufijo}")));
        }
        std::fs::write(dir.join("data.db"), vec![b'x'; 8192]).unwrap();
        assert_eq!(crate::sello::del_fichero(&dir.join("data.db")).unwrap(), Sello::Ilegible);
        std::fs::create_dir_all(dir.join("images").join("productos")).unwrap();
        std::fs::write(dir.join("images").join("productos").join("p.jpg"), "foto").unwrap();
        std::fs::write(dir.join("image_uploads.json"), "[]").unwrap();

        let carpeta = resolver_al_abrir(&dir, Some("negocio-a")).unwrap().expect("se aparta");

        assert_eq!(std::fs::read(carpeta.join("data.db")).unwrap(), vec![b'x'; 8192], "la base, tal cual");
        assert!(carpeta.join("images").join("productos").join("p.jpg").exists());
        assert!(carpeta.join("image_uploads.json").exists());
        assert!(carpeta.join(BACKUP_DIR).join(&sin_sello).exists(), "la copia sin sello no dice de quién es");
        assert!(carpeta.join(BACKUP_DIR).join(&de_otro).exists());
        let quedan: Vec<String> = list_backups(&dir).unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(quedan, vec![de_a.clone()], "la sellada con la licencia se queda para recuperar");
        assert!(!dir.join("data.db").exists());

        // Y con ella se recupera la base dañada.
        let db = crate::connection::init_main_db(&dir, Some("negocio-a")).await.unwrap();
        assert_eq!(status(&db).await.unwrap().state, RecoveryState::DataMissing);
        db.cerrar().await.unwrap();
        drop(db);
        assert!(prepare_restore(&dir, &de_a, Some("negocio-a")).await.is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-06 · Lo apartado nunca pisa nada: con el nombre ocupado se usa otro.
    #[test]
    fn lo_apartado_no_pisa_lo_que_ya_hay() {
        let dir = test_dir("destino_libre");
        std::fs::create_dir_all(&dir).unwrap();
        let nombre = std::ffi::OsStr::new("image_uploads.json");
        assert_eq!(destino_libre(&dir, nombre), dir.join("image_uploads.json"));
        std::fs::write(dir.join("image_uploads.json"), "primero").unwrap();
        assert_eq!(destino_libre(&dir, nombre), dir.join("image_uploads.json.2"));
        std::fs::write(dir.join("image_uploads.json.2"), "segundo").unwrap();
        assert_eq!(destino_libre(&dir, nombre), dir.join("image_uploads.json.3"));

        let origen = test_dir("destino_libre_origen");
        std::fs::create_dir_all(&origen).unwrap();
        std::fs::write(origen.join("image_uploads.json"), "tercero").unwrap();
        mover(&origen.join("image_uploads.json"), &dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("image_uploads.json")).unwrap(), "primero");
        assert_eq!(std::fs::read_to_string(dir.join("image_uploads.json.3")).unwrap(), "tercero");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(origen);
    }

    /// AUD-06 · Un apartado que terminó de mover (la base ya está en su carpeta) pero no llegó a
    /// quitar su marca no se «termina» otra vez: eso se llevaría la base nueva. Sólo se quita la
    /// marca.
    #[tokio::test]
    async fn un_apartado_terminado_con_la_marca_puesta_no_se_lleva_la_base_nueva() {
        let dir = test_dir("apartado_terminado");
        let db = db_sin_sello(&dir).await;
        sellar(&db, "negocio-a").await;
        db.cerrar().await.unwrap();
        drop(db);
        let carpeta = resolver_al_abrir(&dir, Some("negocio-x")).unwrap().expect("apartado");
        let db = crate::connection::init_main_db(&dir, Some("negocio-x")).await.unwrap();
        db.cerrar().await.unwrap();
        drop(db);
        // Lo que no llegó a hacerse.
        std::fs::write(carpeta.join(APARTADO_EN_CURSO), "").unwrap();
        assert!(!hay_apartado_a_medias(&dir).unwrap());

        assert_eq!(resolver_al_abrir(&dir, Some("negocio-x")).unwrap(), None);

        assert!(!carpeta.join(APARTADO_EN_CURSO).exists());
        assert_eq!(crate::sello::del_fichero(&dir.join("data.db")).unwrap(), Sello::De("negocio-x".into()));
        assert_eq!(crate::sello::del_fichero(&carpeta.join("data.db")).unwrap(), Sello::De("negocio-a".into()));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-06 · Con un cambio de negocio pendiente no se borra nada del equipo: ni la retención de las
    /// copias diarias ni la purga de restos (temporales viejos, bases de antes de restaurar, copias de
    /// antes de una migración). Todo eso es del negocio que el arranque aparta. Sin la marca, purgan
    /// como siempre.
    #[tokio::test]
    async fn con_un_cambio_pendiente_la_retencion_no_borra_nada() {
        let dir = test_dir("retencion_suspendida");
        let db = db_operativa(&dir).await;
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        for stamp in 1..=BACKUPS_A_CONSERVAR as i64 {
            std::fs::write(backups.join(format!("{BACKUP_PREFIX}{stamp}{BACKUP_SUFFIX}")), b"antigua").unwrap();
        }
        let mut restos: Vec<PathBuf> = Vec::new();
        for sello in [10, 20, 30] {
            restos.push(backups.join(format!("pre-restore-{sello}.db")));
        }
        restos.push(dir.join("data.restore.1.tmp"));
        for sello in [1, 2, 3] {
            restos.push(dir.join(format!("{MIGRACION_PREFIX}{sello}")));
        }
        let huerfano = backups.join(".backup-1-a.tmp");
        restos.push(huerfano.clone());
        for resto in &restos {
            std::fs::write(resto, b"x").unwrap();
        }
        std::fs::File::options()
            .write(true)
            .open(&huerfano)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600))
            .unwrap();

        marcar_cambio_de_negocio(&dir, "negocio-x").unwrap();
        create_backup(&db, &dir).await.unwrap().expect("la copia se hace");
        purge_restore_leftovers(&dir).unwrap();
        assert_eq!(list_backups(&dir).unwrap().len(), BACKUPS_A_CONSERVAR + 1, "la retención no borra");
        for resto in &restos {
            assert!(resto.exists(), "{} no se borra con el cambio pendiente", resto.display());
        }

        quitar_cambio_de_negocio(&dir).unwrap();
        create_backup(&db, &dir).await.unwrap().expect("la copia se hace");
        purge_restore_leftovers(&dir).unwrap();
        assert_eq!(list_backups(&dir).unwrap().len(), BACKUPS_A_CONSERVAR);
        assert!(!backups.join("pre-restore-10.db").exists() && !huerfano.exists());
        assert!(!dir.join("data.restore.1.tmp").exists() && !dir.join(format!("{MIGRACION_PREFIX}1")).exists());

        db.cerrar().await.unwrap();
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-06 · Un error al abrir o recorrer una carpeta no cuenta como carpeta vacía: se devuelve, y
    /// el apartado se para ahí con las marcas puestas. Sólo una carpeta que no existe está vacía.
    #[test]
    fn un_error_al_recorrer_no_cuenta_como_carpeta_vacia() {
        let dir = test_dir("enumerar");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!hay_apartado_a_medias(&dir).unwrap(), "sin backups/ no hay nada");
        assert!(carpetas_apartadas(&dir).unwrap().is_empty());

        std::fs::write(dir.join("image_uploads.json"), "[]").unwrap();
        std::fs::write(dir.join(BACKUP_DIR), "no es una carpeta").unwrap();
        marcar_cambio_de_negocio(&dir, "negocio-x").unwrap();

        assert!(hay_apartado_a_medias(&dir).is_err());
        assert!(carpetas_apartadas(&dir).is_err());
        assert!(apartar_para_el_cambio_de_negocio(&dir, "negocio-x").is_err());
        assert!(hay_cambio_de_negocio_pendiente(&dir), "la marca sigue");
        assert!(dir.join("image_uploads.json").exists(), "no se ha movido nada");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// AUD-06 · Con un cambio pendiente se aparta todo lo del equipo aunque no haya `data.db` (una
    /// restauración cortada entre sus dos `rename`), con su WAL suelto incluido; si ya no queda nada,
    /// no se crea ninguna carpeta; y una base ya sellada con el negocio nuevo se queda.
    #[tokio::test]
    async fn con_un_cambio_pendiente_se_aparta_todo_aunque_no_haya_base() {
        let dir = test_dir("apartar_sin_base");
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::write(backups.join("pre-restore-1.db"), b"x").unwrap();
        std::fs::write(backups.join(format!("{BACKUP_PREFIX}2{BACKUP_SUFFIX}")), b"x").unwrap();
        std::fs::write(dir.join("data.restore.3.tmp"), b"x").unwrap();
        std::fs::write(dir.join("data.db-wal"), b"x").unwrap();
        std::fs::write(dir.join("image_uploads.json"), b"[]").unwrap();

        let carpeta = apartar_para_el_cambio_de_negocio(&dir, "negocio-x").unwrap().expect("apartado");
        for resto in ["data.restore.3.tmp", "data.db-wal", "image_uploads.json"] {
            assert!(carpeta.join(resto).exists() && !dir.join(resto).exists(), "{resto}");
        }
        assert_eq!(std::fs::read_dir(carpeta.join(BACKUP_DIR)).unwrap().count(), 2);
        assert!(!carpeta.join(APARTADO_EN_CURSO).exists());

        assert_eq!(apartar_para_el_cambio_de_negocio(&dir, "negocio-x").unwrap(), None, "no queda nada");
        assert_eq!(carpetas_apartadas(&dir).unwrap(), vec![carpeta]);

        let db = crate::connection::init_main_db(&dir, Some("negocio-x")).await.unwrap();
        db.cerrar().await.unwrap();
        drop(db);
        std::fs::write(dir.join("image_uploads.json"), b"[]").unwrap();
        assert_eq!(apartar_para_el_cambio_de_negocio(&dir, "negocio-x").unwrap(), None, "la base ya es de X");
        assert!(dir.join("data.db").exists() && dir.join("image_uploads.json").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo que hace una purga justo después de ver que no hay marca, antes de borrar (sólo en tests).
    type Gancho = Box<dyn FnOnce() + Send>;
    static TRAS_MIRAR_LA_MARCA: std::sync::Mutex<Option<Gancho>> = std::sync::Mutex::new(None);

    pub(super) fn tras_mirar_la_marca() {
        let gancho = TRAS_MIRAR_LA_MARCA.lock().unwrap().take();
        if let Some(gancho) = gancho {
            gancho();
        }
    }

    /// AUD-06 · La purga se detiene justo después de ver que no hay marca, y entonces se intenta
    /// publicar el cambio de negocio: la publicación espera a que termine ese borrado (empezó antes del
    /// cambio), y cuando la marca está, ninguna purga borra nada. Ninguna copia se borra con el cambio
    /// ya publicado.
    #[test]
    fn publicar_el_cambio_espera_al_borrado_en_curso_y_despues_no_se_borra_nada() {
        use std::sync::mpsc;
        let dir = test_dir("marca_y_purga");
        let backups = dir.join(BACKUP_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        // Dos que conservar y una que sobra.
        for sello in [10, 20, 30] {
            std::fs::write(backups.join(format!("pre-restore-{sello}.db")), b"de A").unwrap();
        }
        let en_curso = backups.join("pre-restore-10.db");

        let (visto, ha_visto) = mpsc::channel::<()>();
        let (sigue, puede_seguir) = mpsc::channel::<()>();
        *TRAS_MIRAR_LA_MARCA.lock().unwrap() = Some(Box::new(move || {
            visto.send(()).unwrap();
            puede_seguir.recv().unwrap();
        }));

        let purga = {
            let dir = dir.clone();
            std::thread::spawn(move || purge_restore_leftovers(&dir).unwrap())
        };
        ha_visto.recv().unwrap();
        // La purga ha visto que no hay marca y aún no ha borrado. Se publica el cambio.
        let publicar = {
            let dir = dir.clone();
            std::thread::spawn(move || marcar_cambio_de_negocio(&dir, "negocio-x").unwrap())
        };
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!hay_cambio_de_negocio_pendiente(&dir), "la publicación espera al borrado en curso");
        assert!(en_curso.exists());

        sigue.send(()).unwrap();
        publicar.join().unwrap();
        // Publicada la marca, el borrado que estaba en curso ya había terminado.
        assert!(hay_cambio_de_negocio_pendiente(&dir));
        assert!(!en_curso.exists(), "se borró antes de que la marca estuviera");
        purga.join().unwrap();

        // Con la marca puesta, otra purga no borra nada aunque sobre.
        std::fs::write(backups.join("pre-restore-5.db"), b"de A").unwrap();
        purge_restore_leftovers(&dir).unwrap();
        for queda in ["pre-restore-5.db", "pre-restore-20.db", "pre-restore-30.db"] {
            assert!(backups.join(queda).exists(), "{queda}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_mismo_disco {
    //! REC-INC-01 · «Guardar fuera…» dice si la copia ha quedado dentro de este equipo o fuera.

    use super::*;

    #[test]
    fn lo_que_no_se_puede_saber_es_el_mismo_disco() {
        let dir = std::env::temp_dir();
        let no_existe = dir.join("tpv-rec-inc-01-no-existe").join("x.db.gz");
        assert!(mismo_volumen(&dir, &no_existe), "sin poder mirarlo, el aviso prudente");
        assert!(mismo_volumen(&dir, &dir));
    }

    #[cfg(windows)]
    #[test]
    fn en_windows_cuenta_la_unidad_o_el_recurso_de_red() {
        let raiz = |r: &str| raiz_del_volumen(Path::new(r));
        assert_eq!(raiz(r"C:\Users\bar\AppData"), Some("C:".into()));
        assert_eq!(raiz(r"\\?\c:\Users\bar"), raiz(r"C:\otra\carpeta"), "con y sin el prefijo de canonicalize");
        assert_ne!(raiz(r"C:\datos"), raiz(r"E:\copias"), "el USB es otra unidad");
        assert_eq!(raiz(r"\\NAS\Copias\bar"), Some(r"\\nas\copias".into()));
        assert_eq!(raiz(r"\\NAS\Copias\bar"), raiz(r"\\?\UNC\nas\copias\otra"));
        assert_ne!(raiz(r"\\nas\copias"), raiz(r"C:\copias"));
        assert_eq!(raiz(r"carpeta\relativa"), None);
    }

    /// Otra partición u otro disco interno (`D:`) no es el mismo volumen, pero la copia sigue dentro
    /// del ordenador: sólo una unidad extraíble o de red la saca de él.
    #[test]
    fn otra_unidad_fija_sigue_en_este_equipo() {
        use DondeQuedaLaCopia::{EnEsteEquipo, EnLaRed};
        use TipoDeUnidad::{Desconocida, Fija, Red};
        assert_eq!(donde_queda(false, Fija), EnEsteEquipo, "otra partición u otro disco interno");
        assert_eq!(donde_queda(false, Desconocida), EnEsteEquipo, "sin saberlo, el aviso prudente");
        assert_eq!(donde_queda(false, TipoDeUnidad::Extraible), DondeQuedaLaCopia::Extraible);
        assert_eq!(donde_queda(false, Red), EnLaRed);
        for tipo in [Fija, TipoDeUnidad::Extraible, Red, Desconocida] {
            assert_eq!(donde_queda(true, tipo), EnEsteEquipo, "en el volumen de los datos, sea cual sea: {tipo:?}");
        }
    }

    /// Lo que devuelven `GetDriveTypeW` y el bus del disco, simulados.
    #[test]
    fn el_tipo_de_unidad_de_windows() {
        let c = clasificar_unidad_windows;
        assert_eq!(c(3, None), TipoDeUnidad::Fija, "un disco fijo del que no se sabe el bus");
        assert_eq!(c(3, Some(11)), TipoDeUnidad::Fija, "SATA");
        assert_eq!(c(3, Some(17)), TipoDeUnidad::Fija, "NVMe");
        assert_eq!(c(3, Some(12)), TipoDeUnidad::Fija, "un eMMC de dentro del terminal");
        assert_eq!(c(3, Some(7)), TipoDeUnidad::Extraible, "un disco externo por USB se presenta como fijo");
        assert_eq!(c(3, Some(4)), TipoDeUnidad::Extraible, "FireWire");
        assert_eq!(c(2, None), TipoDeUnidad::Extraible, "un pendrive");
        assert_eq!(c(5, None), TipoDeUnidad::Extraible, "un CD o DVD");
        assert_eq!(c(4, None), TipoDeUnidad::Red, "una unidad de red o \\\\servidor\\carpeta");
        assert_eq!(c(6, None), TipoDeUnidad::Fija, "un disco en memoria");
        assert_eq!(c(0, None), TipoDeUnidad::Desconocida);
        assert_eq!(c(1, None), TipoDeUnidad::Desconocida, "una raíz que no existe");
    }

    /// Las llamadas a Windows de verdad: la carpeta temporal está en un disco interno, y una ruta
    /// que no existe no se sabe dónde está.
    #[cfg(windows)]
    #[test]
    fn en_windows_la_carpeta_temporal_esta_en_un_disco_fijo() {
        let temporal = std::env::temp_dir();
        assert_eq!(tipo_de_unidad(&temporal), TipoDeUnidad::Fija, "{}", temporal.display());
        let no_existe = temporal.join("tpv-rec-inc-01-no-existe").join("x.db.gz");
        assert_eq!(tipo_de_unidad(&no_existe), TipoDeUnidad::Desconocida);
    }
}
