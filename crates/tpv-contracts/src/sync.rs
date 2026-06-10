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
