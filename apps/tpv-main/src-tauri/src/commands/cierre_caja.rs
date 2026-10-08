//! Comandos Tauri del **cierre de caja** (arqueo). CUENTA-06. Capa fina: ni SQL ni reglas.
//!
//! RI-70: los cinco exigen la capacidad `caja.cerrar`. Quién cierra o reabre sale de la
//! **sesión**, no de la entrada:
//! `ConfirmarCierreInput` y `CierreIdInput` ya no llevan `id_usuario`.

use tpv_domain::dinero::Dinero;
use tauri::State;

use tpv_application::use_cases::cierre_caja as uc;
use tpv_contracts::cierre_caja::{
    CierreDto, CierreIdInput, CierreListarArgs, CierreResumenDto, ConfirmarCierreInput,
    PreparacionCierreDto,
};
use tpv_contracts::errors::AppErrorDto;

use crate::AppState;

/// El umbral configurado del negocio. Si no se puede leer (Handy sin red, BD a medio arrancar) se
/// cae al valor por defecto en vez de fallar: el arqueo no puede depender de un ajuste cosmético.
async fn umbral(state: &State<'_, AppState>) -> Dinero {
    match state.configuracion_repo().await {
        Ok(repo) => {
            match tpv_application::use_cases::configuracion::get_business(repo.as_ref()).await {
                Ok(b) => b.umbral_descuadre,
                Err(_) => tpv_domain::cierre_caja::UMBRAL_DESCUADRE_POR_DEFECTO,
            }
        }
        Err(_) => tpv_domain::cierre_caja::UMBRAL_DESCUADRE_POR_DEFECTO,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn cierre_preparar(
    state: State<'_, AppState>,
) -> Result<PreparacionCierreDto, AppErrorDto> {
    state.exigir_permiso("caja.cerrar").await?;
    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::preparar(repo.as_ref(), u).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cierre_confirmar(
    state: State<'_, AppState>,
    args: ConfirmarCierreInput,
) -> Result<CierreDto, AppErrorDto> {
    // SEC-01: quién cierra la caja lo dice la sesión, no la entrada. Un arqueo firmado con el
    // nombre que le pasen es una auditoría que da confianza sin merecerla — que es justo lo que
    // era mientras `id_usuario` viajaba en el input (ya no existe ahí).
    let sesion = state.exigir_permiso("caja.cerrar").await?;

    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    // El id llega en `args` (RI-58): lo genera la pantalla al abrir el arqueo, para que confirmar
    // dos veces sea confirmar una. Sigue siendo un literal anterior al INSERT, nunca la sentencia.
    Ok(uc::confirmar(repo.as_ref(), Some(&sesion.id_usuario), args, u).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cierre_listar(
    state: State<'_, AppState>,
    args: Option<CierreListarArgs>,
) -> Result<Vec<CierreResumenDto>, AppErrorDto> {
    state.exigir_permiso("caja.cerrar").await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::listar(repo.as_ref(), args.and_then(|a| a.limite)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cierre_detalle(
    state: State<'_, AppState>,
    id_cierre: String,
) -> Result<CierreDto, AppErrorDto> {
    state.exigir_permiso("caja.cerrar").await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::detalle(repo.as_ref(), &id_cierre).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cierre_reabrir(
    state: State<'_, AppState>,
    args: CierreIdInput,
) -> Result<bool, AppErrorDto> {
    // Reabrir deja rastro (`Reabierto_Por`), así que ese rastro tiene que ser el de verdad.
    let sesion = state.exigir_permiso("caja.cerrar").await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::reabrir(repo.as_ref(), &args.id_cierre, Some(&sesion.id_usuario)).await?)
}
