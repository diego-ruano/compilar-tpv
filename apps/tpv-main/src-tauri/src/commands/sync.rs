//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local); en otro caso `sync_repo` falla.

use tauri::State;

use tpv_application::use_cases::sync as uc;
use tpv_contracts::sync::{ApplySyncChangesArgs, OutboxEntry, SyncHealth};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/// Aplica un lote de cambios (idempotente por op_id) y devuelve el nuevo checkpoint (`seq`).
#[tauri::command]
pub async fn sync_apply_changes(
    state: State<'_, AppState>,
    args: ApplySyncChangesArgs,
) -> Result<i64, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::apply_changes(repo.as_ref(), args).await?)
}

/// Último `seq` aplicado localmente (cursor para pedir el catch-up al reconectar).
#[tauri::command]
pub async fn sync_get_checkpoint(state: State<'_, AppState>) -> Result<i64, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::get_checkpoint(repo.as_ref()).await?)
}

/// Operaciones pendientes de subir a la nube (outbox local), en orden de `seq`.
#[tauri::command]
pub async fn sync_outbox_pending(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<OutboxEntry>, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::outbox_pending(repo.as_ref(), limit).await?)
}

/// Marca una operación del outbox como enviada (tras el `apply_ack` de la nube). `seq` es el cursor
/// que la nube asignó a la operación (0 si no pudo devolverlo); se usa para ascender el anti-eco.
#[tauri::command]
pub async fn sync_outbox_mark_sent(
    state: State<'_, AppState>,
    op_id: String,
    seq: i64,
) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    uc::outbox_mark_sent(repo.as_ref(), &op_id, seq).await?;
    Ok(())
}

/// SYNC-18: la nube aceptó estas operaciones en su cola (`bulk_ack`, o un `apply_ack` que llegó
/// marcado como encolado). Dejan de ofrecerse para reenviar, pero su copia local se conserva hasta
/// que el catch-up las devuelva: ver el puerto `outbox_mark_encolada`.
#[tauri::command]
pub async fn sync_outbox_mark_encolada(
    state: State<'_, AppState>,
    op_ids: Vec<String>,
) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    uc::outbox_mark_encolada(repo.as_ref(), &op_ids).await?;
    Ok(())
}

/// SYNC-18: devuelve al outbox lo que lleva demasiado tiempo encolado sin que la nube lo confirme.
/// Se llama al conectar: reenviar es inocuo (la nube es idempotente por `Op_Id`) y es lo que
/// impide que una operación se quede en el limbo si su ack se perdió o la nube la descartó.
#[tauri::command]
pub async fn sync_liberar_encoladas(
    state: State<'_, AppState>,
    antiguedad_ms: i64,
) -> Result<i64, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::liberar_encoladas_caducadas(repo.as_ref(), antiguedad_ms).await?)
}

/// Purga de mantenimiento de `_Sync_Applied_Ops` (solo registros antiguos ya subidos a la nube).
/// El frontend la invoca cuando el outbox queda vacío tras drenar.
#[tauri::command]
pub async fn sync_purge_applied_ops(state: State<'_, AppState>) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    uc::purge_applied_ops(repo.as_ref()).await?;
    Ok(())
}

/// Foto de salud de la sincronización (SYNC-14) para el panel de Configuración → Conectividad.
#[tauri::command]
pub async fn sync_health(state: State<'_, AppState>) -> Result<SyncHealth, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::health(repo.as_ref()).await?)
}
