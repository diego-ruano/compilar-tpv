//! Conexión y arranque (schema + seed) de la base de datos **SQLite local**.
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

use crate::ejecutor::{Connection, ErrorSql, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_domain::licensing::{que_hacer_con_la_base, QueHacerConLaBase, Sello};
use tpv_domain::login::hash_pin;

use crate::db::{Db, Writer};

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
    tokio::task::spawn_blocking(move || backup_antes_de_migrar(&path)).await.map_err(db_err)?
}

fn backup_antes_de_migrar(db_path: &Path) -> AppResult<()> {
    // Instalación nueva: no hay nada que respaldar (la creará `Db::open`).
    if !db_path.exists() {
        return Ok(());
    }

    let conn = crate::ejecutor::abrir(db_path).map_err(db_err)?;
    // Esta conexión auxiliar también puede coincidir con la limpieza del WAL al cerrar.
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| db_err(ErrorSql::from(e)))?;

    let pending = crate::migrations::has_pending(&conn).map_err(db_err)?;

    // Ya está al día (o BD nueva sin datos): no se migrará nada → no hace falta copia.
    if !pending {
        return Ok(());
    }

    // Volcar el WAL al fichero principal para que la copia esté completa, y cerrar la conexión
    // efímera antes de copiar (Windows bloquea el fichero mientras está abierto).
    let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE);", [], |_| Ok(()));
    drop(conn);

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
/// `licencia` es el negocio de la licencia guardada en el equipo, si la hay (lo conoce el shell).
/// Con ella el equipo está aprovisionado (ver [`seed_admin_if_empty`]) y, AUD-06, se aplica la
/// regla de que una base sólo se usa con la licencia de su negocio
/// (`tpv_domain::licensing::que_hacer_con_la_base`), ANTES de abrir nada:
///
/// - lo que se quedó a medias de un apartado anterior se termina primero, y una base con el sello de
///   otro negocio, o que no se deja leer, se aparta entera con todo lo de ese negocio
///   (`recovery::resolver_al_abrir`); después se abre una vacía. Si algo no se puede mover, falla: el
///   arranque sigue sin base (sin login, sin réplica, sin subidas) y se repite la próxima vez;
/// - una base sin sello se sella con el negocio de la licencia, en la misma transacción que sus
///   datos iniciales.
///
/// Es la misma regla en el arranque, al elegir el modo y al cambiar de base, porque todos abren
/// por aquí. Un corte en cualquier punto de una activación lo resuelve la siguiente apertura.
pub async fn init_main_db(app_data_dir: &Path, licencia: Option<&str>) -> AppResult<Arc<Db>> {
    let db_path = app_data_dir.join("data.db");
    let db_path_str = db_path
        .to_str()
        .ok_or_else(|| AppError::internal("Ruta de BD inválida"))?;

    if let Some(apartado) = crate::recovery::resolver_al_abrir(app_data_dir, licencia)? {
        // AUD-28: el nombre de la carpeta, no la ruta, que lleva el usuario de Windows.
        tracing::warn!(
            target: "tpv::startup",
            carpeta = %crate::recovery::nombre_de(&apartado),
            "la base local era de otro negocio: se ha apartado entera y se abre una nueva"
        );
    }
    let aprovisionado = licencia.is_some();

    // Antes de abrir (lo que dispara las migraciones), respaldar si hay migraciones pendientes.
    backup_if_migration_pending(&db_path).await?;

    let db = Db::open(db_path_str)
        .await
        .map_err(|e| AppError::repository(format!("Error abriendo la BD: {e}")))?;

    // El seed corre sobre la conexión de escritura (exclusiva) tras abrir.
    //
    // AUD-06: y el sello, en la MISMA transacción: una base recién creada con licencia nace con sus
    // datos iniciales y su sello juntos, o sin ninguno de los dos. Las migraciones van antes, cada
    // una en su transacción dentro de `Db::open`: un corte entre ellas y ésta deja una base sin
    // sello y sin datos de negocio, que la siguiente apertura sella igual. Una base sin sello CON
    // datos (anterior a los sellos) también se sella con la licencia, como la activación.
    {
        let w = db.write().await;
        let conn = w.raw();
        conn.transaccion(async {
            seed_admin_if_empty(conn, aprovisionado).await?;
            seed_contact_settings(conn).await?;
            if let Some(negocio) = licencia {
                let sello = Sello::leido(crate::sello::leer(&**conn).await?.as_deref());
                match que_hacer_con_la_base(&sello, negocio, false) {
                    QueHacerConLaBase::Sellar => crate::sello::escribir(conn, negocio).await?,
                    // Lo de otro negocio se ha apartado antes de abrir: si aun así lo es, no se usa.
                    QueHacerConLaBase::Apartar => {
                        return Err(AppError::conflict(
                            "La base de este ordenador es de otro negocio y no se ha podido apartar. Cierra el TPV y vuelve a abrirlo.",
                        ))
                    }
                    QueHacerConLaBase::Usar | QueHacerConLaBase::Reconstruir => {}
                }
            }
            Ok(())
        })
        .await?;
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

/// Abre una base donde traer la nube cuando no hay ninguna abierta: la del equipo no se pudo abrir
/// al arrancar.
///
/// Primero la regla de `init_main_db`: si no se puede apartar lo de otro negocio, falla y no se
/// abre nada. Si lo que queda no se deja abrir, se aparta como ilegible (no se borra) y se abre una
/// vacía en su sitio.
pub async fn abrir_para_recuperar(app_data_dir: &Path, licencia: Option<&str>) -> AppResult<Arc<Db>> {
    crate::recovery::resolver_al_abrir(app_data_dir, licencia)?;
    match init_main_db(app_data_dir, licencia).await {
        Ok(db) => Ok(db),
        Err(e) => {
            if let Some(apartada) = crate::recovery::archivar_base_ilegible(app_data_dir)? {
                // AUD-28: el nombre de la copia apartada, no la ruta.
                tracing::warn!(
                    target: "tpv::recovery",
                    fichero = %crate::recovery::nombre_de(&apartada),
                    error = %e,
                    "base local ilegible apartada para reconstruirla desde la nube"
                );
            }
            init_main_db(app_data_dir, licencia).await
        }
    }
}
