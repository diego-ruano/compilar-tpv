//! Comandos Tauri de clientes (capa fina hexagonal).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::clientes as uc;
use tpv_contracts::clientes::{
    ClienteForm, ClienteIdArgs, ClienteOverview, ClientesOverviewArgs, CreateClienteInput,
    UpdateClienteInput,
};
use tpv_infra_sqlite::clientes::SqliteClientesRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteClientesRepository {
    SqliteClientesRepository::new(conn)
}

#[tauri::command]
pub async fn clientes_get_overview(
    state: State<'_, AppState>,
    args: ClientesOverviewArgs,
) -> Result<Vec<ClienteOverview>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::listar_overview(&repo(conn), &args.ranking).await?)
}

#[tauri::command]
pub async fn clientes_get_cliente_form(
    state: State<'_, AppState>,
    args: ClienteIdArgs,
) -> Result<Option<ClienteForm>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::obtener_form(&repo(conn), args.id_cliente).await?)
}

#[tauri::command]
pub async fn clientes_create_cliente(
    state: State<'_, AppState>,
    args: CreateClienteInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::crear_cliente(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn clientes_update_cliente(
    state: State<'_, AppState>,
    args: UpdateClienteInput,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    Ok(uc::actualizar_cliente(&repo(conn), args).await?)
}
