//! Comandos Tauri del **correo de recuperación** (LOGIN-08). Capa fina: las reglas están en el
//! worker (`domains/login/correoRecuperacion.ts`) y la validación en
//! `tpv_application::use_cases::correo_recuperacion`.
//!
//! Administrador y en la Main. El worker no conoce las sesiones, así que el gate de rol vive aquí;
//! y por eso el proxy genérico `tpv_server_post_json` también exige administrador para estas rutas
//! (`pairing.rs::ruta_de_administracion`), o bastaría con llamarlas por él.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::correo_recuperacion as uc;
use tpv_contracts::errors::{AppErrorDto, ErrorCode};
use tpv_contracts::login::{
    CodigoEnviado, ConfirmarCambioCorreoInput, EstadoCorreoRecuperacion, SolicitarCambioCorreoInput,
};
use tpv_infra_licensing::PairingAdapter;

use crate::{AppState, DeviceMode, ADMIN};

async fn administrador_en_la_main(state: &AppState) -> Result<(), AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    if matches!(*state.mode.lock().await, Some(DeviceMode::Tpv)) {
        return Ok(());
    }
    Err(AppErrorDto::new(
        ErrorCode::Validation,
        "El correo de recuperación se cambia desde el TPV principal",
    ))
}

fn nube(app: &AppHandle) -> Result<PairingAdapter, AppErrorDto> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(PairingAdapter::new(dir))
}

#[tauri::command]
pub async fn correo_recuperacion_estado(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EstadoCorreoRecuperacion, AppErrorDto> {
    administrador_en_la_main(&state).await?;
    Ok(uc::estado(&nube(&app)?).await?)
}

/// Manda un código al correo nuevo. Hasta confirmarlo no cambia nada.
#[tauri::command]
pub async fn correo_recuperacion_solicitar(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SolicitarCambioCorreoInput,
) -> Result<CodigoEnviado, AppErrorDto> {
    administrador_en_la_main(&state).await?;
    Ok(uc::solicitar_cambio(&nube(&app)?, args).await?)
}

#[tauri::command]
pub async fn correo_recuperacion_confirmar(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConfirmarCambioCorreoInput,
) -> Result<EstadoCorreoRecuperacion, AppErrorDto> {
    administrador_en_la_main(&state).await?;
    Ok(uc::confirmar_cambio(&nube(&app)?, args).await?)
}

#[tauri::command]
pub async fn correo_recuperacion_usar_el_de_la_compra(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<EstadoCorreoRecuperacion, AppErrorDto> {
    administrador_en_la_main(&state).await?;
    Ok(uc::usar_el_de_la_compra(&nube(&app)?).await?)
}
