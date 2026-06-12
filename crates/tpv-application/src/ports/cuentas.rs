//! Puerto de persistencia de cuentas (caja).

use async_trait::async_trait;

use tpv_contracts::cuentas::{EntradaDto, SalidaDto};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::error::AppResult;

#[async_trait]
pub trait CuentasRepository: Send + Sync {
    async fn entradas(&self, del: Option<String>, al: Option<String>) -> AppResult<Vec<EntradaDto>>;
    async fn salidas(&self, del: Option<String>, al: Option<String>) -> AppResult<Vec<SalidaDto>>;

    /// Crea/upserta un gasto (id `None` => se genera UUIDv7). Devuelve `true`.
    async fn crear_gasto(&self, id: Option<String>, gasto: GastoData) -> AppResult<bool>;
    /// Actualiza un gasto existente. `true` si afectó fila.
    async fn actualizar_gasto(&self, id_gasto: &str, gasto: GastoData) -> AppResult<bool>;
    /// Elimina un gasto. `true` si borró fila.
    async fn eliminar_gasto(&self, id_gasto: &str) -> AppResult<bool>;

    /// Actualiza un pago (cobro). `true` si afectó fila.
    async fn actualizar_pago(&self, id_pago: &str, pago: PagoData) -> AppResult<bool>;
    /// Elimina un pago (y sus detalles). `true` si borró fila.
    async fn eliminar_pago(&self, id_pago: &str) -> AppResult<bool>;
}
