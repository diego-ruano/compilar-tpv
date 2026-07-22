//! Puerto de lectura de estadísticas (analítica). Solo consultas (sin escritura).

use async_trait::async_trait;

use tpv_contracts::stats::{
    ClientesStatsArgs, ClientesStatsResponse, MesasStatsResponse, ProductosStatsArgs,
    ProductosStatsResponse, ProveedoresStatsArgs, ProveedoresStatsResponse, ReservasStatsArgs,
    ReservasStatsResponse, StatsCategoriaRow, StatsRange, TrabajadoresStatsArgs,
    TrabajadoresStatsResponse,
};

use crate::error::AppResult;

#[async_trait]
pub trait StatsRepository: Send + Sync {
    /// Resumen de mesas para el rango dado.
    async fn mesas(&self, range: StatsRange) -> AppResult<MesasStatsResponse>;

    /// Categorías vendibles (para los selectores de producto).
    async fn list_categorias(&self) -> AppResult<Vec<StatsCategoriaRow>>;

    /// Resumen de productos (mejores/peores) con filtros opcionales de categoría.
    async fn productos(&self, args: ProductosStatsArgs) -> AppResult<ProductosStatsResponse>;

    /// Resumen de reservas (por turno/franja/estado).
    async fn reservas(&self, args: ReservasStatsArgs) -> AppResult<ReservasStatsResponse>;

    /// Tarjetas y ranking de trabajadores.
    async fn trabajadores(
        &self,
        args: TrabajadoresStatsArgs,
    ) -> AppResult<TrabajadoresStatsResponse>;

    /// Resumen de clientes (nuevos/recurrentes/top gasto).
    async fn clientes(&self, args: ClientesStatsArgs) -> AppResult<ClientesStatsResponse>;

    /// Resumen de gasto en proveedores.
    async fn proveedores(&self, args: ProveedoresStatsArgs) -> AppResult<ProveedoresStatsResponse>;
}
