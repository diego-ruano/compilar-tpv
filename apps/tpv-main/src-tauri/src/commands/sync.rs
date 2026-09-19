//! Comandos Tauri de **sincronización nube → Main** (capa fina hexagonal).
//!
//! Aplican en el SQLite local las operaciones recibidas por el WebSocket o por el catch-up.
//! Solo tienen sentido en la Main (modo TPV con BD local); en otro caso `sync_repo` falla.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::sync as uc;
use tpv_contracts::sync::{
    AplicacionSync, ApplySyncChangesArgs, BackfillEstado, BootstrapResultado, OutboxEntry,
    OutboxFallo, SyncHealth,
};
use tpv_infra_licensing::PairingAdapter;

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/// Aplica un lote de cambios (idempotente por op_id) y devuelve el nuevo checkpoint (`seq`).
#[tauri::command]
pub async fn sync_apply_changes(
    state: State<'_, AppState>,
    args: ApplySyncChangesArgs,
) -> Result<AplicacionSync, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::apply_changes(repo.as_ref(), args).await?)
}

/// Último `seq` aplicado localmente (cursor para pedir el catch-up al reconectar).
#[tauri::command]
pub async fn sync_get_checkpoint(state: State<'_, AppState>) -> Result<i64, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::get_checkpoint(repo.as_ref()).await?)
}

/// Operaciones pendientes de subir a la nube (outbox local), en orden de `seq`.
#[tauri::command]
pub async fn sync_outbox_pending(
    state: State<'_, AppState>,
    limit: i64,
) -> Result<Vec<OutboxEntry>, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::outbox_pending(repo.as_ref(), limit).await?)
}

/// Marca una operación del outbox como enviada (tras el `apply_ack` de la nube). `seq` es el cursor
/// que la nube asignó a la operación (0 si no pudo devolverlo); se usa para ascender el anti-eco.
#[tauri::command]
pub async fn sync_outbox_mark_sent(
    state: State<'_, AppState>,
    op_id: String,
    seq: i64,
) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    uc::outbox_mark_sent(repo.as_ref(), &op_id, seq).await?;
    Ok(())
}

/// SYNC-20: la nube RECHAZÓ una operación del outbox (`apply_ack` con `ok:false`).
///
/// Devuelve si la operación se aparta, para que el drenado sepa si seguir con la siguiente o
/// esperar. Antes de esto no había a quién preguntárselo: el drenado paraba siempre, y una
/// operación que la nube no puede aplicar detenía la cola entera sin decírselo a nadie.
#[tauri::command]
pub async fn sync_outbox_mark_failed(
    state: State<'_, AppState>,
    op_id: String,
    error: String,
    permanente: bool,
) -> Result<OutboxFallo, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::outbox_mark_failed(repo.as_ref(), &op_id, &error, permanente).await?)
}

/// SYNC-18: la nube aceptó estas operaciones en su cola (`bulk_ack`, o un `apply_ack` que llegó
/// marcado como encolado). Dejan de ofrecerse para reenviar, pero su copia local se conserva hasta
/// que el catch-up las devuelva: ver el puerto `outbox_mark_encolada`.
#[tauri::command]
pub async fn sync_outbox_mark_encolada(
    state: State<'_, AppState>,
    op_ids: Vec<String>,
) -> Result<(), AppErrorDto> {
    let repo = state.sync_repo().await?;
    uc::outbox_mark_encolada(repo.as_ref(), &op_ids).await?;
    Ok(())
}

/// SYNC-18: devuelve al outbox lo que lleva demasiado tiempo encolado sin que la nube lo confirme.
/// Se llama al conectar: reenviar es inocuo (la nube es idempotente por `Op_Id`) y es lo que
/// impide que una operación se quede en el limbo si su ack se perdió o la nube la descartó.
#[tauri::command]
pub async fn sync_liberar_encoladas(
    state: State<'_, AppState>,
    antiguedad_ms: i64,
) -> Result<i64, AppErrorDto> {
    let repo = state.sync_repo().await?;
    Ok(uc::liberar_encoladas_caducadas(repo.as_ref(), antiguedad_ms).await?)
}

/// Foto de salud de la sincronización (SYNC-14) para el panel de Configuración → Conectividad.
#[tauri::command]
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
