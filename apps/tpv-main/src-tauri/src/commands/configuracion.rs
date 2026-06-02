//! Comandos Tauri de configuración (capa fina hexagonal).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::configuracion as uc;
use tpv_contracts::configuracion::{BusinessSettings, ConfigPatchInput, TicketSettings};
use tpv_infra_sqlite::configuracion::SqliteConfiguracionRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteConfiguracionRepository {
    SqliteConfiguracionRepository::new(conn)
}

#[tauri::command]
pub async fn config_get_business_settings(
    state: State<'_, AppState>,
) -> Result<BusinessSettings, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_business(&repo(conn)).await?)
}

#[tauri::command]
pub async fn config_get_ticket_settings(
    state: State<'_, AppState>,
) -> Result<TicketSettings, String> {
    let conn = get_db(&state).await?;
    Ok(uc::get_ticket(&repo(conn)).await?)
}

#[tauri::command]
pub async fn config_patch_business_settings(
    state: State<'_, AppState>,
    args: ConfigPatchInput,
) -> Result<String, String> {
    let conn = get_db(&state).await?;
    Ok(uc::patch_business(&repo(conn), args.patch).await?)
}

#[tauri::command]
pub async fn config_patch_ticket_settings(
    state: State<'_, AppState>,
    args: ConfigPatchInput,
) -> Result<String, String> {
    let conn = get_db(&state).await?;
    Ok(uc::patch_ticket(&repo(conn), args.patch).await?)
}
