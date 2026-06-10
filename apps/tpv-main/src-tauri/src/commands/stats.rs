//! Comandos Tauri de estadísticas (capa fina hexagonal, solo lectura).

use tauri::State;

use tpv_application::use_cases::stats as uc;
use tpv_contracts::stats::{
    ClientesStatsArgs, ClientesStatsResponse, MesasStatsResponse, ProductosStatsArgs,
    ProductosStatsResponse, ProveedoresStatsArgs, ProveedoresStatsResponse, ReservasStatsArgs,
    ReservasStatsResponse, StatsCategoriaRow, StatsRange, TrabajadoresStatsArgs,
    TrabajadoresStatsResponse,
};
use crate::AppState;

#[tauri::command]
pub async fn stats_mesas_get(
    state: State<'_, AppState>,
    range: StatsRange,
) -> Result<MesasStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::mesas(repo.as_ref(), range).await?)
}

#[tauri::command]
pub async fn stats_productos_list_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<StatsCategoriaRow>, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::list_categorias(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn stats_productos_resumen(
    state: State<'_, AppState>,
    args: ProductosStatsArgs,
) -> Result<ProductosStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::productos(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn stats_reservas_resumen(
    state: State<'_, AppState>,
    args: ReservasStatsArgs,
) -> Result<ReservasStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::reservas(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn stats_trabajadores_resumen(
    state: State<'_, AppState>,
    args: TrabajadoresStatsArgs,
) -> Result<TrabajadoresStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::trabajadores(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn stats_clientes_resumen(
    state: State<'_, AppState>,
    args: ClientesStatsArgs,
) -> Result<ClientesStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::clientes(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn stats_proveedores_resumen(
    state: State<'_, AppState>,
    args: ProveedoresStatsArgs,
) -> Result<ProveedoresStatsResponse, String> {
    let repo = state.stats_repo().await?;
    Ok(uc::proveedores(repo.as_ref(), args).await?)
}
