//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local). Lo que se puede pedir desde una Handy
//! contesta allí `conflict` (`sync_repo_de_la_main`) o, el progreso del histórico, que no hay nada
//! pendiente.

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
    let repo = state
        .sync_repo_de_la_main("La sincronización de la base local sólo existe en el TPV principal")
        .await?;
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
    estado_del_historico(&state).await
}

/// Lo de `sync_backfill_estado`. Una Handy no tiene histórico que bajar —lee de la nube, que lo
/// tiene entero—, así que contesta lo mismo que un equipo que nunca ha perdido su base: nada
/// pendiente. Estadísticas lo pregunta también en una Handy, y un error ahí iría a Sentry como un
/// fallo del programa cada vez que se abre la pantalla.
pub(crate) async fn estado_del_historico(state: &AppState) -> Result<BackfillEstado, AppErrorDto> {
    if *state.mode.lock().await == Some(crate::DeviceMode::Handy) {
        return Ok(BackfillEstado {
            tablas_pendientes: 0,
            tablas_completadas: 0,
            filas_traidas: 0,
            tabla_actual: None,
            ultimo_error: None,
        });
    }
    let repo = state
        .sync_repo_de_la_main("El histórico sólo se descarga en el TPV principal")
        .await?;
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
    // SYNC-36: también se llega con la sesión abierta, desde Configuración → Conectividad, cuando un
    // cambio de la nube se ha atascado en su cuarentena; entonces sólo un administrador. Desde la
    // pantalla de recuperación no hay sesión y no se exige nada (permisos.md).
    state.exigir_rol_si_hay_sesion(&[crate::ADMIN]).await?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    // Puede no haber base: si la local era ilegible, el arranque siguió sin ella para poder llegar
    // hasta la pantalla de recuperación. El volcado necesita dónde escribir.
    crate::commands::recovery::asegurar_base_para_recuperar(&app, &state).await?;
    // Con el motor de réplica parado: una sesión viva que aplicara un cambio después de restaurar
    // movería el checkpoint por encima de lo que la foto no trae (Codex, SYNC-36). Desde la pantalla
    // de recuperación no hay sesión y esto es inmediato; desde Conectividad, espera a que acabe.
    let motor = app.state::<crate::replicacion::SyncNativo>();
    let _turno = motor.turno_para_traer_la_nube()?;
    motor.pausar_hasta_sin_sesion(ESPERA_A_LA_REPLICA).await?;
    let traida = async {
        let repo = state.sync_repo().await?;
        Ok::<_, AppErrorDto>(uc::bootstrap_desde_nube(&PairingAdapter::new(app_data_dir), repo.as_ref()).await?)
    }
    .await;
    motor.reanudar();
    traida
}

/// Lo más que se espera a que la réplica termine lo que tenga en marcha antes de traer la nube: un
/// lote espera su acuse hasta 30 s (`ESPERA_DEL_LOTE`).
const ESPERA_A_LA_REPLICA: std::time::Duration = std::time::Duration::from_secs(45);

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
