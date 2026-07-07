//! Contratos de **sincronización nube → Main** (Opción 3: sentencias ya resueltas).
//!
//! El worker reenvía por WebSocket (y sirve por el catch-up) operaciones con sus sentencias
//! SQL ya resueltas (los IDs/`MAX+1` viajan literales). La Main las aplica tal cual a su
//! SQLite local mediante el comando `sync_apply_changes`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Una sentencia de escritura ya resuelta. `args` son escalares JSON (string/number/bool/null)
/// que se enlazan a los `?` del `sql`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SqlStatement {
    pub sql: String,
    #[ts(type = "Array<unknown>")]
    pub args: Vec<serde_json::Value>,
}

/// Una operación a aplicar de forma atómica e idempotente (por `op_id`). `seq` es el cursor
/// monotono del log de la nube; la Main lo usa como checkpoint del catch-up.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SyncChange {
    pub op_id: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub statements: Vec<SqlStatement>,
}

/// Args del comando que aplica un lote de cambios en orden de `seq`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ApplySyncChangesArgs {
    pub changes: Vec<SyncChange>,
}

/// Una operación pendiente en el outbox local de la Main (dirección Main → nube). El frontend
/// la envía al worker por el WebSocket (`apply`) y, al recibir el `apply_ack`, la marca enviada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct OutboxEntry {
    #[ts(type = "number")]
    pub seq: i64,
    pub op_id: String,
    pub command_name: String,
    pub statements: Vec<SqlStatement>,
}

/// Foto de SALUD de la sincronización local (SYNC-14). La expone el comando `sync_health` para el
/// panel de Configuración → Conectividad, de modo que un fallo de convergencia deje de ser invisible.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SyncHealth {
    /// Operaciones aún sin subir a la nube (profundidad del outbox).
    #[ts(type = "number")]
    pub outbox_pending: i64,
    /// Último `seq` aplicado localmente (checkpoint del catch-up).
    #[ts(type = "number")]
    pub last_seq: i64,
    /// Operaciones en CUARENTENA (SYNC-01): fallaron al aplicarse y se saltaron para no bloquear.
    #[ts(type = "number")]
    pub quarantined: i64,
    /// Operaciones que están fallando pero aún NO en cuarentena (reintentándose).
    #[ts(type = "number")]
    pub failing: i64,
}
