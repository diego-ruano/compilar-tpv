//! Puerto de persistencia de cuentas (caja).

use async_trait::async_trait;

use tpv_contracts::cuentas::{EntradaDto, ResumenCajaDto, SalidaDto, TicketReimpresionDto};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::error::AppResult;

/// Filtros de listado de caja: rango, búsqueda de texto y paginación (`page`/`page_size` en `None`
/// => sin paginar, para exportaciones como el PDF).
#[derive(Debug, Clone, Default)]
pub struct CuentasFiltro {
    pub del: Option<String>,
    pub al: Option<String>,
    pub q: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[async_trait]
pub trait CuentasRepository: Send + Sync {
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<Vec<EntradaDto>>;
    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<Vec<SalidaDto>>;
    /// Resumen agregado de caja (totales por método y conteos) sobre todo el rango + búsqueda.
    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto>;

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

    /// Reconstruye un ticket ya cobrado para volver a imprimirlo (mismo número, marcado COPIA).
    /// `None` si el pago no existe.
    async fn ticket_para_reimprimir(&self, id_pago: &str) -> AppResult<Option<TicketReimpresionDto>>;
}
