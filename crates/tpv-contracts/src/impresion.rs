//! Contratos (DTOs) de la frontera UI<->Rust para imprimir: el ticket y el papel del arqueo.
//!
//! Vivían en `src-tauri/src/printing.rs` sin `#[derive(TS)]`, así que el frontend los redeclaraba
//! a mano, con el dinero como `number` (RI-53). El generador ESC/POS sigue allí; lo que cruza la
//! frontera vive aquí, como el resto de DTOs, y llega a TypeScript por ts-rs.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Una impresora detectada por el sistema.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Una línea (producto agrupado) del ticket.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PrintTicketLine {
    pub nombre: String,
    pub cantidad: u32,
    pub precio_unitario: Dinero,
    /// Tipo de IVA con el que se vendió esta línea. `None` = el general del negocio.
    /// Viene congelado de `Detalle_Comanda`, no del producto: una reimpresión tiene que enseñar
    /// el tipo del día de la venta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub iva_percent: Option<f64>,
}

/// Un tramo del desglose de IVA tal como sale en el papel. Gemelo de `tpv_domain::ticket::TramoIva`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TramoTicket {
    pub tipo: f64,
    pub base: Dinero,
    pub cuota: Dinero,
}

/// El cliente de una factura completa (`F1`/`F3`), tal como sale en el papel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DestinatarioTicket {
    pub nombre_razon: String,
    pub nif: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub domicilio: Option<String>,
}

/// Todo lo que lleva un papel: los datos del negocio, la personalización y el contenido.
///
/// **El ticket de un cobro lo compone Rust desde la base** (`ticket_de_pago`, RI-29): las líneas
/// de `Pago_Detalles`, y el número, la fecha, el QR, el desglose y el total del registro de
/// facturación. La pantalla lo recibe sólo para enseñarlo. Lo único que la pantalla compone es la
/// **precuenta**, y el comando que la imprime le quita todo lo fiscal (`como_precuenta`): un papel
/// con número no puede salir de lo que diga la pantalla.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PrintTicketPayload {
    /// Impresora destino; si es `None`, el comando resuelve la seleccionada en `device_config.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub printer_name: Option<String>,

    // ── Datos del negocio ──
    #[serde(default)]
    pub business_name: String,
    #[serde(default)]
    pub direccion: String,
    #[serde(default)]
    pub telefono: String,
    /// NIF del emisor. En una factura es el del registro (`NIF_Emisor`), no el de los ajustes de
    /// hoy: una reimpresión dice lo que se declaró.
    #[serde(default)]
    pub cif: String,
    /// Razón social del emisor (`Nombre_Razon_Emisor` en una factura). No es el rótulo
    /// (`business_name`) y, a diferencia de él, no se puede ocultar.
    #[serde(default)]
    pub razon_social: String,
    #[serde(default)]
    pub mensaje_footer: String,
    #[serde(default)]
    pub iva_percent: f64,

    // ── Flags de personalización ──
    // Sólo lo que una factura no exige (RI-29). El NIF, la fecha, las líneas, el desglose de IVA y
    // el total no tienen interruptor: salen siempre.
    #[serde(default)]
    pub show_logo: bool,
    /// Ruta relativa del logo en AppData (`images/…`) o un data URL heredado. La lee el comando,
    /// no el builder: aquí dentro no se toca el disco.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub logo_path: Option<String>,
    #[serde(default)]
    pub show_business_name: bool,
    #[serde(default)]
    pub show_address: bool,
    #[serde(default)]
    pub show_phone: bool,
    #[serde(default)]
    pub show_footer_message: bool,

    // ── Bloque fiscal (FISCAL-01) ───────────────────────────────────────────────────────────
    /// URL exacta que va dentro del código QR tributario. Sale de la fila de
    /// `Registros_Facturacion` (`QR_Url`), **no se compone aquí**: es la misma cadena que se
    /// guardó al emitir, y una reimpresión tiene que sacar exactamente esa.
    ///
    /// Vacío o ausente = este papel no lleva QR. Es el caso de la **precuenta**, que no es una
    /// factura, y el de un cobro de modo prueba.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub qr_url: Option<String>,
    /// `true` si el registro se emitió contra el entorno de **pruebas**. El QR apunta entonces a
    /// `prewww2.aeat.es` y el papel lo dice: un ticket de pruebas que parece real es peor que uno
    /// que no sale.
    #[serde(default)]
    pub qr_pruebas: bool,

    /// Ancho de papel en mm (58 / 80 / 112). Acota físicamente las columnas imprimibles.
    #[serde(default = "default_paper_width")]
    pub paper_width_mm: u32,

    // ── Parámetros finos de impresión (Ticket_Settings) ──
    /// DPI de la impresora (203 | 300). Convierte mm→dots para márgenes y ancho útil.
    #[serde(default = "default_paper_dpi")]
    pub paper_dpi: u32,
    /// Caracteres por línea deseados (fuente A). Se acota al ancho físico disponible.
    #[serde(default = "default_chars_per_line")]
    pub chars_per_line: u32,
    #[serde(default)]
    pub margin_top_mm: f64,
    #[serde(default)]
    pub margin_bottom_mm: f64,
    #[serde(default)]
    pub margin_left_mm: f64,
    #[serde(default)]
    pub margin_right_mm: f64,
    /// Escala de fuente (0.5–2.0). ≥1.5 imprime el cuerpo a doble alto (sin perder columnas).
    #[serde(default = "default_font_scale")]
    pub font_scale: f64,

    /// Número correlativo del ticket. `None` = **precuenta**: lo que se le enseña al cliente antes
    /// de cobrar, que no es un ticket de venta y se marca como tal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub numero_ticket: Option<String>,
    /// La fecha que se imprime (`DD/MM/AAAA HH:MM`). En una factura es la de expedición, leída
    /// del registro: una copia de mañana dice el día de la venta. `None` = ahora (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fecha: Option<String>,
    /// Cómo se cobró (`Efectivo` | `Tarjeta`). `None` en una precuenta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub metodo_pago: Option<String>,
    /// De dónde sale la venta: `Mesa 5`, `Barra`… Ayuda a localizar el cobro después.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origen: Option<String>,
    /// Reimpresión de un ticket ya emitido: sale el MISMO número, marcado como copia para que dos
    /// papeles iguales no parezcan dos ventas.
    #[serde(default)]
    pub es_copia: bool,
    /// El cobro está anulado (CUENTA-07). Reimprimirlo sigue permitido —es la prueba de qué
    /// contenía— pero el papel tiene que decirlo: sin la marca circularía como un cobro válido.
    #[serde(default)]
    pub es_anulado: bool,

    #[serde(default)]
    pub items: Vec<PrintTicketLine>,

    /// El desglose de IVA de la factura, leído de su `Desglose_Json`. Es el hecho fiscal: el papel
    /// dice lo que se declaró, no un recálculo. `None` = se calcula de las líneas (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub desglose: Option<Vec<TramoTicket>>,
    /// El `Importe_Total` de la factura. `None` = la suma de las líneas (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<Dinero>,

    /// `F1` | `F2` | `F3`. Una completa (`F1`/`F3`) sale titulada FACTURA y con su cliente.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tipo_factura: Option<String>,
    /// El cliente de una factura completa, leído de su registro.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub destinatario: Option<DestinatarioTicket>,
    /// En una `F3`, el número de la factura que sustituye.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sustituye: Option<String>,
    /// En una rectificativa, el número de la factura que rectifica (art. 7.1.h y 15.4 del RD
    /// 1619/2012: la referencia «expresa e inequívoca» de la factura rectificada).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rectifica: Option<String>,
    /// La fecha de expedición de la factura rectificada (`DD/MM/AAAA`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rectifica_fecha: Option<String>,
    /// Todas las facturas del cobro. **No se imprime**: la pantalla lo usa para ofrecer cada papel
    /// (el ticket, la `F3` del canje, la rectificativa de una devolución…).
    #[serde(default)]
    pub facturas_del_cobro: Vec<FacturaDelCobro>,
}

/// Una factura de un cobro, para elegir qué papel se imprime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct FacturaDelCobro {
    pub num_serie: String,
    /// `F1` | `F2` | `F3` | `R1`..`R5`.
    pub tipo_factura: String,
    pub importe: Dinero,
}

/// Qué ticket de cobro se pide (RI-29): el de un pago, leído entero de la base.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TicketDePagoInput {
    pub id_pago: String,
    /// Reimpresión: el papel sale marcado COPIA, con el mismo número.
    #[serde(default)]
    pub es_copia: bool,
    /// Otra factura del mismo pago: la `F3` que canjeó su ticket. `None` = la del número del pago.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub num_factura: Option<String>,
}

/// Geometría del papel para preguntar por las columnas desde el frontend (previsualización).
/// Es un subconjunto de [`PrintTicketPayload`]: la vista previa no necesita ni negocio ni líneas.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct GeometriaTicket {
    #[serde(default = "default_paper_width")]
    pub paper_width_mm: u32,
    #[serde(default = "default_chars_per_line")]
    pub chars_per_line: u32,
    #[serde(default)]
    pub margin_left_mm: f64,
    #[serde(default)]
    pub margin_right_mm: f64,
}

fn default_paper_width() -> u32 {
    80
}
fn default_paper_dpi() -> u32 {
    203
}
fn default_chars_per_line() -> u32 {
    42
}
fn default_font_scale() -> f64 {
    1.0
}

/// Una corrección de un cierre ya hecho, tal como sale en el papel (CAJA-01).
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct RectificacionArqueo {
    #[serde(default)]
    pub fecha_hora: String,
    #[serde(default)]
    pub descripcion: String,
    #[serde(default)]
    #[ts(optional)]
    pub motivo: Option<String>,
}

/// Lo que hace falta para imprimir un arqueo. CUENTA-06.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PrintArqueoPayload {
    #[serde(default)]
    #[ts(optional)]
    pub printer_name: Option<String>,
    #[serde(default)]
    pub business_name: String,
    #[serde(default)]
    pub fecha_hora: String,
    #[serde(default)]
    #[ts(optional)]
    pub desde: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub usuario: Option<String>,
    #[serde(default)]
    pub fondo_inicial: Dinero,
    #[serde(default)]
    pub ventas_efectivo: Dinero,
    #[serde(default)]
    pub esperado: Dinero,
    #[serde(default)]
    pub contado: Dinero,
    #[serde(default)]
    pub descuadre: Dinero,
    #[serde(default)]
    pub dejado: Dinero,
    #[serde(default)]
    pub retirado: Dinero,
    #[serde(default)]
    #[ts(optional)]
    pub motivo: Option<String>,
    /// Gastos pagados con dinero del cajón (CAJA-01). Restan del esperado.
    #[serde(default)]
    pub gastos_caja: Dinero,
    /// Lo que el cierre marca hoy, si se corrigió un apunte de su periodo (CAJA-01).
    #[serde(default)]
    #[ts(optional)]
    pub rect_esperado: Option<Dinero>,
    #[serde(default)]
    #[ts(optional)]
    pub rect_descuadre: Option<Dinero>,
    #[serde(default)]
    pub rectificaciones: Vec<RectificacionArqueo>,
    /// `(valor, unidades)` de lo contado, para el desglose. Las unidades de un recuento no pasan
    /// de 2^53, así que viajan como `number` y no como `bigint` (§4.3).
    #[serde(default)]
    #[ts(type = "Array<[Dinero, number]>")]
    pub contado_denoms: Vec<(Dinero, i64)>,
    // ── Formato del papel: los mismos ajustes que el ticket ──
    #[serde(default = "default_paper_width")]
    pub paper_width_mm: u32,
    #[serde(default = "default_paper_dpi")]
    pub paper_dpi: u32,
    #[serde(default = "default_chars_per_line")]
    pub chars_per_line: u32,
    #[serde(default)]
    pub margin_left_mm: f64,
    #[serde(default)]
    pub margin_right_mm: f64,
    #[serde(default)]
    pub margin_top_mm: f64,
    #[serde(default)]
    pub margin_bottom_mm: f64,
}
