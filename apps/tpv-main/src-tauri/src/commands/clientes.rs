//! Comandos Tauri de clientes (capa fina hexagonal).
//!
//! El repositorio (SQLite local en modo TPV o HTTP a la nube en modo Handy) lo resuelve
//! `AppState::clientes_repo` según el modo activo: el comando no sabe contra qué backend
//! habla, sólo orquesta entrada/salida e invoca el caso de uso.

use tauri::State;

use tpv_application::use_cases::clientes as uc;
use tpv_contracts::clientes::{
    ClienteForm, ClienteIdArgs, ClienteOverview, ClientesOverviewArgs, CreateClienteInput,
    UpdateClienteInput,
};

use crate::AppState;

#[tauri::command]
pub async fn clientes_get_overview(
    state: State<'_, AppState>,
    args: ClientesOverviewArgs,
) -> Result<Vec<ClienteOverview>, String> {
    let repo = state.clientes_repo().await?;
    Ok(uc::listar_overview(repo.as_ref(), &args.ranking).await?)
}

#[tauri::command]
pub async fn clientes_get_cliente_form(
    state: State<'_, AppState>,
    args: ClienteIdArgs,
) -> Result<Option<ClienteForm>, String> {
    let repo = state.clientes_repo().await?;
    Ok(uc::obtener_form(repo.as_ref(), args.id_cliente).await?)
}

#[tauri::command]
pub async fn clientes_create_cliente(
    state: State<'_, AppState>,
    args: CreateClienteInput,
) -> Result<bool, String> {
    let repo = state.clientes_repo().await?;
    Ok(uc::crear_cliente(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn clientes_update_cliente(
    state: State<'_, AppState>,
    args: UpdateClienteInput,
) -> Result<bool, String> {
    let repo = state.clientes_repo().await?;
    Ok(uc::actualizar_cliente(repo.as_ref(), args).await?)
}
