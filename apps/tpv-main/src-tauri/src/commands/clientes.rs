//! Comandos Tauri de clientes (capa fina hexagonal).
//!
//! El repositorio (SQLite local en modo TPV o HTTP a la nube en modo Handy) lo resuelve
//! `AppState::clientes_repo` según el modo activo: el comando no sabe contra qué backend
//! habla, sólo orquesta entrada/salida e invoca el caso de uso.
//!
//! Todos piden sesión (RI-52): son datos personales de los clientes. La ficha pide
//! `clientes.gestionar`; los dos del formulario de la factura completa (FISCAL-02), el permiso del
//! cobro, porque quien cobra puede no tener el de los clientes, y sólo existen en la Main.

use tpv_domain::dinero::Dinero;
use tauri::State;

use tpv_application::use_cases::clientes as uc;
use tpv_application::use_cases::reconciliacion as uc_reconciliacion;
use tpv_contracts::clientes::{
    ClienteForm, ClienteIdArgs, ClienteOverview, ClientesOverviewArgs, ClientesParaFactura,
    ClientesParaFacturaArgs, CreateClienteInput, GuardarDatosFiscalesInput, UpdateClienteInput,
};

use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn clientes_get_overview(
    state: State<'_, AppState>,
    args: ClientesOverviewArgs,
) -> Result<Vec<ClienteOverview>, AppErrorDto> {
    state.exigir_permiso("clientes.gestionar").await?;
    let repo = state.clientes_repo().await?;
    Ok(uc::listar_overview(repo.as_ref(), &args.ranking).await?)
}

/// Rehace el gasto acumulado de un cliente desde sus pagos (DB-14).
///
/// Acción MANUAL: el job de reconciliación solo avisa del descuadre; corregirlo es una decisión
/// de quien lleva el negocio, y este comando es el botón que la ejecuta.
#[tauri::command]
#[specta::specta]
pub async fn clientes_recalcular_gasto(
    state: State<'_, AppState>,
    args: ClienteIdArgs,
) -> Result<Option<Dinero>, AppErrorDto> {
    state.exigir_permiso("clientes.recalcular").await?;
    let repo = state.reconciliacion_repo().await?;
    Ok(uc_reconciliacion::recalcular_gasto_de_cliente(repo.as_ref(), &args.id_cliente).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn clientes_get_cliente_form(
    state: State<'_, AppState>,
    args: ClienteIdArgs,
) -> Result<Option<ClienteForm>, AppErrorDto> {
    state.exigir_permiso("clientes.gestionar").await?;
    let repo = state.clientes_repo().await?;
    Ok(uc::obtener_form(repo.as_ref(), args.id_cliente).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn clientes_create_cliente(
    state: State<'_, AppState>,
    args: CreateClienteInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("clientes.gestionar").await?;
    let repo = state.clientes_repo().await?;
    Ok(uc::crear_cliente(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn clientes_update_cliente(
    state: State<'_, AppState>,
    args: UpdateClienteInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("clientes.gestionar").await?;
    let repo = state.clientes_repo().await?;
    Ok(uc::actualizar_cliente(repo.as_ref(), args).await?)
}

/// FISCAL-02 · Las fichas entre las que se elige al pedir factura completa, con lo justo para
/// facturar (ni el correo ni el teléfono), y la del cliente de la comanda si se sabe.
///
/// Con el permiso del cobro y no con `clientes.gestionar`: lo pide quien está cobrando.
#[tauri::command]
#[specta::specta]
pub async fn clientes_para_factura(
    state: State<'_, AppState>,
    args: ClientesParaFacturaArgs,
) -> Result<ClientesParaFactura, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.clientes_factura_repo().await?;
    Ok(uc::clientes_para_factura(repo.as_ref(), args).await?)
}

/// FISCAL-02 · Guarda en la ficha del cliente los datos con los que se acaba de facturar. Lo llama la
/// pantalla **después** de cobrar o de emitir la factura: si falla, sólo se avisa.
#[tauri::command]
#[specta::specta]
pub async fn clientes_guardar_datos_fiscales(
    state: State<'_, AppState>,
    args: GuardarDatosFiscalesInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.clientes_factura_repo().await?;
    Ok(uc::guardar_datos_fiscales(repo.as_ref(), args).await?)
}
