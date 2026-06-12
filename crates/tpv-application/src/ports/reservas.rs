//! Puerto de persistencia de reservas.

use async_trait::async_trait;

use tpv_contracts::reservas::{ReservaDto, ReservasMetaDto};
use tpv_domain::reservas::ReservaValidada;

use crate::error::AppResult;

#[async_trait]
pub trait ReservasRepository: Send + Sync {
    /// Zonas + mesas (para los selectores del calendario de reservas).
    async fn meta(&self) -> AppResult<ReservasMetaDto>;

    /// Reservas en el rango `[desde, hasta]` (ambos YYYY-MM-DD ya normalizados).
    async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>>;

    /// Crea o actualiza una reserva (con upsert del cliente asociado). Devuelve `true` si quedó persistida.
    async fn guardar(&self, reserva: ReservaValidada) -> AppResult<bool>;

    /// Elimina una reserva (desvinculando comandas). Devuelve `true` si borró alguna fila.
    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool>;
}
