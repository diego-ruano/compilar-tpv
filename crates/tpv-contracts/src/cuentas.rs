//! Contratos (DTOs) de la frontera UI<->Rust para **cuentas** (caja).
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use tpv_domain::dinero::Dinero;

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
    pub importe: Dinero,
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
    /// Es la devolución de parte de otro cobro: un pago negativo. Se reimprime, pero no se
    /// factura, ni se edita, ni se da de baja por separado.
    #[serde(default)]
    pub es_devolucion: bool,
    /// Lo que se ha devuelto de este cobro con devoluciones parciales vigentes, en positivo. Cero
    /// si no tiene ninguna.
    #[serde(default)]
    pub devuelto: Dinero,
    /// El motivo de una devolución.
    #[serde(default)]
    #[ts(optional)]
    pub motivo_devolucion: Option<String>,
}

/// Dónde empieza la página siguiente de un listado de caja: la clave de orden de la ÚLTIMA fila de
/// la página actual. Paginar por clave y no por `OFFSET` (RI-18) es lo que hace que la página 100 de
/// un año cueste lo mismo que la primera: con `OFFSET` había que leer y descartar todo lo anterior.
///
/// `fecha` es la columna de orden tal cual (`Pagos.Fecha_Hora` con segundos, `Cuentas_Gastos.Fecha`
/// sólo el día), no la que se enseña (`fecha_hora`, recortada): con la recortada, dos cobros del
/// mismo minuto no tendrían un orden estable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CursorCuentas {
    pub fecha: String,
    pub id: String,
}

/// Una página de entradas. `siguiente` es `None` cuando no hay más filas (o no se pidió paginar).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PaginaEntradas {
    pub filas: Vec<EntradaDto>,
    pub siguiente: Option<CursorCuentas>,
}

/// Una página de salidas. Ver [`PaginaEntradas`].
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PaginaSalidas {
    pub filas: Vec<SalidaDto>,
    pub siguiente: Option<CursorCuentas>,
}

/// Fila de salidas (gastos).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SalidaDto {
    pub id: String,
    pub fecha_hora: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: Dinero,
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
    /// Tamaño de página. `None`/0 = sin paginar: se devuelven **todas** las filas (el PDF).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub page_size: Option<u32>,
    /// La página empieza justo después de esta fila (el `siguiente` de la página anterior, ver
    /// [`CursorCuentas`]). Van planos y no como un objeto porque hacia el worker viajan como
    /// parámetros de la URL. Sin los dos, es la primera página.
    #[serde(default)]
    #[ts(optional)]
    pub cursor_fecha: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub cursor_id: Option<String>,
}

impl CuentasRangoArgs {
    /// El cursor, si vienen sus dos partes (una sola no sirve para nada: se ignora).
    pub fn cursor(&self) -> Option<CursorCuentas> {
        match (&self.cursor_fecha, &self.cursor_id) {
            (Some(fecha), Some(id)) if !fecha.trim().is_empty() && !id.trim().is_empty() => {
                Some(CursorCuentas { fecha: fecha.clone(), id: id.clone() })
            }
            _ => None,
        }
    }
}

/// Resumen agregado de caja para un rango (+ búsqueda opcional). Se calcula en SQL sobre TODO el
/// rango, de modo que las cifras de cabecera son correctas aunque la lista esté paginada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ResumenCajaDto {
    pub total_entradas: Dinero,
    pub total_salidas: Dinero,
    pub total_efectivo: Dinero,
    pub total_tarjeta: Dinero,
    #[ts(type = "number")]
    pub count_entradas: i64,
    #[ts(type = "number")]
    pub count_salidas: i64,
    /// Cobros anulados del rango. **No entran en los totales de arriba** y por eso viajan aparte:
    /// un cobro anulado no es una venta, pero cuántos hay y por cuánto importe es exactamente el
    /// dato que no existía y que hace visible la sisa (CUENTA-07).
    #[ts(type = "number")]
    pub count_anuladas: i64,
    pub total_anulado: Dinero,
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
    pub importe: Dinero,
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
    pub importe: Dinero,
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
    pub importe: Dinero,
}

/// Una línea de un cobro, con lo que queda por devolver de ella.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaDevolubleDto {
    pub id_detalle: String,
    pub nombre: String,
    /// Las unidades que se cobraron (al peso, fraccionarias).
    pub cantidad: f64,
    /// Las que ya se devolvieron.
    pub devueltas: f64,
    pub precio_unitario: Dinero,
}

/// Un cobro visto para devolver parte de él.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CobroDevolubleDto {
    pub id_pago: String,
    #[ts(optional)]
    pub numero_ticket: Option<String>,
    /// El método del cobro: el que la pantalla propone para devolver.
    pub metodo: String,
    pub importe: Dinero,
    /// Lo ya devuelto por devoluciones parciales vigentes, en positivo.
    pub devuelto: Dinero,
    pub lineas: Vec<LineaDevolubleDto>,
}

/// Unas unidades de una línea que se devuelven.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaADevolverInput {
    pub id_detalle: String,
    pub cantidad: f64,
}

/// Devolver parte de un cobro. Como al anular, **no lleva quién**: sale de la sesión (SEC-01).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DevolverLineasInput {
    pub id_pago: String,
    pub lineas: Vec<LineaADevolverInput>,
    /// Por dónde sale el dinero: `Efectivo`, `Tarjeta` u `Otro`. Sólo el efectivo resta del
    /// arqueo.
    pub metodo: String,
    #[serde(default)]
    #[ts(optional)]
    pub motivo: Option<String>,
}

/// La devolución hecha: el pago negativo que la registra y su factura rectificativa, si la hay
/// (un cobro de modo prueba no tiene ninguna que rectificar).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DevolucionDto {
    pub id_pago: String,
    /// En negativo, como el pago.
    pub importe: Dinero,
    #[ts(optional)]
    pub num_factura: Option<String>,
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
