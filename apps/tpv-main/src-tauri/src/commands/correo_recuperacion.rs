//! Comandos Tauri del **correo de recuperación** (LOGIN-08). Capa fina: las reglas están en el
//! worker (`domains/login/correoRecuperacion.ts`) y la validación en
//! `tpv_application::use_cases::correo_recuperacion`.
//!
//! Administrador y en la Main. El worker no conoce las sesiones, así que el gate de rol vive aquí;
//! y por eso el proxy genérico `tpv_server_post_json` también exige administrador para estas rutas
//! (`pairing.rs::ruta_de_administracion`), o bastaría con llamarlas por él.
//!
//! Una excepción: pedir y confirmar el código se permiten SIN sesión mientras el PIN inicial esté
//! por elegir. Es el primer arranque: al activar se puede elegir otro correo, y su código se escribe
//! en la pantalla del PIN, cuando todavía no existe nadie con quien iniciar sesión.

use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::correo_recuperacion as uc;
use tpv_application::use_cases::login as login_uc;
use tpv_contracts::errors::{AppErrorDto, ErrorCode};
use tpv_contracts::login::{
    CodigoEnviado, ConfirmarCambioCorreoInput, EstadoCorreoRecuperacion, SolicitarCambioCorreoInput,
};
use tpv_infra_licensing::PairingAdapter;

use crate::{AppState, DeviceMode, ADMIN};

async fn solo_en_la_main(state: &AppState) -> Result<(), AppErrorDto> {
    if matches!(*state.mode.lock().await, Some(DeviceMode::Tpv)) {
        return Ok(());
    }
    Err(AppErrorDto::new(
        ErrorCode::Validation,
        "El correo de recuperación se cambia desde el TPV principal",
    ))
}

async fn administrador_en_la_main(state: &AppState) -> Result<(), AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    solo_en_la_main(state).await
}

/// Con sesión, administrador. Sin sesión, sólo mientras el PIN inicial esté por elegir.
///
/// No abre nada que no estuviera abierto: en esa misma ventana `complete_initial_setup` ya deja
/// poner PIN y correo sin sesión, y se cierra sola en cuanto se elige el PIN. Y el cambio sigue
/// exigiendo el código enviado al correo nuevo, con aviso al de la compra.
async fn administrador_o_primer_arranque(state: &AppState) -> Result<(), AppErrorDto> {
    if state.sesion().await.is_ok() {
        return administrador_en_la_main(state).await;
    }
    let repo = state.login_repo().await?;
    if !login_uc::setup_pendiente(repo.as_ref()).await?.pendiente {
        return Err(AppErrorDto::new(
            ErrorCode::PermisoDenegado,
            "Inicia sesión como administrador para cambiar el correo de recuperación",
        ));
    }
    solo_en_la_main(state).await
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
    administrador_o_primer_arranque(&state).await?;
    Ok(uc::solicitar_cambio(&nube(&app)?, args).await?)
}

#[tauri::command]
pub async fn correo_recuperacion_confirmar(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ConfirmarCambioCorreoInput,
) -> Result<EstadoCorreoRecuperacion, AppErrorDto> {
    administrador_o_primer_arranque(&state).await?;
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
