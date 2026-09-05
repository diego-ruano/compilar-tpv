//! Comandos Tauri del **cierre de caja** (arqueo). CUENTA-06. Capa fina: ni SQL ni reglas.
//!
//! SEC-01: los cinco exigen Administrador, igual que el resto de la sección Cuentas
//! (`PLAN_CIERRE_CAJA.md` §8). Y quién cierra o reabre sale de la **sesión**, no de la entrada:
//! `ConfirmarCierreInput` y `CierreIdInput` ya no llevan `id_usuario`.

use tauri::State;

use tpv_application::use_cases::cierre_caja as uc;
use tpv_contracts::cierre_caja::{
    CierreDto, CierreIdInput, CierreListarArgs, CierreResumenDto, ConfirmarCierreInput,
    PreparacionCierreDto,
};
use tpv_contracts::errors::AppErrorDto;

use crate::{AppState, ADMIN};

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
    state.exigir_rol(&[ADMIN]).await?;
    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::preparar(repo.as_ref(), u).await?)
}

#[tauri::command]
pub async fn cierre_confirmar(
    state: State<'_, AppState>,
    args: ConfirmarCierreInput,
) -> Result<CierreDto, AppErrorDto> {
    // SEC-01: quién cierra la caja lo dice la sesión, no la entrada. Un arqueo firmado con el
    // nombre que le pasen es una auditoría que da confianza sin merecerla — que es justo lo que
    // era mientras `id_usuario` viajaba en el input (ya no existe ahí).
    let sesion = state.exigir_rol(&[ADMIN]).await?;

    let u = umbral(&state).await;
    let repo = state.cierre_caja_repo().await?;
    // El id lo genera la Main antes del INSERT, nunca la sentencia: una `TEXT PRIMARY KEY` con
    // `randomblob` dentro se re-evaluaría al replicar y las dos BD acabarían con claves distintas
    // para la misma fila (el fallo de TRAB-08).
    let id = tpv_infra_sqlite::util::new_id();
    Ok(uc::confirmar(repo.as_ref(), id, Some(&sesion.id_usuario), args, u).await?)
}

#[tauri::command]
pub async fn cierre_listar(
    state: State<'_, AppState>,
    args: Option<CierreListarArgs>,
) -> Result<Vec<CierreResumenDto>, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::listar(repo.as_ref(), args.and_then(|a| a.limite)).await?)
}

#[tauri::command]
pub async fn cierre_detalle(
    state: State<'_, AppState>,
    id_cierre: String,
) -> Result<CierreDto, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::detalle(repo.as_ref(), &id_cierre).await?)
}

#[tauri::command]
pub async fn cierre_reabrir(
    state: State<'_, AppState>,
    args: CierreIdInput,
) -> Result<bool, AppErrorDto> {
    // Reabrir deja rastro (`Reabierto_Por`), así que ese rastro tiene que ser el de verdad.
    let sesion = state.exigir_rol(&[ADMIN]).await?;
    let repo = state.cierre_caja_repo().await?;
    Ok(uc::reabrir(repo.as_ref(), &args.id_cierre, Some(&sesion.id_usuario)).await?)
}
