//! Comandos Tauri del **cierre de caja** (arqueo). CUENTA-06. Capa fina: ni SQL ni reglas.

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
async fn umbral(state: &State<'_, AppState>) -> f64 {
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
pub async fn cierre_preparar(
    state: State<'_, AppState>,
) -> Result<PreparacionCierreDto, AppErrorDto> {
    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::preparar(repo.as_ref(), u).await?)
}

#[tauri::command]
pub async fn cierre_confirmar(
    state: State<'_, AppState>,
    args: ConfirmarCierreInput,
) -> Result<CierreDto, AppErrorDto> {
    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    // El id lo genera la Main antes del INSERT, nunca la sentencia: una `TEXT PRIMARY KEY` con
    // `randomblob` dentro se re-evaluaría al replicar y las dos BD acabarían con claves distintas
    // para la misma fila (el fallo de TRAB-08).
    let id = tpv_infra_sqlite::util::new_id();
    Ok(uc::confirmar(repo.as_ref(), id, args, u).await?)
}

#[tauri::command]
pub async fn cierre_listar(
    state: State<'_, AppState>,
    args: Option<CierreListarArgs>,
) -> Result<Vec<CierreResumenDto>, AppErrorDto> {
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::listar(repo.as_ref(), args.and_then(|a| a.limite)).await?)
}

#[tauri::command]
pub async fn cierre_detalle(
    state: State<'_, AppState>,
    id_cierre: String,
) -> Result<CierreDto, AppErrorDto> {
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::detalle(repo.as_ref(), &id_cierre).await?)
}

#[tauri::command]
pub async fn cierre_reabrir(
    state: State<'_, AppState>,
    args: CierreIdInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::reabrir(repo.as_ref(), &args.id_cierre, args.id_usuario.as_deref()).await?)
}
