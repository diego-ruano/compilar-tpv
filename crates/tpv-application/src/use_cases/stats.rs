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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use crate::error::AppError;

    struct RepoConError;
    fn fallo<T>() -> AppResult<T> { Err(AppError::external("stats no disponibles")) }

    #[async_trait]
    impl StatsRepository for RepoConError {
        async fn mesas(&self, _: StatsRange) -> AppResult<MesasStatsResponse> { fallo() }
        async fn list_categorias(&self) -> AppResult<Vec<StatsCategoriaRow>> { fallo() }
        async fn productos(&self, _: ProductosStatsArgs) -> AppResult<ProductosStatsResponse> { fallo() }
        async fn reservas(&self, _: ReservasStatsArgs) -> AppResult<ReservasStatsResponse> { fallo() }
        async fn trabajadores(&self, _: TrabajadoresStatsArgs) -> AppResult<TrabajadoresStatsResponse> { fallo() }
        async fn clientes(&self, _: ClientesStatsArgs) -> AppResult<ClientesStatsResponse> { fallo() }
        async fn proveedores(&self, _: ProveedoresStatsArgs) -> AppResult<ProveedoresStatsResponse> { fallo() }
    }

    // Este mÃ³dulo es deliberadamente una pasarela sin reglas: el test fija que las siete
    // operaciones siguen expuestas como casos de uso independientes y no se eliminan del wiring.
    #[test]
    fn expone_todas_las_consultas_estadisticas() {
        let _ = mesas;
        let _ = list_categorias;
        let _ = productos;
        let _ = reservas;
        let _ = trabajadores;
        let _ = clientes;
        let _ = proveedores;
    }

    #[tokio::test]
    async fn pasarela_de_mesas_propaga_error_del_repositorio() {
        let error = mesas(&RepoConError, StatsRange::Hoy).await.unwrap_err();
        assert!(error.to_string().contains("stats no disponibles"));
    }

    #[tokio::test]
    async fn pasarela_de_categorias_propaga_error_del_repositorio() {
        let error = list_categorias(&RepoConError).await.unwrap_err();
        assert!(error.to_string().contains("stats no disponibles"));
    }
}
