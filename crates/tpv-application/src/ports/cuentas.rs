//! Puerto de persistencia de cuentas (caja).

use async_trait::async_trait;

use tpv_contracts::cuentas::{
    CursorCuentas, PaginaEntradas, PaginaSalidas, ResumenCajaDto,
};
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
    /// FISCAL-01: **cuál de los dos instrumentos legales** se está usando. Son distintos y generan
    /// registros de facturación distintos; ver [`ClaseBaja`].
    pub clase: ClaseBaja,
}

/// Por qué un cobro deja de contar. Son **dos cosas distintas** y el registro que generan no es el
/// mismo — hasta FISCAL-01 salían por el mismo botón, y la que más se usa no era la que el botón
/// decía.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClaseBaja {
    /// **La venta no existió**: un ticket de prueba, una formación, una mesa equivocada, un cobro
    /// que nunca debió emitirse. Genera un **RF de anulación** (art. 11.1 RRSIF), que no borra nada
    /// —el registro erróneo y el de anulación se conservan y se remiten los dos— y devuelve las
    /// líneas a la comanda.
    ///
    /// La AEAT avisa en su FAQ de desarrolladores de que estos casos deben ser *«MUY POCO
    /// FRECUENTES»*.
    #[default]
    Error,
    /// **La venta existió** y se devuelve el dinero (o se corrige el importe). Genera una **factura
    /// rectificativa** (RF de alta `R5` con `TipoRectificativa = I` e importe negativo), y las
    /// líneas **no** vuelven a la comanda: se vendieron. El stock sí se repone, como en un error:
    /// lo devuelto vuelve al almacén.
    ///
    /// La AEAT lo dice sin matices: *«todas las facturas emitidas, en la medida en que respondan a
    /// operaciones realmente efectuadas (como es el caso habitual) no pueden anularse»*.
    Devolucion,
}

impl ClaseBaja {
    /// Valor que se guarda en `Pagos.Motivo_Baja`.
    pub fn wire(self) -> &'static str {
        match self {
            ClaseBaja::Error => "ERROR",
            ClaseBaja::Devolucion => "DEVOLUCION",
        }
    }

    /// Lee lo que llega del frontend. Cualquier cosa que no sea exactamente `"DEVOLUCION"` es una
    /// anulación por error, que es el comportamiento que había antes de FISCAL-01: un cliente
    /// antiguo que no manda el campo sigue haciendo lo que hacía.
    pub fn desde_texto(s: Option<&str>) -> Self {
        match s.map(str::trim) {
            Some(v) if v.eq_ignore_ascii_case("DEVOLUCION") => ClaseBaja::Devolucion,
            _ => ClaseBaja::Error,
        }
    }

    /// ¿Las líneas vuelven a la comanda?
    ///
    /// Sólo si la venta no existió. En una devolución se vendieron de verdad: devolverlas a la mesa
    /// las dejaría pendientes de cobro y el camarero las volvería a cobrar.
    pub fn devuelve_las_lineas(self) -> bool {
        matches!(self, ClaseBaja::Error)
    }
}

/// Filtros de listado de caja: rango, búsqueda de texto y paginación por clave (`page_size` en
/// `None` => sin paginar, para exportaciones como el PDF; `cursor` en `None` => primera página).
#[derive(Debug, Clone, Default)]
pub struct CuentasFiltro {
    pub del: Option<String>,
    pub al: Option<String>,
    pub q: Option<String>,
    pub page_size: Option<u32>,
    pub cursor: Option<CursorCuentas>,
}

#[async_trait]
pub trait CuentasRepository: Send + Sync {
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<PaginaEntradas>;
    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<PaginaSalidas>;
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

    /// Anula un cobro **sin borrarlo** (CUENTA-07): repone el stock y resta el gasto del cliente
    /// (las dos clases), marca el pago y deja el movimiento en `Movimientos_Caja`. `true` si el
    /// pago existía.
    async fn anular_pago(&self, args: AnularPagoArgs) -> AppResult<bool>;

    /// Anota que alguien abrió el cajón SIN una venta detrás (para dar cambio, para cuadrar).
    /// No lo impide —el camarero lo necesita—: lo deja registrado, que es la única pista real
    /// cuando falta dinero. Las aperturas de un cobro no se anotan aquí: ya las cuenta su pago.
    async fn registrar_apertura_cajon(&self, id_usuario: Option<String>) -> AppResult<()>;
}
