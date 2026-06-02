//! Casos de uso de estadísticas. Al ser lectura pura sin reglas de negocio,
//! son pasarelas finas hacia el puerto `StatsRepository` (toda la lógica de
//! agregación vive en el adaptador SQLite).

use tpv_contracts::stats::{
    ClientesStatsArgs, ClientesStatsResponse, MesasStatsResponse, ProductosStatsArgs,
    ProductosStatsResponse, ProveedoresStatsArgs, ProveedoresStatsResponse, ReservasStatsArgs,
    ReservasStatsResponse, StatsCategoriaRow, StatsRange, TrabajadoresStatsArgs,
    TrabajadoresStatsResponse,
};

use crate::error::AppResult;
use crate::ports::stats::StatsRepository;

pub async fn mesas(repo: &dyn StatsRepository, range: StatsRange) -> AppResult<MesasStatsResponse> {
    repo.mesas(range).await
}

pub async fn list_categorias(repo: &dyn StatsRepository) -> AppResult<Vec<StatsCategoriaRow>> {
    repo.list_categorias().await
}

pub async fn productos(
    repo: &dyn StatsRepository,
    args: ProductosStatsArgs,
) -> AppResult<ProductosStatsResponse> {
    repo.productos(args).await
}

pub async fn reservas(
    repo: &dyn StatsRepository,
    args: ReservasStatsArgs,
) -> AppResult<ReservasStatsResponse> {
    repo.reservas(args).await
}

pub async fn trabajadores(
    repo: &dyn StatsRepository,
    args: TrabajadoresStatsArgs,
) -> AppResult<TrabajadoresStatsResponse> {
    repo.trabajadores(args).await
}

pub async fn clientes(
    repo: &dyn StatsRepository,
    args: ClientesStatsArgs,
) -> AppResult<ClientesStatsResponse> {
    repo.clientes(args).await
}

pub async fn proveedores(
    repo: &dyn StatsRepository,
    args: ProveedoresStatsArgs,
) -> AppResult<ProveedoresStatsResponse> {
    repo.proveedores(args).await
}
