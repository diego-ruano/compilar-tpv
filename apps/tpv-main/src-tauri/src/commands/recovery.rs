//! Comandos finos para la recuperación física de la base local.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::AppState;
use tpv_application::error::AppError;
use tpv_application::use_cases::sync as uc_sync;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::recovery::{LocalBackupInfo, RecoveryState, RecoveryStatus};

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, AppErrorDto> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppErrorDto::internal(format!("Error obteniendo AppData: {e}")))
}

#[tauri::command]
pub async fn recovery_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecoveryStatus, AppErrorDto> {
    let abierta = { state.db.lock().await.as_ref().cloned() };
    let Some(db) = abierta else {
        // Un traslado manda también sin base: la pantalla tiene que ofrecer sólo la nube.
        if tpv_infra_sqlite::recovery::hay_traslado_pendiente(&app_data_dir(&app)?) {
            return Ok(RecoveryStatus {
                state: RecoveryState::TransferPending,
            });
        }
        // No tener `Db` son dos cosas muy distintas y no pueden contestar lo mismo. En Handy no
        // existe SQLite local y, por definición, tampoco una recuperación de Main. En una Main sí
        // la hay: significa que la base no se pudo abrir al arrancar (corrupta o ilegible), que es
        // exactamente "faltan los datos" y debe llevar a la pantalla de recuperación.
        let es_main = matches!(*state.mode.lock().await, Some(crate::DeviceMode::Tpv));
        return Ok(RecoveryStatus {
            state: if es_main {
                RecoveryState::DataMissing
            } else {
                RecoveryState::Ready
            },
        });
    };
    Ok(tpv_infra_sqlite::recovery::status(&db).await?)
}

#[tauri::command]
pub async fn recovery_list_backups(app: AppHandle) -> Result<Vec<LocalBackupInfo>, AppErrorDto> {
    Ok(tpv_infra_sqlite::recovery::list_backups(&app_data_dir(
        &app,
    )?)?)
}

/// Copia manual desde Configuración. El job diario cubre el día a día, pero antes de una
/// actualización o de tocar el catálogo entero se quiere una copia de AHORA, no la de esta
/// madrugada.
#[tauri::command]
pub async fn recovery_create_backup(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalBackupInfo, AppErrorDto> {
    let dir = app_data_dir(&app)?;
    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| AppErrorDto::internal("DB no inicializada"))?;

    tpv_infra_sqlite::recovery::create_backup(&db, &dir)
        .await?
        .ok_or_else(|| {
            AppError::conflict(
                "Esta base aún no está operativa: queda terminar la recuperación. Una copia ahora guardaría un estado a medias.",
            )
            .into()
        })
}

/// Guarda una copia fuera del equipo. Las copias diarias viven en el mismo disco que protegen:
/// cubren un borrado o una corrupción, no un disco muerto. Y la PII del personal (DNI, IBAN, nº de
/// la Seguridad Social) sólo existe aquí, porque va cifrada con una clave que no sube a la nube.
#[tauri::command]
pub async fn recovery_export_backup(
    app: AppHandle,
    backup_id: String,
    destino: String,
) -> Result<(), AppErrorDto> {
    let dir = app_data_dir(&app)?;
    tpv_infra_sqlite::recovery::export_backup(&dir, &backup_id, Path::new(&destino)).await?;
    Ok(())
}

/// Trae una copia de fuera al almacén local. No restaura: deja la copia disponible para que la
/// restauración siga siendo el mismo camino guardado que las demás.
#[tauri::command]
pub async fn recovery_import_backup(
    app: AppHandle,
    origen: String,
) -> Result<LocalBackupInfo, AppErrorDto> {
    let dir = app_data_dir(&app)?;
    Ok(tpv_infra_sqlite::recovery::import_backup(&dir, Path::new(&origen)).await?)
}

/// Deja el equipo en condiciones de reconstruirse desde la nube cuando la base local no se pudo
/// ni abrir (corrupta, ilegible) y el arranque siguió sin ella.
///
/// El volcado de la nube necesita una base donde escribir y en ese estado no hay ninguna: aparta
/// el fichero ilegible (no lo borra) y abre uno vacío en su sitio. **Sólo actúa si NO hay `Db`**;
/// con una base abierta esto sería un borrado disfrazado, y quién puede reemplazar datos
/// utilizables lo decide `bootstrap_restaurar` dentro de su transacción, con su guardia de outbox.
pub(crate) async fn asegurar_base_para_recuperar(
    app: &AppHandle,
    state: &AppState,
) -> Result<(), AppErrorDto> {
    // El modo se lee y se suelta ANTES de tomar `db`: mantener los dos a la vez, y en distinto
    // orden según el comando, es como se fabrica un interbloqueo que sólo aparece en producción.
    let es_main = {
        let modo = state.mode.lock().await;
        matches!(*modo, Some(crate::DeviceMode::Tpv))
    };
    if !es_main {
        return Ok(());
    }

    let mut guard = state.db.lock().await;
    if guard.is_some() {
        return Ok(());
    }

    let dir = app_data_dir(app)?;
    if let Some(apartada) = tpv_infra_sqlite::recovery::archivar_base_ilegible(&dir)? {
        tracing::warn!(
            target: "tpv::recovery",
            ruta = ?apartada,
            "base local ilegible apartada para reconstruirla desde la nube"
        );
    }

    let db = tpv_infra_sqlite::connection::init_main_db(&dir, crate::dispositivo_aprovisionado(&dir))
        .await?;
    crate::configure_outbox_notifier(app, &db);
    *guard = Some(db);
    Ok(())
}

/// Sustituye la BD completa por una copia local ya validada. El mutex de `AppState` permanece
/// tomado desde que se comprueba que se puede reemplazar hasta que la base nueva está abierta:
/// ningún comando ni job puede adquirir una conexión nueva en ese intervalo (REV-18).
#[tauri::command]
pub async fn recovery_restore_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup_id: String,
) -> Result<LocalBackupInfo, AppErrorDto> {
    let dir = app_data_dir(&app)?;
    let selected = tpv_infra_sqlite::recovery::list_backups(&dir)?
        .into_iter()
        .find(|b| b.id == backup_id)
        .ok_or_else(|| AppError::not_found("La copia local seleccionada ya no existe"))?;

    // REV-18: el cerrojo se toma UNA vez, y la comprobación va dentro.
    //
    // Reemplazar el fichero se lleva por delante el outbox actual, así que antes se comprueba que
    // no haya nada sin subir (`asegurar_reemplazo_seguro`, la misma guardia que el volcado desde la
    // nube). Pero se comprobaba soltando el cerrojo justo después, y entre el permiso y el
    // reemplazo cabía una escritura: exactamente la ventana que `bootstrap_restaurar` evita
    // haciendo la comprobación DENTRO de su transacción, y que CLAUDE.md dice no dejar abierta.
    //
    // El precio es que la copia del fichero se prepara con el cerrojo tomado, o sea que ningún
    // comando puede coger una conexión mientras dura. Es aceptable justo aquí: a esta pantalla sólo
    // se llega con el equipo sin poder operar —reconciliación pendiente, cero usuarios o base
    // ilegible—, y el intercambio de más abajo ya lo retiene hasta diez segundos.
    let mut guard = state.db.lock().await;

    if let Some(actual) = guard.as_ref() {
        tpv_infra_sqlite::recovery::asegurar_reemplazo_seguro(actual).await?;
    }

    let prepared = tpv_infra_sqlite::recovery::prepare_restore(&dir, &backup_id).await?;

    // Puede no haber `Db`: si la base local estaba corrupta, el arranque no pudo abrirla y siguió
    // sin ella para poder llegar hasta aquí. Es justo el caso que esta pantalla existe para
    // resolver, y entonces no hay nada que cerrar ni ninguna operación en vuelo que esperar.
    if let Some(db) = guard.take() {
        // Fuerza el contenido comprometido del WAL al fichero antes de soltar la base anterior. No
        // es la que vamos a restaurar, pero es nuestra red de rollback si el intercambio falla.
        {
            let w = db.write().await;
            let _ = w.raw().query("PRAGMA wal_checkpoint(TRUNCATE);", ()).await;
        }

        // Los repositorios se crean por comando y normalmente desaparecen enseguida. Esperamos los
        // que estuvieran terminando (p. ej. un job) en vez de reemplazar un fichero aún abierto en
        // Windows. El mutex impide que aparezcan clones nuevos durante esta espera.
        for _ in 0..200 {
            if Arc::strong_count(&db) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if Arc::strong_count(&db) != 1 {
            *guard = Some(db);
            tpv_infra_sqlite::recovery::discard_prepared(&prepared);
            return Err(AppError::conflict(
                "La base de datos sigue ocupada por otra operación; vuelve a intentarlo en unos segundos",
            )
            .into());
        }
        drop(db);
    }

    let installed = match tpv_infra_sqlite::recovery::install_prepared(&dir, &prepared) {
        Ok(i) => i,
        Err(e) => {
            // El intercambio no llegó a completarse: reabrimos el fichero original.
            tpv_infra_sqlite::recovery::discard_prepared(&prepared);
            let reopened = tpv_infra_sqlite::connection::init_main_db(
                &dir,
                crate::dispositivo_aprovisionado(&dir),
            )
            .await
            .map_err(AppErrorDto::from)?;
            crate::configure_outbox_notifier(&app, &reopened);
            *guard = Some(reopened);
            return Err(e.into());
        }
    };

    match tpv_infra_sqlite::connection::init_main_db(&dir, crate::dispositivo_aprovisionado(&dir))
        .await
    {
        Ok(restored) => {
            crate::configure_outbox_notifier(&app, &restored);
            *guard = Some(restored);
            // Best-effort: la BD anterior y los temporales no entran en la retención de las copias
            // diarias, así que cada intento dejaría otra base entera en AppData.
            if let Err(e) = tpv_infra_sqlite::recovery::purge_restore_leftovers(&dir) {
                tracing::warn!(target: "tpv::recovery", error = %e, "no se pudieron purgar los restos de restauraciones anteriores");
            }
            Ok(selected)
        }
        Err(restore_error) => {
            let rollback = tpv_infra_sqlite::recovery::rollback_install(&dir, installed);
            let reopened = if rollback.is_ok() {
                tpv_infra_sqlite::connection::init_main_db(
                    &dir,
                    crate::dispositivo_aprovisionado(&dir),
                )
                .await
                .ok()
            } else {
                None
            };
            if let Some(original) = reopened {
                crate::configure_outbox_notifier(&app, &original);
                *guard = Some(original);
            }
            Err(AppErrorDto::internal(format!(
                "No se pudo abrir la copia restaurada; se intentó recuperar la base anterior: {restore_error}"
            )))
        }
    }
}

/// Última barrera de seguridad del desbloqueo. Aunque el frontend se equivoque, no se limpia la
/// marca persistente mientras quede outbox, falle una operación o el checkpoint no haya alcanzado
/// el high-water que acaba de observar en la nube.
#[tauri::command]
pub async fn recovery_complete(
    state: State<'_, AppState>,
    cloud_high_water: i64,
) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    let health = uc_sync::health(repo.as_ref()).await?;
    if health.outbox_pending != 0
        || health.last_seq < cloud_high_water
        || health.failing != 0
        || health.quarantined != 0
    {
        return Err(AppError::conflict(format!(
            "La reconciliación aún no ha terminado (outbox={}, checkpoint={}, nube={}, fallos={}, cuarentena={})",
            health.outbox_pending,
            health.last_seq,
            cloud_high_water,
            health.failing,
            health.quarantined,
        ))
        .into());
    }

    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| AppErrorDto::internal("DB no inicializada"))?;
    tpv_infra_sqlite::recovery::complete_reconciliation(&db).await?;
    Ok(())
}
