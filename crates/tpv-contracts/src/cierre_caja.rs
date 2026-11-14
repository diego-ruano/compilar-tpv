//! DTOs del **cierre de caja** (arqueo). CUENTA-06 · CAJA-01.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
/// Una moneda o billete del recuento.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DenominacionDto {
    pub valor: Dinero,
    pub unidades: i64,
}

/// Una corrección de un apunte que cambió los números de un cierre ya hecho (CAJA-01).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RectificacionDto {
    pub id_rectificacion: String,
    pub fecha_hora: String,
    /// Nombre de quien corrigió, resuelto al leer.
    pub usuario_nombre: Option<String>,
    /// Qué se tocó, en una frase: «Cobro 2026/000045 de 12,50 €: Efectivo → Tarjeta».
    pub descripcion: String,
    pub motivo: Option<String>,
    pub esperado_antes: Dinero,
    pub esperado_despues: Dinero,
    pub descuadre_antes: Dinero,
    pub descuadre_despues: Dinero,
}

/// Un cierre completo, con su doble recuento. Lo que pinta la ficha del histórico.
///
/// Las columnas de siempre son la **foto de esa noche** y no cambian nunca. Si después se corrige un
/// apunte de su periodo, lo que el cierre marca hoy va en los `rect_*` (CAJA-01).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CierreDto {
    pub id_cierre: String,
    pub fecha_hora: String,
    pub id_usuario: Option<String>,
    /// Nombre de quien cerró, resuelto al leer (la fila sólo guarda el id).
    pub usuario_nombre: Option<String>,
    pub fondo_inicial: Dinero,
    pub ventas_efectivo: Dinero,
    pub esperado: Dinero,
    pub contado: Dinero,
    pub descuadre: Dinero,
    pub dejado: Dinero,
    pub retirado: Dinero,
    pub motivo: Option<String>,
    /// `None` = el cierre sigue en pie (no se ha deshecho).
    pub reabierto_en: Option<String>,
    pub reabierto_por: Option<String>,
    /// Desde cuándo cuenta este cierre (exclusivo): la hora del cierre anterior. `None` en el
    /// primero. Es lo que dice a qué cierre pertenece un apunte que se corrige después.
    pub periodo_desde: Option<String>,
    /// Gastos pagados con dinero del cajón durante el periodo, tal como estaban al cerrar.
    #[serde(default)]
    pub gastos_caja: Dinero,
    /// Lo que el cierre marca hoy tras corregir apuntes de su periodo. `None` = nunca se ha
    /// rectificado.
    pub rect_ventas_efectivo: Option<Dinero>,
    pub rect_gastos_caja: Option<Dinero>,
    pub rect_esperado: Option<Dinero>,
    pub rect_descuadre: Option<Dinero>,
    pub contado_denoms: Vec<DenominacionDto>,
    pub dejado_denoms: Vec<DenominacionDto>,
    /// Cada corrección que cambió sus números, de la más antigua a la más reciente.
    #[serde(default)]
    pub rectificaciones: Vec<RectificacionDto>,
}

/// Una fila del histórico. Sin el desglose por denominación, que sólo se pide al abrir la ficha.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CierreResumenDto {
    pub id_cierre: String,
    pub fecha_hora: String,
    pub usuario_nombre: Option<String>,
    pub esperado: Dinero,
    pub contado: Dinero,
    pub descuadre: Dinero,
    pub retirado: Dinero,
    pub motivo: Option<String>,
    pub reabierto_en: Option<String>,
    /// CAJA-01: lo que marca hoy si se ha rectificado.
    pub rect_esperado: Option<Dinero>,
    pub rect_descuadre: Option<Dinero>,
}

/// Lo que la pantalla necesita saber **antes** de que nadie cuente nada.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PreparacionCierreDto {
    /// Desde cuándo está abierto el periodo. `None` = no hay ningún cierre previo, así que éste es
    /// el primero y la pantalla tiene que pedir además el fondo de partida.
    pub desde: Option<String>,
    /// `true` en el primer cierre de la vida del negocio.
    pub es_primer_cierre: bool,
    /// Lo que dejó el cierre anterior. En el primero es 0 y lo declara el usuario.
    pub fondo_inicial: Dinero,
    pub ventas_efectivo: Dinero,
    /// Gastos del periodo pagados con dinero del cajón (CAJA-01). Restan del esperado.
    pub gastos_caja: Dinero,
    pub esperado: Dinero,
    /// Comandas sin cobrar ahora mismo. No impide cerrar: se avisa y se sigue.
    pub comandas_abiertas: i64,
    /// A partir de cuánto descuadre hay que escribir un motivo.
    pub umbral_descuadre: Dinero,
    /// Cobros anulados durante este periodo. **No entran en el cálculo** (el esperado sale de los
    /// cobros activos, como siempre): es una línea informativa. Y es justo el dato que no existía
    /// antes de CUENTA-07 — un descuadre de 40 € junto a "3 anulaciones por 40 €" se explica solo.
    pub anulaciones: i64,
    pub anulaciones_importe: Dinero,
    /// DO-02 · El histórico de una recuperación que todavía se está descargando, cuando por eso el
    /// esperado puede salir corto: en el primer cierre, que suma desde el principio, y la
    /// recuperación sólo trajo lo reciente. Con un cierre anterior no pasa: la recuperación trae
    /// siempre todo lo que hay desde él. `None` = nada que avisar. **No impide cerrar.**
    pub historico_pendiente: Option<crate::sync::BackfillEstado>,
}

/// Cómo quedaría un cierre ya hecho si se hace un cambio (CAJA-01).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ImpactoCierreDto {
    pub id_cierre: String,
    pub fecha_hora: String,
    /// Lo que marca hoy: lo rectificado si lo hay, la foto de esa noche si no.
    pub esperado_antes: Dinero,
    pub esperado_despues: Dinero,
    pub descuadre_antes: Dinero,
    pub descuadre_despues: Dinero,
}

/// A qué cierres ya hechos afectaría un cambio de caja, para avisar antes de hacerlo.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ImpactoCajaDto {
    /// Vacío = el apunte es del periodo abierto: no hay nada que avisar.
    pub cierres: Vec<ImpactoCierreDto>,
    /// Algún descuadre cambia, así que el cambio necesita un motivo.
    pub requiere_motivo: bool,
}

/* =========================================================
   Entrada (args/inputs)
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct DenominacionInput {
    pub valor: Dinero,
    pub unidades: i64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ConfirmarCierreInput {
    /// El id del cierre, un UUID que genera la pantalla al abrir el arqueo (RI-58).
    ///
    /// Es lo que hace idempotente la confirmación: un doble clic o un reintento tras una respuesta
    /// que no llegó devuelven el cierre ya guardado en vez de crear otro con el periodo vacío.
    pub id_cierre: String,
    /// Sólo se usa en el primer cierre; en los demás manda el `dejado` del anterior y esto se
    /// ignora, para que nadie pueda reescribir el punto de partida a posteriori.
    #[serde(default)]
    pub fondo_inicial: Option<Dinero>,
    pub contado: Vec<DenominacionInput>,
    pub dejado: Vec<DenominacionInput>,
    #[serde(default)]
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CierreIdInput {
    pub id_cierre: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CierreListarArgs {
    #[serde(default)]
    pub limite: Option<i64>,
}

/// Un cambio de caja que todavía no se ha hecho, para saber a qué cierres afectaría (CAJA-01).
///
/// Lleva sólo lo que le importa al arqueo de cada apunte: la fecha, el método y el importe, y si un
/// gasto salió del cajón. El concepto o el proveedor no mueven ningún número.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "tipo", rename_all = "snake_case")]
pub enum CambioCajaInput {
    EditarPago {
        id_pago: String,
        fecha_hora: String,
        metodo: String,
    },
    AnularPago {
        id_pago: String,
        /// REV-08: `"ERROR"` o `"DEVOLUCION"`. De esto depende a qué cierre le toca el cambio, que
        /// es lo que la pantalla enseña antes de confirmar. Ausente = `"ERROR"`, como en
        /// `AnularPagoInput`.
        #[serde(default)]
        clase: Option<String>,
    },
    CrearGasto {
        fecha: String,
        importe: Dinero,
        pagado_con_caja: bool,
    },
    EditarGasto {
        id_gasto: String,
        fecha: String,
        importe: Dinero,
        pagado_con_caja: bool,
    },
    BorrarGasto {
        id_gasto: String,
    },
}
