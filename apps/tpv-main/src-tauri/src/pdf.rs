//! Un escritor de PDF mínimo: páginas A4, texto con las fuentes estándar Helvetica y Helvetica-Bold,
//! líneas, rectángulos y, como mucho, una imagen JPEG. Es lo que necesita el PDF de una factura
//! (`factura_pdf.rs`) y nada más.
//!
//! **Por qué no un crate.** Las fuentes estándar del PDF no se incrustan (todo visor las trae), y
//! con la codificación `WinAnsiEncoding` cubren lo que escribe un bar en España: tildes, ñ, ü, ç,
//! ¿, ¡ y el €. Con eso, escribir el fichero son unos objetos de texto y una tabla de posiciones;
//! una dependencia para esto traería tipografías, compresión y un modelo de documento que no se
//! usan.
//!
//! **Determinista**: los mismos datos dan los mismos bytes. No lleva fecha de creación ni
//! identificador aleatorio, y el contenido de las páginas va sin comprimir (una factura son unas
//! decenas de KB), lo que además deja leer el texto en los tests.

/// Ancho y alto de un A4 en puntos (1/72 de pulgada).
pub(crate) const A4: (f64, f64) = (595.0, 842.0);

/// Las dos fuentes del documento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fuente {
    Normal,
    Negrita,
}

impl Fuente {
    fn recurso(self) -> &'static str {
        match self {
            Fuente::Normal => "F1",
            Fuente::Negrita => "F2",
        }
    }
}

/// Una imagen JPEG en RGB, que el PDF lleva tal cual (`DCTDecode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImagenJpeg {
    pub ancho: u32,
    pub alto: u32,
    pub bytes: Vec<u8>,
}

/// El contenido de una página, en operadores del PDF.
#[derive(Debug, Default, Clone)]
pub(crate) struct Pagina {
    ops: String,
}

impl Pagina {
    /// Texto con su línea base en `(x, y)`, en gris `gris` (0 negro, 1 blanco).
    pub fn texto(&mut self, x: f64, y: f64, fuente: Fuente, tam: f64, gris: f64, texto: &str) {
        if texto.is_empty() {
            return;
        }
        self.ops.push_str(&format!(
            "BT /{} {} Tf {} g {} {} Td {} Tj ET\n",
            fuente.recurso(),
            num(tam),
            num(gris),
            num(x),
            num(y),
            cadena(texto)
        ));
    }

    /// Una línea de `(x1, y1)` a `(x2, y2)`.
    pub fn linea(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, grosor: f64, gris: f64) {
        self.ops.push_str(&format!(
            "{} w {} G {} {} m {} {} l S\n",
            num(grosor),
            num(gris),
            num(x1),
            num(y1),
            num(x2),
            num(y2)
        ));
    }

    /// Un rectángulo relleno, con la esquina inferior izquierda en `(x, y)`.
    pub fn rectangulo(&mut self, x: f64, y: f64, ancho: f64, alto: f64, gris: f64) {
        self.ops.push_str(&format!(
            "{} g {} {} {} {} re f\n",
            num(gris),
            num(x),
            num(y),
            num(ancho),
            num(alto)
        ));
    }

    /// La imagen del documento, con la esquina inferior izquierda en `(x, y)`.
    pub fn imagen(&mut self, x: f64, y: f64, ancho: f64, alto: f64) {
        self.ops.push_str(&format!(
            "q {} 0 0 {} {} {} cm /Im1 Do Q\n",
            num(ancho),
            num(alto),
            num(x),
            num(y)
        ));
    }
}

/// Lo que ocupa `texto` en puntos con esa fuente y ese tamaño.
pub(crate) fn ancho(texto: &str, fuente: Fuente, tam: f64) -> f64 {
    let tabla = match fuente {
        Fuente::Normal => &HELVETICA,
        Fuente::Negrita => &HELVETICA_NEGRITA,
    };
    let milesimas: u32 = texto.chars().map(|c| u32::from(tabla[winansi(c) as usize])).sum();
    f64::from(milesimas) * tam / 1000.0
}

/// Parte `texto` en líneas que caben en `max` puntos, por palabras. Una palabra que no cabe sola se
/// corta por caracteres. Sin líneas vacías.
pub(crate) fn envolver(texto: &str, fuente: Fuente, tam: f64, max: f64) -> Vec<String> {
    let mut lineas = Vec::new();
    for parrafo in texto.split('\n') {
        let mut actual = String::new();
        for palabra in parrafo.split_whitespace() {
            let candidata = if actual.is_empty() {
                palabra.to_string()
            } else {
                format!("{actual} {palabra}")
            };
            if ancho(&candidata, fuente, tam) <= max {
                actual = candidata;
                continue;
            }
            if !actual.is_empty() {
                lineas.push(std::mem::take(&mut actual));
            }
            // La palabra sola no cabe: se corta donde llegue.
            let mut trozo = String::new();
            for c in palabra.chars() {
                trozo.push(c);
                if ancho(&trozo, fuente, tam) > max && trozo.chars().count() > 1 {
                    trozo.pop();
                    lineas.push(std::mem::take(&mut trozo));
                    trozo.push(c);
                }
            }
            actual = trozo;
        }
        if !actual.is_empty() {
            lineas.push(actual);
        }
    }
    lineas
}

/// El documento entero: las páginas en orden, la imagen si la hay y el título de sus propiedades.
pub(crate) fn documento(paginas: &[Pagina], imagen: Option<&ImagenJpeg>, titulo: &str) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut posiciones: Vec<usize> = Vec::new();
    // La segunda línea, con bytes altos, avisa a quien lo transporte de que es un fichero binario.
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let n_paginas = paginas.len().max(1);
    // 1 catálogo, 2 árbol de páginas, 3 y 4 las fuentes, 5 las propiedades, 6 la imagen; después,
    // por cada página, la página y su contenido.
    let primera_pagina = 7;
    let objeto = |out: &mut Vec<u8>, posiciones: &mut Vec<usize>, cuerpo: &[u8]| {
        posiciones.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", posiciones.len()).as_bytes());
        out.extend_from_slice(cuerpo);
        out.extend_from_slice(b"\nendobj\n");
    };

    objeto(&mut out, &mut posiciones, b"<< /Type /Catalog /Pages 2 0 R >>");
    let hijos: Vec<String> =
        (0..n_paginas).map(|i| format!("{} 0 R", primera_pagina + 2 * i)).collect();
    objeto(
        &mut out,
        &mut posiciones,
        format!("<< /Type /Pages /Kids [{}] /Count {} >>", hijos.join(" "), n_paginas).as_bytes(),
    );
    for base in ["Helvetica", "Helvetica-Bold"] {
        objeto(
            &mut out,
            &mut posiciones,
            format!("<< /Type /Font /Subtype /Type1 /BaseFont /{base} /Encoding /WinAnsiEncoding >>")
                .as_bytes(),
        );
    }
    objeto(
        &mut out,
        &mut posiciones,
        format!("<< /Title {} /Producer (TPV) >>", cadena_ascii(titulo)).as_bytes(),
    );
    match imagen {
        Some(img) => {
            let mut cuerpo = format!(
                "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB \
                 /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                img.ancho,
                img.alto,
                img.bytes.len()
            )
            .into_bytes();
            cuerpo.extend_from_slice(&img.bytes);
            cuerpo.extend_from_slice(b"\nendstream");
            objeto(&mut out, &mut posiciones, &cuerpo);
        }
        // Sin imagen, el objeto 6 existe igual (vacío) para que la numeración no dependa de ella.
        None => objeto(&mut out, &mut posiciones, b"null"),
    }

    let vacia = Pagina::default();
    for i in 0..n_paginas {
        let pagina = paginas.get(i).unwrap_or(&vacia);
        let recursos = if imagen.is_some() {
            "/Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 6 0 R >>"
        } else {
            "/Font << /F1 3 0 R /F2 4 0 R >>"
        };
        objeto(
            &mut out,
            &mut posiciones,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << {} >> /Contents {} 0 R >>",
                num(A4.0),
                num(A4.1),
                recursos,
                primera_pagina + 2 * i + 1
            )
            .as_bytes(),
        );
        let mut cuerpo = format!("<< /Length {} >>\nstream\n", pagina.ops.len()).into_bytes();
        cuerpo.extend_from_slice(pagina.ops.as_bytes());
        cuerpo.extend_from_slice(b"\nendstream");
        objeto(&mut out, &mut posiciones, &cuerpo);
    }

    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", posiciones.len() + 1).as_bytes());
    for p in &posiciones {
        out.extend_from_slice(format!("{p:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            posiciones.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Un número para el contenido: con dos decimales como mucho y sin ceros de sobra.
fn num(n: f64) -> String {
    let n = if n.is_finite() { n } else { 0.0 };
    let s = format!("{n:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".to_string() } else { s.to_string() }
}

/// Un texto como cadena del PDF en `WinAnsiEncoding`. Lo que no es ASCII imprimible va en octal,
/// así que el contenido de las páginas es texto ASCII.
fn cadena(texto: &str) -> String {
    let mut s = String::with_capacity(texto.len() + 2);
    s.push('(');
    for c in texto.chars() {
        match winansi(c) {
            b'(' => s.push_str("\\("),
            b')' => s.push_str("\\)"),
            b'\\' => s.push_str("\\\\"),
            b @ 0x20..=0x7E => s.push(b as char),
            b => s.push_str(&format!("\\{b:03o}")),
        }
    }
    s.push(')');
    s
}

/// Un texto de las propiedades del documento: sólo ASCII, que vale igual en cualquier codificación.
fn cadena_ascii(texto: &str) -> String {
    let ascii: String = texto.chars().map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '?' }).collect();
    cadena(&ascii)
}

/// El byte de `c` en `WinAnsiEncoding` (la página 1252 de Windows). Lo que no está sale `?`, y un
/// carácter de control, como espacio: el texto lo escribe una persona.
pub(crate) fn winansi(c: char) -> u8 {
    match c as u32 {
        0x20..=0x7E => c as u8,
        0xA0..=0xFF => c as u32 as u8,
        0x00..=0x1F | 0x7F..=0x9F => b' ',
        _ => match c {
            '€' => 0x80,
            '‚' => 0x82,
            'ƒ' => 0x83,
            '„' => 0x84,
            '…' => 0x85,
            '†' => 0x86,
            '‡' => 0x87,
            'ˆ' => 0x88,
            '‰' => 0x89,
            'Š' => 0x8A,
            '‹' => 0x8B,
            'Œ' => 0x8C,
            'Ž' => 0x8E,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '˜' => 0x98,
            '™' => 0x99,
            'š' => 0x9A,
            '›' => 0x9B,
            'œ' => 0x9C,
            'ž' => 0x9E,
            'Ÿ' => 0x9F,
            _ => b'?',
        },
    }
}

/// Anchos de Helvetica en milésimas del tamaño, por byte de `WinAnsiEncoding` (las métricas
/// estándar de Adobe). Sólo sirven para alinear y partir líneas: el visor dibuja con las suyas.
const HELVETICA: [u16; 256] = {
    let mut t = [278u16; 256];
    let ascii: [u16; 95] = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // ' '..'/'
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // '0'..'?'
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // '@'..'O'
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // 'P'..'_'
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // '`'..'o'
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // 'p'..'~'
    ];
    let mut i = 0;
    while i < 95 {
        t[32 + i] = ascii[i];
        i += 1;
    }
    let alto: [u16; 128] = [
        556, 278, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 278, 611, 278, // 0x80
        278, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 278, 500, 667, // 0x90
        278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 0xA0
        400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 0xB0
        667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 0xC0
        722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 0xD0
        556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, // 0xE0
        556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, // 0xF0
    ];
    let mut j = 0;
    while j < 128 {
        t[128 + j] = alto[j];
        j += 1;
    }
    t
};

/// Lo mismo para Helvetica-Bold.
const HELVETICA_NEGRITA: [u16; 256] = {
    let mut t = [278u16; 256];
    let ascii: [u16; 95] = [
        278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // ' '..'/'
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, // '0'..'?'
        975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, // '@'..'O'
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, // 'P'..'_'
        333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // '`'..'o'
        611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, // 'p'..'~'
    ];
    let mut i = 0;
    while i < 95 {
        t[32 + i] = ascii[i];
        i += 1;
    }
    let alto: [u16; 128] = [
        556, 278, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 278, 611, 278, // 0x80
        278, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 278, 500, 667, // 0x90
        278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 0xA0
        400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 0xB0
        722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 0xC0
        722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 0xD0
        556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, // 0xE0
        611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556, // 0xF0
    ];
    let mut j = 0;
    while j < 128 {
        t[128 + j] = alto[j];
        j += 1;
    }
    t
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lo_de_un_bar_en_espana_cabe_en_winansi() {
        assert_eq!(winansi('€'), 0x80);
        assert_eq!(winansi('ñ'), 0xF1);
        assert_eq!(winansi('Ñ'), 0xD1);
        assert_eq!(winansi('á'), 0xE1);
        assert_eq!(winansi('É'), 0xC9);
        assert_eq!(winansi('ü'), 0xFC);
        assert_eq!(winansi('ç'), 0xE7);
        assert_eq!(winansi('¿'), 0xBF);
        assert_eq!(winansi('¡'), 0xA1);
        assert_eq!(winansi('º'), 0xBA);
        assert_eq!(winansi('ª'), 0xAA);
        assert_eq!(winansi('·'), 0xB7);
        // Lo que no está sale `?`, y un control, espacio.
        assert_eq!(winansi('🍺'), b'?');
        assert_eq!(winansi('\u{1b}'), b' ');
        assert_eq!(winansi('\u{85}'), b' ');
    }

    #[test]
    fn el_texto_va_en_ascii_con_lo_demas_en_octal() {
        assert_eq!(cadena("Café 1,50 €"), "(Caf\\351 1,50 \\200)");
        assert_eq!(cadena("a(b)c\\"), "(a\\(b\\)c\\\\)");
        assert_eq!(cadena("¿Ñu?"), "(\\277\\321u?)");
    }

    #[test]
    fn los_numeros_salen_cortos_y_siempre_iguales() {
        assert_eq!(num(595.0), "595");
        assert_eq!(num(12.5), "12.5");
        assert_eq!(num(0.333333), "0.33");
        assert_eq!(num(-0.001), "0");
        assert_eq!(num(f64::NAN), "0");
    }

    #[test]
    fn las_palabras_no_se_salen_de_su_ancho() {
        let lineas = envolver("Hamburguesa completa con patatas y refresco grande", Fuente::Normal, 10.0, 100.0);
        assert!(lineas.len() > 1);
        for l in &lineas {
            assert!(ancho(l, Fuente::Normal, 10.0) <= 100.0, "{l}");
        }
        assert_eq!(lineas.join(" "), "Hamburguesa completa con patatas y refresco grande");
        // Una palabra más ancha que la línea se corta.
        let largas = envolver(&"W".repeat(40), Fuente::Negrita, 10.0, 50.0);
        assert!(largas.len() > 1);
        assert!(largas.iter().all(|l| ancho(l, Fuente::Negrita, 10.0) <= 50.0));
        assert!(envolver("", Fuente::Normal, 10.0, 100.0).is_empty());
    }

    #[test]
    fn el_documento_es_un_pdf_con_su_tabla_de_posiciones_bien_hecha() {
        let mut p = Pagina::default();
        p.texto(50.0, 800.0, Fuente::Negrita, 12.0, 0.0, "Hola");
        let pdf = documento(&[p.clone(), p], None, "Prueba");
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        // Byte a byte (los de la cabecera binaria, como `?`), para que las posiciones casen.
        let texto: String = pdf.iter().map(|&b| if b.is_ascii() { b as char } else { '?' }).collect();
        assert!(texto.contains("/Count 2"));

        // Cada posición de la tabla apunta al principio de su objeto.
        let xref = texto.rfind("\nxref\n").unwrap() + 1;
        let startxref: usize = texto[texto.rfind("startxref\n").unwrap() + 10..].lines().next().unwrap().parse().unwrap();
        assert_eq!(startxref, xref);
        let entradas: Vec<&str> = texto[xref..].lines().skip(3).take_while(|l| l.ends_with(" n ")).collect();
        assert_eq!(entradas.len(), 10);
        for (i, e) in entradas.iter().enumerate() {
            let pos: usize = e[..10].parse().unwrap();
            assert!(pdf[pos..].starts_with(format!("{} 0 obj", i + 1).as_bytes()), "objeto {}", i + 1);
        }
        // Y cada línea de la tabla mide 20 bytes.
        assert!(entradas.iter().all(|e| e.len() + 1 == 20));
    }

    #[test]
    fn los_mismos_datos_dan_los_mismos_bytes() {
        let mut p = Pagina::default();
        p.texto(50.0, 800.0, Fuente::Normal, 10.0, 0.0, "Factura");
        assert_eq!(documento(std::slice::from_ref(&p), None, "x"), documento(&[p], None, "x"));
    }
}
