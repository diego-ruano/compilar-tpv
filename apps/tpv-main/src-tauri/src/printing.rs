//! Servicio de impresión (host/OS) — fuera de la arquitectura hexagonal a propósito.
//!
//! Es una preocupación de hardware/SO (como `save_image` en `main.rs`), no lógica de negocio,
//! así que NO pasa por las crates `tpv-*`. Habla directamente con la **API de Windows**
//! (winspool) por FFI:
//!   - `list_printers()`  → `EnumPrintersW` (locales + conexiones de red/WiFi) + impresora por
//!     defecto vía `GetDefaultPrinterW`.
//!   - `print_raw()`      → `OpenPrinterW` + `StartDocPrinterW` (datatype "RAW") + `WritePrinter`,
//!     es decir: Windows hace de puente y manda los bytes tal cual a la impresora. Antes purga los
//!     trabajos del TPV atascados en la cola y, si Windows dice que la impresora no puede
//!     imprimir, no manda nada (RI-29).
//!
//! Además construye el ticket en **ESC/POS** (`build_ticket`) replicando la personalización del
//! front (`PreviewModal`): qué elementos se muestran, ancho de papel, IVA, líneas, total, footer.

use tpv_domain::dinero::Dinero;
use tpv_domain::ticket::{LineaTicket, TramoIva};

// Lo que cruza la frontera con la pantalla (el ticket, el arqueo, la lista de impresoras) vive en
// `tpv-contracts`, que es de donde sale su tipo en TypeScript (RI-53). Aquí sólo se construye el
// papel.
pub use tpv_contracts::impresion::{
    GeometriaTicket, PrintArqueoPayload, PrintTicketPayload, PrinterInfo,
};

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
pub(crate) fn fmt_eur(n: Dinero) -> String {
    format!("{} €", n.texto_fiscal()).replace('.', ",")
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

/// Desglose de IVA del papel.
///
/// En una factura es el **declarado** (`p.desglose`, leído de su `Desglose_Json`): el papel dice
/// lo que se declaró en el registro, no un recálculo (RI-29). Sólo la precuenta, que no tiene registro, lo calcula
/// de las líneas con `tpv_domain::ticket`.
///
/// **La cuenta no vive aquí desde FISCAL-01.** Tiene tres consumidores —este generador, la vista
/// previa de `TicketPaper.tsx` y el `Desglose` del registro de facturación— y tres copias de la
/// misma aritmética es exactamente la divergencia que no se ve hasta que el papel y el registro
/// dicen cosas distintas del mismo cobro. Las reglas (la cuota se despeja, no
/// se redondea) están documentadas allí.
///
/// Una línea sin tipo propio usa el general del negocio, que es el caso de casi todo.
pub(crate) fn desglose_iva(p: &PrintTicketPayload) -> Vec<TramoIva> {
    if let Some(declarado) = &p.desglose {
        return declarado
            .iter()
            .map(|t| TramoIva { tipo: t.tipo, base: t.base, cuota: t.cuota })
            .collect();
    }
    let lineas: Vec<LineaTicket> = p
        .items
        .iter()
        .map(|it| LineaTicket {
            total_con_iva: it.precio_unitario.por(it.cantidad as i64),
            tipo_iva: it.iva_percent.unwrap_or(p.iva_percent),
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
///
/// AUD-30: los bytes son los de `Logo_DataUrl`, que llega replicado, así que se decodifican con
/// las mismas cotas con que se guarda una imagen (`imagenes::decodificar`) y no con las de
/// `image`, que dejan pasar un PNG de 65 KB que pide 3 GiB.
pub fn rasterizar_logo(bytes: &[u8], ancho_max_dots: u32) -> Option<Vec<u8>> {
    logo_o_nada(|| {
        crate::imagenes::decodificar(bytes).map(|(img, _)| rasterizar(img, ancho_max_dots))
    })
}

/// El bloque del logo, o `None` con un aviso si no se ha podido hacer.
///
/// AUD-30: también si el intento acaba en pánico. Los decodificadores son de terceros y lo que
/// leen puede venir hecho a mala idea; un pánico aquí mataría la tarea del comando, que no
/// contestaría nunca, y nada de lo que rodea al ticket puede impedir que salga.
fn logo_o_nada(
    intento: impl FnOnce() -> Result<Vec<u8>, String> + std::panic::UnwindSafe,
) -> Option<Vec<u8>> {
    match std::panic::catch_unwind(intento) {
        Ok(Ok(bloque)) => Some(bloque),
        Ok(Err(motivo)) => {
            tracing::warn!(target: "tpv::impresion", %motivo, "el logo no se puede imprimir: el ticket sale sin él");
            None
        }
        Err(_) => {
            tracing::warn!(target: "tpv::impresion", "pánico al rasterizar el logo: el ticket sale sin él");
            None
        }
    }
}

/// La imagen ya decodificada, como bloque `GS v 0`.
///
/// La imagen se entrega, no se presta, para no tener a la vez más copias de las que hacen falta
/// (AUD-30): lo más que conviven son la imagen y su copia RGBA mientras se convierte. Después
/// quedan esa copia y el plano gris, y al redimensionar, el plano gris y el intermedio.
fn rasterizar(img: image::DynamicImage, ancho_max_dots: u32) -> Vec<u8> {
    // El ancho se ajusta al papel; el alto va en proporción. Se usa un múltiplo de 8 porque cada
    // byte de la trama son 8 puntos horizontales.
    let ancho = ancho_max_dots.min(img.width().max(1)).max(8) & !7;
    let alto = ((img.height() as f64) * (ancho as f64) / (img.width().max(1) as f64)).round() as u32;
    let alto = alto.clamp(1, 1024); // tope de seguridad: un logo no puede comerse el rollo

    // La transparencia se compone sobre BLANCO antes de nada. Casi todos los logos son un PNG
    // con el fondo transparente, y `to_luma8()` tira el canal alfa: los píxeles de fuera del
    // dibujo (que suelen ser negro con alfa 0) se leían como negro opaco y el logo salía como un
    // rectángulo de tinta. El papel es blanco, así que lo transparente es blanco.
    //
    // `into_rgba8` da los mismos píxeles que `to_rgba8`, pero si la imagen ya es RGBA no la copia
    // y, si no lo es, suelta el original en cuanto la ha convertido.
    let rgba = img.into_rgba8();
    let mut plano = image::GrayImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let luma = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
        let alfa = a as f32 / 255.0;
        let sobre_blanco = luma * alfa + 255.0 * (1.0 - alfa);
        plano.put_pixel(x, y, image::Luma([sobre_blanco.round() as u8]));
    }
    // La copia RGBA ya no hace falta, y el redimensionado reserva su propio intermedio (16 bytes
    // por cada píxel del ancho original y del alto de salida).
    drop(rgba);

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
    out
}

/// Lo que distingue el papel de una factura que no es un ticket. Todo sale del registro (RI-29):
///
/// - Una **rectificativa** (`R1`–`R5`) se titula FACTURA RECTIFICATIVA y dice qué factura rectifica
///   y de qué fecha: la «referencia expresa e inequívoca» de los arts. 7.1.h y 15.4 del RD
///   1619/2012.
/// - Una **completa** (`F1`/`F3`) se titula FACTURA; una `F3` dice además qué factura sustituye.
/// - Las dos llevan al cliente, si lo tienen: nombre, NIF y domicilio (art. 6.1 c, d y e).
fn bloque_tipo_de_factura(out: &mut Vec<u8>, p: &PrintTicketPayload, cols: usize) {
    let tipo = p.tipo_factura.as_deref().unwrap_or("");
    let titulo = match tipo {
        "R1" | "R2" | "R3" | "R4" | "R5" => "FACTURA RECTIFICATIVA",
        "F1" | "F3" => "FACTURA",
        _ => return,
    };
    esc_align(out, 1);
    esc_bold(out, true);
    text_wrap(out, titulo, cols);
    esc_bold(out, false);
    esc_align(out, 0);
    if let Some(n) = p.rectifica.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let fecha = p.rectifica_fecha.as_deref().map(str::trim).unwrap_or("");
        let texto = if fecha.is_empty() {
            format!("Rectifica a la factura {n}")
        } else {
            format!("Rectifica a la factura {n} del {fecha}")
        };
        text_wrap(out, &texto, cols);
    }
    // Lo que sustituye una F3: un ticket, varios (un canje de un periodo) o una rectificativa.
    let sustituidas: Vec<&str> = p.sustituye.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).collect();
    match sustituidas.as_slice() {
        [] => {}
        [una] => text_wrap(out, &format!("Sustituye a la factura {una}"), cols),
        varias => text_wrap(out, &format!("Sustituye a las facturas {}", varias.join(", ")), cols),
    }
    if let Some(d) = &p.destinatario {
        sep(out, cols);
        text_wrap(out, &format!("Cliente: {}", d.nombre_razon.trim()), cols);
        text_wrap(out, &format!("NIF: {}", d.nif.trim()), cols);
        if let Some(dom) = d.domicilio.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            text_wrap(out, dom, cols);
        }
    }
}

/// Los cobros cuyo ticket original ya ha salido en esta sesión de la app.
///
/// El original abre el cajón (si se pagó en efectivo); imprimirlo otra vez —dos pulsaciones, o el
/// cliente que pide otro— no es un cobro nuevo: sale como COPIA y sin abrir el cajón. Basta con
/// recordarlo en memoria: el original sólo lo imprime la pantalla del cobro, que olvida su último
/// cobro al cambiar de comanda o al reiniciar, y Cuentas pide siempre la copia.
#[derive(Default)]
pub struct TicketsImpresos(std::sync::Mutex<std::collections::HashSet<String>>);

impl TicketsImpresos {
    pub fn ya_impreso(&self, id_pago: &str) -> bool {
        self.0.lock().map(|s| s.contains(id_pago.trim())).unwrap_or(false)
    }

    pub fn anotar(&self, id_pago: &str) {
        if let Ok(mut s) = self.0.lock() {
            s.insert(id_pago.trim().to_string());
        }
    }
}

/// Lo que la pantalla manda a imprimir es **siempre una precuenta** (RI-29): se le quita todo lo
/// fiscal. Un papel con número o con la marca de copia sólo sale de `ticket_de_pago`, que lo lee
/// de la base; si la pantalla pudiera ponerlos, podría imprimir una factura que no es la del cobro.
pub fn como_precuenta(mut p: PrintTicketPayload) -> PrintTicketPayload {
    p.numero_ticket = None;
    p.fecha = None;
    p.metodo_pago = None;
    p.es_copia = false;
    p.es_anulado = false;
    p.abre_cajon = false;
    p.desglose = None;
    p.total = None;
    p.tipo_factura = None;
    p.destinatario = None;
    p.sustituye = Vec::new();
    p.rectifica = None;
    p.rectifica_fecha = None;
    p.facturas_del_cobro = Vec::new();
    p
}

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
    // La razón social es quien factura, y no se puede ocultar (RI-29). Si coincide con el rótulo
    // que ya se ha impreso, repetirla no añade nada.
    let razon = p.razon_social.trim();
    let ya_impresa = p.show_business_name && razon.eq_ignore_ascii_case(p.business_name.trim());
    if !razon.is_empty() && !ya_impresa {
        text_wrap(&mut out, razon, cols);
    }
    if p.show_address && !p.direccion.trim().is_empty() {
        text_wrap(&mut out, &p.direccion, cols);
    }
    if p.show_phone && !p.telefono.trim().is_empty() {
        text_wrap(&mut out, &format!("Tel: {}", p.telefono), cols);
    }
    if !p.cif.trim().is_empty() {
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
    // La fecha de una factura es la de expedición, que viene del registro: una copia de mañana
    // dice el día de la venta (RI-29). Sólo la precuenta lleva la de ahora.
    let fecha = p
        .fecha
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Local::now().format("%d/%m/%Y %H:%M").to_string());
    text_line(&mut out, &line_two(&fecha, &etiqueta, cols));

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
        bloque_tipo_de_factura(&mut out, p, cols);
    }

    sep(&mut out, cols);

    // El total de una factura es su `Importe_Total`; el de la precuenta, la suma de las líneas.
    let total: Dinero = p.total.unwrap_or_else(|| {
        p.items
            .iter()
            .map(|it| it.precio_unitario.por(it.cantidad as i64))
            .sum()
    });

    if p.items.is_empty() {
        esc_align(&mut out, 1);
        text_wrap(&mut out, "No hay productos en el ticket.", cols);
        esc_align(&mut out, 0);
    } else {
        for it in &p.items {
            let line_total = it.precio_unitario.por(it.cantidad as i64);
            text_line(&mut out, &line_two(&it.nombre, &fmt_eur(line_total), cols));
            text_line(
                &mut out,
                &format!("  {} x {}", it.cantidad, fmt_eur(it.precio_unitario)),
            );
        }
    }

    sep(&mut out, cols);

    // ── Base + IVA ──
    let tramos = desglose_iva(p);
    match tramos.as_slice() {
        // Sin líneas: el ticket sigue enseñando su base y su IVA a cero, como toda la vida.
        [] => {
            text_line(&mut out, &line_two("BASE", &fmt_eur(Dinero::CERO), cols));
            text_line(
                &mut out,
                &line_two(&format!("IVA ({}%)", fmt_pct(p.iva_percent)), &fmt_eur(Dinero::CERO), cols),
            );
        }
        // Un solo tipo (el caso de un bar normal): se imprime como toda la vida, sin convertir
        // el ticket en una tabla por algo que no aporta nada.
        [TramoIva { tipo, base, cuota }] => {
            text_line(&mut out, &line_two("BASE", &fmt_eur(*base), cols));
            text_line(
                &mut out,
                &line_two(&format!("IVA ({}%)", fmt_pct(*tipo)), &fmt_eur(*cuota), cols),
            );
        }
        // Varios tramos: hay que verlos por separado. Un ticket con comida al reducido y algo
        // envasado para llevar al general no se puede resumir en una sola cifra.
        _ => {
            for TramoIva { tipo, base, cuota } in &tramos {
                text_line(
                    &mut out,
                    &line_two(&format!("BASE ({}%)", fmt_pct(*tipo)), &fmt_eur(*base), cols),
                );
                text_line(
                    &mut out,
                    &line_two(&format!("IVA ({}%)", fmt_pct(*tipo)), &fmt_eur(*cuota), cols),
                );
            }
        }
    }

    // ── Total ──
    sep(&mut out, cols);
    esc_bold(&mut out, true);
    esc_size(&mut out, 0x11);
    // Con tamaño doble caben la mitad de columnas.
    text_line(&mut out, &line_two("TOTAL", &fmt_eur(total), cols / 2));
    esc_size(&mut out, base_size);
    esc_bold(&mut out, false);

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

    // El cajón se abre SOLO con el ticket original de un cobro en efectivo (`abre_cajon`, que
    // decide `ticket_de_pago`): en tarjeta no hace falta, y abrirlo con una copia es abrirlo sin
    // venta. Va después del corte, con el ticket ya fuera.
    if p.abre_cajon {
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

/// El papel del arqueo (CUENTA-06).
///
/// Es un **documento interno**, no un ticket de venta, y de ahí salen sus tres diferencias:
/// - **No consume numeración.** No reserva número de la serie: gastar un correlativo en un
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
    // Sólo si los hay: una línea a cero en todos los arqueos de un bar que no paga nada con caja
    // sería ruido en el papel que se lee buscando un descuadre.
    if !p.gastos_caja.es_cero() {
        text_line(&mut out, &line_two("Gastos de caja", &format!("-{}", fmt_eur(p.gastos_caja)), cols));
    }
    esc_bold(&mut out, true);
    text_line(&mut out, &line_two("Deberia haber", &fmt_eur(p.esperado), cols));
    text_line(&mut out, &line_two("Contado", &fmt_eur(p.contado), cols));
    esc_bold(&mut out, false);

    sep(&mut out, cols);
    // El descuadre es lo que se busca al coger este papel, así que va en grande y con su signo.
    esc_bold(&mut out, true);
    esc_size(&mut out, 0x01);
    let etiqueta = etiqueta_descuadre(p.descuadre);
    text_line(&mut out, &etiqueta);
    esc_size(&mut out, 0x00);
    esc_bold(&mut out, false);

    if let Some(m) = p.motivo.as_deref().filter(|m| !m.trim().is_empty()) {
        text_wrap(&mut out, &format!("Motivo: {}", m.trim()), cols);
    }

    // CAJA-01. Lo de arriba es la foto de esa noche y no cambia; si después se corrigió un apunte
    // de su periodo, el papel dice aparte lo que marca hoy y por qué. La flecha de la descripción
    // no está en CP858: se escribe con lo que la impresora sí sabe.
    if let (Some(esperado), Some(descuadre)) = (p.rect_esperado, p.rect_descuadre) {
        sep(&mut out, cols);
        esc_bold(&mut out, true);
        text_line(&mut out, "RECTIFICADO DESPUES");
        esc_bold(&mut out, false);
        text_line(&mut out, &line_two("Deberia haber hoy", &fmt_eur(esperado), cols));
        text_line(&mut out, &line_two("Hoy", &etiqueta_descuadre(descuadre), cols));
        for r in &p.rectificaciones {
            let descripcion = r.descripcion.trim().replace('→', "->");
            text_wrap(&mut out, &format!("{} {}", r.fecha_hora.trim(), descripcion), cols);
            if let Some(m) = r.motivo.as_deref().filter(|m| !m.trim().is_empty()) {
                text_wrap(&mut out, &format!("  Motivo: {}", m.trim()), cols);
            }
        }
    }

    sep(&mut out, cols);
    text_line(&mut out, &line_two("Se deja en el cajon", &fmt_eur(p.dejado), cols));
    text_line(&mut out, &line_two("Se retira", &fmt_eur(p.retirado), cols));

    // El desglose por denominación es lo que convierte "faltan 50" en "falta un billete de 50".
    let denoms: Vec<&(Dinero, i64)> = p.contado_denoms.iter().filter(|(_, u)| *u > 0).collect();
    if !denoms.is_empty() {
        sep(&mut out, cols);
        text_line(&mut out, "Recuento");
        for (valor, unidades) in denoms {
            let izq = format!("  {} x {}", unidades, fmt_eur(*valor));
            text_line(
                &mut out,
                &line_two(&izq, &fmt_eur(valor.por(*unidades)), cols),
            );
        }
    }

    esc_feed_dots(&mut out, mm_to_dots(p.margin_bottom_mm, dpi));
    esc_feed(&mut out, 4);
    esc_cut(&mut out);
    out
}

/// El descuadre en palabras: un número con signo se lee mal a las dos de la mañana.
fn etiqueta_descuadre(descuadre: Dinero) -> String {
    if descuadre.es_cero() {
        "CUADRA".to_string()
    } else if descuadre.es_negativo() {
        format!("FALTAN {}", fmt_eur(-descuadre))
    } else {
        format!("SOBRAN {}", fmt_eur(descuadre))
    }
}

/// Formatea un porcentaje sin decimales innecesarios (`10` en vez de `10,00`).
pub(crate) fn fmt_pct(n: f64) -> String {
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
// La cola de Windows (RI-29)
// ──────────────────────────────────────────────────────────────────────────────
//
// `WritePrinter` no habla con la impresora: deja el trabajo en la cola de Windows y dice que sí.
// Con la impresora apagada, el ticket se quedaba en la cola, el TPV lo daba por impreso y, al
// encenderla, salían de golpe todos los atrasados —y se abría el cajón por cada uno que llevara el
// pulso—. Ahora, antes de mandar, se borran los trabajos del TPV que llevan más de
// [`MINUTOS_ATASCADO`] en la cola y se pregunta a Windows por el estado de la impresora: si dice
// que no puede imprimir, no se manda nada y se avisa. Si no sabe decirlo (hay drivers que no
// informan), se manda igual.

/// Los trabajos del TPV llevan este prefijo en su nombre de documento: es lo que los distingue de
/// los de cualquier otro programa al purgar la cola.
const PREFIJO_DOC: &str = "TPV · ";
pub const DOC_TICKET: &str = "TPV · Ticket";
pub const DOC_ARQUEO: &str = "TPV · Cierre de caja";
pub const DOC_CAJON: &str = "TPV · Abrir cajón";
pub const DOC_PRUEBA: &str = "TPV · Prueba";

/// Lo que puede llevar un trabajo del TPV en la cola antes de darlo por atascado. Un ticket que
/// sale media hora tarde no le sirve a nadie, y un pulso de cajón atrasado lo abre sin nadie
/// delante.
const MINUTOS_ATASCADO: u64 = 5;

fn es_trabajo_del_tpv(documento: &str) -> bool {
    documento.starts_with(PREFIJO_DOC)
}

/// `enviado` y `ahora` en unidades de `FILETIME` (centenas de nanosegundos).
fn esta_atascado(enviado: u64, ahora: u64) -> bool {
    ahora.saturating_sub(enviado) >= MINUTOS_ATASCADO * 60 * 10_000_000
}

/// Por qué Windows dice que la impresora no puede imprimir ahora (`PRINTER_INFO_2`), o `None` si
/// no dice nada. El ahorro de energía no cuenta: la impresora despierta al recibir el trabajo.
fn motivo_no_disponible(status: u32, attributes: u32) -> Option<&'static str> {
    const ATTRIBUTE_WORK_OFFLINE: u32 = 0x0000_0400;
    const PAUSED: u32 = 0x0000_0001;
    const ERROR: u32 = 0x0000_0002;
    const PENDING_DELETION: u32 = 0x0000_0004;
    const PAPER_JAM: u32 = 0x0000_0008;
    const PAPER_OUT: u32 = 0x0000_0010;
    const OFFLINE: u32 = 0x0000_0080;
    const NOT_AVAILABLE: u32 = 0x0000_1000;
    const USER_INTERVENTION: u32 = 0x0010_0000;
    const DOOR_OPEN: u32 = 0x0040_0000;

    let tiene = |bit: u32| status & bit != 0;
    if tiene(OFFLINE) || tiene(NOT_AVAILABLE) || attributes & ATTRIBUTE_WORK_OFFLINE != 0 {
        Some("desconectada o apagada")
    } else if tiene(PAUSED) {
        Some("en pausa")
    } else if tiene(PAPER_OUT) {
        Some("sin papel")
    } else if tiene(PAPER_JAM) {
        Some("con el papel atascado")
    } else if tiene(DOOR_OPEN) {
        Some("con la tapa abierta")
    } else if tiene(PENDING_DELETION) {
        Some("eliminándose de Windows")
    } else if tiene(ERROR) || tiene(USER_INTERVENTION) {
        Some("con un error")
    } else {
        None
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Implementación específica de plataforma (Windows winspool / stub)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    // Los nombres de aqui son los de la API de Win32 tal cual (`OpenPrinterW`, `HANDLE`, `BOOL`):
    // traducirlos a snake case o a `Handle` rompe la correspondencia con la documentacion de
    // Microsoft, que es lo unico con lo que se puede cotejar esta capa.
    #![allow(non_snake_case, clippy::upper_case_acronyms)]
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

    /// `PRINTER_INFO_2W`. Sólo se leen `attributes` y `status`, pero la estructura tiene que estar
    /// entera para que los desplazamientos coincidan con los de Windows.
    #[repr(C)]
    struct PrinterInfo2W {
        p_server_name: *mut u16,
        p_printer_name: *mut u16,
        p_share_name: *mut u16,
        p_port_name: *mut u16,
        p_driver_name: *mut u16,
        p_comment: *mut u16,
        p_location: *mut u16,
        p_dev_mode: *mut c_void,
        p_sep_file: *mut u16,
        p_print_processor: *mut u16,
        p_datatype: *mut u16,
        p_parameters: *mut u16,
        p_security_descriptor: *mut c_void,
        attributes: u32,
        priority: u32,
        default_priority: u32,
        start_time: u32,
        until_time: u32,
        status: u32,
        c_jobs: u32,
        average_ppm: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SystemTime {
        campos: [u16; 8],
    }

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn valor(&self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }

    /// `JOB_INFO_1W`.
    #[repr(C)]
    struct JobInfo1W {
        job_id: u32,
        p_printer_name: *mut u16,
        p_machine_name: *mut u16,
        p_user_name: *mut u16,
        p_document: *mut u16,
        p_datatype: *mut u16,
        p_status: *mut u16,
        status: u32,
        priority: u32,
        position: u32,
        total_pages: u32,
        pages_printed: u32,
        submitted: SystemTime,
    }

    const JOB_CONTROL_DELETE: u32 = 5;

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
        fn GetPrinterW(hprinter: HANDLE, level: u32, pprinter: *mut u8, cbbuf: u32, pcbneeded: *mut u32) -> BOOL;
        fn EnumJobsW(
            hprinter: HANDLE,
            firstjob: u32,
            nojobs: u32,
            level: u32,
            pjob: *mut u8,
            cbbuf: u32,
            pcbneeded: *mut u32,
            pcreturned: *mut u32,
        ) -> BOOL;
        fn SetJobW(hprinter: HANDLE, jobid: u32, level: u32, pjob: *mut u8, command: u32) -> BOOL;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimeAsFileTime(lpsystemtimeasfiletime: *mut FileTime);
        fn SystemTimeToFileTime(lpsystemtime: *const SystemTime, lpfiletime: *mut FileTime) -> BOOL;
    }

    /// `(status, attributes)` de `PRINTER_INFO_2`, o `None` si Windows no lo da.
    unsafe fn estado(hprinter: HANDLE) -> Option<(u32, u32)> {
        let mut needed: u32 = 0;
        GetPrinterW(hprinter, 2, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            return None;
        }
        // Alineado a 8 bytes: la estructura lleva punteros.
        let mut buf: Vec<u64> = vec![0u64; (needed as usize).div_ceil(8)];
        if GetPrinterW(hprinter, 2, buf.as_mut_ptr() as *mut u8, needed, &mut needed) == 0 {
            return None;
        }
        let info = &*(buf.as_ptr() as *const PrinterInfo2W);
        Some((info.status, info.attributes))
    }

    /// Borra de la cola los trabajos del TPV atascados y devuelve cuántos borró. Si no puede, no
    /// pasa nada: es una limpieza, no una condición para imprimir.
    unsafe fn purgar_atascados(hprinter: HANDLE) -> u32 {
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        EnumJobsW(hprinter, 0, 1000, 1, std::ptr::null_mut(), 0, &mut needed, &mut returned);
        if needed == 0 {
            return 0;
        }
        let mut buf: Vec<u64> = vec![0u64; (needed as usize).div_ceil(8)];
        let ok = EnumJobsW(
            hprinter,
            0,
            1000,
            1,
            buf.as_mut_ptr() as *mut u8,
            needed,
            &mut needed,
            &mut returned,
        );
        if ok == 0 {
            return 0;
        }

        let mut ahora = FileTime::default();
        GetSystemTimeAsFileTime(&mut ahora);

        let trabajos = buf.as_ptr() as *const JobInfo1W;
        let mut borrados = 0;
        for i in 0..returned as usize {
            let t = &*trabajos.add(i);
            if !super::es_trabajo_del_tpv(&wide_to_string(t.p_document)) {
                continue;
            }
            // `Submitted` va en UTC, igual que `GetSystemTimeAsFileTime`.
            let mut enviado = FileTime::default();
            if SystemTimeToFileTime(&t.submitted, &mut enviado) == 0 {
                continue;
            }
            if super::esta_atascado(enviado.valor(), ahora.valor())
                && SetJobW(hprinter, t.job_id, 0, std::ptr::null_mut(), JOB_CONTROL_DELETE) != 0
            {
                borrados += 1;
            }
        }
        borrados
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
            let n_u64 = (needed as usize).div_ceil(8);
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
                let purgados = purgar_atascados(hprinter);
                if purgados > 0 {
                    tracing::warn!(
                        target: "tpv::impresion",
                        purgados,
                        "trabajos del TPV atascados en la cola de Windows, borrados"
                    );
                }
                let no_disponible =
                    estado(hprinter).and_then(|(status, atributos)| super::motivo_no_disponible(status, atributos));
                if let Some(motivo) = no_disponible {
                    return Err(format!(
                        "La impresora «{printer_name}» está {motivo}. No se ha mandado nada a la \
                         cola: vuelve a imprimir cuando esté lista."
                    ));
                }
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
