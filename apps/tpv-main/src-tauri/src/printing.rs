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

/// Columnas de caracteres (fuente A) según el ancho de papel. Sirve de tope físico razonable
/// cuando no hay un DPI/margen fiable con el que calcular el ancho útil real.
fn cols_for(paper_width_mm: u32) -> usize {
    match paper_width_mm {
        58 => 32,
        112 => 64,
        _ => 48, // 80mm
    }
}

/// Ancho aproximado de un carácter de la fuente A en dots (12 dots ≈ estándar térmico).
const CHAR_DOTS: u32 = 12;

/// Convierte milímetros a dots según el DPI de la impresora.
fn mm_to_dots(mm: f64, dpi: u32) -> u32 {
    if mm <= 0.0 {
        0
    } else {
        ((mm / 25.4) * dpi as f64).round() as u32
    }
}

/// Columnas efectivas del cuerpo: parte de `chars_per_line` deseado pero lo acota al ancho
/// físico disponible (ancho de papel − márgenes izq/dcha), para no desbordar el papel.
fn effective_cols(p: &PrintTicketPayload) -> usize {
    let dpi = if p.paper_dpi == 300 { 300 } else { 203 };
    let paper_dots = mm_to_dots(p.paper_width_mm as f64, dpi);
    let left_dots = mm_to_dots(p.margin_left_mm, dpi);
    let right_dots = mm_to_dots(p.margin_right_mm, dpi);
    let avail = paper_dots.saturating_sub(left_dots + right_dots);
    let desired = p.chars_per_line.clamp(20, 80) as usize;
    let physical_max = if avail == 0 {
        cols_for(p.paper_width_mm)
    } else {
        (avail / CHAR_DOTS) as usize
    };
    desired.min(physical_max).max(10)
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

    if p.show_date_time {
        let fecha = chrono::Local::now().format("%d/%m/%Y %H:%M").to_string();
        text_line(&mut out, &line_two(&fecha, "VENTA", cols));
    } else {
        text_line(&mut out, &line_two("", "VENTA", cols));
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
        let divisor = 1.0 + p.iva_percent / 100.0;
        let base = if divisor == 0.0 { total } else { total / divisor };
        let iva = total - base;
        text_line(&mut out, &line_two("BASE", &fmt_eur(base), cols));
        text_line(
            &mut out,
            &line_two(&format!("IVA ({}%)", fmt_pct(p.iva_percent)), &fmt_eur(iva), cols),
        );
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
