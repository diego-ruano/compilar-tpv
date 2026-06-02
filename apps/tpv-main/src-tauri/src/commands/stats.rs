//! Comandos Tauri de estadísticas (capa fina hexagonal, solo lectura).

use std::sync::Arc;

use libsql::Connection;
use tauri::State;

use tpv_application::use_cases::stats as uc;
use tpv_contracts::stats::{
    ClientesStatsArgs, ClientesStatsResponse, MesasStatsResponse, ProductosStatsArgs,
    ProductosStatsResponse, ProveedoresStatsArgs, ProveedoresStatsResponse, ReservasStatsArgs,
    ReservasStatsResponse, StatsCategoriaRow, StatsRange, TrabajadoresStatsArgs,
    TrabajadoresStatsResponse,
};
use tpv_infra_sqlite::stats::SqliteStatsRepository;

use crate::{get_db, AppState};

fn repo(conn: Arc<Connection>) -> SqliteStatsRepository {
    SqliteStatsRepository::new(conn)
}

#[tauri::command]
pub async fn stats_mesas_get(
    state: State<'_, AppState>,
    range: StatsRange,
) -> Result<MesasStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::mesas(&repo(conn), range).await?)
}

#[tauri::command]
pub async fn stats_productos_list_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<StatsCategoriaRow>, String> {
    let conn = get_db(&state).await?;
    Ok(uc::list_categorias(&repo(conn)).await?)
}

#[tauri::command]
pub async fn stats_productos_resumen(
    state: State<'_, AppState>,
    args: ProductosStatsArgs,
) -> Result<ProductosStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::productos(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn stats_reservas_resumen(
    state: State<'_, AppState>,
    args: ReservasStatsArgs,
) -> Result<ReservasStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::reservas(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn stats_trabajadores_resumen(
    state: State<'_, AppState>,
    args: TrabajadoresStatsArgs,
) -> Result<TrabajadoresStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::trabajadores(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn stats_clientes_resumen(
    state: State<'_, AppState>,
    args: ClientesStatsArgs,
) -> Result<ClientesStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::clientes(&repo(conn), args).await?)
}

#[tauri::command]
pub async fn stats_proveedores_resumen(
    state: State<'_, AppState>,
    args: ProveedoresStatsArgs,
) -> Result<ProveedoresStatsResponse, String> {
    let conn = get_db(&state).await?;
    Ok(uc::proveedores(&repo(conn), args).await?)
}
