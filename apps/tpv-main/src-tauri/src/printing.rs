//! Servicio de impresión (host/OS) — fuera de la arquitectura hexagonal a propósito.
//!
//! Es una preocupación de hardware/SO (como `save_image` en `main.rs`), no lógica de negocio,
//! así que NO pasa por las crates `tpv-*`. Habla directamente con la **API de Windows**
//! (winspool) por FFI:
//!   - `list_printers()`  → `EnumPrintersW` (locales + conexiones de red/WiFi) + impresora por
//!     defecto vía `GetDefaultPrinterW`.
//!   - `print_raw()`      → `OpenPrinterW` + `StartDocPrinterW` (datatype "RAW") + `WritePrinter`,
//!     es decir: Windows hace de puente y manda los bytes tal cual a la impresora.
//!
//! Además construye el ticket en **ESC/POS** (`build_ticket`) replicando la personalización del
//! front (`PreviewModal`): qué elementos se muestran, ancho de papel, IVA, líneas, total, footer.

use serde::{Deserialize, Serialize};
use tpv_domain::ticket::{LineaTicket, TramoIva};

/// Una impresora detectada por el sistema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterInfo {
    pub name: String,
    pub is_default: bool,
}

/// Una línea (producto agrupado) del ticket.
#[derive(Debug, Clone, Deserialize)]
pub struct PrintTicketLine {
    pub nombre: String,
    pub cantidad: u32,
    pub precio_unitario: f64,
    /// Tipo de IVA con el que se vendió esta línea. `None` = el general del negocio.
    /// Viene congelado de `Detalle_Comanda`, no del producto: una reimpresión tiene que enseñar
    /// el tipo del día de la venta.
    #[serde(default)]
    pub iva_percent: Option<f64>,
    /// FISCAL-01: la línea se vendió EXENTA de IVA, que no es lo mismo que vendida al 0 %. Va
    /// congelada como el tipo, y por lo mismo.
    #[serde(default)]
    pub exento: bool,
    /// `E1`..`E6`. Sólo se mira si `exento`.
    #[serde(default)]
    pub causa_exencion: Option<String>,
}

/// Payload de impresión enviado desde el frontend. Lleva los datos del negocio + los flags de
/// personalización del ticket (mismos que `useBusinessSettings`/`useTicketSettings`) para que el
/// builder ESC/POS produzca exactamente lo que el usuario ve en la previsualización.
#[derive(Debug, Clone, Deserialize)]
pub struct PrintTicketPayload {
    /// Impresora destino; si es `None`, el comando resuelve la seleccionada en `device_config.json`.
    #[serde(default)]
    pub printer_name: Option<String>,

    // ── Datos del negocio ──
    #[serde(default)]
    pub business_name: String,
    #[serde(default)]
    pub direccion: String,
    #[serde(default)]
    pub telefono: String,
    #[serde(default)]
    pub cif: String,
    #[serde(default)]
    pub mensaje_footer: String,
    #[serde(default)]
    pub iva_percent: f64,

    // ── Flags de personalización ──
    #[serde(default)]
    pub show_logo: bool,
    /// Ruta relativa del logo en AppData (`images/…`) o un data URL heredado. La lee el comando,
    /// no el builder: aquí dentro no se toca el disco.
    #[serde(default)]
    pub logo_path: Option<String>,
    #[serde(default)]
    pub show_business_name: bool,
    #[serde(default)]
    pub show_address: bool,
    #[serde(default)]
    pub show_phone: bool,
    #[serde(default)]
    pub show_cif: bool,
    #[serde(default)]
    pub show_date_time: bool,
    #[serde(default)]
    pub show_line_items: bool,
    #[serde(default)]
    pub show_base_and_iva: bool,
    #[serde(default)]
    pub show_total: bool,
    #[serde(default)]
    pub show_footer_message: bool,

    // ── Bloque fiscal (FISCAL-01) ───────────────────────────────────────────────────────────
    /// URL exacta que va dentro del código QR tributario. Sale de la fila de
    /// `Registros_Facturacion` (`QR_Url`), **no se compone aquí**: es la misma cadena que se
    /// guardó al emitir, y una reimpresión tiene que sacar exactamente esa.
    ///
    /// Vacío o ausente = este papel no lleva QR. Es el caso de la **precuenta**, que no es una
    /// factura, y el de un ticket emitido antes de que el negocio completara sus datos fiscales.
    #[serde(default)]
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
    #[serde(default)]
    pub numero_ticket: Option<String>,
    /// Cómo se cobró (`Efectivo` | `Tarjeta`). `None` en una precuenta.
    #[serde(default)]
    pub metodo_pago: Option<String>,
    /// De dónde sale la venta: `Mesa 5`, `Barra`… Ayuda a localizar el cobro después.
    #[serde(default)]
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

// ──────────────────────────────────────────────────────────────────────────────
// Construcción del ticket en ESC/POS (independiente de plataforma)
// ──────────────────────────────────────────────────────────────────────────────

/// Columnas de caracteres (fuente A) que caben en cada formato de papel.
///
/// ⚠️ Son las columnas **imprimibles**, que no salen del ancho del rollo: una impresora de 58 mm
/// imprime sobre unos 48 mm (384 dots ÷ 12 por carácter = 32 columnas), y una de 80 mm sobre unos
/// 72 mm (576 ÷ 12 = 48). Derivar las columnas de los milímetros de papel da un 20 % de más y el
/// texto se sale.
fn cols_for(paper_width_mm: u32) -> usize {
    match paper_width_mm {
        58 => 32,
        112 => 64,
        _ => 48, // 80mm
    }
}

/// Milímetros **imprimibles** de cada formato (el rollo menos el margen muerto del cabezal).
/// Solo se usa para traducir los márgenes del usuario a columnas.
fn printable_mm(paper_width_mm: u32) -> f64 {
    match paper_width_mm {
        58 => 48.0,
        112 => 104.0,
        _ => 72.0, // 80mm
    }
}

/// Convierte milímetros a dots según el DPI de la impresora.
fn mm_to_dots(mm: f64, dpi: u32) -> u32 {
    if mm <= 0.0 {
        0
    } else {
        ((mm / 25.4) * dpi as f64).round() as u32
    }
}

/// Columnas efectivas del cuerpo: las que pide el usuario (`chars_per_line`), acotadas por las que
/// de verdad caben — las imprimibles del formato menos lo que se comen sus márgenes.
///
/// El tope sale de [`cols_for`], no de recalcularlo desde los milímetros de papel: el rollo es más
/// ancho que la zona imprimible, así que hacerlo por milímetros daba 38 columnas donde caben 32 y
/// el texto se salía en cuanto alguien subía `chars_per_line`.
pub fn cols_efectivas(
    paper_width_mm: u32,
    chars_per_line: u32,
    margin_left_mm: f64,
    margin_right_mm: f64,
) -> usize {
    let cols_papel = cols_for(paper_width_mm);

    // Los márgenes se traducen a columnas por proporción sobre el ancho imprimible: así no depende
    // del DPI ni de cuántos dots ocupe un carácter en cada modelo.
    let margen_mm = margin_left_mm.max(0.0) + margin_right_mm.max(0.0);
    let cols_margen = ((margen_mm / printable_mm(paper_width_mm)) * cols_papel as f64).round();
    let physical_max = cols_papel.saturating_sub(cols_margen.max(0.0) as usize);

    let desired = chars_per_line.clamp(20, 80) as usize;
    desired.min(physical_max).max(10)
}

fn effective_cols(p: &PrintTicketPayload) -> usize {
    cols_efectivas(
        p.paper_width_mm,
        p.chars_per_line,
        p.margin_left_mm,
        p.margin_right_mm,
    )
}

/// Geometría del papel para preguntar por las columnas desde el frontend (previsualización).
/// Es un subconjunto de [`PrintTicketPayload`]: la vista previa no necesita ni negocio ni líneas.
#[derive(Debug, Clone, Deserialize)]
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


/// Importe en formato español: `1,70 €`.
///
/// Se redondea a céntimos ANTES de formatear, y no se deja la tarea al `{:.2}`. Dos motivos, los
/// dos comprobados:
///
/// - `{:.2}` rompe los empates al PAR (1,125 → "1,12"), mientras que la vista previa —y cualquiera
///   que haga la cuenta a mano— redondea hacia arriba. Redondeando antes con la misma operación que
///   usa el frontend, los dos lados no tienen forma de discrepar.
/// - Un importe negativo minúsculo daba `-0,00 €`, que en un ticket no significa nada.
///
/// Sin separador de miles a propósito: en una columna de 32 caracteres, un punto de millar se
/// confunde con el decimal.
fn fmt_eur(n: f64) -> String {
    let c = a_centimos(n);
    let c = if c == 0.0 { 0.0 } else { c }; // se lleva por delante el -0.0
    format!("{:.2} €", c).replace('.', ",")
}

/// Línea de dos columnas: `left` a la izquierda, `right` pegado a la derecha dentro de `cols`.
fn line_two(left: &str, right: &str, cols: usize) -> String {
    let right_len = right.chars().count();
    let max_left = cols.saturating_sub(right_len + 1);
    let l: String = left.chars().take(max_left).collect();
    let used = l.chars().count() + right_len;
    let pad = cols.saturating_sub(used);
    format!("{}{}{}", l, " ".repeat(pad), right)
}

/// Codifica a **CP858** (PC858: CP850 con el € en 0xD5), que es la tabla que traen de fábrica
/// prácticamente todas las térmicas vendidas en Europa. El builder emite `ESC t 19` para que la
/// impresora la interprete.
///
/// Dos reglas que sostienen todo lo demás:
///
/// - **Un carácter, un byte.** El maquetado del ticket cuenta columnas, no bytes; si un carácter
///   se codificara en dos, la línea saldría más corta de lo calculado y el importe dejaría de
///   cuadrar contra el borde derecho. Lo que no está en la tabla cae a `?`, que ocupa uno.
/// - **Nada de bytes de control.** El nombre de un producto lo escribe el usuario, y un `ESC` o un
///   salto de línea colados ahí no serían texto: la impresora los leería como comandos y el resto
///   del ticket saldría en otro tamaño, o se ordenaría un corte a media venta. Se convierten en
///   espacio, que mantiene el ancho.
fn encode_cp858(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for ch in s.chars() {
        let b: u8 = match ch {
            // Los de control nunca llegan a la impresora como tales.
            c if (c as u32) < 0x20 || (c as u32) == 0x7F => b' ',
            c if (c as u32) < 0x80 => c as u8,

            'Ç' => 0x80, 'ü' => 0x81, 'é' => 0x82, 'â' => 0x83, 'ä' => 0x84,
            'à' => 0x85, 'å' => 0x86, 'ç' => 0x87, 'ê' => 0x88, 'ë' => 0x89,
            'è' => 0x8A, 'ï' => 0x8B, 'î' => 0x8C, 'ì' => 0x8D, 'Ä' => 0x8E, 'Å' => 0x8F,

            'É' => 0x90, 'æ' => 0x91, 'Æ' => 0x92, 'ô' => 0x93, 'ö' => 0x94,
            'ò' => 0x95, 'û' => 0x96, 'ù' => 0x97, 'ÿ' => 0x98, 'Ö' => 0x99, 'Ü' => 0x9A,
            'ø' => 0x9B, '£' => 0x9C, 'Ø' => 0x9D, '×' => 0x9E, 'ƒ' => 0x9F,

            'á' => 0xA0, 'í' => 0xA1, 'ó' => 0xA2, 'ú' => 0xA3, 'ñ' => 0xA4, 'Ñ' => 0xA5,
            'ª' => 0xA6, 'º' => 0xA7, '¿' => 0xA8, '®' => 0xA9, '¬' => 0xAA, '½' => 0xAB,
            '¼' => 0xAC, '¡' => 0xAD, '«' => 0xAE, '»' => 0xAF,

            // Las mayúsculas acentuadas viven repartidas por el bloque de dibujo de cajas, que es
            // el motivo de que sea fácil dejárselas: "JAMÓN IBÉRICO" salía "JAM?N IB?RICO".
            'Á' => 0xB5, 'Â' => 0xB6, 'À' => 0xB7, '©' => 0xB8,
            'ã' => 0xC6, 'Ã' => 0xC7,
            'ð' => 0xD0, 'Ð' => 0xD1, 'Ê' => 0xD2, 'Ë' => 0xD3, 'È' => 0xD4,
            '€' => 0xD5, 'Í' => 0xD6, 'Î' => 0xD7, 'Ï' => 0xD8,
            '¦' => 0xDD, 'Ì' => 0xDE,
            'Ó' => 0xE0, 'ß' => 0xE1, 'Ô' => 0xE2, 'Ò' => 0xE3, 'õ' => 0xE4, 'Õ' => 0xE5,
            'µ' => 0xE6, 'þ' => 0xE7, 'Þ' => 0xE8, 'Ú' => 0xE9, 'Û' => 0xEA, 'Ù' => 0xEB,
            'ý' => 0xEC, 'Ý' => 0xED, '¯' => 0xEE, '´' => 0xEF,
            '±' => 0xF1, '¾' => 0xF3, '¶' => 0xF4, '§' => 0xF5, '÷' => 0xF6, '¸' => 0xF7,
            '°' => 0xF8, '¨' => 0xF9, '·' => 0xFA, '¹' => 0xFB, '³' => 0xFC, '²' => 0xFD,

            _ => b'?',
        };
        out.push(b);
    }
    out
}

// Helpers ESC/POS sobre un buffer de bytes.
fn esc_init(out: &mut Vec<u8>) {
    out.extend_from_slice(&[0x1B, 0x40]); // ESC @  (reset)
    out.extend_from_slice(&[0x1B, 0x74, 19]); // ESC t 19  (code page CP858)
}
fn esc_align(out: &mut Vec<u8>, n: u8) {
    out.extend_from_slice(&[0x1B, 0x61, n]); // 0 izq · 1 centro · 2 dcha
}
fn esc_bold(out: &mut Vec<u8>, on: bool) {
    out.extend_from_slice(&[0x1B, 0x45, if on { 1 } else { 0 }]);
}
fn esc_size(out: &mut Vec<u8>, n: u8) {
    out.extend_from_slice(&[0x1D, 0x21, n]); // GS ! n  (0x00 normal, 0x11 doble)
}
fn esc_feed(out: &mut Vec<u8>, lines: u8) {
    out.extend_from_slice(&[0x1B, 0x64, lines]); // ESC d n
}
/// Avanza el papel `dots` puntos (para márgenes superior/inferior en mm). ESC J admite 0–255,
/// así que troceamos si hace falta.
fn esc_feed_dots(out: &mut Vec<u8>, mut dots: u32) {
    while dots > 0 {
        let n = dots.min(255) as u8;
        out.extend_from_slice(&[0x1B, 0x4A, n]); // ESC J n  (print & feed n dots)
        dots -= n as u32;
    }
}
/// Fija el margen izquierdo en `dots` (GS L). Desplaza físicamente el área de impresión.
fn esc_left_margin(out: &mut Vec<u8>, dots: u32) {
    out.extend_from_slice(&[0x1D, 0x4C, (dots & 0xFF) as u8, ((dots >> 8) & 0xFF) as u8]);
}
/// Pulso al cajón portamonedas (`ESC p m t1 t2`).
///
/// El cajón no está conectado al ordenador: cuelga de la impresora por un RJ11 y se abre con un
/// pulso de corriente a su solenoide. `m=0` es el pin 2, que es el que usan casi todos; los
/// tiempos van en unidades de 2 ms (50 ms de pulso y 500 ms de descanso, lo habitual).
///
/// Son cinco bytes dentro del mismo trabajo de impresión: puestos al final, el cajón se abre
/// cuando el ticket ya ha salido.
fn esc_abrir_cajon(out: &mut Vec<u8>) {
    out.extend_from_slice(&[0x1B, 0x70, 0x00, 0x19, 0xFA]);
}

fn esc_cut(out: &mut Vec<u8>) {
    out.extend_from_slice(&[0x1D, 0x56, 0x00]); // GS V 0  (corte total)
}
fn text_line(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&encode_cp858(s));
    out.push(b'\n');
}
/// Parte un texto en líneas de como mucho `ancho` caracteres, cortando por los espacios.
///
/// Una impresora térmica no envuelve: parte por donde llega, sin mirar si está a mitad de palabra.
/// El nombre del negocio, la dirección y el mensaje del pie son texto libre que escribe el
/// usuario, y el ancho del papel no lo tiene delante cuando lo escribe. Sin esto, "Avenida de la
/// Constitución 145" salía cortada como "Avenida de la Constituci" + "ón 145".
///
/// Una palabra más larga que la línea (una URL, un correo) sí se parte a lo bruto: es eso o
/// perderla.
fn envolver(texto: &str, ancho: usize) -> Vec<String> {
    let ancho = ancho.max(1);
    let mut lineas: Vec<String> = Vec::new();
    let mut actual = String::new();

    for palabra in texto.split_whitespace() {
        let mut palabra = palabra;

        // Palabra más larga que la línea entera: se trocea.
        while palabra.chars().count() > ancho {
            if !actual.is_empty() {
                lineas.push(std::mem::take(&mut actual));
            }
            let corte: String = palabra.chars().take(ancho).collect();
            lineas.push(corte);
            palabra = &palabra[palabra
                .char_indices()
                .nth(ancho)
                .map(|(i, _)| i)
                .unwrap_or(palabra.len())..];
        }
        if palabra.is_empty() {
            continue;
        }

        let cabe = actual.is_empty() || actual.chars().count() + 1 + palabra.chars().count() <= ancho;
        if cabe {
            if !actual.is_empty() {
                actual.push(' ');
            }
            actual.push_str(palabra);
        } else {
            lineas.push(std::mem::take(&mut actual));
            actual.push_str(palabra);
        }
    }
    if !actual.is_empty() {
        lineas.push(actual);
    }
    if lineas.is_empty() {
        lineas.push(String::new());
    }
    lineas
}

/// Escribe un texto libre envuelto a `ancho` columnas.
fn text_wrap(out: &mut Vec<u8>, texto: &str, ancho: usize) {
    for l in envolver(texto, ancho) {
        text_line(out, &l);
    }
}

fn sep(out: &mut Vec<u8>, cols: usize) {
    text_line(out, &"-".repeat(cols));
}

/// Construye los bytes ESC/POS del ticket replicando la personalización del front.
/// Redondea a céntimos. Todo lo que se imprime pasa por aquí antes de compararse con otra cifra:
/// dos importes que "casi" cuadran en coma flotante cuadran o no cuadran **en el papel**, que es
/// donde lo mira el cliente.
fn a_centimos(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// Reparte el ticket por tipo de IVA: devuelve `(tipo, base, iva)` por cada tipo presente,
/// ordenado por tipo. Las tres cifras vienen ya redondeadas a céntimos.
///
/// Los precios son con IVA incluido (es lo que se le enseña al cliente en hostelería), así que la
/// base se saca dividiendo: `base = total / (1 + tipo/100)`. Se calcula **por línea** y se suma
/// por tipo, no sobre el total del ticket: con dos tipos distintos, aplicar uno solo al total da
/// un desglose que no cuadra.
///
/// Desglose de IVA del ticket, delegado en `tpv_domain::ticket`.
///
/// **La cuenta no vive aquí desde FISCAL-01.** Tiene tres consumidores —este generador, la vista
/// previa de `TicketPaper.tsx` y el `Desglose` del registro de facturación que se remite a la
/// AEAT— y tres copias de la misma aritmética es exactamente la divergencia que no se ve hasta que
/// la AEAT devuelve un «aceptado con errores» meses después. Las reglas (la cuota se despeja, no
/// se redondea; las exentas son otra clase de tramo) están documentadas allí.
///
/// Una línea sin tipo propio usa el general del negocio, que es el caso de casi todo.
fn desglose_iva(p: &PrintTicketPayload) -> Vec<TramoIva> {
    let lineas: Vec<LineaTicket> = p
        .items
        .iter()
        .map(|it| LineaTicket {
            total_con_iva: it.precio_unitario * it.cantidad as f64,
            tipo_iva: it.iva_percent.unwrap_or(p.iva_percent),
            exento: it.exento,
            causa_exencion: it.causa_exencion.clone(),
        })
        .collect();
    tpv_domain::ticket::desglose(&lineas)
}

/// Puntos de ancho que puede ocupar el logo: los del cabezal del formato, menos lo que se coman
/// los márgenes.
///
/// **No depende de `chars_per_line`.** Esa opción es la densidad del TEXTO: alguien que la baja a
/// 20 quiere las letras más grandes, no un logo del tercio del papel. Se calculaba desde las
/// columnas efectivas y el logo encogía con ellas.
///
/// Los márgenes se descuentan por proporción sobre el ancho útil, igual que en [`cols_efectivas`]:
/// así el resultado no depende del DPI ni de cuántos puntos ocupe un carácter en cada modelo.
fn ancho_logo_dots(paper_width_mm: u32, margin_left_mm: f64, margin_right_mm: f64) -> u32 {
    let cabezal = (cols_for(paper_width_mm) as u32) * 12;

    let margen_mm = margin_left_mm.max(0.0) + margin_right_mm.max(0.0);
    let fraccion = (margen_mm / printable_mm(paper_width_mm)).clamp(0.0, 0.9);
    let ancho = (cabezal as f64 * (1.0 - fraccion)).round() as u32;

    // Múltiplo de 8: cada byte de la trama son 8 puntos horizontales.
    ancho.max(8) & !7
}

/// Convierte una imagen a un bloque ESC/POS `GS v 0` listo para imprimir.
///
/// Una térmica es de **un bit**: cada punto se marca o no. Un logo plano de líneas sale nítido;
/// una fotografía saldría como una mancha si se recortara por un umbral, así que se difumina con
/// Floyd–Steinberg — el error de redondeo de cada píxel se reparte entre sus vecinos, que es lo que
/// crea la ilusión de grises con solo negro y blanco.
///
/// Devuelve `None` si la imagen no se puede decodificar: el ticket sale sin logo, que es mejor que
/// no salir.
pub fn rasterizar_logo(bytes: &[u8], ancho_max_dots: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;

    // El ancho se ajusta al papel; el alto va en proporción. Se usa un múltiplo de 8 porque cada
    // byte de la trama son 8 puntos horizontales.
    let ancho = ancho_max_dots.min(img.width().max(1)).max(8) & !7;
    let alto = ((img.height() as f64) * (ancho as f64) / (img.width().max(1) as f64)).round() as u32;
    let alto = alto.clamp(1, 1024); // tope de seguridad: un logo no puede comerse el rollo

    // La transparencia se compone sobre BLANCO antes de nada. Casi todos los logos son un PNG
    // con el fondo transparente, y `to_luma8()` tira el canal alfa: los píxeles de fuera del
    // dibujo (que suelen ser negro con alfa 0) se leían como negro opaco y el logo salía como un
    // rectángulo de tinta. El papel es blanco, así que lo transparente es blanco.
    let rgba = img.to_rgba8();
    let mut plano = image::GrayImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let luma = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
        let alfa = a as f32 / 255.0;
        let sobre_blanco = luma * alfa + 255.0 * (1.0 - alfa);
        plano.put_pixel(x, y, image::Luma([sobre_blanco.round() as u8]));
    }

    let gris = image::imageops::resize(&plano, ancho, alto, image::imageops::FilterType::Lanczos3);

    // Difuminado Floyd–Steinberg sobre una copia en coma flotante.
    let mut buf: Vec<f32> = gris.pixels().map(|p| p.0[0] as f32).collect();
    let w = ancho as usize;
    let h = alto as usize;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let viejo = buf[i];
            let nuevo = if viejo < 128.0 { 0.0 } else { 255.0 };
            buf[i] = nuevo;
            let err = viejo - nuevo;
            let mut reparte = |dx: usize, dy: usize, factor: f32| {
                if dx < w && dy < h {
                    buf[dy * w + dx] += err * factor;
                }
            };
            if x + 1 < w {
                reparte(x + 1, y, 7.0 / 16.0);
            }
            if y + 1 < h {
                if x > 0 {
                    reparte(x - 1, y + 1, 3.0 / 16.0);
                }
                reparte(x, y + 1, 5.0 / 16.0);
                if x + 1 < w {
                    reparte(x + 1, y + 1, 1.0 / 16.0);
                }
            }
        }
    }

    // Empaquetado: un bit por punto, el más significativo a la izquierda, 1 = negro.
    let bytes_por_fila = w / 8;
    let mut trama = Vec::with_capacity(bytes_por_fila * h);
    for y in 0..h {
        for bx in 0..bytes_por_fila {
            let mut b: u8 = 0;
            for bit in 0..8 {
                let x = bx * 8 + bit;
                if buf[y * w + x] < 128.0 {
                    b |= 0x80 >> bit;
                }
            }
            trama.push(b);
        }
    }

    // GS v 0 m xL xH yL yH  +  datos
    let mut out = vec![0x1D, 0x76, 0x30, 0x00];
    out.push((bytes_por_fila & 0xFF) as u8);
    out.push(((bytes_por_fila >> 8) & 0xFF) as u8);
    out.push((h & 0xFF) as u8);
    out.push(((h >> 8) & 0xFF) as u8);
    out.extend_from_slice(&trama);
    Some(out)
}

/// Lado (en dots) que debe tener el código QR para caer en la banda de **30 a 40 mm** que exige el
/// art. 21.1 de la Orden, al DPI configurado.
///
/// Se calcula desde el papel y no desde `chars_per_line`: esa opción es la densidad del TEXTO, no
/// del código. Y si el papel es tan estrecho que no caben 30 mm más su zona de silencio, se usa lo
/// que haya: un QR algo menor sigue leyéndose, y un QR que no cabe no se imprime.
fn lado_qr_dots(paper_width_mm: u32, margin_left_mm: f64, margin_right_mm: f64, dpi: u32) -> u32 {
    let util_mm = (printable_mm(paper_width_mm) - margin_left_mm.max(0.0) - margin_right_mm.max(0.0))
        .max(1.0);
    // Zona de silencio: mínimo 2 mm por los cuatro lados (la especificación recomienda 6).
    let disponible_mm = (util_mm - 2.0 * ZONA_SILENCIO_MM).max(1.0);
    let objetivo_mm = disponible_mm.clamp(QR_MIN_MM, QR_MAX_MM);
    mm_to_dots(objetivo_mm, dpi).max(8)
}

/// Rasteriza la URL a un bloque ESC/POS `GS v 0`, por el **mismo camino que el logo**.
///
/// Se hace así y no con el `GS ( k` nativo de QR de ESC/POS porque es más portable: el comando
/// nativo no lo llevan todas las térmicas, y una que no lo entienda imprime la basura del comando
/// en vez del código. Una trama de bits la pinta cualquiera.
///
/// - ISO/IEC 18004:2015 con nivel de corrección **M** (medio), que es el que exige el art. 21.1.
/// - Cada módulo del código se dibuja como un cuadrado de N×N dots, con N entero: un escalado
///   fraccionario deja módulos de anchos distintos y hay lectores que se atragantan.
///
/// Devuelve `None` si la URL no cabe en un QR o si el papel no da ni para un módulo. El ticket sale
/// entonces sin código: **nada de lo que rodea al ticket puede impedir cobrar**, y la factura
/// sigue siendo válida (el registro ya está emitido y se remitirá igual).
pub fn rasterizar_qr(url: &str, lado_max_dots: u32) -> Option<Vec<u8>> {
    use qrcode::{EcLevel, QrCode};

    let code = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::M).ok()?;
    let modulos = code.width(); // el código es cuadrado
    if modulos == 0 {
        return None;
    }

    // Escala entera. Si ni siquiera cabe a 1 dot por módulo, no hay QR que imprimir.
    let escala = (lado_max_dots as usize / modulos).max(1);
    if modulos * escala > 4096 {
        return None;
    }

    let lado = modulos * escala;
    // Cada byte de la trama son 8 puntos horizontales, así que el ancho se redondea hacia arriba
    // al múltiplo de 8 y el sobrante queda en blanco (parte de la zona de silencio).
    let bytes_por_fila = lado.div_ceil(8);
    let ancho_bits = bytes_por_fila * 8;

    let oscuro: Vec<bool> = code.to_colors().iter().map(|c| *c == qrcode::Color::Dark).collect();
    if oscuro.len() < modulos * modulos {
        return None;
    }

    let mut trama = vec![0u8; bytes_por_fila * lado];
    for y in 0..lado {
        let my = y / escala;
        for x in 0..lado {
            let mx = x / escala;
            if oscuro[my * modulos + mx] {
                trama[y * bytes_por_fila + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    debug_assert!(ancho_bits >= lado);

    // GS v 0 m xL xH yL yH + datos
    let mut out = vec![0x1D, 0x76, 0x30, 0x00];
    out.push((bytes_por_fila & 0xFF) as u8);
    out.push(((bytes_por_fila >> 8) & 0xFF) as u8);
    out.push((lado & 0xFF) as u8);
    out.push(((lado >> 8) & 0xFF) as u8);
    out.extend_from_slice(&trama);
    Some(out)
}

/// Tamaño mínimo y máximo del QR en milímetros (art. 21.1 de la Orden).
const QR_MIN_MM: f64 = 30.0;
const QR_MAX_MM: f64 = 40.0;
/// Zona de silencio alrededor del código: mínimo 2 mm por los cuatro lados.
const ZONA_SILENCIO_MM: f64 = 2.0;

/// Texto que SIEMPRE precede al código, para distinguirlo de cualquier otro QR de la factura.
const QR_ROTULO: &str = "QR tributario:";
/// Leyenda que va justo debajo en un sistema que emite facturas verificables.
const QR_LEYENDA: &str = "VERI*FACTU";
/// Aviso del entorno de pruebas. No lo pide la norma: lo pide el sentido común.
const QR_AVISO_PRUEBAS: &str = "-- ENTORNO DE PRUEBAS --";

pub fn build_ticket(p: &PrintTicketPayload, logo: Option<&[u8]>) -> Vec<u8> {
    let cols = effective_cols(p);
    let dpi = if p.paper_dpi == 300 { 300 } else { 203 };
    // Escala de fuente: sólo el eje de altura (mantiene columnas). GS ! 0x01 = doble alto.
    let base_size: u8 = if p.font_scale >= 1.5 { 0x01 } else { 0x00 };
    let mut out: Vec<u8> = Vec::new();

    esc_init(&mut out);

    // Margen izquierdo físico (GS L) y margen superior (avance en dots).
    esc_left_margin(&mut out, mm_to_dots(p.margin_left_mm, dpi));
    esc_feed_dots(&mut out, mm_to_dots(p.margin_top_mm, dpi));

    // Tamaño base del cuerpo (respeta font_scale); las cabeceras lo sobreescriben y restauran.
    esc_size(&mut out, base_size);

    // ── El QR tributario abre la factura (FISCAL-01, art. 21 de la Orden) ──
    //
    // «El código QR se situará al principio de la factura, antes de que empiece el contenido de
    // ésta generado por el sistema informático de facturación», centrado respecto a los márgenes,
    // precedido siempre por el texto «QR tributario:» y seguido de la leyenda «VERI*FACTU».
    //
    // Esto DEROGA la regla de §11 de CLAUDE.md que ponía el logo arriba y luego lo bajó al final:
    // el QR gana, y no por jerarquía de normas sino porque la razón que puso el logo abajo —que lo
    // primero que se lea sea de quién es el ticket y cuánto se ha pagado— sigue cumpliéndose. El
    // QR no es contenido que compita por la atención: es una etiqueta.
    //
    // Si no hay URL (una precuenta, o un ticket de antes de configurar los datos fiscales) no se
    // imprime nada: ni el hueco ni la leyenda.
    if let Some(url) = p.qr_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        let lado = lado_qr_dots(p.paper_width_mm, p.margin_left_mm, p.margin_right_mm, dpi);
        if let Some(bloque) = rasterizar_qr(url, lado) {
            esc_align(&mut out, 1);
            text_line(&mut out, QR_ROTULO);
            // Zona de silencio arriba y abajo. `text_line` ya deja el salto de línea; esto añade
            // el aire que exige la especificación (mínimo 2 mm, recomendado 6).
            esc_feed_dots(&mut out, mm_to_dots(ZONA_SILENCIO_MM, dpi));
            out.extend_from_slice(&bloque);
            esc_feed_dots(&mut out, mm_to_dots(ZONA_SILENCIO_MM, dpi));
            // La leyenda va en negrita: la norma pide un tipo y tamaño «iguales o superiores a los
            // del resto de datos de la factura».
            esc_bold(&mut out, true);
            text_wrap(&mut out, QR_LEYENDA, cols);
            if p.qr_pruebas {
                text_wrap(&mut out, QR_AVISO_PRUEBAS, cols);
            }
            esc_bold(&mut out, false);
            esc_align(&mut out, 0);
            sep(&mut out, cols);
        }
    }

    // ── Cabecera: los datos del negocio, a la izquierda ──
    //
    // El logo NO va aquí: cierra el ticket (ver el final de esta función). Arriba obligaba a
    // centrar el texto debajo de él para que no quedara descolgado, y lo primero que se lee de un
    // recibo debe ser de quién es y cuánto se ha pagado.
    esc_align(&mut out, 0);
    if p.show_business_name {
        esc_bold(&mut out, true);
        esc_size(&mut out, 0x11); // doble alto+ancho para el nombre
        // A doble ancho cabe la mitad de texto: medirlo contra las columnas enteras dejaba el
        // nombre partido a mitad de palabra en cuanto el negocio se llamaba algo más que "Bar".
        let nombre = if p.business_name.trim().is_empty() { "TPV" } else { &p.business_name };
        text_wrap(&mut out, nombre, cols / 2);
        esc_size(&mut out, base_size);
        esc_bold(&mut out, false);
    }
    if p.show_address && !p.direccion.trim().is_empty() {
        text_wrap(&mut out, &p.direccion, cols);
    }
    if p.show_phone && !p.telefono.trim().is_empty() {
        text_wrap(&mut out, &format!("Tel: {}", p.telefono), cols);
    }
    if p.show_cif && !p.cif.trim().is_empty() {
        text_wrap(&mut out, &format!("CIF: {}", p.cif), cols);
    }

    // ── Cuerpo (izquierda) ──
    sep(&mut out, cols);

    // Encabezado del cuerpo: fecha a la izquierda y, a la derecha, QUÉ es este papel — su número
    // si es un ticket de venta, o PRECUENTA si aún no se ha cobrado.
    let etiqueta = match p.numero_ticket.as_deref() {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => "PRECUENTA".to_string(),
    };
    if p.show_date_time {
        let fecha = chrono::Local::now().format("%d/%m/%Y %H:%M").to_string();
        text_line(&mut out, &line_two(&fecha, &etiqueta, cols));
    } else {
        text_line(&mut out, &line_two("", &etiqueta, cols));
    }

    // Origen y método: es lo que permite encontrar el cobro después (una devolución, un arqueo).
    if let Some(o) = p.origen.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        text_line(&mut out, &line_two(o, "", cols));
    }
    if let Some(m) = p.metodo_pago.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        text_line(&mut out, &line_two("Pago", m, cols));
    }

    // Los avisos que evitan confundir un papel con otro.
    if p.numero_ticket.as_deref().map(str::trim).unwrap_or("").is_empty() {
        esc_align(&mut out, 1);
        text_wrap(&mut out, "NO ES UN TICKET DE VENTA", cols);
        esc_align(&mut out, 0);
    } else {
        // ANULADO va antes que COPIA y no la sustituye: son dos cosas distintas y las dos
        // importan. Que el papel sea una copia explica por qué hay dos iguales; que el cobro
        // esté anulado es lo que impide que se cuente como una venta.
        if p.es_anulado {
            esc_align(&mut out, 1);
            esc_bold(&mut out, true);
            text_line(&mut out, "*** ANULADO ***");
            esc_bold(&mut out, false);
            esc_align(&mut out, 0);
        }
        if p.es_copia {
            esc_align(&mut out, 1);
            esc_bold(&mut out, true);
            text_line(&mut out, "COPIA");
            esc_bold(&mut out, false);
            esc_align(&mut out, 0);
        }
    }

    sep(&mut out, cols);

    // Total siempre se calcula de los items, aunque las líneas estén ocultas.
    let total: f64 = p.items.iter().map(|it| it.precio_unitario * it.cantidad as f64).sum();

    if !p.show_line_items {
        esc_align(&mut out, 1);
        text_wrap(&mut out, "(Lineas de productos ocultas)", cols);
        esc_align(&mut out, 0);
    } else if p.items.is_empty() {
        esc_align(&mut out, 1);
        text_wrap(&mut out, "No hay productos en el ticket.", cols);
        esc_align(&mut out, 0);
    } else {
        for it in &p.items {
            let line_total = it.precio_unitario * it.cantidad as f64;
            text_line(&mut out, &line_two(&it.nombre, &fmt_eur(line_total), cols));
            text_line(
                &mut out,
                &format!("  {} x {}", it.cantidad, fmt_eur(it.precio_unitario)),
            );
        }
    }

    sep(&mut out, cols);

    // ── Base + IVA ──
    if p.show_base_and_iva {
        let tramos = desglose_iva(p);
        match tramos.as_slice() {
            // Sin líneas: el ticket sigue enseñando su base y su IVA a cero, como toda la vida.
            [] => {
                text_line(&mut out, &line_two("BASE", &fmt_eur(0.0), cols));
                text_line(
                    &mut out,
                    &line_two(&format!("IVA ({}%)", fmt_pct(p.iva_percent)), &fmt_eur(0.0), cols),
                );
            }
            // Un solo tipo sujeto (el caso de un bar normal): se imprime como toda la vida, sin
            // convertir el ticket en una tabla por algo que no aporta nada.
            [TramoIva::Sujeta { tipo, base, cuota }] => {
                text_line(&mut out, &line_two("BASE", &fmt_eur(*base), cols));
                text_line(
                    &mut out,
                    &line_two(&format!("IVA ({}%)", fmt_pct(*tipo)), &fmt_eur(*cuota), cols),
                );
            }
            // Varios tramos: hay que verlos por separado. Un ticket con comida al reducido y algo
            // envasado para llevar al general no se puede resumir en una sola cifra — y una línea
            // exenta no tiene ninguna cifra de IVA que enseñar, así que sale sin ella.
            _ => {
                for t in &tramos {
                    match t {
                        TramoIva::Sujeta { tipo, base, cuota } => {
                            text_line(
                                &mut out,
                                &line_two(&format!("BASE ({}%)", fmt_pct(*tipo)), &fmt_eur(*base), cols),
                            );
                            text_line(
                                &mut out,
                                &line_two(&format!("IVA ({}%)", fmt_pct(*tipo)), &fmt_eur(*cuota), cols),
                            );
                        }
                        TramoIva::Exenta { causa, base } => {
                            text_line(
                                &mut out,
                                &line_two(&format!("BASE EXENTA ({causa})"), &fmt_eur(*base), cols),
                            );
                        }
                    }
                }
            }
        }
    }

    // ── Total ──
    if p.show_total {
        sep(&mut out, cols);
        esc_bold(&mut out, true);
        esc_size(&mut out, 0x11);
        // Con tamaño doble caben la mitad de columnas.
        text_line(&mut out, &line_two("TOTAL", &fmt_eur(total), cols / 2));
        esc_size(&mut out, base_size);
        esc_bold(&mut out, false);
    }

    // ── Mensaje final ──
    if p.show_footer_message {
        let msg = if p.mensaje_footer.trim().is_empty() {
            "¡Gracias por su visita!"
        } else {
            &p.mensaje_footer
        };
        esc_feed(&mut out, 1);
        esc_align(&mut out, 1);
        text_wrap(&mut out, msg, cols);
        esc_align(&mut out, 0);
    }

    // ── Logo, cerrando el ticket ──
    //
    // Lo último y centrado, como la firma de un papel. Aquí sí puede ocupar el ancho del papel:
    // no compite con ningún texto por la línea, que era lo que obligaba a encogerlo cuando estaba
    // arriba.
    if p.show_logo {
        let ancho_logo = ancho_logo_dots(p.paper_width_mm, p.margin_left_mm, p.margin_right_mm);
        if let Some(bloque) = logo.and_then(|b| rasterizar_logo(b, ancho_logo)) {
            esc_feed(&mut out, 1);
            esc_align(&mut out, 1);
            out.extend_from_slice(&bloque);
            esc_align(&mut out, 0);
        }
    }

    // Margen inferior (mm) + avance + corte.
    esc_feed_dots(&mut out, mm_to_dots(p.margin_bottom_mm, dpi));
    esc_feed(&mut out, 4);
    esc_cut(&mut out);

    // El cajón se abre SOLO si se cobró en efectivo: en tarjeta no hace falta y abrirlo delante
    // del cliente sin motivo es exponer el dinero. Va después del corte, con el ticket ya fuera.
    if p
        .metodo_pago
        .as_deref()
        .map(|m| m.trim().eq_ignore_ascii_case("efectivo"))
        .unwrap_or(false)
    {
        esc_abrir_cajon(&mut out);
    }

    out
}

/// Trabajo de impresión que **solo** abre el cajón, sin sacar papel.
///
/// Usa la variante en tiempo real (`DLE DC4`), que la impresora atiende aunque tenga trabajos por
/// delante: el botón de "abrir cajón" existe para dar cambio, y esperar a que termine una cola de
/// tickets lo haría inútil.
pub fn build_abrir_cajon() -> Vec<u8> {
    // DLE DC4 n m t → n=1 (pulso), m=0 (pin 2), t=2 (200 ms).
    vec![0x10, 0x14, 0x01, 0x00, 0x02]
}

/// Lo que hace falta para imprimir un arqueo. CUENTA-06.
#[derive(Debug, Clone, Default, serde::Deserialize)]
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
    pub fondo_inicial: f64,
    #[serde(default)]
    pub ventas_efectivo: f64,
    #[serde(default)]
    pub esperado: f64,
    #[serde(default)]
    pub contado: f64,
    #[serde(default)]
    pub descuadre: f64,
    #[serde(default)]
    pub dejado: f64,
    #[serde(default)]
    pub retirado: f64,
    #[serde(default)]
    pub motivo: Option<String>,
    /// `(valor, unidades)` de lo contado, para el desglose.
    #[serde(default)]
    pub contado_denoms: Vec<(f64, i64)>,
    // ── Formato del papel: los mismos ajustes que el ticket ──
    #[serde(default = "def_paper_width")]
    pub paper_width_mm: u32,
    #[serde(default = "def_dpi")]
    pub paper_dpi: u32,
    #[serde(default = "def_cpl")]
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

fn def_paper_width() -> u32 {
    80
}
fn def_dpi() -> u32 {
    203
}
fn def_cpl() -> u32 {
    42
}

/// El papel del arqueo (CUENTA-06).
///
/// Es un **documento interno**, no un ticket de venta, y de ahí salen sus tres diferencias:
/// - **No consume numeración.** No pasa por `siguiente_numero_ticket`: gastar un correlativo en un
///   arqueo dejaría huecos sin explicación en la serie de ventas.
/// - **Sin datos fiscales**: ni CIF, ni desglose de IVA. Sí el nombre del negocio y la fecha, para
///   saber de quién y de cuándo es el papel.
/// - **No abre el cajón.** El cajón ya está abierto: se acaba de contar.
pub fn build_arqueo(p: &PrintArqueoPayload) -> Vec<u8> {
    let cols = cols_efectivas(
        p.paper_width_mm,
        p.chars_per_line,
        p.margin_left_mm,
        p.margin_right_mm,
    );
    let dpi = if p.paper_dpi == 300 { 300 } else { 203 };
    let mut out: Vec<u8> = Vec::new();

    esc_init(&mut out);
    esc_left_margin(&mut out, mm_to_dots(p.margin_left_mm, dpi));
    esc_feed_dots(&mut out, mm_to_dots(p.margin_top_mm, dpi));
    esc_size(&mut out, 0x00);

    esc_align(&mut out, 0);
    if !p.business_name.trim().is_empty() {
        esc_bold(&mut out, true);
        text_wrap(&mut out, p.business_name.trim(), cols);
        esc_bold(&mut out, false);
    }

    esc_bold(&mut out, true);
    esc_size(&mut out, 0x01);
    text_line(&mut out, "CIERRE DE CAJA");
    esc_size(&mut out, 0x00);
    esc_bold(&mut out, false);

    sep(&mut out, cols);
    text_line(&mut out, &line_two("Cerrado", &p.fecha_hora, cols));
    if let Some(d) = p.desde.as_deref().filter(|d| !d.trim().is_empty()) {
        text_line(&mut out, &line_two("Desde", d.trim(), cols));
    } else {
        text_line(&mut out, &line_two("Desde", "primer cierre", cols));
    }
    if let Some(u) = p.usuario.as_deref().filter(|u| !u.trim().is_empty()) {
        text_line(&mut out, &line_two("Por", u.trim(), cols));
    }

    sep(&mut out, cols);
    text_line(&mut out, &line_two("Fondo de partida", &fmt_eur(p.fondo_inicial), cols));
    text_line(&mut out, &line_two("Cobrado en efectivo", &fmt_eur(p.ventas_efectivo), cols));
    esc_bold(&mut out, true);
    text_line(&mut out, &line_two("Deberia haber", &fmt_eur(p.esperado), cols));
    text_line(&mut out, &line_two("Contado", &fmt_eur(p.contado), cols));
    esc_bold(&mut out, false);

    sep(&mut out, cols);
    // El descuadre es lo que se busca al coger este papel, así que va en grande y con su signo.
    esc_bold(&mut out, true);
    esc_size(&mut out, 0x01);
    let etiqueta = if p.descuadre == 0.0 {
        "CUADRA".to_string()
    } else if p.descuadre < 0.0 {
        format!("FALTAN {}", fmt_eur(-p.descuadre))
    } else {
        format!("SOBRAN {}", fmt_eur(p.descuadre))
    };
    text_line(&mut out, &etiqueta);
    esc_size(&mut out, 0x00);
    esc_bold(&mut out, false);

    if let Some(m) = p.motivo.as_deref().filter(|m| !m.trim().is_empty()) {
        text_wrap(&mut out, &format!("Motivo: {}", m.trim()), cols);
    }

    sep(&mut out, cols);
    text_line(&mut out, &line_two("Se deja en el cajon", &fmt_eur(p.dejado), cols));
    text_line(&mut out, &line_two("Se retira", &fmt_eur(p.retirado), cols));

    // El desglose por denominación es lo que convierte "faltan 50" en "falta un billete de 50".
    let denoms: Vec<&(f64, i64)> = p.contado_denoms.iter().filter(|(_, u)| *u > 0).collect();
    if !denoms.is_empty() {
        sep(&mut out, cols);
        text_line(&mut out, "Recuento");
        for (valor, unidades) in denoms {
            let izq = format!("  {} x {}", unidades, fmt_eur(*valor));
            text_line(
                &mut out,
                &line_two(&izq, &fmt_eur(a_centimos(valor * *unidades as f64)), cols),
            );
        }
    }

    esc_feed_dots(&mut out, mm_to_dots(p.margin_bottom_mm, dpi));
    esc_feed(&mut out, 4);
    esc_cut(&mut out);
    out
}

/// Formatea un porcentaje sin decimales innecesarios (`10` en vez de `10,00`).
fn fmt_pct(n: f64) -> String {
    if (n - n.round()).abs() < f64::EPSILON {
        format!("{}", n.round() as i64)
    } else {
        format!("{:.2}", n).replace('.', ",")
    }
}

/// Ticket de prueba para verificar que la impresora seleccionada responde.
pub fn build_test_ticket(printer_name: &str) -> Vec<u8> {
    let cols = cols_for(80);
    let mut out: Vec<u8> = Vec::new();
    esc_init(&mut out);
    esc_align(&mut out, 1);
    esc_bold(&mut out, true);
    esc_size(&mut out, 0x11);
    text_line(&mut out, "TPV");
    esc_size(&mut out, 0x00);
    esc_bold(&mut out, false);
    text_line(&mut out, "Prueba de impresion");
    esc_align(&mut out, 0);
    sep(&mut out, cols);
    text_line(&mut out, &line_two("Impresora", "OK", cols));
    text_line(&mut out, printer_name);
    text_line(&mut out, "Acentos: áéíóú ñÑ ¿¡ üÜ €");
    text_line(
        &mut out,
        &chrono::Local::now().format("%d/%m/%Y %H:%M:%S").to_string(),
    );
    sep(&mut out, cols);
    esc_align(&mut out, 1);
    text_line(&mut out, "Si lees esto, todo funciona.");
    esc_align(&mut out, 0);
    esc_feed(&mut out, 4);
    esc_cut(&mut out);
    out
}

// ──────────────────────────────────────────────────────────────────────────────
// Implementación específica de plataforma (Windows winspool / stub)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    #![allow(non_snake_case)]
    use super::PrinterInfo;
    use std::ffi::c_void;

    type HANDLE = *mut c_void;
    type BOOL = i32;

    #[repr(C)]
    struct PrinterInfo4W {
        p_printer_name: *mut u16,
        p_server_name: *mut u16,
        attributes: u32,
    }

    #[repr(C)]
    struct DocInfo1W {
        p_doc_name: *mut u16,
        p_output_file: *mut u16,
        p_datatype: *mut u16,
    }

    const PRINTER_ENUM_LOCAL: u32 = 0x0000_0002;
    const PRINTER_ENUM_CONNECTIONS: u32 = 0x0000_0004;

    #[link(name = "winspool")]
    extern "system" {
        fn EnumPrintersW(
            flags: u32,
            name: *const u16,
            level: u32,
            pprinterenum: *mut u8,
            cbbuf: u32,
            pcbneeded: *mut u32,
            pcreturned: *mut u32,
        ) -> BOOL;
        fn OpenPrinterW(pprintername: *const u16, phprinter: *mut HANDLE, pdefault: *mut c_void) -> BOOL;
        fn ClosePrinter(hprinter: HANDLE) -> BOOL;
        fn StartDocPrinterW(hprinter: HANDLE, level: u32, pdocinfo: *mut u8) -> u32;
        fn StartPagePrinter(hprinter: HANDLE) -> BOOL;
        fn WritePrinter(hprinter: HANDLE, pbuf: *const c_void, cbbuf: u32, pcwritten: *mut u32) -> BOOL;
        fn EndPagePrinter(hprinter: HANDLE) -> BOOL;
        fn EndDocPrinter(hprinter: HANDLE) -> BOOL;
        fn GetDefaultPrinterW(pszbuffer: *mut u16, pcchbuffer: *mut u32) -> BOOL;
    }

    pub(super) fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub(super) unsafe fn wide_to_string(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        String::from_utf16_lossy(slice)
    }

    fn get_default_printer() -> Option<String> {
        unsafe {
            let mut size: u32 = 0;
            // Primera llamada: obtiene el tamaño (en chars) necesario.
            GetDefaultPrinterW(std::ptr::null_mut(), &mut size);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u16; size as usize];
            if GetDefaultPrinterW(buf.as_mut_ptr(), &mut size) == 0 {
                return None;
            }
            let s = wide_to_string(buf.as_ptr());
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
    }

    pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            let level = 4u32;
            let mut needed: u32 = 0;
            let mut returned: u32 = 0;

            // Primera llamada con buffer vacío: nos dice cuántos bytes hacen falta.
            EnumPrintersW(flags, std::ptr::null(), level, std::ptr::null_mut(), 0, &mut needed, &mut returned);
            if needed == 0 {
                return Ok(Vec::new());
            }

            // Buffer alineado a 8 bytes (los structs llevan punteros): usamos Vec<u64>.
            let n_u64 = ((needed as usize) + 7) / 8;
            let mut buf: Vec<u64> = vec![0u64; n_u64];
            let buf_ptr = buf.as_mut_ptr() as *mut u8;

            if EnumPrintersW(flags, std::ptr::null(), level, buf_ptr, needed, &mut needed, &mut returned) == 0 {
                return Err("EnumPrintersW falló al enumerar impresoras".to_string());
            }

            let default_name = get_default_printer().unwrap_or_default();
            let mut out = Vec::with_capacity(returned as usize);
            let info_ptr = buf_ptr as *const PrinterInfo4W;
            for i in 0..(returned as isize) {
                let info = info_ptr.offset(i);
                let name = wide_to_string((*info).p_printer_name);
                if name.is_empty() {
                    continue;
                }
                let is_default = !default_name.is_empty() && name == default_name;
                out.push(PrinterInfo { name, is_default });
            }
            Ok(out)
        }
    }

    pub fn print_raw(printer_name: &str, doc_name: &str, data: &[u8]) -> Result<(), String> {
        unsafe {
            let wname = to_wide(printer_name);
            let mut hprinter: HANDLE = std::ptr::null_mut();
            if OpenPrinterW(wname.as_ptr(), &mut hprinter, std::ptr::null_mut()) == 0 || hprinter.is_null() {
                return Err(format!(
                    "No se pudo abrir la impresora '{printer_name}' (¿desconectada o nombre incorrecto?)"
                ));
            }

            // Cerramos siempre el handle, pase lo que pase.
            let result = (|| {
                let mut wdoc = to_wide(doc_name);
                let mut wdatatype = to_wide("RAW");
                let mut doc = DocInfo1W {
                    p_doc_name: wdoc.as_mut_ptr(),
                    p_output_file: std::ptr::null_mut(),
                    p_datatype: wdatatype.as_mut_ptr(),
                };

                let job = StartDocPrinterW(hprinter, 1, &mut doc as *mut _ as *mut u8);
                if job == 0 {
                    return Err("StartDocPrinter falló".to_string());
                }
                if StartPagePrinter(hprinter) == 0 {
                    EndDocPrinter(hprinter);
                    return Err("StartPagePrinter falló".to_string());
                }

                let mut written: u32 = 0;
                let ok = WritePrinter(
                    hprinter,
                    data.as_ptr() as *const c_void,
                    data.len() as u32,
                    &mut written,
                );
                EndPagePrinter(hprinter);
                EndDocPrinter(hprinter);

                if ok == 0 {
                    return Err("WritePrinter falló al enviar los datos".to_string());
                }
                if (written as usize) != data.len() {
                    return Err(format!("WritePrinter escribió {written}/{} bytes", data.len()));
                }
                Ok(())
            })();

            ClosePrinter(hprinter);
            result
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::PrinterInfo;

    pub fn list_printers() -> Result<Vec<PrinterInfo>, String> {
        Err("La impresión solo está disponible en Windows".to_string())
    }

    pub fn print_raw(_printer_name: &str, _doc_name: &str, _data: &[u8]) -> Result<(), String> {
        Err("La impresión solo está disponible en Windows".to_string())
    }
}

pub use imp::{list_printers, print_raw};

#[cfg(test)]
mod tests;
