//! Comandos Tauri de cuentas/caja (capa fina hexagonal).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::cuentas as uc;
use tpv_contracts::cuentas::{
    CreateGastoInput, CuentasRangoArgs, DeleteGastoInput, DeletePagoInput, EntradaDto, SalidaDto,
    UpdateGastoInput, UpdatePagoInput,
};
use tpv_infra_sqlite::cuentas::SqliteCuentasRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteCuentasRepository {
    SqliteCuentasRepository::new(conn)
}

#[tauri::command]
pub async fn cuentas_get_entradas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<EntradaDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_entradas(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_get_salidas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<SalidaDto>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_salidas(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_create_gasto(
    state: State<'_, AppState>,
    args: CreateGastoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::create_gasto(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_update_gasto(
    state: State<'_, AppState>,
    args: UpdateGastoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_gasto(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_delete_gasto(
    state: State<'_, AppState>,
    args: DeleteGastoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_gasto(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_update_pago(
    state: State<'_, AppState>,
    args: UpdatePagoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::update_pago(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn cuentas_delete_pago(
    state: State<'_, AppState>,
    args: DeletePagoInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::delete_pago(&repo(conn), args).await?)
}
