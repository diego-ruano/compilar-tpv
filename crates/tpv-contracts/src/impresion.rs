//! Contratos (DTOs) de la frontera UI<->Rust para imprimir: el ticket y el papel del arqueo.
//!
//! Vivían en `src-tauri/src/printing.rs` sin `#[derive(specta::Type)]`, así que el frontend los redeclaraba
//! a mano, con el dinero como `number` (RI-53). El generador ESC/POS sigue allí; lo que cruza la
//! frontera vive aquí, como el resto de DTOs, y llega a TypeScript con Specta (`pnpm generate-types`).

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
/// Una impresora detectada por el sistema.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Una línea (producto agrupado) del ticket.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PrintTicketLine {
    pub nombre: String,
    pub cantidad: u32,
    pub precio_unitario: Dinero,
    /// Tipo de IVA con el que se vendió esta línea. `None` = el general del negocio.
    /// Viene congelado de `Detalle_Comanda`, no del producto: una reimpresión tiene que enseñar
    /// el tipo del día de la venta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iva_percent: Option<f64>,
}

/// Un tramo del desglose de IVA tal como sale en el papel. Gemelo de `tpv_domain::ticket::TramoIva`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct TramoTicket {
    pub tipo: f64,
    pub base: Dinero,
    pub cuota: Dinero,
}

/// El cliente de una factura completa (`F1`/`F3`), tal como sale en el papel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DestinatarioTicket {
    pub nombre_razon: String,
    pub nif: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domicilio: Option<String>,
}

/// Todo lo que lleva un papel: los datos del negocio, la personalización y el contenido.
///
/// **El ticket de un cobro lo compone Rust desde la base** (`ticket_de_pago`, RI-29): las líneas
/// de `Pago_Detalles`, y el número, la fecha, el desglose y el total del registro de
/// facturación. La pantalla lo recibe sólo para enseñarlo. Lo único que la pantalla compone es la
/// **precuenta**, y el comando que la imprime le quita todo lo fiscal (`como_precuenta`): un papel
/// con número no puede salir de lo que diga la pantalla.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PrintTicketPayload {
    /// Impresora destino; si es `None`, el comando resuelve la seleccionada en `device_config.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub logo_path: Option<String>,
    #[serde(default)]
    pub show_business_name: bool,
    #[serde(default)]
    pub show_address: bool,
    #[serde(default)]
    pub show_phone: bool,
    #[serde(default)]
    pub show_footer_message: bool,

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
    pub numero_ticket: Option<String>,
    /// La fecha que se imprime (`DD/MM/AAAA HH:MM`). En una factura es la de expedición, leída
    /// del registro: una copia de mañana dice el día de la venta. `None` = ahora (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fecha: Option<String>,
    /// Cómo se cobró (`Efectivo` | `Tarjeta`). `None` en una precuenta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metodo_pago: Option<String>,
    /// De dónde sale la venta: `Mesa 5`, `Barra`… Ayuda a localizar el cobro después.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origen: Option<String>,
    /// Reimpresión de un ticket ya emitido: sale el MISMO número, marcado como copia para que dos
    /// papeles iguales no parezcan dos ventas.
    #[serde(default)]
    pub es_copia: bool,
    /// El cobro está anulado (CUENTA-07). Reimprimirlo sigue permitido —es la prueba de qué
    /// contenía— pero el papel tiene que decirlo: sin la marca circularía como un cobro válido.
    #[serde(default)]
    pub es_anulado: bool,
    /// Si el papel lleva el pulso que abre el cajón. Sólo el ticket ORIGINAL de un cobro en
    /// efectivo, que es cuando hay que meter el dinero y dar el cambio: ni una copia, ni la `F3` de
    /// un canje, ni una rectificativa, ni una precuenta. Lo decide `ticket_de_pago`, no el
    /// generador.
    #[serde(default)]
    pub abre_cajon: bool,

    #[serde(default)]
    pub items: Vec<PrintTicketLine>,

    /// El desglose de IVA de la factura, leído de su `Desglose_Json`. Es el hecho fiscal: el papel
    /// dice lo que se declaró, no un recálculo. `None` = se calcula de las líneas (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desglose: Option<Vec<TramoTicket>>,
    /// El `Importe_Total` de la factura. `None` = la suma de las líneas (la precuenta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<Dinero>,

    /// `F1` | `F2` | `F3`. Una completa (`F1`/`F3`) sale titulada FACTURA y con su cliente.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tipo_factura: Option<String>,
    /// El cliente de una factura completa, leído de su registro.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destinatario: Option<DestinatarioTicket>,
    /// En una `F3`, los números de las facturas que sustituye: el ticket que canjea, los de un
    /// canje de varios o, tras una devolución, la rectificativa.
    #[serde(default)]
    pub sustituye: Vec<String>,
    /// En una rectificativa, el número de la factura que rectifica (art. 7.1.h y 15.4 del RD
    /// 1619/2012: la referencia «expresa e inequívoca» de la factura rectificada).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rectifica: Option<String>,
    /// La fecha de expedición de la factura rectificada (`DD/MM/AAAA`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rectifica_fecha: Option<String>,
    /// Todas las facturas del cobro. **No se imprime**: la pantalla lo usa para ofrecer cada papel
    /// (el ticket, la `F3` del canje, la rectificativa de una devolución…).
    #[serde(default)]
    pub facturas_del_cobro: Vec<FacturaDelCobro>,
}

/// Una factura de un cobro, para elegir qué papel se imprime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct FacturaDelCobro {
    pub num_serie: String,
    /// `F1` | `F2` | `F3` | `R1`..`R5`.
    pub tipo_factura: String,
    pub importe: Dinero,
    /// En una `F3` en negativo, qué contrarresta: hay tres que se emiten así y la pantalla tiene
    /// que llamar a cada una por lo que es. `None` en todas las demás.
    pub contrarresta: Option<F3Negativa>,
}

/// Por qué se emitió una `F3` en negativo. Se deduce de lo que sustituye.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum F3Negativa {
    /// Sustituye a la rectificativa (`R5`) de una devolución de un ticket canjeado: es la factura
    /// completa de la devolución, con el cliente (FAQ de la AEAT, apartado 27, casos 2 y 3).
    Devolucion,
    /// Contrarresta una `F3` con los datos del cliente mal; tras ella va la buena con los mismos
    /// tickets (FISCAL-02). No sale dinero.
    CorreccionDeDatos,
    /// Saca de una `F3` de varios tickets el de un cobro dado de baja por error: los demás siguen
    /// siendo ventas y esa `F3` no se puede anular.
    BajaPorError,
}

/// Qué ticket de cobro se pide (RI-29): el de un pago, leído entero de la base.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TicketDePagoInput {
    pub id_pago: String,
    /// Reimpresión: el papel sale marcado COPIA, con el mismo número.
    #[serde(default)]
    pub es_copia: bool,
    /// Otra factura del mismo pago: la `F3` que canjeó su ticket. `None` = la del número del pago.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_factura: Option<String>,
}

/// Geometría del papel para preguntar por las columnas desde el frontend (previsualización).
/// Es un subconjunto de [`PrintTicketPayload`]: la vista previa no necesita ni negocio ni líneas.
#[derive(Debug, Clone, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
pub struct RectificacionArqueo {
    #[serde(default)]
    pub fecha_hora: String,
    #[serde(default)]
    pub descripcion: String,
    #[serde(default)]
    pub motivo: Option<String>,
}

/// Lo que hace falta para imprimir un arqueo. CUENTA-06.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
pub struct PrintArqueoPayload {
    #[serde(default)]
    pub printer_name: Option<String>,
    #[serde(default)]
    pub business_name: String,
    #[serde(default)]
    pub fecha_hora: String,
    #[serde(default)]
    pub desde: Option<String>,
    #[serde(default)]
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
    pub motivo: Option<String>,
    /// Gastos pagados con dinero del cajón (CAJA-01). Restan del esperado.
    #[serde(default)]
    pub gastos_caja: Dinero,
    /// Lo que el cierre marca hoy, si se corrigió un apunte de su periodo (CAJA-01).
    #[serde(default)]
    pub rect_esperado: Option<Dinero>,
    #[serde(default)]
    pub rect_descuadre: Option<Dinero>,
    #[serde(default)]
    pub rectificaciones: Vec<RectificacionArqueo>,
    /// `(valor, unidades)` de lo contado, para el desglose. Las unidades de un recuento no pasan
    /// de 2^53, así que viajan como `number` y no como `bigint` (§4.3).
    #[serde(default)]
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
