//! Puerto de **aplicación de cambios de la nube** en la BD local de la Main.
//!
//! Lo implementa `tpv-infra-sqlite` ejecutando las sentencias ya resueltas que llegan por el
//! WebSocket (o por el catch-up al reconectar) contra el SQLite local, de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`) del último cambio aplicado.

use async_trait::async_trait;

use tpv_contracts::sync::{OutboxEntry, SyncChange, SyncHealth};

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
    ///
    /// `seq` es el cursor que la nube asignó a la operación en su log (`Sync_Changes`). Sirve para
    /// "ascender" el registro anti-eco de `_Sync_Applied_Ops` (que se insertó con `Seq=0`) a su
    /// `Seq` real, de modo que la purga por cursor pueda retirarlo cuando el checkpoint lo supere.
    /// Si la nube no pudo devolver un `seq` (p. ej. cache-hit de idempotencia sin log), llega `0`
    /// y el anti-eco se queda en `Seq=0` (lo retirará la purga TTL una vez subido).
    async fn outbox_mark_sent(&self, op_id: &str, seq: i64) -> AppResult<()>;

    /// Purga de mantenimiento de `_Sync_Applied_Ops` que SOLO retira lo ya confirmado en la nube:
    /// registros antiguos (TTL) cuyo `Op_Id` ya no está pendiente en el outbox. Pensada para
    /// llamarse cuando el outbox queda vacío tras drenar (todo subido). Es segura por diseño: nunca
    /// borra un anti-eco cuya operación siga sin enviarse (evitaría su re-aplicación tras catch-up).
    async fn purge_applied_ops(&self) -> AppResult<()>;

    /// Foto de salud de la sincronización (profundidad de outbox, checkpoint, ops en
    /// cuarentena/fallando) para el panel de Configuración → Conectividad (SYNC-14).
    async fn health(&self) -> AppResult<SyncHealth>;
}
