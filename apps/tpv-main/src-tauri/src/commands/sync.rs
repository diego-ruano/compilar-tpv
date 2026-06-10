//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local); en otro caso `sync_repo` falla.

use tauri::State;

use tpv_application::use_cases::sync as uc;
use tpv_contracts::sync::ApplySyncChangesArgs;

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
