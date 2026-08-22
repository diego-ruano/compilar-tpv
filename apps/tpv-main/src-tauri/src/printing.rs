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
    /// Reservado: el logo (imagen) aún no se rasteriza a ESC/POS, por eso este flag no se lee.
    #[serde(default)]
    #[allow(dead_code)]
    pub show_logo: bool,
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
fn fmt_eur(n: f64) -> String {
    format!("{:.2} €", n).replace('.', ",")
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

/// Codifica a **CP858** (PC858, incluye € y acentos del español). Lo que no esté mapeado
/// cae a `?`. El builder emite `ESC t 19` para que la impresora interprete esta página.
fn encode_cp858(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for ch in s.chars() {
        let b: u8 = match ch {
            c if (c as u32) < 0x80 => c as u8,
            'Ç' => 0x80, 'ü' => 0x81, 'é' => 0x82, 'â' => 0x83, 'ä' => 0x84,
            'à' => 0x85, 'å' => 0x86, 'ç' => 0x87, 'ê' => 0x88, 'ë' => 0x89,
            'è' => 0x8A, 'ï' => 0x8B, 'î' => 0x8C, 'ì' => 0x8D, 'Ä' => 0x8E, 'Å' => 0x8F,
            'É' => 0x90, 'æ' => 0x91, 'Æ' => 0x92, 'ô' => 0x93, 'ö' => 0x94,
            'ò' => 0x95, 'û' => 0x96, 'ù' => 0x97, 'ÿ' => 0x98, 'Ö' => 0x99, 'Ü' => 0x9A,
            'ø' => 0x9B, '£' => 0x9C, 'Ø' => 0x9D,
            'á' => 0xA0, 'í' => 0xA1, 'ó' => 0xA2, 'ú' => 0xA3, 'ñ' => 0xA4, 'Ñ' => 0xA5,
            'ª' => 0xA6, 'º' => 0xA7, '¿' => 0xA8, '®' => 0xA9,
            '¡' => 0xAD, '«' => 0xAE, '»' => 0xAF,
            '€' => 0xD5,
            '·' => 0xFA,
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
fn sep(out: &mut Vec<u8>, cols: usize) {
    text_line(out, &"-".repeat(cols));
}

/// Construye los bytes ESC/POS del ticket replicando la personalización del front.
/// Reparte el ticket por tipo de IVA: devuelve `(tipo, base, iva)` por cada tipo presente,
/// ordenado por tipo.
///
/// Los precios son con IVA incluido (es lo que se le enseña al cliente en hostelería), así que la
/// base se saca dividiendo: `base = total / (1 + tipo/100)`. Se calcula **por línea** y se suma
/// por tipo, no sobre el total del ticket: con dos tipos distintos, aplicar uno solo al total da
/// un desglose que no cuadra.
///
/// Una línea sin tipo propio usa el general del negocio, que es el caso de casi todo.
fn desglose_iva(p: &PrintTicketPayload) -> Vec<(f64, f64, f64)> {
    let mut por_tipo: Vec<(f64, f64)> = Vec::new(); // (tipo, total con IVA)

    for it in &p.items {
        let tipo = it.iva_percent.unwrap_or(p.iva_percent);
        let total_linea = it.precio_unitario * it.cantidad as f64;
        // Se agrupa comparando con tolerancia: un 10.0 y un 10.000000001 son el mismo tipo.
        match por_tipo.iter_mut().find(|(t, _)| (*t - tipo).abs() < 1e-9) {
            Some((_, acc)) => *acc += total_linea,
            None => por_tipo.push((tipo, total_linea)),
        }
    }

    por_tipo.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    por_tipo
        .into_iter()
        .map(|(tipo, total)| {
            let divisor = 1.0 + tipo / 100.0;
            let base = if divisor.abs() < f64::EPSILON { total } else { total / divisor };
            (tipo, base, total - base)
        })
        .collect()
}

pub fn build_ticket(p: &PrintTicketPayload) -> Vec<u8> {
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

    // ── Cabecera (centrada) ──
    esc_align(&mut out, 1);
    // Nota: el logo (imagen) no se imprime en esta versión (requiere rasterizado ESC/POS).
    if p.show_business_name {
        esc_bold(&mut out, true);
        esc_size(&mut out, 0x11); // doble alto+ancho para el nombre
        text_line(&mut out, if p.business_name.trim().is_empty() { "TPV" } else { &p.business_name });
        esc_size(&mut out, base_size);
        esc_bold(&mut out, false);
    }
    if p.show_address && !p.direccion.trim().is_empty() {
        text_line(&mut out, &p.direccion);
    }
    if p.show_phone && !p.telefono.trim().is_empty() {
        text_line(&mut out, &format!("Tel: {}", p.telefono));
    }
    if p.show_cif && !p.cif.trim().is_empty() {
        text_line(&mut out, &format!("CIF: {}", p.cif));
    }

    // ── Cuerpo (izquierda) ──
    esc_align(&mut out, 0);
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

    // Los dos avisos que evitan confundir un papel con otro.
    if p.numero_ticket.as_deref().map(str::trim).unwrap_or("").is_empty() {
        esc_align(&mut out, 1);
        text_line(&mut out, "NO ES UN TICKET DE VENTA");
        esc_align(&mut out, 0);
    } else if p.es_copia {
        esc_align(&mut out, 1);
        esc_bold(&mut out, true);
        text_line(&mut out, "COPIA");
        esc_bold(&mut out, false);
        esc_align(&mut out, 0);
    }

    sep(&mut out, cols);

    // Total siempre se calcula de los items, aunque las líneas estén ocultas.
    let total: f64 = p.items.iter().map(|it| it.precio_unitario * it.cantidad as f64).sum();

    if !p.show_line_items {
        esc_align(&mut out, 1);
        text_line(&mut out, "(Lineas de productos ocultas)");
        esc_align(&mut out, 0);
    } else if p.items.is_empty() {
        esc_align(&mut out, 1);
        text_line(&mut out, "No hay productos en el ticket.");
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
        if tramos.len() <= 1 {
            // Un solo tipo (el caso de un bar normal): se imprime como toda la vida, sin
            // convertir el ticket en una tabla por algo que no aporta nada.
            let t = tramos.first().copied().unwrap_or((p.iva_percent, 0.0, 0.0));
            text_line(&mut out, &line_two("BASE", &fmt_eur(t.1), cols));
            text_line(
                &mut out,
                &line_two(&format!("IVA ({}%)", fmt_pct(t.0)), &fmt_eur(t.2), cols),
            );
        } else {
            // Varios tipos: hay que verlos por separado. Un ticket con comida al reducido y algo
            // envasado para llevar al general no se puede resumir en una sola cifra.
            for (tipo, base, iva) in &tramos {
                text_line(
                    &mut out,
                    &line_two(&format!("BASE ({}%)", fmt_pct(*tipo)), &fmt_eur(*base), cols),
                );
                text_line(
                    &mut out,
                    &line_two(&format!("IVA ({}%)", fmt_pct(*tipo)), &fmt_eur(*iva), cols),
                );
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
        text_line(&mut out, msg);
        esc_align(&mut out, 0);
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

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn wide_to_string(ptr: *const u16) -> String {
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
mod tests_ancho {
    //! Cuántas columnas caben de verdad en el papel.
    //!
    //! Esto se calculaba a partir de los milímetros del ROLLO, y el rollo es más ancho que la zona
    //! que la impresora puede marcar: daba 38 columnas donde caben 32. No se notaba porque el
    //! valor por defecto (42) queda por debajo de todo, pero el panel deja subirlo — y ahí el
    //! ticket se salía del papel.

    use super::*;

    fn geometria(paper_width_mm: u32, chars_per_line: u32, izq: f64, dcha: f64) -> usize {
        cols_efectivas(paper_width_mm, chars_per_line, izq, dcha)
    }

    #[test]
    fn nunca_pasa_de_las_columnas_imprimibles_del_formato() {
        // Aunque se pidan 80, el papel manda: 32 / 48 / 64 son los anchos reales de fuente A.
        assert_eq!(geometria(58, 80, 0.0, 0.0), 32);
        assert_eq!(geometria(80, 80, 0.0, 0.0), 48);
        assert_eq!(geometria(112, 80, 0.0, 0.0), 64);
    }

    #[test]
    fn respeta_lo_que_pide_el_usuario_si_cabe() {
        assert_eq!(geometria(80, 42, 0.0, 0.0), 42);
        assert_eq!(geometria(58, 30, 0.0, 0.0), 30);
    }

    #[test]
    fn los_margenes_quitan_columnas() {
        // 12 mm de margen sobre los 72 mm imprimibles de un 80 mm = un sexto de las 48 columnas.
        assert_eq!(geometria(80, 80, 6.0, 6.0), 40);
        // Y con márgenes puestos, lo pedido sigue mandando si es menor.
        assert_eq!(geometria(80, 30, 6.0, 6.0), 30);
    }

    #[test]
    fn unos_margenes_absurdos_no_dejan_el_ticket_en_cero() {
        // Suelo de 10 columnas: preferimos un ticket estrecho a uno vacío o a un pánico por
        // dividir entre nada.
        assert_eq!(geometria(58, 80, 100.0, 100.0), 10);
    }

    #[test]
    fn los_margenes_negativos_se_ignoran() {
        assert_eq!(geometria(80, 80, -5.0, 0.0), 48);
    }
}

#[cfg(test)]
mod tests_desglose_iva {
    //! El reparto del ticket por tipo de IVA.
    //!
    //! Los precios se muestran con IVA incluido, así que la base se saca dividiendo. Lo que hay
    //! que fijar aquí es que se calcule **por línea y luego se sume**, y no aplicando un tipo al
    //! total: en cuanto un ticket mezcla dos tipos, la segunda forma da un desglose que no cuadra
    //! con lo que se ha cobrado.

    use super::*;

    fn linea(precio: f64, cantidad: u32, iva: Option<f64>) -> PrintTicketLine {
        PrintTicketLine {
            nombre: "x".into(),
            cantidad,
            precio_unitario: precio,
            iva_percent: iva,
        }
    }

    fn payload(iva_negocio: f64, items: Vec<PrintTicketLine>) -> PrintTicketPayload {
        PrintTicketPayload {
            printer_name: None,
            business_name: String::new(),
            direccion: String::new(),
            telefono: String::new(),
            cif: String::new(),
            mensaje_footer: String::new(),
            iva_percent: iva_negocio,
            show_logo: false,
            show_business_name: false,
            show_address: false,
            show_phone: false,
            show_cif: false,
            show_date_time: false,
            show_line_items: true,
            show_base_and_iva: true,
            show_total: true,
            show_footer_message: false,
            paper_width_mm: 80,
            paper_dpi: 203,
            chars_per_line: 42,
            margin_top_mm: 0.0,
            margin_bottom_mm: 0.0,
            margin_left_mm: 0.0,
            margin_right_mm: 0.0,
            font_scale: 1.0,
            numero_ticket: None,
            metodo_pago: None,
            origen: None,
            es_copia: false,
            items,
        }
    }

    /// Compara con la tolerancia de un céntimo mal redondeado.
    fn cerca(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn sin_tipos_propios_todo_va_al_del_negocio() {
        let p = payload(10.0, vec![linea(11.0, 1, None), linea(5.5, 2, None)]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 1);
        assert!(cerca(d[0].0, 10.0));
        // 22 € con IVA al 10% → base 20, IVA 2.
        assert!(cerca(d[0].1, 20.0), "base {}", d[0].1);
        assert!(cerca(d[0].2, 2.0), "iva {}", d[0].2);
    }

    #[test]
    fn el_tipo_de_la_linea_manda_sobre_el_del_negocio() {
        let p = payload(10.0, vec![linea(12.1, 1, Some(21.0))]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 1);
        assert!(cerca(d[0].0, 21.0));
        assert!(cerca(d[0].1, 10.0), "base {}", d[0].1);
    }

    #[test]
    fn un_ticket_con_dos_tipos_los_separa_y_suma_lo_mismo_que_el_total() {
        // Comida al 10 y algo envasado para llevar al 21, que es el caso que obligó a esto.
        let p = payload(10.0, vec![linea(11.0, 1, None), linea(12.1, 1, Some(21.0))]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 2);
        // Ordenado por tipo: primero el 10, luego el 21.
        assert!(cerca(d[0].0, 10.0) && cerca(d[1].0, 21.0));
        assert!(cerca(d[0].1, 10.0) && cerca(d[0].2, 1.0));
        assert!(cerca(d[1].1, 10.0) && cerca(d[1].2, 2.1));

        // Y lo que de verdad importa: base + IVA de todos los tramos == lo cobrado.
        let suma: f64 = d.iter().map(|(_, base, iva)| base + iva).sum();
        assert!(cerca(suma, 23.1), "suma {suma}");
    }

    #[test]
    fn las_lineas_del_mismo_tipo_se_agrupan_en_un_solo_tramo() {
        let p = payload(
            10.0,
            vec![linea(11.0, 1, Some(21.0)), linea(11.0, 1, Some(21.0)), linea(11.0, 1, None)],
        );
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 2);
        // Los dos del 21 suman 22 € con IVA.
        let tramo21 = d.iter().find(|(t, _, _)| cerca(*t, 21.0)).unwrap();
        assert!(cerca(tramo21.1 + tramo21.2, 22.0));
    }

    #[test]
    fn un_ticket_vacio_no_revienta() {
        let d = desglose_iva(&payload(10.0, vec![]));
        assert!(d.is_empty());
    }

    #[test]
    fn un_tipo_del_cero_por_ciento_no_divide_entre_cero() {
        let p = payload(0.0, vec![linea(10.0, 1, Some(0.0))]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 1);
        assert!(cerca(d[0].1, 10.0), "base {}", d[0].1);
        assert!(cerca(d[0].2, 0.0), "iva {}", d[0].2);
    }
}

#[cfg(test)]
mod tests_identidad_del_ticket {
    //! Qué papel es cada papel.
    //!
    //! Con numeración aparecen dos documentos que no se pueden confundir: la PRECUENTA (antes de
    //! cobrar, sin número) y el TICKET (tras el cobro, numerado). Y una reimpresión sale con el
    //! mismo número que el original, así que tiene que decir que es una COPIA — si no, dos papeles
    //! idénticos parecen dos ventas.
    //!
    //! Se comprueba sobre los bytes ESC/POS: es lo que de verdad sale por la impresora.

    use super::*;

    fn base(items: Vec<PrintTicketLine>) -> PrintTicketPayload {
        PrintTicketPayload {
            printer_name: None,
            business_name: "Bar".into(),
            direccion: String::new(),
            telefono: String::new(),
            cif: String::new(),
            mensaje_footer: String::new(),
            iva_percent: 10.0,
            show_logo: false,
            show_business_name: true,
            show_address: false,
            show_phone: false,
            show_cif: false,
            show_date_time: false,
            show_line_items: true,
            show_base_and_iva: true,
            show_total: true,
            show_footer_message: false,
            paper_width_mm: 80,
            paper_dpi: 203,
            chars_per_line: 42,
            margin_top_mm: 0.0,
            margin_bottom_mm: 0.0,
            margin_left_mm: 0.0,
            margin_right_mm: 0.0,
            font_scale: 1.0,
            numero_ticket: None,
            metodo_pago: None,
            origen: None,
            es_copia: false,
            items,
        }
    }

    fn linea() -> PrintTicketLine {
        PrintTicketLine {
            nombre: "Cafe".into(),
            cantidad: 1,
            precio_unitario: 1.1,
            iva_percent: None,
        }
    }

    /// El ticket se codifica en CP858; para buscar texto ASCII basta con leerlo como bytes.
    fn contiene(bytes: &[u8], texto: &str) -> bool {
        bytes
            .windows(texto.len())
            .any(|w| w == texto.as_bytes())
    }

    #[test]
    fn sin_numero_es_una_precuenta_y_lo_dice() {
        let bytes = build_ticket(&base(vec![linea()]));

        assert!(contiene(&bytes, "PRECUENTA"));
        assert!(
            contiene(&bytes, "NO ES UN TICKET DE VENTA"),
            "una precuenta no puede parecer un ticket de venta"
        );
    }

    #[test]
    fn con_numero_sale_el_numero_y_no_el_aviso() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000042".into());
        let bytes = build_ticket(&p);

        assert!(contiene(&bytes, "T-000042"));
        assert!(!contiene(&bytes, "PRECUENTA"));
        assert!(!contiene(&bytes, "NO ES UN TICKET DE VENTA"));
    }

    #[test]
    fn una_reimpresion_lleva_el_mismo_numero_y_dice_COPIA() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000042".into());
        p.es_copia = true;
        let bytes = build_ticket(&p);

        assert!(contiene(&bytes, "T-000042"));
        assert!(contiene(&bytes, "COPIA"));
    }

    #[test]
    fn una_precuenta_nunca_se_marca_como_copia() {
        // Sin número no hay original del que ser copia: el aviso que toca es el de precuenta.
        let mut p = base(vec![linea()]);
        p.es_copia = true;
        let bytes = build_ticket(&p);

        assert!(contiene(&bytes, "NO ES UN TICKET DE VENTA"));
        assert!(!contiene(&bytes, "COPIA"));
    }

    #[test]
    fn el_origen_y_el_metodo_salen_impresos() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000007".into());
        p.origen = Some("Mesa 5".into());
        p.metodo_pago = Some("Tarjeta".into());
        let bytes = build_ticket(&p);

        assert!(contiene(&bytes, "Mesa 5"));
        assert!(contiene(&bytes, "Tarjeta"));
    }

    /// `ESC p 0 25 250` — el pulso al solenoide del cajón.
    const PULSO_CAJON: [u8; 5] = [0x1B, 0x70, 0x00, 0x19, 0xFA];

    #[test]
    fn cobrando_en_efectivo_el_ticket_abre_el_cajon() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000001".into());
        p.metodo_pago = Some("Efectivo".into());
        let bytes = build_ticket(&p);

        assert!(
            bytes.windows(5).any(|w| w == PULSO_CAJON),
            "un cobro en efectivo tiene que abrir el cajón"
        );
    }

    #[test]
    fn cobrando_con_tarjeta_el_cajon_no_se_abre() {
        // Abrirlo sin motivo delante del cliente es exponer el dinero.
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000001".into());
        p.metodo_pago = Some("Tarjeta".into());
        let bytes = build_ticket(&p);

        assert!(!bytes.windows(5).any(|w| w == PULSO_CAJON));
    }

    #[test]
    fn una_precuenta_no_abre_el_cajon() {
        // No hay cobro: no hay dinero que meter.
        let bytes = build_ticket(&base(vec![linea()]));
        assert!(!bytes.windows(5).any(|w| w == PULSO_CAJON));
    }

    #[test]
    fn el_metodo_se_reconoce_sin_importar_mayusculas_ni_espacios() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000001".into());
        p.metodo_pago = Some("  EFECTIVO  ".into());
        let bytes = build_ticket(&p);

        assert!(bytes.windows(5).any(|w| w == PULSO_CAJON));
    }

    #[test]
    fn el_boton_manual_abre_sin_sacar_papel() {
        // Variante en tiempo real: la impresora la atiende aunque tenga trabajos por delante, que
        // es lo que hace util un boton para dar cambio.
        let bytes = build_abrir_cajon();

        assert_eq!(bytes, vec![0x10, 0x14, 0x01, 0x00, 0x02]);
        assert!(!bytes.contains(&0x0A), "no debe imprimir ninguna linea");
    }

    #[test]
    fn un_numero_en_blanco_cuenta_como_precuenta() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("   ".into());
        let bytes = build_ticket(&p);

        assert!(contiene(&bytes, "PRECUENTA"));
    }
}
