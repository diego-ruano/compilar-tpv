//! Comandos finos para la recuperación física de la base local.

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
pub async fn recovery_status(state: State<'_, AppState>) -> Result<RecoveryStatus, AppErrorDto> {
    let Some(db) = state.db.lock().await.as_ref().cloned() else {
        // En Handy no existe SQLite local y, por definición, tampoco una recuperación de Main.
        return Ok(RecoveryStatus {
            state: RecoveryState::Ready,
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

/// Sustituye la BD completa por una copia local ya validada. Mientras se cierra el `Db`, el mutex
/// de `AppState` permanece tomado: ningún comando ni job puede adquirir una conexión nueva.
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

    // Antes de preparar nada: reemplazar el fichero se lleva por delante el outbox actual. Es la
    // misma guardia que el volcado desde la nube (ver `asegurar_reemplazo_seguro`).
    if let Some(actual) = state.db.lock().await.as_ref().cloned() {
        tpv_infra_sqlite::recovery::asegurar_reemplazo_seguro(&actual).await?;
    }

    let prepared = tpv_infra_sqlite::recovery::prepare_restore(&dir, &backup_id).await?;

    let mut guard = state.db.lock().await;
    let Some(db) = guard.take() else {
        tpv_infra_sqlite::recovery::discard_prepared(&prepared);
        return Err(AppErrorDto::internal("DB no inicializada"));
    };

    // Fuerza el contenido comprometido del WAL al fichero antes de soltar la base anterior. No es
    // la que vamos a restaurar, pero es nuestra red de rollback si el intercambio falla.
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
