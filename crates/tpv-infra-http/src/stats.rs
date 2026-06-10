//! Adaptador HTTP del repositorio de estadísticas (dominio `/v1/stats` del worker). Solo lecturas.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::stats::StatsRepository;
use tpv_contracts::stats::{
    ClientesStatsArgs, ClientesStatsResponse, MesasStatsResponse, ProductosStatsArgs,
    ProductosStatsResponse, ProveedoresStatsArgs, ProveedoresStatsResponse, ReservasStatsArgs,
    ReservasStatsResponse, StatsCategoriaRow, StatsRange, TrabajadoresStatsArgs,
    TrabajadoresStatsResponse,
};

use crate::CloudClient;

pub struct HttpStatsRepository {
    client: Arc<CloudClient>,
}

impl HttpStatsRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

/// Serializa un enum de filtro (`StatsRange`/`StatsTurno`) a su valor de query (string serde).
fn enum_str<T: Serialize>(v: &T) -> AppResult<String> {
    serde_json::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(String::from))
        .ok_or_else(|| AppError::external("enum_serialize_failed"))
}

#[async_trait]
impl StatsRepository for HttpStatsRepository {
    async fn mesas(&self, range: StatsRange) -> AppResult<MesasStatsResponse> {
        self.client
            .get_query("/v1/stats/mesas", &[("range", enum_str(&range)?)])
            .await
    }

    async fn list_categorias(&self) -> AppResult<Vec<StatsCategoriaRow>> {
        self.client.get_json("/v1/stats/productos/categorias").await
    }

    async fn productos(&self, args: ProductosStatsArgs) -> AppResult<ProductosStatsResponse> {
        let mut q = vec![("range", enum_str(&args.range)?)];
        if let Some(t) = args.categoria_top_id {
            q.push(("categoria_top_id", t.to_string()));
        }
        if let Some(w) = args.categoria_worst_id {
            q.push(("categoria_worst_id", w.to_string()));
        }
        self.client.get_query("/v1/stats/productos", &q).await
    }

    async fn reservas(&self, args: ReservasStatsArgs) -> AppResult<ReservasStatsResponse> {
        self.client
            .get_query(
                "/v1/stats/reservas",
                &[
                    ("range", enum_str(&args.range)?),
                    ("turno", enum_str(&args.turno)?),
                ],
            )
            .await
    }

    async fn trabajadores(
        &self,
        args: TrabajadoresStatsArgs,
    ) -> AppResult<TrabajadoresStatsResponse> {
        self.client
            .get_query("/v1/stats/trabajadores", &[("range", enum_str(&args.range)?)])
            .await
    }

    async fn clientes(&self, args: ClientesStatsArgs) -> AppResult<ClientesStatsResponse> {
        self.client
            .get_query("/v1/stats/clientes", &[("range", enum_str(&args.range)?)])
            .await
    }

    async fn proveedores(
        &self,
        args: ProveedoresStatsArgs,
    ) -> AppResult<ProveedoresStatsResponse> {
        self.client
            .get_query("/v1/stats/proveedores", &[("range", enum_str(&args.range)?)])
            .await
    }
}
