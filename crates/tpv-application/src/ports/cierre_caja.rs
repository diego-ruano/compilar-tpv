//! Puerto de persistencia del **cierre de caja** (arqueo). CUENTA-06 · CAJA-01.

use tpv_domain::dinero::Dinero;
use async_trait::async_trait;

use tpv_contracts::cierre_caja::{CierreDto, CierreResumenDto};
use tpv_domain::cierre_caja::{Denominacion, TotalesCaja};

use crate::error::AppResult;

/// Qué clase de apunte de caja se está mirando. Los dos viven en tablas distintas y con formato de
/// fecha distinto (un cobro lleva hora, un gasto no).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApunteCaja {
    Pago,
    Gasto,
}

/// Un apunte de caja tal como está guardado, con lo que le hace falta al arqueo y a la frase que
/// describe su corrección.
#[derive(Debug, Clone)]
pub enum ApunteGuardado {
    Cobro {
        fecha_hora: String,
        importe: Dinero,
        metodo: String,
        activo: bool,
        numero_ticket: Option<String>,
    },
    Gasto {
        fecha: String,
        importe: Dinero,
        pagado_con_caja: bool,
        concepto: String,
    },
}

/// Todo lo que hace falta para guardar un cierre, ya calculado y validado por el dominio.
#[derive(Debug, Clone)]
pub struct CierreNuevo {
    pub id_cierre: String,
    pub id_usuario: Option<String>,
    /// La hora del cierre anterior, o `None` en el primero (CAJA-01).
    pub periodo_desde: Option<String>,
    pub fondo_inicial: Dinero,
    pub ventas_efectivo: Dinero,
    pub gastos_caja: Dinero,
    pub esperado: Dinero,
    pub contado: Dinero,
    pub descuadre: Dinero,
    pub dejado: Dinero,
    pub retirado: Dinero,
    pub motivo: Option<String>,
    pub contado_denoms: Vec<Denominacion>,
    pub dejado_denoms: Vec<Denominacion>,
}

/// El periodo que se va a cerrar, leído **dentro** de la transacción del cierre (RI-58).
#[derive(Debug, Clone)]
pub struct PeriodoAbierto {
    /// La hora del último cierre no reabierto, o `None` si es el primero.
    pub desde: Option<String>,
    /// Lo que dejó en el cajón ese cierre: el fondo de este.
    pub dejado_anterior: Option<Dinero>,
    /// Lo que entró y salió del cajón desde `desde` hasta la hora del cierre.
    pub totales: TotalesCaja,
}

/// Arma el cierre con lo que se ha leído del periodo: calcula y valida. Es dominio puro; el
/// repositorio sólo lo llama dentro de su transacción.
pub type ArmarCierre<'a> = &'a (dyn Fn(PeriodoAbierto) -> AppResult<CierreNuevo> + Send + Sync);

/// Una rectificación ya calculada, lista para guardar (CAJA-01).
#[derive(Debug, Clone)]
pub struct RectificacionNueva {
    pub id_cierre: String,
    pub id_usuario: Option<String>,
    pub descripcion: String,
    pub motivo: Option<String>,
    /// Los totales del periodo después del cambio.
    pub totales: TotalesCaja,
    pub esperado_antes: Dinero,
    pub esperado: Dinero,
    pub descuadre_antes: Dinero,
    pub descuadre: Dinero,
}

#[async_trait]
pub trait CierreCajaRepository: Send + Sync {
    /// El último cierre **no reabierto**, que es el que marca dónde empieza el periodo actual.
    ///
    /// Un cierre reabierto deja de contar como corte: por eso el "último" no es simplemente el de
    /// fecha más alta, sino el más reciente que siga cerrado.
    async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>>;

    /// Lo que entró y salió del cajón desde `desde` (exclusivo) hasta ahora: cobros en efectivo y
    /// gastos pagados con caja. `None` = desde el principio, que es lo que pasa en el primer cierre.
    async fn totales_desde(&self, desde: Option<&str>) -> AppResult<TotalesCaja>;

    /// Anulaciones del periodo (cuántas y por cuánto), contadas por la fecha en que se anularon.
    ///
    /// **No entra en el cálculo del arqueo**: el esperado sigue saliendo de los cobros activos, y
    /// sumar desde dos sitios distintos la misma cifra es cómo empiezan a divergir. Es una línea
    /// informativa — y es justamente el dato que no existía antes de CUENTA-07.
    async fn anulaciones_desde(&self, desde: Option<&str>) -> AppResult<(i64, Dinero)>;

    /// Cuántas comandas siguen abiertas. No impide cerrar: sólo se avisa.
    async fn comandas_abiertas(&self) -> AppResult<i64>;

    /// Cierra el periodo **en una sola transacción del escritor** (RI-58): lee el último cierre y
    /// los totales hasta la hora del cierre, deja que `armar` calcule y valide, y guarda el cierre
    /// con su doble recuento.
    ///
    /// - **Idempotente por `id_cierre`**: si ya existe, no hace nada. Una doble confirmación o un
    ///   reintento tras una respuesta perdida no crean un segundo arqueo.
    /// - La hora del cierre es también el límite de los totales: un cobro no puede quedar dentro del
    ///   periodo cerrado y fuera de sus cifras.
    async fn cerrar_periodo(&self, id_cierre: &str, armar: ArmarCierre<'_>) -> AppResult<()>;

    /// Histórico, de más reciente a más antiguo.
    async fn listar(&self, limite: i64) -> AppResult<Vec<CierreResumenDto>>;

    /// Un cierre con su desglose por denominación y sus rectificaciones.
    async fn detalle(&self, id_cierre: &str) -> AppResult<Option<CierreDto>>;

    /// Marca un cierre como reabierto. `true` si estaba cerrado y se ha reabierto.
    async fn reabrir(&self, id_cierre: &str, id_usuario: Option<&str>) -> AppResult<bool>;

    /// El cierre (no deshecho) cuyo periodo contiene este instante, o `None` si cae en el periodo
    /// abierto (CAJA-01).
    async fn cierre_de_momento(&self, momento: &str) -> AppResult<Option<CierreDto>>;

    /// Un apunte de caja tal como está guardado. `None` si no existe.
    async fn apunte(&self, tipo: ApunteCaja, id: &str) -> AppResult<Option<ApunteGuardado>>;

    /// Guarda lo que un cierre marca ahora y deja constancia de por qué (CAJA-01). La foto de esa
    /// noche no se toca.
    async fn guardar_rectificacion(&self, r: RectificacionNueva) -> AppResult<()>;

    /// Cuántas horas lleva abierto el periodo actual. Sin ningún cierre previo cuenta desde el
    /// cobro más antiguo; si no hay ni cobros, 0 (no hay nada que cerrar).
    ///
    /// Lo calcula la BD y no el llamante: es una resta de fechas, y hacerla en Rust obligaría a
    /// parsear el texto de la fecha para acabar en el mismo número.
    async fn horas_periodo_abierto(&self) -> AppResult<i64>;
}
