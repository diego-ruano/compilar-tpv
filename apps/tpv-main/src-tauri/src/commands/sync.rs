//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local); en otro caso `sync_repo` falla.

use tauri::State;

use tpv_application::use_cases::sync as uc;
use tpv_contracts::sync::{ApplySyncChangesArgs, OutboxEntry};

use crate::AppState;

/// Aplica un lote de cambios (idempotente por op_id) y devuelve el nuevo checkpoint (`seq`).
#[tauri::command]
pub async fn sync_apply_changes(
    state: State<'_, AppState>,
    args: ApplySyncChangesArgs,
) -> Result<i64, String> {
    let repo = state.sync_repo().await?;
    Ok(uc::apply_changes(repo.as_ref(), args).await?)
}

/// Último `seq` aplicado localmente (cursor para pedir el catch-up al reconectar).
#[tauri::command]
pub async fn sync_get_checkpoint(state: State<'_, AppState>) -> Result<i64, String> {
    let repo = state.sync_repo().await?;
    Ok(uc::get_checkpoint(repo.as_ref()).await?)
}

/// Operaciones pendientes de subir a la nube (outbox local), en orden de `seq`.
#[tauri::command]
pub async fn sync_outbox_pending(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<OutboxEntry>, String> {
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
) -> Result<(), String> {
    let repo = state.sync_repo().await?;
    uc::outbox_mark_sent(repo.as_ref(), &op_id, seq).await?;
    Ok(())
}

/// Purga de mantenimiento de `_Sync_Applied_Ops` (solo registros antiguos ya subidos a la nube).
/// El frontend la invoca cuando el outbox queda vacío tras drenar.
#[tauri::command]
pub async fn sync_purge_applied_ops(state: State<'_, AppState>) -> Result<(), String> {
    let repo = state.sync_repo().await?;
    uc::purge_applied_ops(repo.as_ref()).await?;
    Ok(())
}
