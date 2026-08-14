//! Comando Tauri del **runner de jobs** (capa fina). Solo lectura: el runner se declara en
//! `jobs/registro.rs` y no se pilota desde la UI.

use tauri::AppHandle;

use tpv_contracts::jobs::JobStatus;

/// Foto de las tareas periódicas para el panel de Configuración → Conectividad: cuándo corrió cada
/// una por última vez, si va bien y, si no, con qué error.
#[tauri::command]
pub async fn jobs_status(app: AppHandle) -> Result<Vec<JobStatus>, String> {
    crate::jobs::estado_actual(&app).await
}
