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

/// Marca una operación del outbox como enviada tras el `apply_ack` de la nube. `seq` es el cursor
/// que la nube le asignó (0 si no lo pudo devolver); se usa para ascender el anti-eco a su Seq real.
pub async fn outbox_mark_sent(repo: &dyn SyncRepository, op_id: &str, seq: i64) -> AppResult<()> {
    repo.outbox_mark_sent(op_id, seq).await
}

/// Purga de mantenimiento de `_Sync_Applied_Ops` (solo lo ya subido a la nube). Se invoca cuando el
/// outbox queda vacío tras drenar.
pub async fn purge_applied_ops(repo: &dyn SyncRepository) -> AppResult<()> {
    repo.purge_applied_ops().await
}
