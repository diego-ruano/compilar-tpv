//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local); en otro caso `sync_repo` falla.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::sync as uc;
use tpv_contracts::sync::{
    BackfillEstado, BootstrapResultado, SyncHealth,
};
use tpv_infra_licensing::PairingAdapter;

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/// Sólo lectura/control de transporte: ningún comando acepta SQL ni confirmaciones.
#[tauri::command]
#[specta::specta]
pub fn sync_estado(app: AppHandle) -> tpv_contracts::sync::EstadoReplicacion {
    app.state::<crate::replicacion::SyncNativo>().estado()
}

#[tauri::command]
#[specta::specta]
pub fn sync_reintentar(app: AppHandle) {
    app.state::<crate::replicacion::SyncNativo>().reintentar();
}

/// El checkpoint es diagnóstico, no permite modificar el cursor.
#[tauri::command]
#[specta::specta]
pub async fn sync_health(state: State<'_, AppState>) -> Result<SyncHealth, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::health(repo.as_ref()).await?)
}

/// SYNC-19: progreso del backfill del histórico (fase 2). Lo pinta el panel de Conectividad y lo
/// mira Estadísticas para avisar de que un total de rango largo todavía puede crecer.
///
/// Es sólo lectura de una tabla de control local: en un equipo que nunca ha perdido su base
/// devuelve todo a cero, que es lo que hace que quien lo consulte no tenga que preguntar antes si
/// hay recuperación en curso.
#[tauri::command]
#[specta::specta]
pub async fn sync_backfill_estado(state: State<'_, AppState>) -> Result<BackfillEstado, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::backfill_estado(repo.as_ref()).await?)
}

/// Reconstruye la BD local desde la nube. Es la salida de una Main que ha perdido su `data.db`:
/// la pantalla de recuperación (a la que lleva `setup_pendiente.requiere_recuperacion`) lo llama y
/// después ya se puede iniciar sesión con las credenciales de siempre.
///
/// Lo hace Rust de punta a punta —descarga firmada + restauración— en vez de bajar el volcado al
/// frontend y devolverlo: son las tablas enteras del negocio, y cruzarlas dos veces por el puente
/// IPC sólo para reenviarlas es copiar megabytes a cambio de nada.
#[tauri::command]
#[specta::specta]
pub async fn sync_bootstrap_desde_nube(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapResultado, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    // Puede no haber base: si la local era ilegible, el arranque siguió sin ella para poder llegar
    // hasta la pantalla de recuperación. El volcado necesita dónde escribir.
    crate::commands::recovery::asegurar_base_para_recuperar(&app, &state).await?;
    let repo = state.sync_repo().await?;
    Ok(uc::bootstrap_desde_nube(&PairingAdapter::new(app_data_dir), repo.as_ref()).await?)
}

/// Inicialización destructiva sólo para el caso explícito `tenant_db_not_provisioned`. El servidor
/// vuelve a comprobarlo antes de crear nada; una respuesta ambigua nunca llega a esta rama.
#[tauri::command]
#[specta::specta]
pub async fn sync_inicializar_tenant_vacio(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapResultado, AppErrorDto> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    crate::commands::recovery::asegurar_base_para_recuperar(&app, &state).await?;
    let repo = state.sync_repo().await?;
    Ok(uc::inicializar_tenant_vacio(&PairingAdapter::new(app_data_dir), repo.as_ref()).await?)
}
