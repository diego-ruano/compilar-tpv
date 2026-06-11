//! Puerto de **aplicación de cambios de la nube** en la BD local de la Main.
//!
//! Lo implementa `tpv-infra-sqlite` ejecutando las sentencias ya resueltas que llegan por el
//! WebSocket (o por el catch-up al reconectar) contra el SQLite local, de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`) del último cambio aplicado.

use async_trait::async_trait;

use tpv_contracts::sync::{OutboxEntry, SyncChange};

use crate::error::AppResult;

#[async_trait]
pub trait SyncRepository: Send + Sync {
    /// Aplica los cambios en orden de `seq`, saltando los `op_id` ya aplicados. Cada operación
    /// es atómica. Devuelve el nuevo checkpoint (último `seq` aplicado).
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<i64>;

    /// Último `seq` aplicado localmente (0 si todavía ninguno).
    async fn get_checkpoint(&self) -> AppResult<i64>;

    /// Operaciones pendientes de subir a la nube (outbox local), en orden, hasta `limit`.
    async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>>;

    /// Marca una operación del outbox como enviada (la nube confirmó con `apply_ack`).
    async fn outbox_mark_sent(&self, op_id: &str) -> AppResult<()>;
}
