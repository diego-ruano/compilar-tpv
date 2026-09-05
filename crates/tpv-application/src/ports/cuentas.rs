//! Puerto de persistencia de cuentas (caja).

use async_trait::async_trait;

use tpv_contracts::cuentas::{EntradaDto, ResumenCajaDto, SalidaDto, TicketReimpresionDto};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::error::AppResult;

/// Lo que hace falta para anular un cobro, ya validado.
///
/// `id_usuario` **no** es opcional por capricho: el `CHECK` de `Pagos` exige que un cobro anulado
/// diga quién lo anuló, y ese quién sale de la sesión del backend (SEC-01), nunca de la entrada.
#[derive(Debug, Clone)]
pub struct AnularPagoArgs {
    pub id_pago: String,
    pub id_usuario: String,
    pub motivo: String,
}

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
    ///
    /// `id_usuario` es quién lo registra, y sale de la sesión del backend (SEC-01): va al
    /// historial de caja, no a la fila del gasto.
    async fn crear_gasto(
        &self,
        id: Option<String>,
        gasto: GastoData,
        id_usuario: Option<&str>,
    ) -> AppResult<bool>;
    /// Actualiza un gasto existente. `true` si afectó fila.
    async fn actualizar_gasto(&self, id_gasto: &str, gasto: GastoData) -> AppResult<bool>;
    /// Elimina un gasto. `true` si borró fila. `id_usuario`, como en `crear_gasto`.
    async fn eliminar_gasto(&self, id_gasto: &str, id_usuario: Option<&str>) -> AppResult<bool>;

    /// Actualiza un pago (cobro). `true` si afectó fila.
    async fn actualizar_pago(&self, id_pago: &str, pago: PagoData) -> AppResult<bool>;

    /// El estado de un cobro (`ACTIVO` / `ANULADO`), o `None` si no existe.
    ///
    /// Va aparte de `anular_pago` porque quien decide es el dominio (`puede_anularse`) y el caso
    /// de uso necesita el estado ANTES de pedir el cambio: el repositorio no puede quedarse con la
    /// regla o volvería a haber dos.
    async fn estado_pago(&self, id_pago: &str) -> AppResult<Option<String>>;

    /// Anula un cobro **sin borrarlo** (CUENTA-07): revierte stock y gasto del cliente, marca el
    /// pago y deja el movimiento en `Movimientos_Caja`. `true` si el pago existía.
    async fn anular_pago(&self, args: AnularPagoArgs) -> AppResult<bool>;

    /// Anota que alguien abrió el cajón SIN una venta detrás (para dar cambio, para cuadrar).
    /// No lo impide —el camarero lo necesita—: lo deja registrado, que es la única pista real
    /// cuando falta dinero. Las aperturas de un cobro no se anotan aquí: ya las cuenta su pago.
    async fn registrar_apertura_cajon(&self, id_usuario: Option<String>) -> AppResult<()>;

    /// Reconstruye un ticket ya cobrado para volver a imprimirlo (mismo número, marcado COPIA).
    /// `None` si el pago no existe.
    async fn ticket_para_reimprimir(&self, id_pago: &str) -> AppResult<Option<TicketReimpresionDto>>;
}
