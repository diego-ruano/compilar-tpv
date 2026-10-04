//! Construcción del sobre SOAP y lectura de la respuesta.
//!
//! No hay librería de SOAP aquí y no hace falta: el sobre es fijo y el cuerpo lo dicta el XSD. Lo
//! que sí hay que hacer bien es el **escapado** y el **orden de los elementos**, porque el XSD usa
//! `sequence` y un elemento fuera de sitio es un `4102` («el XML no cumple el esquema») que rechaza
//! el envío entero.
//!
//! ## La regla que gobierna todo este módulo
//!
//! **Nada se recalcula.** Los importes, la huella, la fecha y el bloque del sistema informático
//! salen tal cual de la fila que se escribió al emitir. Recomponer un importe desde un `f64` aquí
//! haría que la huella que se manda dejara de corresponder a los datos que la acompañan, y la AEAT
//! lo marcaría como «aceptado con errores» (código 2000) — un fallo silencioso que no se ve como un
//! error ruidoso sino como una columna en un panel.
//!
//! ## Fuentes
//!
//! `SuministroLR.xsd`, `SuministroInformacion.xsd` y `RespuestaSuministro.xsd` de la AEAT, más el
//! ejemplo de mensaje del documento *Descripción del servicio web* v1.0.3 §9.

use tpv_application::ports::aeat::{CabeceraEnvio, LineaRespuesta, RegistroParaEnvio, RespuestaRemision};

/// Espacios de nombres del WSDL. Los prefijos (`sum`, `sum1`) son los del ejemplo oficial; el
/// servidor no depende de ellos, pero usar los mismos hace que una traza se lea igual que la
/// documentación.
const NS_LR: &str = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd";
const NS_SF: &str = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

/// Versión del diseño de registro. Es el único valor que admite `VersionType`.
pub const ID_VERSION: &str = "1.0";

/// Escapa un texto para meterlo en un nodo XML.
///
/// Esos caracteres ya se han quitado antes, en `tpv_domain::verifactu::sanear_texto` (el catálogo
/// de la AEAT define el error 1287 para `<`, `>`, `"`, `'` y `=`). Esta función es la segunda red:
/// un texto que se colara sin sanear produciría un XML inválido, que es peor que un rechazo.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Los caracteres de control no son XML 1.0 válido ni escapados. Se convierten en
            // espacio, igual que hace el generador de tickets y por el mismo motivo: el nombre de
            // un producto lo escribe una persona.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Un elemento simple del espacio de nombres `sum1`.
fn el(out: &mut String, nombre: &str, valor: &str) {
    out.push_str(&format!("<sum1:{nombre}>{}</sum1:{nombre}>", esc(valor)));
}

/// Igual, pero se omite entero si el valor es `None` o está vacío.
///
/// Omitir es distinto de mandar vacío, y en este XSD la diferencia importa: un `<TipoRectificativa/>`
/// en una factura que no es rectificativa es el error 1115, mientras que no ponerlo es lo correcto.
fn el_opt(out: &mut String, nombre: &str, valor: Option<&str>) {
    if let Some(v) = valor.map(str::trim).filter(|v| !v.is_empty()) {
        el(out, nombre, v);
    }
}

/// Construye el sobre SOAP completo de un `RegFactuSistemaFacturacion`.
///
/// El orden de los elementos **es** el del `sequence` del XSD y no se puede tocar. Se escribe de
/// arriba abajo siguiendo `RegistroFacturacionAltaType` para que comparar este código con el
/// esquema sea leer las dos listas en paralelo.
pub fn construir_envio(cabecera: &CabeceraEnvio, registros: &[RegistroParaEnvio]) -> String {
    let mut b = String::with_capacity(4096 + registros.len() * 2048);
    b.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    b.push_str(&format!(
        r#"<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sum="{NS_LR}" xmlns:sum1="{NS_SF}"><soapenv:Header/><soapenv:Body><sum:RegFactuSistemaFacturacion>"#
    ));

    // ── Cabecera ──
    b.push_str("<sum:Cabecera><sum1:ObligadoEmision>");
    el(&mut b, "NombreRazon", &cabecera.nombre_razon_obligado);
    el(&mut b, "NIF", &cabecera.nif_obligado);
    b.push_str("</sum1:ObligadoEmision>");
    if cabecera.incidencia {
        // `RemisionVoluntaria/Incidencia = "S"`: «esto llega tarde y sé por qué». Sólo se informa
        // cuando de verdad lo es; ponerlo siempre sería ruido que deja de significar nada.
        b.push_str("<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia></sum1:RemisionVoluntaria>");
    }
    b.push_str("</sum:Cabecera>");

    for r in registros {
        b.push_str("<sum:RegistroFactura>");
        if r.tipo == "ANULACION" {
            escribir_anulacion(&mut b, r);
        } else {
            escribir_alta(&mut b, r);
        }
        b.push_str("</sum:RegistroFactura>");
    }

    b.push_str("</sum:RegFactuSistemaFacturacion></soapenv:Body></soapenv:Envelope>");
    b
}

/// `RegistroAlta`, en el orden exacto de `RegistroFacturacionAltaType`.
fn escribir_alta(b: &mut String, r: &RegistroParaEnvio) {
    b.push_str("<sum1:RegistroAlta>");
    el(b, "IDVersion", ID_VERSION);

    b.push_str("<sum1:IDFactura>");
    el(b, "IDEmisorFactura", &r.nif_emisor);
    el(b, "NumSerieFactura", &r.num_serie_factura);
    el(b, "FechaExpedicionFactura", &r.fecha_expedicion);
    b.push_str("</sum1:IDFactura>");

    el(b, "NombreRazonEmisor", &r.nombre_razon_emisor);

    // Subsanación y rechazo previo. Las tres combinaciones válidas están en el anexo de
    // «Validaciones y errores», y no son intercambiables:
    //   · alta normal            → ninguno de los dos
    //   · subsanar lo ACEPTADO   → Subsanacion=S, sin RechazoPrevio  (el registro ya está allí)
    //   · subsanar lo RECHAZADO  → Subsanacion=S, RechazoPrevio=X    (el registro NO está allí)
    //   · subsanar tras rechazo
    //     de una subsanación     → Subsanacion=S, RechazoPrevio=S
    // Mandar `X` cuando el registro sí existe es el ERROR (2) de ese anexo, y al revés el ERROR (3).
    el_opt(b, "Subsanacion", r.subsanacion.as_deref());
    el_opt(b, "RechazoPrevio", r.rechazo_previo.as_deref());

    el(b, "TipoFactura", r.tipo_factura.as_deref().unwrap_or("F2"));
    el_opt(b, "TipoRectificativa", r.tipo_rectificativa.as_deref());

    // Facturas rectificadas / sustituidas. Cada bloque sólo puede ir en su tipo: las rectificadas
    // sólo en una `R*` (error 1117), las sustituidas SÓLO en una `F3` (error 1116).
    if let Some(refs) = r.referencias_json.as_deref().and_then(parsear_json) {
        escribir_referencias(b, &refs, "rectificadas", "FacturasRectificadas", "IDFacturaRectificada");
        escribir_referencias(b, &refs, "sustituidas", "FacturasSustituidas", "IDFacturaSustituida");
    }

    // `FechaOperacion` va SÓLO si la operación se efectuó otro día. No es opcional a nuestro gusto:
    // los arts. 6.1.i) (factura completa) y 7.1.c) (simplificada) del RD 1619/2012 lo exigen con la
    // misma redacción, *«siempre que se trate de una fecha distinta a la de expedición»*. Al revés
    // también manda: informarlo cuando coincide es ruido, y la AEAT ya interpreta la ausencia como
    // «igual a FechaExpedicionFactura».
    //
    // En un bar el caso normal es que coincidan —se consume y se cobra en el mismo acto— y por eso
    // esto está vacío casi siempre. Los tres casos en que no: una comanda que cruza la medianoche,
    // una rectificativa de una venta de otro día y una F3 que canjea un ticket anterior.
    //
    // Quién decide el valor es la capa que emite; aquí sólo se transcribe. Va DESPUÉS de las
    // referencias y ANTES de `DescripcionOperacion`, que es el orden del `sequence` del XSD.
    el_opt(b, "FechaOperacion", r.fecha_operacion.as_deref());

    el(
        b,
        "DescripcionOperacion",
        r.descripcion_operacion
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Servicios de hosteleria y restauracion"),
    );

    el_opt(b, "Macrodato", r.macrodato.as_deref());

    // `Destinatarios` es obligatorio en F1/F3/R1-R4 y está PROHIBIDO en F2 y R5 (errores 1189 y
    // 1190). Se escribe si la fila lo tiene, que es exactamente cuando la emisión lo puso.
    if let Some(d) = r.destinatario_json.as_deref().and_then(parsear_json) {
        let nombre = campo(&d, "NombreRazon");
        let nif = campo(&d, "NIF");
        if !nombre.is_empty() || !nif.is_empty() {
            b.push_str("<sum1:Destinatarios><sum1:IDDestinatario>");
            el(b, "NombreRazon", &nombre);
            el(b, "NIF", &nif);
            b.push_str("</sum1:IDDestinatario></sum1:Destinatarios>");
        }
    }

    // ── Desglose ──
    b.push_str("<sum1:Desglose>");
    if let Some(serde_json::Value::Array(tramos)) = r.desglose_json.as_deref().and_then(parsear_json) {
        // `DetalleDesglose` está acotado a 12 por el XSD. En hostelería son dos o tres; el recorte
        // existe para que un catálogo raro no tumbe el envío entero con un 4113.
        for t in tramos.iter().take(12) {
            escribir_detalle(b, t);
        }
    }
    b.push_str("</sum1:Desglose>");

    // Los importes van tal cual: es el texto que entró en la cadena hasheada.
    el(b, "CuotaTotal", r.cuota_total.as_deref().unwrap_or("0.00"));
    el(b, "ImporteTotal", r.importe_total.as_deref().unwrap_or("0.00"));

    escribir_encadenamiento(b, r);
    escribir_sistema(b, &r.sistema_json);

    el(b, "FechaHoraHusoGenRegistro", &r.fecha_hora_huso);
    el(b, "TipoHuella", &r.tipo_huella);
    el(b, "Huella", &r.huella);

    b.push_str("</sum1:RegistroAlta>");
}

/// `RegistroAnulacion`. Es otro diseño de registro: menos campos, otro `IDFactura` y sin desglose.
fn escribir_anulacion(b: &mut String, r: &RegistroParaEnvio) {
    b.push_str("<sum1:RegistroAnulacion>");
    el(b, "IDVersion", ID_VERSION);

    b.push_str("<sum1:IDFactura>");
    el(b, "IDEmisorFacturaAnulada", &r.nif_emisor);
    el(b, "NumSerieFacturaAnulada", &r.num_serie_factura);
    el(b, "FechaExpedicionFacturaAnulada", &r.fecha_expedicion);
    b.push_str("</sum1:IDFactura>");

    el_opt(b, "SinRegistroPrevio", r.sin_registro_previo.as_deref());
    el_opt(b, "RechazoPrevio", r.rechazo_previo.as_deref());

    escribir_encadenamiento(b, r);
    escribir_sistema(b, &r.sistema_json);

    el(b, "FechaHoraHusoGenRegistro", &r.fecha_hora_huso);
    el(b, "TipoHuella", &r.tipo_huella);
    el(b, "Huella", &r.huella);

    b.push_str("</sum1:RegistroAnulacion>");
}

/// El bloque `Encadenamiento`, que es un `choice`: **o** `PrimerRegistro` **o** `RegistroAnterior`.
///
/// Poner los dos, o ninguno, es un XML que no cumple el esquema. Y marcar `PrimerRegistro = "S"`
/// cuando ya existen registros para ese SIF y NIF es el error admisible 2007 — el escenario de una
/// Main restaurada, y la razón por la que el último eslabón siempre vuelve en el bootstrap.
fn escribir_encadenamiento(b: &mut String, r: &RegistroParaEnvio) {
    b.push_str("<sum1:Encadenamiento>");
    match r.ant_huella.as_deref().filter(|h| !h.trim().is_empty()) {
        Some(huella) => {
            b.push_str("<sum1:RegistroAnterior>");
            el(b, "IDEmisorFactura", r.ant_nif.as_deref().unwrap_or(""));
            el(b, "NumSerieFactura", r.ant_num_serie.as_deref().unwrap_or(""));
            el(b, "FechaExpedicionFactura", r.ant_fecha.as_deref().unwrap_or(""));
            el(b, "Huella", huella);
            b.push_str("</sum1:RegistroAnterior>");
        }
        None => el(b, "PrimerRegistro", "S"),
    }
    b.push_str("</sum1:Encadenamiento>");
}

/// El bloque `SistemaInformatico`, **tal como se congeló** en la fila.
///
/// Se lee del JSON guardado y no se recompone desde la configuración de hoy: si mañana cambia la
/// versión del TPV, el registro de ayer tiene que seguir diciendo con cuál se generó.
fn escribir_sistema(b: &mut String, sistema_json: &str) {
    let v = parsear_json(sistema_json).unwrap_or(serde_json::Value::Null);
    b.push_str("<sum1:SistemaInformatico>");
    el(b, "NombreRazon", &campo(&v, "NombreRazon"));
    // El XSD lo pone en un `choice`: **o** NIF **o** IDOtro, y uno de los dos es obligatorio
    // (error 1223). Aquí siempre es NIF: el productor es español.
    el(b, "NIF", &campo(&v, "NIF"));
    el(b, "NombreSistemaInformatico", &campo(&v, "NombreSistemaInformatico"));
    el(b, "IdSistemaInformatico", &campo(&v, "IdSistemaInformatico"));
    el(b, "Version", &campo(&v, "Version"));
    el(b, "NumeroInstalacion", &campo(&v, "NumeroInstalacion"));
    el(b, "TipoUsoPosibleSoloVerifactu", &campo_o(&v, "TipoUsoPosibleSoloVerifactu", "S"));
    el(b, "TipoUsoPosibleMultiOT", &campo_o(&v, "TipoUsoPosibleMultiOT", "N"));
    el(b, "IndicadorMultiplesOT", &campo_o(&v, "IndicadorMultiplesOT", "N"));
    b.push_str("</sum1:SistemaInformatico>");
}

/// Una línea del desglose (`DetalleType`), en el orden del XSD.
///
/// Siempre sujeta y no exenta (`CalificacionOperacion`), con tipo y cuota: el TPV no emite tramos
/// exentos (`tpv_domain::ticket`). Al 0 %, el tipo y la cuota también se informan (error 1208).
fn escribir_detalle(b: &mut String, t: &serde_json::Value) {
    b.push_str("<sum1:DetalleDesglose>");
    // `Impuesto` no se informa: vacío se considera `01` (IVA), que es el caso. Canarias, Ceuta y
    // Melilla (IGIC e IPSI) están fuera de alcance.
    // `ClaveRegimen` SÍ es obligatorio cuando el impuesto es IVA (error 1245).
    el(b, "ClaveRegimen", &campo_o(t, "ClaveRegimen", "01"));

    el(b, "CalificacionOperacion", &campo_o(t, "CalificacionOperacion", "S1"));
    el(b, "TipoImpositivo", &campo(t, "TipoImpositivo"));
    el(b, "BaseImponibleOimporteNoSujeto", &campo(t, "BaseImponibleOimporteNoSujeto"));
    el(b, "CuotaRepercutida", &campo(t, "CuotaRepercutida"));
    b.push_str("</sum1:DetalleDesglose>");
}

fn escribir_referencias(
    b: &mut String,
    refs: &serde_json::Value,
    clave: &str,
    envoltorio: &str,
    elemento: &str,
) {
    let Some(serde_json::Value::Array(lista)) = refs.get(clave) else {
        return;
    };
    if lista.is_empty() {
        return;
    }
    b.push_str(&format!("<sum1:{envoltorio}>"));
    for f in lista.iter().take(1000) {
        b.push_str(&format!("<sum1:{elemento}>"));
        el(b, "IDEmisorFactura", &campo(f, "IDEmisorFactura"));
        el(b, "NumSerieFactura", &campo(f, "NumSerieFactura"));
        el(b, "FechaExpedicionFactura", &campo(f, "FechaExpedicionFactura"));
        b.push_str(&format!("</sum1:{elemento}>"));
    }
    b.push_str(&format!("</sum1:{envoltorio}>"));
}

fn parsear_json(s: &str) -> Option<serde_json::Value> {
    serde_json::from_str(s).ok()
}

fn campo(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

fn campo_o(v: &serde_json::Value, k: &str, por_defecto: &str) -> String {
    let c = campo(v, k);
    if c.is_empty() {
        por_defecto.to_string()
    } else {
        c
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura de la respuesta
// ─────────────────────────────────────────────────────────────────────────────

/// Un elemento de la respuesta, ya leído: su nombre local, su texto y sus hijos.
///
/// Se guarda el nombre **local** y no `prefijo:nombre` porque el prefijo lo elige el servidor y no
/// forma parte del contrato: la misma respuesta puede llegar como `sfR:EstadoEnvio` o
/// `ns2:EstadoEnvio` sin dejar de ser válida. Un parser que se ate al prefijo funciona hasta el día
/// que la AEAT cambia su serializador.
///
/// RI-35: antes la respuesta se leía buscando cadenas `nombre>`, y eso no entendía una etiqueta con
/// atributos (`<ns:EstadoEnvio xmlns:ns="…">` no se encontraba), ni `CDATA`, ni las referencias
/// numéricas (`&#241;` llegaba tal cual a `DescripcionErrorRegistro`), y casaba por sufijo
/// (`<x:OtroCSV>` valía por `CSV`). Ahora lo lee `quick-xml`, y cada campo se busca donde lo pone
/// `RespuestaSuministro.xsd`, no en cualquier punto del documento.
#[derive(Debug, Default)]
struct Nodo {
    nombre: String,
    texto: String,
    hijos: Vec<Nodo>,
}

impl Nodo {
    fn nuevo(nombre: &[u8]) -> Self {
        Nodo {
            nombre: String::from_utf8_lossy(nombre).into_owned(),
            ..Nodo::default()
        }
    }

    /// El hijo directo con ese nombre.
    fn hijo(&self, nombre: &str) -> Option<&Nodo> {
        self.hijos.iter().find(|h| h.nombre == nombre)
    }

    /// El texto, sin blancos en los extremos, del hijo directo con ese nombre.
    fn texto_de(&self, nombre: &str) -> Option<String> {
        self.hijo(nombre).map(|h| h.texto.trim().to_string())
    }

    /// El primer descendiente con ese nombre, en orden de documento.
    fn buscar(&self, nombre: &str) -> Option<&Nodo> {
        self.hijos
            .iter()
            .find_map(|h| if h.nombre == nombre { Some(h) } else { h.buscar(nombre) })
    }

    /// Todos los descendientes con ese nombre, en orden de documento. No entra dentro de uno que
    /// ya casa: una `RespuestaLinea` no contiene otra.
    fn todos<'a>(&'a self, nombre: &str, out: &mut Vec<&'a Nodo>) {
        for h in &self.hijos {
            if h.nombre == nombre {
                out.push(h);
            } else {
                h.todos(nombre, out);
            }
        }
    }
}

/// Lee el documento entero a un árbol de [`Nodo`].
///
/// Un XML mal formado es un error con su motivo, no una respuesta vacía: así el job falla diciendo
/// por qué, en vez de reintentar el lote sin explicación.
fn parsear(xml: &str) -> Result<Nodo, String> {
    use quick_xml::events::Event;

    let mut reader = quick_xml::Reader::from_str(xml);
    let ilegible = |e: &dyn std::fmt::Display| format!("La respuesta de la AEAT no es un XML legible: {e}");

    // La raíz es un nodo sin nombre que hace de documento.
    let mut pila = vec![Nodo::default()];
    loop {
        match reader.read_event().map_err(|e| ilegible(&e))? {
            Event::Start(e) => pila.push(Nodo::nuevo(e.local_name().as_ref())),
            Event::Empty(e) => {
                let n = Nodo::nuevo(e.local_name().as_ref());
                pila.last_mut().expect("la raíz no se saca nunca").hijos.push(n);
            }
            Event::End(_) => {
                // `check_end_names` está activo por defecto: un cierre que no corresponde ya es un
                // error de `read_event`. Aquí sólo queda que haya algo abierto que cerrar.
                if pila.len() < 2 {
                    return Err(ilegible(&"cierre sin apertura"));
                }
                let n = pila.pop().expect("hay al menos dos");
                pila.last_mut().expect("hay al menos uno").hijos.push(n);
            }
            Event::Text(t) => {
                let t = t.xml10_content().map_err(|e| ilegible(&e))?;
                pila.last_mut().expect("la raíz no se saca nunca").texto.push_str(&t);
            }
            Event::CData(c) => {
                let c = c.decode().map_err(|e| ilegible(&e))?;
                pila.last_mut().expect("la raíz no se saca nunca").texto.push_str(&c);
            }
            // `&amp;`, `&#241;`… llegan como un evento aparte del texto que las rodea.
            Event::GeneralRef(r) => {
                let c = match r.resolve_char_ref().map_err(|e| ilegible(&e))? {
                    Some(c) => c.to_string(),
                    None => {
                        let nombre = r.decode().map_err(|e| ilegible(&e))?;
                        quick_xml::escape::resolve_predefined_entity(&nombre)
                            .ok_or_else(|| ilegible(&format!("entidad desconocida &{nombre};")))?
                            .to_string()
                    }
                };
                pila.last_mut().expect("la raíz no se saca nunca").texto.push_str(&c);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if pila.len() != 1 {
        return Err(ilegible(&"el documento termina con elementos sin cerrar"));
    }
    Ok(pila.pop().expect("comprobado arriba"))
}

/// Lee la respuesta del servicio.
///
/// Si el XML trae un `Fault` de SOAP, se devuelve como error: significa que el mensaje no estaba
/// bien formado o que la cabecera no pasó, y en los dos casos **el envío completo se rechazó** — no
/// hay líneas que clasificar.
pub fn leer_respuesta(xml: &str) -> Result<RespuestaRemision, String> {
    let doc = parsear(xml)?;

    if let Some(fault) = doc.buscar("Fault") {
        let fs = fault
            .buscar("faultstring")
            .map(|n| n.texto.trim().to_string())
            .unwrap_or_else(|| "sin descripción".to_string());
        return Err(format!("SOAP Fault: {fs}"));
    }

    // Los tres van en `RespuestaRegFactuSistemaFacturacion`, fuera de las líneas, y ninguna línea
    // trae elementos con esos nombres: el primero que aparece es el del envío.
    let campo = |nombre: &str| doc.buscar(nombre).map(|n| n.texto.trim().to_string());
    let estado_envio = campo("EstadoEnvio").unwrap_or_else(|| "Incorrecto".to_string());
    let csv = campo("CSV").filter(|s| !s.is_empty());
    let tiempo_espera_envio = campo("TiempoEsperaEnvio").and_then(|s| s.parse().ok());

    // Cada `RespuestaLinea` es un registro del envío. Se recorren en orden, que es el mismo en el
    // que se mandaron, pero se casan por número y no por posición: si la AEAT omitiera una línea,
    // casar por índice desplazaría todos los estados una posición y marcaría como aceptado un
    // registro rechazado.
    //
    // ⚠️ Y el número **no basta**: una anulación lleva el mismo que su alta. Lo que las separa es
    // `Operacion/TipoOperacion` (`Alta` | `Anulacion`): en la respuesta el `IDFactura` es siempre
    // `IDFacturaExpedidaType`, con `NumSerieFactura` también en una anulación
    // (`RespuestaExpedidaType` en `esquemas/RespuestaSuministro.xsd`). Aquí es el único sitio donde
    // ese dato existe; más arriba ya sólo hay un booleano.
    //
    // RI-89: se distinguía por un `NumSerieFacturaAnulada` que la respuesta no trae, así que toda
    // línea salía como alta y ninguna anulación casaba: se quedaban PENDIENTE para siempre.
    //
    // Una línea sin `TipoOperacion` (el XSD lo exige) no se puede atribuir: se descarta, que para
    // `remitir_ciclo` es «la AEAT no dijo nada de este registro» y lo deja PENDIENTE. Suponerla un
    // alta podría anotar en el alta el resultado de su anulación.
    //
    // Los campos se leen como hijos directos de la línea: `RegistroDuplicado` trae su propio
    // `CodigoErrorRegistro` y `DescripcionErrorRegistro`, y esos son los del registro que ya había
    // en la AEAT, no los de esta línea.
    let mut nodos = Vec::new();
    doc.todos("RespuestaLinea", &mut nodos);
    let lineas = nodos
        .into_iter()
        .filter_map(|l| {
            let anulacion = match l.hijo("Operacion")?.texto_de("TipoOperacion")?.as_str() {
                "Alta" => false,
                "Anulacion" => true,
                _ => return None,
            };
            Some(LineaRespuesta {
                anulacion,
                num_serie_factura: l
                    .hijo("IDFactura")
                    .and_then(|i| i.texto_de("NumSerieFactura"))
                    .unwrap_or_default(),
                estado: l.texto_de("EstadoRegistro").unwrap_or_default(),
                codigo_error: l.texto_de("CodigoErrorRegistro").and_then(|s| s.parse().ok()),
                descripcion_error: l.texto_de("DescripcionErrorRegistro").filter(|s| !s.is_empty()),
                estado_duplicado: l
                    .hijo("RegistroDuplicado")
                    .and_then(|d| d.texto_de("EstadoRegistroDuplicado"))
                    .filter(|s| !s.is_empty()),
            })
        })
        .collect();

    Ok(RespuestaRemision {
        estado_envio,
        csv,
        tiempo_espera_envio,
        lineas,
    })
}

#[cfg(test)]
// Algún nombre de test usa MAYUSCULAS para enfatizar la afirmacion que fija
// (`..._su_ANULACION_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn registro_base() -> RegistroParaEnvio {
        RegistroParaEnvio {
            id_registro: "r1".into(),
            tipo: "ALTA".into(),
            nif_emisor: "89890001K".into(),
            num_serie_factura: "2027/000001".into(),
            fecha_expedicion: "15-01-2027".into(),
            fecha_operacion: None,
            nombre_razon_emisor: "Bar de Pruebas SL".into(),
            tipo_factura: Some("F2".into()),
            tipo_rectificativa: None,
            descripcion_operacion: Some("Servicios de hosteleria".into()),
            importe_total: Some("12.10".into()),
            cuota_total: Some("1.10".into()),
            desglose_json: Some(
                r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"10","BaseImponibleOimporteNoSujeto":"11.00","CuotaRepercutida":"1.10"}]"#
                    .into(),
            ),
            destinatario_json: None,
            referencias_json: None,
            macrodato: None,
            primer_registro: Some("S".into()),
            ant_nif: None,
            ant_num_serie: None,
            ant_fecha: None,
            ant_huella: None,
            huella: "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60".into(),
            tipo_huella: "01".into(),
            fecha_hora_huso: "2027-01-15T21:34:56+01:00".into(),
            sistema_json: r#"{"NombreRazon":"Altaria","NIF":"B12345674","NombreSistemaInformatico":"TPV Altaria","IdSistemaInformatico":"01","Version":"1.0.0","NumeroInstalacion":"t-1","TipoUsoPosibleSoloVerifactu":"S","TipoUsoPosibleMultiOT":"N","IndicadorMultiplesOT":"N"}"#.into(),
            subsanacion: None,
            rechazo_previo: None,
            sin_registro_previo: None,
        }
    }

    fn cabecera() -> CabeceraEnvio {
        CabeceraEnvio {
            nif_obligado: "89890001K".into(),
            nombre_razon_obligado: "Bar de Pruebas SL".into(),
            incidencia: false,
        }
    }

    /// Índice del primer elemento con ese nombre, para comprobar el ORDEN del `sequence`.
    fn pos(xml: &str, tag: &str) -> usize {
        xml.find(&format!("<sum1:{tag}>"))
            .unwrap_or_else(|| panic!("falta <sum1:{tag}> en\n{xml}"))
    }

    #[test]
    fn el_alta_respeta_el_orden_del_sequence_del_xsd() {
        // El XSD usa `sequence`: un elemento fuera de sitio es un 4102 («el XML no cumple el
        // esquema») que rechaza el ENVÍO ENTERO, no sólo esa factura. No hay forma de detectarlo
        // leyendo el XML a ojo, así que se fija aquí.
        let xml = construir_envio(&cabecera(), &[registro_base()]);
        let orden = [
            "IDVersion",
            "IDFactura",
            "NombreRazonEmisor",
            "TipoFactura",
            "DescripcionOperacion",
            "Desglose",
            "CuotaTotal",
            "ImporteTotal",
            "Encadenamiento",
            "SistemaInformatico",
            "FechaHoraHusoGenRegistro",
            "TipoHuella",
            "Huella",
        ];
        let mut anterior = 0usize;
        for tag in orden {
            let p = pos(&xml, tag);
            assert!(p > anterior, "{tag} está fuera de orden");
            anterior = p;
        }
    }

    #[test]
    fn los_importes_van_tal_cual_se_guardaron() {
        // La regla que gobierna este módulo: nada se recalcula. Si el XML llevara un importe
        // recompuesto desde un f64, la huella dejaría de corresponder a los datos y la AEAT lo
        // marcaría como «aceptado con errores» (código 2000) — un fallo que no se ve como un error.
        let mut r = registro_base();
        r.importe_total = Some("123.10".into());
        r.cuota_total = Some("12.35".into());
        let xml = construir_envio(&cabecera(), &[r]);
        assert!(xml.contains("<sum1:ImporteTotal>123.10</sum1:ImporteTotal>"));
        assert!(xml.contains("<sum1:CuotaTotal>12.35</sum1:CuotaTotal>"));
    }

    #[test]
    fn el_primer_registro_va_como_primer_registro_y_no_como_registro_anterior() {
        // `Encadenamiento` es un `choice`: uno u otro, nunca los dos ni ninguno.
        let xml = construir_envio(&cabecera(), &[registro_base()]);
        assert!(xml.contains("<sum1:PrimerRegistro>S</sum1:PrimerRegistro>"));
        assert!(!xml.contains("RegistroAnterior"));
    }

    #[test]
    fn un_registro_encadenado_lleva_el_eslabon_anterior_completo() {
        let mut r = registro_base();
        r.primer_registro = None;
        r.ant_nif = Some("89890001K".into());
        r.ant_num_serie = Some("2027/000000".into());
        r.ant_fecha = Some("14-01-2027".into());
        r.ant_huella = Some("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97".into());
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(!xml.contains("PrimerRegistro"));
        assert!(xml.contains("<sum1:RegistroAnterior>"));
        assert!(xml.contains("<sum1:NumSerieFactura>2027/000000</sum1:NumSerieFactura>"));
        assert!(xml.contains(
            "<sum1:Huella>F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97</sum1:Huella>"
        ));
    }

    #[test]
    fn una_linea_al_cero_por_ciento_lleva_tipo_y_cuota() {
        // Un producto al 0 % es «sujeta y no exenta, gravada al 0 %», y ahí el tipo y la cuota son
        // OBLIGATORIOS (error 1208).
        let mut r = registro_base();
        r.desglose_json = Some(
            r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"0","BaseImponibleOimporteNoSujeto":"10.00","CuotaRepercutida":"0.00"}]"#
                .into(),
        );
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:CalificacionOperacion>S1</sum1:CalificacionOperacion>"));
        assert!(xml.contains("<sum1:TipoImpositivo>0</sum1:TipoImpositivo>"));
        assert!(xml.contains("<sum1:CuotaRepercutida>0.00</sum1:CuotaRepercutida>"));
    }

    #[test]
    fn el_desglose_siempre_lleva_clave_de_regimen() {
        // Error 1245: con Impuesto vacío (que es como va, y vacío se considera IVA), ClaveRegimen
        // es obligatorio.
        let xml = construir_envio(&cabecera(), &[registro_base()]);
        assert!(xml.contains("<sum1:ClaveRegimen>01</sum1:ClaveRegimen>"));
    }

    #[test]
    fn una_f2_no_lleva_destinatarios() {
        // Error 1190: en F2 y R5 el bloque Destinatarios NO puede venir informado. La emisión no lo
        // pone, y aquí se comprueba que no aparece por otra vía.
        let xml = construir_envio(&cabecera(), &[registro_base()]);
        assert!(!xml.contains("Destinatarios"));
    }

    #[test]
    fn una_f1_lleva_su_destinatario() {
        let mut r = registro_base();
        r.tipo_factura = Some("F1".into());
        r.destinatario_json = Some(r#"{"NombreRazon":"Empresa SL","NIF":"B12345674"}"#.into());
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:Destinatarios><sum1:IDDestinatario>"));
        assert!(xml.contains("<sum1:NombreRazon>Empresa SL</sum1:NombreRazon>"));
        // Y va DESPUÉS de DescripcionOperacion y ANTES del desglose (orden del sequence).
        assert!(pos(&xml, "DescripcionOperacion") < pos(&xml, "Destinatarios"));
        assert!(pos(&xml, "Destinatarios") < pos(&xml, "Desglose"));
    }

    #[test]
    fn el_domicilio_del_cliente_no_va_al_xml() {
        // RI-29: `Destinatario_Json` guarda el domicilio para el papel de la factura completa. El
        // XSD de `IDDestinatario` no tiene sitio para él: sólo salen el nombre y el NIF.
        let mut r = registro_base();
        r.tipo_factura = Some("F1".into());
        r.destinatario_json = Some(
            r#"{"NombreRazon":"Empresa SL","NIF":"B12345674","Domicilio":"Calle Mayor 1"}"#.into(),
        );
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:NIF>B12345674</sum1:NIF>"));
        assert!(!xml.contains("Calle Mayor"));
        assert!(!xml.contains("Domicilio"));
    }

    #[test]
    fn una_rectificativa_lleva_su_tipo_y_las_facturas_rectificadas() {
        let mut r = registro_base();
        r.tipo_factura = Some("R5".into());
        r.tipo_rectificativa = Some("I".into());
        r.referencias_json = Some(
            r#"{"rectificadas":[{"IDEmisorFactura":"89890001K","NumSerieFactura":"2027/000001","FechaExpedicionFactura":"15-01-2027"}],"sustituidas":[]}"#
                .into(),
        );
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:TipoRectificativa>I</sum1:TipoRectificativa>"));
        assert!(xml.contains("<sum1:FacturasRectificadas><sum1:IDFacturaRectificada>"));
        // `FacturasSustituidas` vacío NO se escribe: sólo puede ir en una F3 (error 1116).
        assert!(!xml.contains("FacturasSustituidas"));
        // Orden: TipoFactura → TipoRectificativa → FacturasRectificadas.
        assert!(pos(&xml, "TipoFactura") < pos(&xml, "TipoRectificativa"));
        assert!(pos(&xml, "TipoRectificativa") < pos(&xml, "FacturasRectificadas"));
    }

    #[test]
    fn una_factura_normal_no_lleva_tipo_rectificativa_ni_vacio() {
        // Error 1115: si la factura no es rectificativa, el campo NO debe tener valor. Omitirlo es
        // distinto de mandarlo vacío, y aquí la diferencia es un rechazo.
        let xml = construir_envio(&cabecera(), &[registro_base()]);
        assert!(!xml.contains("TipoRectificativa"));
    }

    #[test]
    fn la_subsanacion_de_un_rechazo_lleva_rechazo_previo_x() {
        let mut r = registro_base();
        r.subsanacion = Some("S".into());
        r.rechazo_previo = Some("X".into());
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:Subsanacion>S</sum1:Subsanacion>"));
        assert!(xml.contains("<sum1:RechazoPrevio>X</sum1:RechazoPrevio>"));
        // Van entre NombreRazonEmisor y TipoFactura, que es su sitio en el sequence.
        assert!(pos(&xml, "NombreRazonEmisor") < pos(&xml, "Subsanacion"));
        assert!(pos(&xml, "Subsanacion") < pos(&xml, "TipoFactura"));
    }

    #[test]
    fn la_anulacion_es_otro_diseno_de_registro() {
        let mut r = registro_base();
        r.tipo = "ANULACION".into();
        let xml = construir_envio(&cabecera(), &[r]);

        assert!(xml.contains("<sum1:RegistroAnulacion>"));
        assert!(xml.contains("<sum1:IDEmisorFacturaAnulada>"));
        assert!(xml.contains("<sum1:NumSerieFacturaAnulada>"));
        // No lleva desglose, ni importes, ni tipo de factura.
        assert!(!xml.contains("Desglose"));
        assert!(!xml.contains("ImporteTotal"));
        assert!(!xml.contains("TipoFactura"));
        // Pero sí encadenamiento, sistema y huella.
        assert!(xml.contains("Encadenamiento"));
        assert!(xml.contains("SistemaInformatico"));
        assert!(xml.contains("<sum1:TipoHuella>01</sum1:TipoHuella>"));
    }

    #[test]
    fn la_incidencia_solo_se_informa_cuando_la_hay() {
        let sin = construir_envio(&cabecera(), &[registro_base()]);
        assert!(!sin.contains("RemisionVoluntaria"));

        let mut c = cabecera();
        c.incidencia = true;
        let con = construir_envio(&c, &[registro_base()]);
        assert!(con.contains("<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia>"));
    }

    #[test]
    fn el_texto_se_escapa() {
        // La primera red es `sanear_texto` en el dominio (la AEAT rechaza < > " ' = aunque vayan
        // escapados, error 1287). Esta es la segunda: un texto que se colara sin sanear produciría
        // un XML inválido, que es peor que un rechazo.
        let mut r = registro_base();
        r.nombre_razon_emisor = "Bar & Cía".into();
        let xml = construir_envio(&cabecera(), &[r]);
        assert!(xml.contains("Bar &amp; Cía"));
        assert!(!xml.contains("Bar & Cía"));
    }

    #[test]
    fn el_desglose_se_recorta_a_doce_tramos() {
        // `DetalleDesglose` está acotado a maxOccurs=12. Pasarse es un 4113 que rechaza el envío
        // entero, y en hostelería no debería ocurrir nunca: el recorte existe para que un catálogo
        // raro no se lleve por delante a las otras 999 facturas del lote.
        let tramos: Vec<String> = (0..20)
            .map(|i| {
                format!(
                    r#"{{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"{i}","BaseImponibleOimporteNoSujeto":"1.00","CuotaRepercutida":"0.10"}}"#
                )
            })
            .collect();
        let mut r = registro_base();
        r.desglose_json = Some(format!("[{}]", tramos.join(",")));
        let xml = construir_envio(&cabecera(), &[r]);
        assert_eq!(xml.matches("<sum1:DetalleDesglose>").count(), 12);
    }

    // ── Lectura de la respuesta ────────────────────────────────────────────────────────────────

    const RESPUESTA_OK: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
 <env:Body>
  <sfR:RespuestaRegFactuSistemaFacturacion xmlns:sfR="x">
   <sfR:CSV>ABC123DEF456</sfR:CSV>
   <sfR:Cabecera/>
   <sfR:TiempoEsperaEnvio>60</sfR:TiempoEsperaEnvio>
   <sfR:EstadoEnvio>Correcto</sfR:EstadoEnvio>
   <sfR:RespuestaLinea>
     <sf:IDFactura><sf:NumSerieFactura>2027/000001</sf:NumSerieFactura></sf:IDFactura>
     <sf:Operacion><sf:TipoOperacion>Alta</sf:TipoOperacion></sf:Operacion>
     <sfR:EstadoRegistro>Correcto</sfR:EstadoRegistro>
   </sfR:RespuestaLinea>
  </sfR:RespuestaRegFactuSistemaFacturacion>
 </env:Body>
</env:Envelope>"#;

    #[test]
    fn lee_una_respuesta_correcta() {
        let r = leer_respuesta(RESPUESTA_OK).unwrap();
        assert_eq!(r.estado_envio, "Correcto");
        assert_eq!(r.csv.as_deref(), Some("ABC123DEF456"));
        assert_eq!(r.tiempo_espera_envio, Some(60));
        assert_eq!(r.lineas.len(), 1);
        assert_eq!(r.lineas[0].num_serie_factura, "2027/000001");
        assert_eq!(r.lineas[0].estado, "Correcto");
    }

    #[test]
    fn lee_una_respuesta_parcial_con_su_codigo_de_error() {
        let xml = r#"<env:Envelope xmlns:env="x"><env:Body><r:Resp xmlns:r="y">
          <r:TiempoEsperaEnvio>120</r:TiempoEsperaEnvio>
          <r:EstadoEnvio>ParcialmenteCorrecto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Correcto</r:EstadoRegistro>
          </r:RespuestaLinea>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000002</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>AceptadoConErrores</r:EstadoRegistro>
            <r:CodigoErrorRegistro>2000</r:CodigoErrorRegistro>
            <r:DescripcionErrorRegistro>El calculo de la huella suministrada es incorrecta.</r:DescripcionErrorRegistro>
          </r:RespuestaLinea>
        </r:Resp></env:Body></env:Envelope>"#;
        let r = leer_respuesta(xml).unwrap();

        assert_eq!(r.estado_envio, "ParcialmenteCorrecto");
        assert_eq!(r.tiempo_espera_envio, Some(120));
        assert_eq!(r.lineas.len(), 2);
        assert_eq!(r.lineas[1].estado, "AceptadoConErrores");
        assert_eq!(r.lineas[1].codigo_error, Some(2000));
        assert!(r.lineas[1].descripcion_error.as_deref().unwrap().contains("huella"));
    }

    #[test]
    fn distingue_el_alta_de_su_ANULACION_aunque_lleven_el_MISMO_numero() {
        // El `IDFactura` de una anulación es el de la factura que anula, así que las dos líneas
        // traen `2027/000001`, y las dos con `NumSerieFactura`: la respuesta usa
        // `IDFacturaExpedidaType` para todas (`RespuestaExpedidaType` en RespuestaSuministro.xsd).
        // Lo único que las separa es `Operacion/TipoOperacion`. Aquí es el único sitio del
        // programa donde ese dato existe — si se pierde, `remitir_ciclo` no casa nunca la anulación
        // (RI-89) o la casa con la línea del alta.
        //
        // Y va con la anulación PRIMERO a propósito: si el parser mirase sólo por posición o
        // devolviese siempre el primer número que encuentra, este orden lo delataría.
        let xml = r#"<env:Envelope xmlns:env="x"><env:Body><r:Resp xmlns:r="y">
          <r:EstadoEnvio>ParcialmenteCorrecto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:IDEmisorFactura>89890001K</s:IDEmisorFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura><s:FechaExpedicionFactura>15-01-2027</s:FechaExpedicionFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Anulacion</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Incorrecto</r:EstadoRegistro>
            <r:CodigoErrorRegistro>1150</r:CodigoErrorRegistro>
          </r:RespuestaLinea>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Correcto</r:EstadoRegistro>
          </r:RespuestaLinea>
        </r:Resp></env:Body></env:Envelope>"#;

        let r = leer_respuesta(xml).unwrap();
        assert_eq!(r.lineas.len(), 2);

        assert_eq!(r.lineas[0].num_serie_factura, "2027/000001");
        assert!(r.lineas[0].anulacion, "la primera es la de la ANULACIÓN");
        assert_eq!(r.lineas[0].estado, "Incorrecto");

        assert_eq!(r.lineas[1].num_serie_factura, "2027/000001");
        assert!(!r.lineas[1].anulacion, "la segunda es la del ALTA");
        assert_eq!(r.lineas[1].estado, "Correcto");
    }

    #[test]
    fn una_linea_sin_TIPO_DE_OPERACION_no_se_atribuye_a_nadie() {
        // El XSD lo exige, pero si faltara no se sabe si es la del alta o la de su anulación.
        // Suponer una de las dos podría anotar en un registro el resultado del otro; descartarla
        // deja el registro PENDIENTE, que es lo que `remitir_ciclo` hace con lo que la AEAT calla.
        let xml = r#"<r:Resp xmlns:r="y">
          <r:EstadoEnvio>Correcto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <r:EstadoRegistro>Correcto</r:EstadoRegistro>
          </r:RespuestaLinea>
        </r:Resp>"#;
        assert!(leer_respuesta(xml).unwrap().lineas.is_empty());
    }

    #[test]
    fn lee_el_estado_de_un_duplicado() {
        // Un rechazo por duplicado (3000) trae el estado en que quedó el registro que ya tenían.
        // Es lo que permite tratarlo como aceptado en vez de reintentar para siempre.
        let xml = r#"<e:E xmlns:e="x"><e:B><r:R xmlns:r="y">
          <r:EstadoEnvio>Incorrecto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Incorrecto</r:EstadoRegistro>
            <r:CodigoErrorRegistro>3000</r:CodigoErrorRegistro>
            <r:DescripcionErrorRegistro>Registro de facturacion duplicado.</r:DescripcionErrorRegistro>
            <r:RegistroDuplicado>
              <s:IdPeticionRegistroDuplicado>P1</s:IdPeticionRegistroDuplicado>
              <s:EstadoRegistroDuplicado>Correcta</s:EstadoRegistroDuplicado>
            </r:RegistroDuplicado>
          </r:RespuestaLinea>
        </r:R></e:B></e:E>"#;
        let r = leer_respuesta(xml).unwrap();

        assert_eq!(r.lineas[0].codigo_error, Some(3000));
        assert_eq!(r.lineas[0].estado_duplicado.as_deref(), Some("Correcta"));
    }

    #[test]
    fn un_soap_fault_es_un_error_y_no_una_respuesta_vacia() {
        // Un Fault significa que el mensaje no estaba bien formado o que la cabecera no pasó: el
        // envío COMPLETO se rechazó y no hay líneas que clasificar. Leerlo como una respuesta sin
        // líneas daría por buenos todos los registros del lote.
        let xml = r#"<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>
          <env:Fault>
            <faultcode>env:Client</faultcode>
            <faultstring>Codigo[4104].El NIF del titular en la cabecera no esta identificado.</faultstring>
          </env:Fault>
        </env:Body></env:Envelope>"#;
        let e = leer_respuesta(xml).unwrap_err();
        assert!(e.contains("4104"), "{e}");
    }

    #[test]
    fn el_parser_no_depende_del_prefijo_que_use_el_servidor() {
        // El prefijo lo elige el servidor y no forma parte del contrato: la misma respuesta puede
        // llegar como `sfR:EstadoEnvio` o como `ns2:EstadoEnvio`. Un parser atado al prefijo
        // funciona hasta el día que la AEAT cambia su serializador.
        let a = leer_respuesta(RESPUESTA_OK).unwrap();
        let b = leer_respuesta(&RESPUESTA_OK.replace("sfR:", "ns2:")).unwrap();
        assert_eq!(a.estado_envio, b.estado_envio);
        assert_eq!(a.lineas.len(), b.lineas.len());
    }

    // ── Respuestas REALES de preproducción ──
    //
    // `testdata/` guarda respuestas tal como las mandó la AEAT (capturadas con el arnés
    // `verifactu:ciclo`, que las deja en `target/verifactu-pruebas/respuestas/`), con el NIF, el
    // nombre del titular y el CSV cambiados por otros de prueba. Son la referencia de la forma de la
    // respuesta: los XML escritos a mano de arriba fueron los que dejaron pasar RI-89.

    const REAL_ALTAS: &str = include_str!("../testdata/respuesta_altas.xml");
    const REAL_ANULACIONES: &str = include_str!("../testdata/respuesta_anulaciones.xml");

    #[test]
    fn una_respuesta_REAL_de_altas_se_lee_entera() {
        let r = leer_respuesta(REAL_ALTAS).unwrap();
        assert_eq!(r.estado_envio, "Correcto");
        assert_eq!(r.csv.as_deref(), Some("A-PRUEBAALTAS000"));
        assert_eq!(r.tiempo_espera_envio, Some(60));
        let nums: Vec<_> = r.lineas.iter().map(|l| l.num_serie_factura.as_str()).collect();
        assert_eq!(nums, ["2026/000003", "2026/000004"]);
        assert!(r.lineas.iter().all(|l| !l.anulacion && l.estado == "Correcto"));
    }

    #[test]
    fn una_respuesta_REAL_de_anulaciones_trae_NumSerieFactura_y_se_distingue_por_TipoOperacion() {
        // Es la prueba de RI-89 con lo que de verdad contesta la AEAT: ni rastro de
        // `NumSerieFacturaAnulada` en la respuesta.
        assert!(!REAL_ANULACIONES.contains("NumSerieFacturaAnulada"));
        let r = leer_respuesta(REAL_ANULACIONES).unwrap();
        assert_eq!(r.csv.as_deref(), Some("A-PRUEBAANULAC00"));
        let nums: Vec<_> = r.lineas.iter().map(|l| l.num_serie_factura.as_str()).collect();
        assert_eq!(nums, ["2026/000003", "2026/000004"]);
        assert!(r.lineas.iter().all(|l| l.anulacion && l.estado == "Correcto"));
    }

    // ── RI-35: lo que un escáner de cadenas no entendía ──

    #[test]
    fn una_etiqueta_con_ATRIBUTOS_se_lee_igual() {
        // Un serializador que declare el espacio de nombres en cada elemento es igual de válido.
        // Con el escáner, `EstadoEnvio>` no aparecía y el envío se leía como «Incorrecto» sin líneas.
        let xml = r#"<r:Resp xmlns:r="y">
          <r:EstadoEnvio xmlns:r="y">Correcto</r:EstadoEnvio>
          <r:RespuestaLinea xmlns:r="y">
            <s:IDFactura xmlns:s="z"><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <s:Operacion xmlns:s="z"><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Correcto</r:EstadoRegistro>
          </r:RespuestaLinea>
        </r:Resp>"#;
        let r = leer_respuesta(xml).unwrap();
        assert_eq!(r.estado_envio, "Correcto");
        assert_eq!(r.lineas.len(), 1);
        assert_eq!(r.lineas[0].num_serie_factura, "2027/000001");
    }

    #[test]
    fn el_texto_se_descodifica_entero_con_CDATA_y_referencias_numericas() {
        let xml = r#"<r:Resp xmlns:r="y">
          <r:EstadoEnvio>Incorrecto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>A&amp;B/1</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Incorrecto</r:EstadoRegistro>
            <r:CodigoErrorRegistro>1100</r:CodigoErrorRegistro>
            <r:DescripcionErrorRegistro>A&#241;o <![CDATA[<incorrecto>]]> &#x2014; ver</r:DescripcionErrorRegistro>
          </r:RespuestaLinea>
        </r:Resp>"#;
        let l = &leer_respuesta(xml).unwrap().lineas[0];
        assert_eq!(l.num_serie_factura, "A&B/1");
        assert_eq!(l.descripcion_error.as_deref(), Some("Año <incorrecto> — ver"));
    }

    #[test]
    fn un_nombre_que_ACABA_igual_no_es_el_campo() {
        // El escáner buscaba `CSV>` y casaba con `<x:OtroCSV>`.
        let xml = r#"<r:Resp xmlns:r="y">
          <r:OtroCSV>NO</r:OtroCSV>
          <r:EstadoEnvio>Correcto</r:EstadoEnvio>
        </r:Resp>"#;
        assert_eq!(leer_respuesta(xml).unwrap().csv, None);
    }

    #[test]
    fn el_codigo_de_la_linea_no_se_toma_del_REGISTRO_DUPLICADO() {
        // `RegistroDuplicado` trae su propio código y descripción, los del registro que ya estaba
        // en la AEAT. Aquí la línea no trae los suyos y no se le pueden atribuir aquellos.
        let xml = r#"<r:Resp xmlns:r="y">
          <r:EstadoEnvio>Incorrecto</r:EstadoEnvio>
          <r:RespuestaLinea>
            <s:IDFactura><s:NumSerieFactura>2027/000001</s:NumSerieFactura></s:IDFactura>
            <s:Operacion><s:TipoOperacion>Alta</s:TipoOperacion></s:Operacion>
            <r:EstadoRegistro>Incorrecto</r:EstadoRegistro>
            <r:RegistroDuplicado>
              <s:EstadoRegistroDuplicado>AceptadaConErrores</s:EstadoRegistroDuplicado>
              <s:CodigoErrorRegistro>2000</s:CodigoErrorRegistro>
              <s:DescripcionErrorRegistro>La del registro que ya estaba</s:DescripcionErrorRegistro>
            </r:RegistroDuplicado>
          </r:RespuestaLinea>
        </r:Resp>"#;
        let l = &leer_respuesta(xml).unwrap().lineas[0];
        assert_eq!(l.codigo_error, None);
        assert_eq!(l.descripcion_error, None);
        assert_eq!(l.estado_duplicado.as_deref(), Some("AceptadaConErrores"));
    }

    #[test]
    fn un_XML_mal_formado_es_un_error_que_dice_por_que() {
        // Antes se leía como un envío «Incorrecto» sin líneas: todo el lote seguía PENDIENTE y el
        // job reintentaba sin decir nada. Ahora el error llega al panel del job.
        for roto in [
            r#"<r:Resp><r:EstadoEnvio>Correcto</r:Otro></r:Resp>"#,
            r#"<r:Resp><r:EstadoEnvio>Correcto</r:EstadoEnvio>"#,
            r#"<html><body>502 Bad Gateway<br></body></html>"#,
        ] {
            let e = leer_respuesta(roto).unwrap_err();
            assert!(e.contains("no es un XML legible"), "{roto} → {e}");
        }
    }
}
