//! Contratos de recuperación de la base local de la Main.

use serde::{Deserialize, Serialize};
/// Estado que decide si la aplicación puede abrir el login o debe permanecer bloqueada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryState {
    Ready,
    DataMissing,
    ReconciliationPending,
    /// La licencia se trasladó a este equipo desde otro. Lo que tenga la base local es de antes
    /// del traslado, así que no se puede trabajar con ella: se reconstruye desde la nube, igual que
    /// un equipo nuevo. Sólo con la nube — una copia local también sería de antes.
    TransferPending,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RecoveryStatus {
    pub state: RecoveryState,
}

/// Copia local disponible. `id` es opaco para la UI y sólo puede proceder del listado.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LocalBackupInfo {
    pub id: String,
    pub created_at_ms: i64,
    pub size_bytes: i64,
    /// La ha traído una persona desde fuera del equipo (un USB). La retención de las copias
    /// diarias no la alcanza, y la pantalla la distingue: su fecha no dice nada de este disco.
    pub importada: bool,
}
