//! Contratos de recuperación de la base local de la Main.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Estado que decide si la aplicación puede abrir el login o debe permanecer bloqueada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(
    export,
    export_to = "../../../packages/contracts/src/generated/bindings.ts"
)]
pub enum RecoveryState {
    Ready,
    DataMissing,
    ReconciliationPending,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../packages/contracts/src/generated/bindings.ts"
)]
pub struct RecoveryStatus {
    pub state: RecoveryState,
}

/// Copia local disponible. `id` es opaco para la UI y sólo puede proceder del listado.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../packages/contracts/src/generated/bindings.ts"
)]
pub struct LocalBackupInfo {
    pub id: String,
    #[ts(type = "number")]
    pub created_at_ms: i64,
    #[ts(type = "number")]
    pub size_bytes: i64,
}
