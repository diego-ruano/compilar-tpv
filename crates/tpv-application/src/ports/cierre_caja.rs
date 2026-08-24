//! Puerto de persistencia del **cierre de caja** (arqueo). CUENTA-06.

use async_trait::async_trait;

use tpv_contracts::cierre_caja::{CierreDto, CierreResumenDto};
use tpv_domain::cierre_caja::Denominacion;

use crate::error::AppResult;

/// Qué clase de apunte de caja se está mirando. Los dos viven en tablas distintas y con formato de
/// fecha distinto (un cobro lleva hora, un gasto no).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApunteCaja {
    Pago,
    Gasto,
}

/// Todo lo que hace falta para guardar un cierre, ya calculado y validado por el dominio.
#[derive(Debug, Clone)]
pub struct CierreNuevo {
    pub id_cierre: String,
    pub id_usuario: Option<String>,
    pub fondo_inicial: f64,
    pub ventas_efectivo: f64,
    pub esperado: f64,
    pub contado: f64,
    pub descuadre: f64,
    pub dejado: f64,
    pub retirado: f64,
    pub motivo: Option<String>,
    pub contado_denoms: Vec<Denominacion>,
    pub dejado_denoms: Vec<Denominacion>,
}

#[async_trait]
pub trait CierreCajaRepository: Send + Sync {
    /// El último cierre **no reabierto**, que es el que marca dónde empieza el periodo actual.
    ///
    /// Un cierre reabierto deja de contar como corte: por eso el "último" no es simplemente el de
    /// fecha más alta, sino el más reciente que siga cerrado.
    async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>>;

    /// Cobros en efectivo desde `desde` (exclusivo) hasta ahora. `None` = desde el principio de los
    /// tiempos, que es lo que pasa en el primer cierre.
    async fn ventas_efectivo_desde(&self, desde: Option<&str>) -> AppResult<f64>;

    /// Cuántas comandas siguen abiertas. No impide cerrar: sólo se avisa.
    async fn comandas_abiertas(&self) -> AppResult<i64>;

    /// Guarda el cierre y su doble recuento.
    async fn crear(&self, cierre: CierreNuevo) -> AppResult<()>;

    /// Histórico, de más reciente a más antiguo.
    async fn listar(&self, limite: i64) -> AppResult<Vec<CierreResumenDto>>;

    /// Un cierre con su desglose por denominación.
    async fn detalle(&self, id_cierre: &str) -> AppResult<Option<CierreDto>>;

    /// Marca un cierre como reabierto. `true` si estaba cerrado y se ha reabierto.
    async fn reabrir(&self, id_cierre: &str, id_usuario: Option<&str>) -> AppResult<bool>;

    /// Fecha de un apunte de caja, para saber si cae dentro de un periodo cerrado.
    ///
    /// Hace falta porque un borrado sólo trae el id: sin esto, el gate no tendría contra qué
    /// comparar y habría que fiarse de que la pantalla mande la fecha correcta, que es justo lo que
    /// un gate no puede hacer.
    async fn fecha_apunte(&self, tipo: ApunteCaja, id: &str) -> AppResult<Option<String>>;

    /// Fecha del corte vigente: la del último cierre no reabierto, o `None` si no hay ninguno.
    ///
    /// Es lo que consulta el gate `periodo_cerrado` antes de dejar tocar un cobro o un gasto. Va
    /// aparte de `ultimo_cierre` porque esa comprobación se hace en cada escritura de caja y sólo
    /// necesita una fecha, no la fila entera.
    async fn corte_vigente(&self) -> AppResult<Option<String>>;
}
