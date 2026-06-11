//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use tpv_contracts::sync::{ApplySyncChangesArgs, OutboxEntry};

use crate::error::AppResult;
use crate::ports::sync::SyncRepository;

/// Aplica un lote de cambios recibidos de la nube. Si viene vacío, solo devuelve el checkpoint.
pub async fn apply_changes(
    repo: &dyn SyncRepository,
    args: ApplySyncChangesArgs,
) -> AppResult<i64> {
    if args.changes.is_empty() {
        return repo.get_checkpoint().await;
    }
    repo.apply_changes(args.changes).await
}

/// Último `seq` aplicado localmente (cursor del catch-up).
pub async fn get_checkpoint(repo: &dyn SyncRepository) -> AppResult<i64> {
    repo.get_checkpoint().await
}

/// Operaciones pendientes de subir a la nube (outbox), en orden.
pub async fn outbox_pending(repo: &dyn SyncRepository, limit: i64) -> AppResult<Vec<OutboxEntry>> {
    let limit = if limit <= 0 { 50 } else { limit.min(500) };
    repo.outbox_pending(limit).await
}

/// Marca una operación del outbox como enviada tras el `apply_ack` de la nube.
pub async fn outbox_mark_sent(repo: &dyn SyncRepository, op_id: &str) -> AppResult<()> {
    repo.outbox_mark_sent(op_id).await
}
