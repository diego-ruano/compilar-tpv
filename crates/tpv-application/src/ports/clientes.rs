//! Puerto de persistencia de clientes.

use async_trait::async_trait;

use tpv_contracts::clientes::{ClienteForm, ClienteOverview};
use tpv_domain::clientes::{Cliente, ClienteRanking, NuevoCliente};

use crate::error::AppResult;

/// Repositorio de clientes. Lo implementa `tpv-infra-sqlite` contra la BD local.
#[async_trait]
pub trait ClientesRepository: Send + Sync {
    /// Top/listado de clientes según el criterio de ranking.
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>>;

    /// Datos de formulario de un cliente, o `None` si no existe.
    async fn form(&self, id_cliente: i64) -> AppResult<Option<ClienteForm>>;

    /// Crea (o upserta por id) un cliente. Devuelve `true` si quedó persistido.
    async fn create(&self, nuevo: NuevoCliente) -> AppResult<bool>;

    /// Actualiza un cliente existente. Devuelve `true` si afectó alguna fila.
    async fn update(&self, cliente: Cliente) -> AppResult<bool>;
}
