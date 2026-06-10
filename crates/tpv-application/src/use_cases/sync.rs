//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use tpv_contracts::sync::ApplySyncChangesArgs;

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
