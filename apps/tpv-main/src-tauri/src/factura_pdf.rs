//! El PDF A4 de una factura completa, y dónde se guarda en el equipo.
//!
//! Se maqueta a partir del **mismo papel** que se imprime (`PrintTicketPayload`, que compone
//! `use_cases::tickets::ticket_de_pago` desde el registro): el número, la fecha de expedición, el
//! emisor y el cliente declarados, las líneas, el desglose y el total salen de ahí, y el dinero con
//! el formateador del papel (`printing::fmt_eur`). Así el PDF y el ticket de una factura no pueden
//! decir cosas distintas. Lo que cambia es el formato: A4, con el emisor arriba a la izquierda, el
//! título y el número a la derecha, el cliente debajo y las líneas en una tabla.
//!
//! Lo compone el job `facturas_pdf` una vez, después del cobro o de la emisión
//! (`use_cases::facturas_pdf`). El escritor de PDF es `pdf.rs`.

use std::path::PathBuf;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::facturas_pdf::{ArchivoFacturas, MaquetaFactura};
use tpv_contracts::impresion::PrintTicketPayload;
use tpv_domain::dinero::Dinero;
use tpv_domain::ticket::TramoIva;

use crate::pdf::{self, Fuente, ImagenJpeg, Pagina, A4};
use crate::printing::{desglose_iva, fmt_eur, fmt_pct};

/// La carpeta de AppData con los PDF de las facturas. Está en el `deny` de `fs` de la webview
/// (capabilities/default.json).
pub(crate) const CARPETA: &str = "facturas";

const MARGEN: f64 = 50.0;
const DERECHA: f64 = A4.0 - MARGEN;
const ARRIBA: f64 = A4.1 - MARGEN;
/// Lo más abajo que llega el contenido: debajo va el pie con el número de página.
const ABAJO: f64 = 70.0;

/// El hueco del logo, en puntos.
const LOGO_MAX: (f64, f64) = (150.0, 60.0);
/// Lo más grande que se guarda el logo dentro del PDF, en píxeles: de sobra para 150 puntos.
const LOGO_MAX_PX: u32 = 600;

// Las columnas de las líneas: la descripción a la izquierda y lo demás alineado a la derecha.
const ANCHO_DESCRIPCION: f64 = 250.0;
const COL_CANTIDAD: f64 = 350.0;
const COL_PRECIO: f64 = 425.0;
const COL_IVA: f64 = 470.0;
/// Donde empiezan las etiquetas de los totales.
const COL_TOTALES: f64 = 360.0;

const TEXTO: f64 = 9.5;
const GRIS: f64 = 0.4;

/// El título de la factura, como en el papel (`printing::bloque_tipo_de_factura`).
fn titulo(tipo_factura: Option<&str>) -> &'static str {
    match tipo_factura.map(str::trim) {
        Some("R1" | "R2" | "R3" | "R4" | "R5") => "FACTURA RECTIFICATIVA",
        Some("F1" | "F3") => "FACTURA",
        _ => "FACTURA SIMPLIFICADA",
    }
}

/// Las páginas que se van llenando de arriba abajo.
struct Maqueta {
    paginas: Vec<Pagina>,
    y: f64,
}

impl Maqueta {
    fn nueva() -> Self {
        Maqueta { paginas: vec![Pagina::default()], y: ARRIBA }
    }

    fn pagina(&mut self) -> &mut Pagina {
        if self.paginas.is_empty() {
            self.paginas.push(Pagina::default());
        }
        let ultima = self.paginas.len() - 1;
        &mut self.paginas[ultima]
    }

    /// ¿Caben `alto` puntos más en esta página?
    fn cabe(&self, alto: f64) -> bool {
        self.y - alto >= ABAJO
    }

    fn salto(&mut self) {
        self.paginas.push(Pagina::default());
        self.y = ARRIBA;
    }

    fn texto(&mut self, x: f64, fuente: Fuente, tam: f64, gris: f64, s: &str) {
        let y = self.y;
        self.pagina().texto(x, y, fuente, tam, gris, s);
    }

    /// Texto que acaba en `x`.
    fn a_la_derecha(&mut self, x: f64, fuente: Fuente, tam: f64, gris: f64, s: &str) {
        let desde = x - pdf::ancho(s, fuente, tam);
        self.texto(desde, fuente, tam, gris, s);
    }

    fn centrado(&mut self, fuente: Fuente, tam: f64, gris: f64, s: &str) {
        let desde = (A4.0 - pdf::ancho(s, fuente, tam)) / 2.0;
        self.texto(desde, fuente, tam, gris, s);
    }

    fn raya(&mut self, desde: f64, hasta: f64, grosor: f64) {
        let y = self.y;
        self.pagina().linea(desde, y, hasta, y, grosor, 0.6);
    }

    /// Un párrafo partido al ancho, una línea debajo de otra.
    fn parrafo(&mut self, x: f64, ancho: f64, fuente: Fuente, tam: f64, s: &str) {
        for linea in pdf::envolver(s, fuente, tam, ancho) {
            if !self.cabe(tam + 3.0) {
                self.salto();
            }
            self.y -= tam + 2.5;
            self.texto(x, fuente, tam, 0.0, &linea);
        }
    }

    fn cabecera_de_lineas(&mut self) {
        let y = self.y;
        self.pagina().rectangulo(MARGEN, y - 16.0, DERECHA - MARGEN, 16.0, 0.92);
        self.y -= 11.5;
        let t = 8.5;
        self.texto(MARGEN + 4.0, Fuente::Negrita, t, 0.0, "Descripción");
        self.a_la_derecha(COL_CANTIDAD, Fuente::Negrita, t, 0.0, "Cant.");
        self.a_la_derecha(COL_PRECIO, Fuente::Negrita, t, 0.0, "Precio");
        self.a_la_derecha(COL_IVA, Fuente::Negrita, t, 0.0, "IVA");
        self.a_la_derecha(DERECHA - 4.0, Fuente::Negrita, t, 0.0, "Importe");
        self.y -= 10.0;
    }
}

/// El PDF de la factura de este papel. Sin E/S: el logo llega ya convertido.
pub(crate) fn pdf_de_factura(p: &PrintTicketPayload, logo: Option<&ImagenJpeg>) -> Vec<u8> {
    let mut m = Maqueta::nueva();
    let no_vacio = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let numero = p.numero_ticket.as_deref().and_then(no_vacio).unwrap_or_default();
    let titulo = titulo(p.tipo_factura.as_deref());

    // ── El emisor, arriba a la izquierda ──
    //
    // Lo que exige una factura sale siempre: quién la expide, su NIF y su domicilio (art. 6.1 del
    // RD 1619/2012). El teléfono, si el ticket lo lleva.
    let mut y_izq = ARRIBA;
    if let Some(img) = logo.filter(|i| i.ancho > 0 && i.alto > 0) {
        let escala = (LOGO_MAX.0 / f64::from(img.ancho)).min(LOGO_MAX.1 / f64::from(img.alto));
        let (w, h) = (f64::from(img.ancho) * escala, f64::from(img.alto) * escala);
        m.pagina().imagen(MARGEN, y_izq - h, w, h);
        y_izq -= h + 10.0;
    }
    let mut izquierda = |m: &mut Maqueta, fuente: Fuente, tam: f64, s: &str| {
        for linea in pdf::envolver(s, fuente, tam, 270.0) {
            y_izq -= tam + 3.0;
            m.pagina().texto(MARGEN, y_izq, fuente, tam, 0.0, &linea);
        }
    };
    let rotulo = p.business_name.trim();
    let razon = p.razon_social.trim();
    if !rotulo.is_empty() {
        izquierda(&mut m, Fuente::Negrita, 13.0, rotulo);
    }
    if !razon.is_empty() && !razon.eq_ignore_ascii_case(rotulo) {
        izquierda(&mut m, Fuente::Normal, TEXTO, razon);
    }
    if let Some(cif) = no_vacio(&p.cif) {
        izquierda(&mut m, Fuente::Normal, TEXTO, &format!("NIF: {cif}"));
    }
    if let Some(dir) = no_vacio(&p.direccion) {
        izquierda(&mut m, Fuente::Normal, TEXTO, &dir);
    }
    if p.show_phone {
        if let Some(tel) = no_vacio(&p.telefono) {
            izquierda(&mut m, Fuente::Normal, TEXTO, &format!("Tel: {tel}"));
        }
    }

    // ── El título, el número y la fecha, arriba a la derecha ──
    let mut y_der = ARRIBA - 18.0;
    m.pagina().texto(DERECHA - pdf::ancho(titulo, Fuente::Negrita, 18.0), y_der, Fuente::Negrita, 18.0, 0.0, titulo);
    for (fuente, tam, s) in [
        (Fuente::Negrita, 11.0, (!numero.is_empty()).then(|| format!("Número: {numero}"))),
        (Fuente::Normal, TEXTO, p.fecha.as_deref().and_then(no_vacio).map(|f| format!("Fecha: {f}"))),
    ] {
        if let Some(s) = s {
            y_der -= tam + 6.0;
            m.pagina().texto(DERECHA - pdf::ancho(&s, fuente, tam), y_der, fuente, tam, 0.0, &s);
        }
    }

    m.y = y_izq.min(y_der) - 14.0;
    m.raya(MARGEN, DERECHA, 0.8);
    m.y -= 6.0;

    // ── Lo que rectifica o sustituye: las mismas frases que el papel ──
    if let Some(n) = p.rectifica.as_deref().and_then(no_vacio) {
        let texto = match p.rectifica_fecha.as_deref().and_then(no_vacio) {
            Some(fecha) => format!("Rectifica a la factura {n} del {fecha}"),
            None => format!("Rectifica a la factura {n}"),
        };
        m.parrafo(MARGEN, DERECHA - MARGEN, Fuente::Normal, TEXTO, &texto);
    }
    let sustituidas: Vec<&str> = p.sustituye.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).collect();
    match sustituidas.as_slice() {
        [] => {}
        [una] => m.parrafo(MARGEN, DERECHA - MARGEN, Fuente::Normal, TEXTO, &format!("Sustituye a la factura {una}")),
        varias => m.parrafo(
            MARGEN,
            DERECHA - MARGEN,
            Fuente::Normal,
            TEXTO,
            &format!("Sustituye a las facturas {}", varias.join(", ")),
        ),
    }

    // ── El cliente ──
    if let Some(d) = &p.destinatario {
        m.y -= 12.0;
        m.texto(MARGEN, Fuente::Negrita, 8.0, GRIS, "CLIENTE");
        m.parrafo(MARGEN, 300.0, Fuente::Negrita, 10.5, d.nombre_razon.trim());
        m.parrafo(MARGEN, 300.0, Fuente::Normal, TEXTO, &format!("NIF: {}", d.nif.trim()));
        if let Some(dom) = d.domicilio.as_deref().and_then(no_vacio) {
            m.parrafo(MARGEN, 300.0, Fuente::Normal, TEXTO, &dom);
        }
    }

    // ── Las líneas ──
    m.y -= 18.0;
    if !m.cabe(40.0) {
        m.salto();
    }
    m.cabecera_de_lineas();
    if p.items.is_empty() {
        m.y -= 14.0;
        m.texto(MARGEN + 4.0, Fuente::Normal, TEXTO, GRIS, "No hay productos en la factura.");
    }
    for it in &p.items {
        // Lo mismo que el papel: el importe de la línea es el precio por las unidades.
        let importe = it.precio_unitario.por(it.cantidad as i64);
        let iva = it.iva_percent.unwrap_or(p.iva_percent);
        let descripcion = pdf::envolver(&it.nombre, Fuente::Normal, TEXTO, ANCHO_DESCRIPCION);
        let alto = 13.0 * descripcion.len().max(1) as f64 + 2.0;
        if !m.cabe(alto) {
            m.salto();
            m.cabecera_de_lineas();
        }
        m.y -= 13.0;
        m.a_la_derecha(COL_CANTIDAD, Fuente::Normal, TEXTO, 0.0, &it.cantidad.to_string());
        m.a_la_derecha(COL_PRECIO, Fuente::Normal, TEXTO, 0.0, &fmt_eur(it.precio_unitario));
        m.a_la_derecha(COL_IVA, Fuente::Normal, TEXTO, 0.0, &format!("{}%", fmt_pct(iva)));
        m.a_la_derecha(DERECHA - 4.0, Fuente::Normal, TEXTO, 0.0, &fmt_eur(importe));
        for (i, linea) in descripcion.iter().enumerate() {
            if i > 0 {
                m.y -= 13.0;
            }
            m.texto(MARGEN + 4.0, Fuente::Normal, TEXTO, 0.0, linea);
        }
        m.y -= 2.0;
    }
    m.y -= 6.0;
    m.raya(MARGEN, DERECHA, 0.8);

    // ── Base, IVA y total: el desglose declarado, como en el papel ──
    let tramos = desglose_iva(p);
    let mut filas: Vec<(String, Dinero)> = Vec::new();
    match tramos.as_slice() {
        [] => {
            filas.push(("Base imponible".into(), Dinero::CERO));
            filas.push((format!("IVA ({}%)", fmt_pct(p.iva_percent)), Dinero::CERO));
        }
        [TramoIva { tipo, base, cuota }] => {
            filas.push(("Base imponible".into(), *base));
            filas.push((format!("IVA ({}%)", fmt_pct(*tipo)), *cuota));
        }
        varios => {
            for TramoIva { tipo, base, cuota } in varios {
                filas.push((format!("Base imponible ({}%)", fmt_pct(*tipo)), *base));
                filas.push((format!("IVA ({}%)", fmt_pct(*tipo)), *cuota));
            }
        }
    }
    let total: Dinero = p.total.unwrap_or_else(|| {
        p.items.iter().map(|it| it.precio_unitario.por(it.cantidad as i64)).sum()
    });
    let alto_totales = 14.0 * filas.len() as f64 + 40.0;
    if !m.cabe(alto_totales) {
        m.salto();
    }
    m.y -= 6.0;
    for (etiqueta, importe) in &filas {
        m.y -= 14.0;
        m.texto(COL_TOTALES, Fuente::Normal, TEXTO, 0.0, etiqueta);
        m.a_la_derecha(DERECHA - 4.0, Fuente::Normal, TEXTO, 0.0, &fmt_eur(*importe));
    }
    m.y -= 8.0;
    m.raya(COL_TOTALES, DERECHA, 0.8);
    m.y -= 17.0;
    m.texto(COL_TOTALES, Fuente::Negrita, 13.0, 0.0, "TOTAL");
    m.a_la_derecha(DERECHA - 4.0, Fuente::Negrita, 13.0, 0.0, &fmt_eur(total));

    if let Some(pago) = p.metodo_pago.as_deref().and_then(no_vacio) {
        m.y -= 22.0;
        m.texto(MARGEN, Fuente::Normal, TEXTO, 0.0, &format!("Forma de pago: {pago}"));
    }

    // ── El mensaje del negocio, si el ticket lo lleva ──
    if p.show_footer_message {
        if let Some(msg) = no_vacio(&p.mensaje_footer) {
            m.y -= 14.0;
            for linea in pdf::envolver(&msg, Fuente::Normal, 9.0, DERECHA - MARGEN) {
                if !m.cabe(12.0) {
                    m.salto();
                }
                m.y -= 12.0;
                m.centrado(Fuente::Normal, 9.0, GRIS, &linea);
            }
        }
    }

    // ── El pie de cada página ──
    let n = m.paginas.len();
    let nombre = if numero.is_empty() { titulo.to_string() } else { format!("{titulo} {numero}") };
    for (i, pagina) in m.paginas.iter_mut().enumerate() {
        let pie = format!("{nombre} · Página {} de {n}", i + 1);
        let x = (A4.0 - pdf::ancho(&pie, Fuente::Normal, 8.0)) / 2.0;
        pagina.texto(x, 30.0, Fuente::Normal, 8.0, 0.45, &pie);
    }

    let titulo_doc = if numero.is_empty() { "Factura".to_string() } else { format!("Factura {numero}") };
    pdf::documento(&m.paginas, logo, &titulo_doc)
}

/// El logo del negocio como JPEG para el PDF: la transparencia sobre blanco y, como mucho,
/// [`LOGO_MAX_PX`] de lado.
///
/// Se decodifica con las mismas cotas con que se guarda una imagen (`imagenes::decodificar`,
/// AUD-30): el logo llega replicado. Lo que no se puede leer, o hace fallar al decodificador
/// (también con un pánico), deja la factura sin logo, con un aviso en el registro.
pub(crate) fn logo_en_jpeg(bytes: &[u8]) -> Option<ImagenJpeg> {
    let intento = || -> Result<ImagenJpeg, String> {
        let (img, _) = crate::imagenes::decodificar(bytes)?;
        let img = if img.width() > LOGO_MAX_PX || img.height() > LOGO_MAX_PX {
            img.resize(LOGO_MAX_PX, LOGO_MAX_PX, image::imageops::FilterType::Lanczos3)
        } else {
            img
        };
        let rgba = img.into_rgba8();
        let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
        for (x, y, px) in rgba.enumerate_pixels() {
            let [r, g, b, a] = px.0;
            let alfa = f32::from(a) / 255.0;
            let sobre_blanco = |c: u8| (f32::from(c) * alfa + 255.0 * (1.0 - alfa)).round() as u8;
            rgb.put_pixel(x, y, image::Rgb([sobre_blanco(r), sobre_blanco(g), sobre_blanco(b)]));
        }
        drop(rgba);
        let (ancho, alto) = rgb.dimensions();
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(rgb)
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85))
            .map_err(|e| format!("no se ha podido convertir el logo: {e}"))?;
        Ok(ImagenJpeg { ancho, alto, bytes: out.into_inner() })
    };
    match std::panic::catch_unwind(intento) {
        Ok(Ok(img)) => Some(img),
        Ok(Err(motivo)) => {
            tracing::warn!(target: "tpv::facturas", %motivo, "el logo no se puede poner en la factura: sale sin él");
            None
        }
        Err(_) => {
            tracing::warn!(target: "tpv::facturas", "pánico al convertir el logo: la factura sale sin él");
            None
        }
    }
}

/// Maqueta el PDF de una factura con el logo del negocio que haya en AppData. Va en el hilo de
/// bloqueo: decodificar el logo y escribir el PDF es CPU, y el job no se la quita al runtime.
pub(crate) struct MaquetaPdf {
    app_data: PathBuf,
}

impl MaquetaPdf {
    pub(crate) fn new(app_data: PathBuf) -> Self {
        Self { app_data }
    }
}

#[async_trait]
impl MaquetaFactura for MaquetaPdf {
    async fn pdf(&self, papel: PrintTicketPayload) -> AppResult<Vec<u8>> {
        let dir = self.app_data.clone();
        tokio::task::spawn_blocking(move || {
            let logo = if papel.show_logo {
                papel
                    .logo_path
                    .as_deref()
                    .and_then(|ruta| crate::leer_imagen_local(Some(dir.as_path()), ruta))
                    .and_then(|b| logo_en_jpeg(&b))
            } else {
                None
            };
            pdf_de_factura(&papel, logo.as_ref())
        })
        .await
        .map_err(|e| AppError::internal(format!("el hilo que compone el PDF se ha caído: {e}")))
    }
}

/// ¿Tiene `id` la forma de un `ID_Registro` (36 cifras hexadecimales y guiones, como un UUID)? Sólo
/// eso se convierte en un nombre de fichero: nada que pueda salir de la carpeta ni nombrar un
/// dispositivo de Windows. Es lo mismo que pide `tpv_infra_sqlite::facturas_pdf` para apuntarla.
fn es_id_de_registro(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Los PDF de las facturas en `AppData/facturas/{ID_Registro}.pdf`.
pub(crate) struct CarpetaFacturas {
    app_data: PathBuf,
}

impl CarpetaFacturas {
    pub(crate) fn new(app_data: PathBuf) -> Self {
        Self { app_data }
    }

    fn fichero(&self, id: &str) -> AppResult<PathBuf> {
        if !es_id_de_registro(id) {
            return Err(AppError::internal("el identificador de la factura no es un UUID"));
        }
        Ok(self.app_data.join(CARPETA).join(format!("{}.pdf", id.to_ascii_lowercase())))
    }
}

impl ArchivoFacturas for CarpetaFacturas {
    fn ruta(&self, id_registro: &str) -> String {
        format!("{CARPETA}/{}.pdf", id_registro.to_ascii_lowercase())
    }

    fn leer(&self, id_registro: &str) -> AppResult<Option<Vec<u8>>> {
        match std::fs::read(self.fichero(id_registro)?) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::internal(format!("no se puede leer el PDF de la factura: {e}"))),
        }
    }

    fn guardar(&self, id_registro: &str, pdf: &[u8]) -> AppResult<()> {
        let destino = self.fichero(id_registro)?;
        let carpeta = self.app_data.join(CARPETA);
        std::fs::create_dir_all(&carpeta)
            .map_err(|e| AppError::internal(format!("no se puede crear la carpeta de las facturas: {e}")))?;
        // Primero a un temporal y luego en su sitio: un corte a media escritura no deja un PDF
        // partido con el nombre del bueno.
        let temporal = destino.with_extension("pdf.tmp");
        std::fs::write(&temporal, pdf)
            .and_then(|_| std::fs::rename(&temporal, &destino))
            .map_err(|e| {
                let _ = std::fs::remove_file(&temporal);
                AppError::internal(format!("no se puede guardar el PDF de la factura: {e}"))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap};
    use tpv_contracts::impresion::{DestinatarioTicket, PrintTicketLine, TramoTicket};

    fn eur(c: i64) -> Dinero {
        Dinero::de_centimos(c)
    }

    fn linea(nombre: &str, cantidad: u32, precio: i64, iva: f64) -> PrintTicketLine {
        PrintTicketLine { nombre: nombre.into(), cantidad, precio_unitario: eur(precio), iva_percent: Some(iva) }
    }

    /// Una F1 de un bar: tres líneas a dos tipos de IVA, con su cliente.
    fn f1() -> PrintTicketPayload {
        PrintTicketPayload {
            printer_name: None,
            business_name: "Bar La Plaza".into(),
            direccion: "Calle Mayor 1, Logroño".into(),
            telefono: "600123456".into(),
            cif: "B12345674".into(),
            razon_social: "Hostelería Peña SL".into(),
            mensaje_footer: "¡Gracias por su visita!".into(),
            iva_percent: 10.0,
            show_logo: false,
            logo_path: None,
            show_business_name: true,
            show_address: true,
            show_phone: false,
            show_footer_message: true,
            paper_width_mm: 80,
            paper_dpi: 203,
            chars_per_line: 42,
            margin_top_mm: 0.0,
            margin_bottom_mm: 0.0,
            margin_left_mm: 0.0,
            margin_right_mm: 0.0,
            font_scale: 1.0,
            numero_ticket: Some("F-000001".into()),
            fecha: Some("02/01/2027 13:45".into()),
            metodo_pago: Some("Tarjeta".into()),
            origen: Some("Mesa 5".into()),
            es_copia: false,
            es_anulado: false,
            abre_cajon: false,
            items: vec![
                linea("Café con leche", 2, 130, 10.0),
                linea("Ración de jamón ibérico", 1, 1450, 10.0),
                linea("Agua 1,5 L para llevar", 3, 95, 21.0),
            ],
            desglose: Some(vec![
                TramoTicket { tipo: 10.0, base: eur(1555), cuota: eur(155) },
                TramoTicket { tipo: 21.0, base: eur(236), cuota: eur(49) },
            ]),
            total: Some(eur(1995)),
            tipo_factura: Some("F1".into()),
            destinatario: Some(DestinatarioTicket {
                nombre_razon: "Construcciones Muñoz SA".into(),
                nif: "A58818501".into(),
                domicilio: Some("Avda. de la Constitución 12, 2º, Málaga".into()),
            }),
            sustituye: vec![],
            rectifica: None,
            rectifica_fecha: None,
            facturas_del_cobro: vec![],
        }
    }

    /// El texto que dibuja el PDF, cadena a cadena, devuelto a Unicode.
    fn textos(pdf: &[u8]) -> Vec<String> {
        let mut inverso: HashMap<u8, char> = HashMap::new();
        for u in 0x20..0x2200u32 {
            if let Some(c) = char::from_u32(u).filter(|c| !c.is_control()) {
                let b = pdf::winansi(c);
                if b != b'?' || c == '?' {
                    inverso.entry(b).or_insert(c);
                }
            }
        }
        let s = String::from_utf8_lossy(pdf);
        let mut out = Vec::new();
        for trozo in s.split(" Tj").filter(|t| t.ends_with(')')) {
            let Some(inicio) = trozo.rfind(" (") else { continue };
            let bruto = &trozo[inicio + 2..trozo.len() - 1];
            let mut texto = String::new();
            let mut cs = bruto.chars().peekable();
            while let Some(c) = cs.next() {
                if c != '\\' {
                    texto.push(c);
                    continue;
                }
                match cs.peek().copied() {
                    Some(d) if d.is_ascii_digit() => {
                        let oct: String = (0..3).filter_map(|_| cs.next()).collect();
                        let b = u8::from_str_radix(&oct, 8).unwrap();
                        texto.push(inverso[&b]);
                    }
                    Some(o) => {
                        cs.next();
                        texto.push(o);
                    }
                    None => {}
                }
            }
            out.push(texto);
        }
        out
    }

    /// Los importes que salen en un texto: `12,34 €`, `-0,50 €`.
    fn importes(texto: &str) -> BTreeSet<String> {
        let cs: Vec<char> = texto.chars().collect();
        let mut out = BTreeSet::new();
        for (i, c) in cs.iter().enumerate() {
            if *c != '€' || i < 2 || cs[i - 1] != ' ' {
                continue;
            }
            let mut j = i - 1;
            while j > 0 && (cs[j - 1].is_ascii_digit() || cs[j - 1] == ',' || cs[j - 1] == '-') {
                j -= 1;
            }
            let numero: String = cs[j..i - 1].iter().collect();
            if !numero.is_empty() {
                out.insert(format!("{numero} €"));
            }
        }
        out
    }

    /// El texto del ticket de papel (CP858), con el € en su sitio.
    fn texto_del_papel(p: &PrintTicketPayload) -> String {
        crate::printing::build_ticket(p, None)
            .into_iter()
            .map(|b| match b {
                0xD5 => '€',
                0x20..=0x7E => b as char,
                _ => ' ',
            })
            .collect()
    }

    #[test]
    fn la_factura_lleva_lo_que_lleva_su_papel() {
        let p = f1();
        let pdf = pdf_de_factura(&p, None);
        let t = textos(&pdf);
        let todo = t.join("\n");

        for esperado in [
            "FACTURA",
            "Número: F-000001",
            "Fecha: 02/01/2027 13:45",
            "Bar La Plaza",
            "Hostelería Peña SL",
            "NIF: B12345674",
            "Calle Mayor 1, Logroño",
            "CLIENTE",
            "Construcciones Muñoz SA",
            "NIF: A58818501",
            "Avda. de la Constitución 12, 2º, Málaga",
            "Café con leche",
            "Ración de jamón ibérico",
            "Agua 1,5 L para llevar",
            "Forma de pago: Tarjeta",
            "¡Gracias por su visita!",
            "TOTAL",
            "FACTURA F-000001 · Página 1 de 1",
        ] {
            assert!(t.iter().any(|s| s == esperado), "falta «{esperado}» en {t:#?}");
        }

        // Los importes son los del papel, con su mismo formato: cada uno de los que imprime la
        // térmica (líneas, precios, bases, cuotas y total) está en el PDF.
        let del_papel = importes(&texto_del_papel(&p));
        let del_pdf = importes(&todo);
        assert!(!del_papel.is_empty());
        assert!(del_papel.is_subset(&del_pdf), "papel {del_papel:?}\npdf {del_pdf:?}");
        for esperado in ["2,60 €", "14,50 €", "2,85 €", "15,55 €", "1,55 €", "2,36 €", "0,49 €", "19,95 €"] {
            assert!(del_pdf.contains(esperado), "falta {esperado}: {del_pdf:?}");
        }
        assert!(t.iter().any(|s| s == "Base imponible (10%)"));
        assert!(t.iter().any(|s| s == "IVA (21%)"));
    }

    #[test]
    fn las_tildes_la_ene_y_el_euro_van_en_winansi() {
        let pdf = pdf_de_factura(&f1(), None);
        let s = String::from_utf8_lossy(&pdf);
        assert!(s.contains("/Encoding /WinAnsiEncoding"));
        assert!(s.contains("(Caf\\351 con leche)"), "é en octal");
        assert!(s.contains("Mu\\361oz"), "ñ en octal");
        assert!(s.contains("\\241Gracias"), "¡ en octal");
        assert!(s.contains("19,95 \\200"), "€ en octal");
        // Fuera de la cabecera binaria no hay ni un byte que no sea ASCII: nada de UTF-8 colado.
        assert!(pdf[15..].iter().all(|b| b.is_ascii()));
    }

    #[test]
    fn una_rectificativa_dice_que_rectifica_y_va_en_negativo() {
        let mut p = f1();
        p.tipo_factura = Some("R1".into());
        p.numero_ticket = Some("R-000003".into());
        p.rectifica = Some("F-000001".into());
        p.rectifica_fecha = Some("02/01/2027".into());
        p.metodo_pago = None;
        p.items = vec![linea("Café con leche", 2, -130, 10.0)];
        p.desglose = Some(vec![TramoTicket { tipo: 10.0, base: eur(-236), cuota: eur(-24) }]);
        p.total = Some(eur(-260));

        let t = textos(&pdf_de_factura(&p, None));
        assert!(t.iter().any(|s| s == "FACTURA RECTIFICATIVA"));
        assert!(t.iter().any(|s| s == "Rectifica a la factura F-000001 del 02/01/2027"));
        assert!(t.iter().any(|s| s == "Base imponible"));
        let imp = importes(&t.join("\n"));
        for esperado in ["-1,30 €", "-2,60 €", "-2,36 €", "-0,24 €"] {
            assert!(imp.contains(esperado), "falta {esperado}: {imp:?}");
        }
        assert!(!t.iter().any(|s| s.starts_with("Forma de pago")));
    }

    #[test]
    fn una_f3_dice_que_facturas_sustituye() {
        let mut p = f1();
        p.tipo_factura = Some("F3".into());
        p.sustituye = vec!["T-000007".into(), "T-000009".into()];
        let t = textos(&pdf_de_factura(&p, None));
        assert!(t.iter().any(|s| s == "Sustituye a las facturas T-000007, T-000009"));

        p.sustituye = vec!["T-000007".into()];
        let t = textos(&pdf_de_factura(&p, None));
        assert!(t.iter().any(|s| s == "Sustituye a la factura T-000007"));
    }

    #[test]
    fn muchas_lineas_siguen_en_otra_pagina_con_su_cabecera() {
        let mut p = f1();
        p.items = (0..120).map(|i| linea(&format!("Producto {i}"), 1, 100, 10.0)).collect();
        let pdf = pdf_de_factura(&p, None);
        let s = String::from_utf8_lossy(&pdf);
        let paginas = s.matches("/Type /Page ").count();
        assert!(paginas >= 3, "{paginas} páginas");
        let t = textos(&pdf);
        assert_eq!(t.iter().filter(|x| *x == "Descripción").count(), paginas);
        assert_eq!(t.iter().filter(|x| *x == "TOTAL").count(), 1);
        assert!(t.iter().any(|x| x == "Producto 0") && t.iter().any(|x| x == "Producto 119"));
        assert!(t.iter().any(|x| *x == format!("FACTURA F-000001 · Página {paginas} de {paginas}")));
    }

    #[test]
    fn los_mismos_datos_dan_el_mismo_pdf() {
        assert_eq!(pdf_de_factura(&f1(), None), pdf_de_factura(&f1(), None));
    }

    #[test]
    fn el_logo_va_dentro_como_jpeg() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(40, 20, image::Rgba([200, 30, 30, 128])))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let logo = logo_en_jpeg(png.get_ref()).expect("el logo se convierte");
        assert_eq!((logo.ancho, logo.alto), (40, 20));
        assert!(logo.bytes.starts_with(&[0xFF, 0xD8]));

        let pdf = pdf_de_factura(&f1(), Some(&logo));
        let s = String::from_utf8_lossy(&pdf);
        assert!(s.contains("/Filter /DCTDecode"));
        assert!(s.contains("/Im1 Do"));
    }

    #[test]
    fn un_logo_que_no_es_una_imagen_deja_la_factura_sin_el() {
        assert!(logo_en_jpeg(b"no soy una imagen").is_none());
        assert!(logo_en_jpeg(b"").is_none());
    }

    fn carpeta_temporal() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tpv-facturas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn la_carpeta_guarda_y_devuelve_el_pdf_de_cada_factura() {
        let dir = carpeta_temporal();
        let c = CarpetaFacturas::new(dir.clone());
        let id = "0190f3a1-7b2c-4d4e-8f00-123456789abc";
        assert_eq!(c.leer(id).unwrap(), None);
        c.guardar(id, b"%PDF-1.4 uno").unwrap();
        c.guardar(id, b"%PDF-1.4 dos").unwrap();
        assert_eq!(c.leer(id).unwrap().as_deref(), Some(&b"%PDF-1.4 dos"[..]));
        assert_eq!(c.ruta(id), format!("facturas/{id}.pdf"));
        assert!(dir.join("facturas").join(format!("{id}.pdf")).exists());
        // Sin restos del temporal.
        assert_eq!(std::fs::read_dir(dir.join("facturas")).unwrap().count(), 1);
        // En mayúsculas es el mismo fichero.
        assert!(c.leer(&id.to_uppercase()).unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn la_carpeta_no_admite_un_nombre_que_no_sea_un_registro() {
        let dir = carpeta_temporal();
        let c = CarpetaFacturas::new(dir.clone());
        for malo in ["", "../data.db", "..\\data", "NUL", "facturas/x", "0190f3a1-7b2c-4d4e-8f00-123456789ab/"] {
            assert!(c.leer(malo).is_err(), "{malo:?}");
            assert!(c.guardar(malo, b"%PDF-").is_err(), "{malo:?}");
        }
        assert!(!dir.join("data.db").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
