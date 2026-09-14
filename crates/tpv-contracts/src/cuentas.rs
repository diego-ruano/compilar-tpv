//! Contratos (DTOs) de la frontera UI<->Rust para **cuentas** (caja).
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Fila de entradas (cobros). `id` es String (igual que el backend antiguo).
///
/// Los cobros anulados **salen en esta lista** (CUENTA-07): es el único sitio donde se investiga un
/// descuadre, y ahí esconderlos sería devolver el producto al estado que este cambio arregla. Lo
/// que no hacen es contar en los totales de cabecera (ver `ResumenCajaDto`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EntradaDto {
    pub id: String,
    pub fecha_hora: String,
    pub cliente: String,
    pub metodo: String,
    pub importe: f64,
    /// `ACTIVO` o `ANULADO`.
    pub estado: String,
    #[ts(optional)]
    pub anulado_en: Option<String>,
    /// Nombre de quien anuló, resuelto al leer (la fila sólo guarda el id). Es el dato por el que
    /// se pregunta cuando falta dinero, así que no puede quedarse en un UUID.
    #[ts(optional)]
    pub anulado_por: Option<String>,
    #[ts(optional)]
    pub motivo_anulacion: Option<String>,
}

/// Una línea de un ticket ya cobrado, tal y como hace falta para reimprimirlo.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaTicketDto {
    pub nombre: String,
    /// Unidades vendidas en esa línea. La copia tiene que decir "2 x 1,30" igual que el original,
    /// no "1 x 2,60": el importe cuadraría, pero no sería el mismo papel.
    pub cantidad: f64,
    pub precio_unitario: f64,
    /// Tipo de IVA con el que se vendió, congelado en la línea. `None` = el del negocio.
    #[ts(optional)]
    pub iva_percent: Option<f64>,
}

/// Todo lo que hace falta para volver a sacar un ticket ya cobrado.
///
/// Se lee del cobro guardado, no se recalcula: el número es el del original y los tipos de IVA son
/// los del día de la venta. Es lo que hace que la copia sea una copia y no un ticket nuevo con los
/// datos de hoy.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TicketReimpresionDto {
    /// Número del ticket original. Vacío en cobros anteriores a la numeración.
    pub numero_ticket: String,
    pub metodo_pago: String,
    /// `Mesa 5` / `Barra`.
    pub origen: String,
    pub lineas: Vec<LineaTicketDto>,
    /// El cobro está anulado: la copia sale marcada como tal. Reimprimirlo sigue permitido —es la
    /// prueba de qué contenía— pero un papel que no lo diga circularía como un cobro válido.
    pub anulado: bool,
}

/// Fila de salidas (gastos).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SalidaDto {
    pub id: String,
    pub fecha_hora: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    pub proveedor_id: Option<String>,
    /// El dinero salió del cajón (CAJA-01). Sólo estos gastos restan del esperado del arqueo.
    #[serde(default)]
    pub pagado_con_caja: bool,
}

/* ── Args/Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CuentasRangoArgs {
    #[serde(default)]
    #[ts(optional)]
    pub del: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub al: Option<String>,
    /// Búsqueda de texto (server-side): filtra por fecha/cliente/concepto/método/importe.
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
    /// Página 1-based. Si es `None`, se devuelven **todas** las filas (usado por el PDF).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub page: Option<u32>,
    /// Tamaño de página. Si es `None`/0 junto con `page`, se ignora la paginación.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub page_size: Option<u32>,
}

/// Resumen agregado de caja para un rango (+ búsqueda opcional). Se calcula en SQL sobre TODO el
/// rango, de modo que las cifras de cabecera son correctas aunque la lista esté paginada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ResumenCajaDto {
    pub total_entradas: f64,
    pub total_salidas: f64,
    pub total_efectivo: f64,
    pub total_tarjeta: f64,
    #[ts(type = "number")]
    pub count_entradas: i64,
    #[ts(type = "number")]
    pub count_salidas: i64,
    /// Cobros anulados del rango. **No entran en los totales de arriba** y por eso viajan aparte:
    /// un cobro anulado no es una venta, pero cuántos hay y por cuánto importe es exactamente el
    /// dato que no existía y que hace visible la sisa (CUENTA-07).
    #[ts(type = "number")]
    pub count_anuladas: i64,
    pub total_anulado: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CreateGastoInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_gasto: Option<String>,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional)]
    pub proveedor_id: Option<String>,
    /// CAJA-01: el gasto se pagó con dinero del cajón. Ausente = no.
    #[serde(default)]
    #[ts(optional)]
    pub pagado_con_caja: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdateGastoInput {
    pub id_gasto: String,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional)]
    pub proveedor_id: Option<String>,
    /// CAJA-01: el gasto se pagó con dinero del cajón. Ausente = no.
    #[serde(default)]
    #[ts(optional)]
    pub pagado_con_caja: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeleteGastoInput {
    pub id_gasto: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdatePagoInput {
    pub id_pago: String,
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,
}

/// Anular un cobro (CUENTA-07). **No lleva `id_usuario`**: quién anula sale de la sesión del
/// backend (SEC-01). Una anulación firmada con el nombre que le pase la pantalla es una auditoría
/// que da confianza sin merecerla.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AnularPagoInput {
    pub id_pago: String,
    /// Obligatorio. Quién y cuándo los pone el sistema; el porqué sólo puede ponerlo quien anula.
    #[serde(default)]
    #[ts(optional)]
    pub motivo: Option<String>,
    /// FISCAL-01: `"ERROR"` (la venta no existió → RF de anulación) o `"DEVOLUCION"` (la venta
    /// existió y se devuelve el dinero → factura rectificativa `R5`).
    ///
    /// Ausente = `"ERROR"`, que es lo que hacía este comando antes de FISCAL-01. Son dos
    /// instrumentos legales distintos y la pantalla tiene que explicar la diferencia en una frase,
    /// no ofrecer dos botones parecidos.
    #[serde(default)]
    #[ts(optional)]
    pub clase: Option<String>,
}
