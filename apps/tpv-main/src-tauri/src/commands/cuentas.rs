//! Comandos Tauri de cuentas/caja (capa fina hexagonal).

use tauri::State;

use tpv_application::use_cases::cuentas as uc;
use tpv_contracts::cuentas::{
    CreateGastoInput, CuentasRangoArgs, DeleteGastoInput, DeletePagoInput, EntradaDto,
    ResumenCajaDto, SalidaDto, TicketReimpresionDto, UpdateGastoInput, UpdatePagoInput,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
pub async fn cuentas_get_entradas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<EntradaDto>, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_entradas(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_get_salidas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<SalidaDto>, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_salidas(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_get_resumen(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<ResumenCajaDto, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_resumen(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_create_gasto(
    state: State<'_, AppState>,
    args: CreateGastoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::create_gasto(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_update_gasto(
    state: State<'_, AppState>,
    args: UpdateGastoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::update_gasto(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_delete_gasto(
    state: State<'_, AppState>,
    args: DeleteGastoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::delete_gasto(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_update_pago(
    state: State<'_, AppState>,
    args: UpdatePagoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::update_pago(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn cuentas_delete_pago(
    state: State<'_, AppState>,
    args: DeletePagoInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::delete_pago(repo.as_ref(), args).await?)
}

/// Devuelve un ticket ya cobrado para volver a imprimirlo: mismo número, mismos tipos de IVA y las
/// mismas líneas que cobró ese pago (no las de la comanda entera, que en un cobro fraccionado
/// serían otras). Quien imprime lo marca como COPIA.
#[tauri::command]
pub async fn cuentas_ticket_para_reimprimir(
    state: State<'_, AppState>,
    id_pago: String,
) -> Result<Option<TicketReimpresionDto>, AppErrorDto> {
    let repo = state.cuentas_repo().await?;
    Ok(uc::ticket_para_reimprimir(repo.as_ref(), &id_pago).await?)
}
