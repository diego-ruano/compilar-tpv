//! Comando Tauri del **runner de jobs** (capa fina). Solo lectura: el runner se declara en
//! `jobs/registro.rs` y no se pilota desde la UI.

use tauri::AppHandle;

use tpv_contracts::interruptores::InterruptorApagado;
use tpv_contracts::jobs::JobStatus;
use tpv_contracts::errors::AppErrorDto;

/// Foto de las tareas periódicas para el panel de Configuración → Conectividad: cuándo corrió cada
/// una por última vez, si va bien y, si no, con qué error.
#[tauri::command]
#[specta::specta]
pub async fn jobs_status(app: AppHandle) -> Result<Vec<JobStatus>, AppErrorDto> {
    crate::jobs::estado_actual(&app).await.map_err(AppErrorDto::from)
}

/// PROD-06: lo que la nube tiene apagado en este equipo ahora mismo. Lo leen Conectividad y Fiscal
/// para decir por qué una cola crece, y `socketMain.ts` para decidir si puede volcar el atraso.
///
/// Sin sesión a propósito: no revela nada que el equipo no esté haciendo ya, y el socket lo
/// pregunta antes del login.
#[tauri::command]
#[specta::specta]
pub async fn interruptores_apagados(app: AppHandle) -> Result<Vec<InterruptorApagado>, AppErrorDto> {
    Ok(crate::interruptores::vigentes(&app))
}
