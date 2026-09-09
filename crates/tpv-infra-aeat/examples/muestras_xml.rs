//! Genera **muestras del XML que se manda a la AEAT**, para validarlas contra los XSD oficiales.
//!
//! ```text
//! cargo run -p tpv-infra-aeat --example muestras_xml -- <directorio>
//! pnpm verifactu:validar-xml          # hace las dos cosas (ver scripts/verifactu-validar-xml.mjs)
//! ```
//!
//! ## Por qué esto existe
//!
//! Los tests de `xml.rs` comprueban reglas concretas: que tal campo esté, que tal otro no, que el
//! orden sea el del `sequence`. Eso caza los errores que uno sabe buscar. Lo que **no** puede
//! cazar es el que uno no sabe que existe — un tipo que no cumple su patrón, un `maxLength` que se
//! pasa, un elemento que falta en un caso que nadie previó.
//!
//! Para eso está el XSD, que es el contrato entero escrito por la AEAT. Validar contra él **antes**
//! de conectarse convierte el primer envío real en una comprobación de que el certificado funciona,
//! y no en una sesión de depuración a ciegas contra un servidor que sólo contesta «4102: el XML no
//! cumple el esquema» sin decir qué campo.
//!
//! Las muestras cubren los casos que de verdad se emiten en un bar, más los que se emiten poco y
//! por eso son los que se rompen sin que nadie lo note.

use std::path::PathBuf;

use tpv_application::ports::aeat::{CabeceraEnvio, RegistroParaEnvio};
use tpv_infra_aeat::xml;

fn base() -> RegistroParaEnvio {
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
        descripcion_operacion: Some("Servicios de hosteleria y restauracion".into()),
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
        sistema_json: r#"{"NombreRazon":"Altaria Lights","NIF":"B12345674","NombreSistemaInformatico":"TPV Altaria","IdSistemaInformatico":"01","Version":"0.1.0","NumeroInstalacion":"tenant-de-pruebas","TipoUsoPosibleSoloVerifactu":"S","TipoUsoPosibleMultiOT":"N","IndicadorMultiplesOT":"N"}"#.into(),
        subsanacion: None,
        rechazo_previo: None,
        sin_registro_previo: None,
    }
}

fn encadenado(mut r: RegistroParaEnvio) -> RegistroParaEnvio {
    r.primer_registro = None;
    r.ant_nif = Some("89890001K".into());
    r.ant_num_serie = Some("2027/000000".into());
    r.ant_fecha = Some("14-01-2027".into());
    r.ant_huella = Some("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97".into());
    r
}

fn cabecera(incidencia: bool) -> CabeceraEnvio {
    CabeceraEnvio {
        nif_obligado: "89890001K".into(),
        nombre_razon_obligado: "Bar de Pruebas SL".into(),
        incidencia,
    }
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/muestras-xml"));
    std::fs::create_dir_all(&dir).expect("creando el directorio de muestras");

    let mut muestras: Vec<(&str, String)> = Vec::new();

    // ── El caso normal de un bar: un ticket, primer registro de la cadena ──
    muestras.push((
        "01-f2-primer-registro",
        xml::construir_envio(&cabecera(false), &[base()]),
    ));

    // ── El caso normal a partir del segundo ticket: encadenado ──
    muestras.push((
        "02-f2-encadenada",
        xml::construir_envio(&cabecera(false), &[encadenado(base())]),
    ));

    // ── Dos tipos de IVA en el mismo ticket (comida al 10 y algo envasado al 21) ──
    let mut dos_tipos = encadenado(base());
    dos_tipos.importe_total = Some("24.20".into());
    dos_tipos.cuota_total = Some("3.20".into());
    dos_tipos.desglose_json = Some(
        r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"10","BaseImponibleOimporteNoSujeto":"11.00","CuotaRepercutida":"1.10"},
            {"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"21","BaseImponibleOimporteNoSujeto":"10.00","CuotaRepercutida":"2.10"}]"#
            .into(),
    );
    muestras.push((
        "03-f2-dos-tipos",
        xml::construir_envio(&cabecera(false), &[dos_tipos]),
    ));

    // ── Una línea EXENTA junto a una sujeta. Es el caso que más fácil se rompe: la exenta no
    //    puede llevar TipoImpositivo ni CuotaRepercutida, y el XSD lo impone con un <choice>. ──
    let mut con_exenta = encadenado(base());
    con_exenta.importe_total = Some("17.10".into());
    con_exenta.cuota_total = Some("1.10".into());
    con_exenta.desglose_json = Some(
        r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"10","BaseImponibleOimporteNoSujeto":"11.00","CuotaRepercutida":"1.10"},
            {"ClaveRegimen":"01","OperacionExenta":"E1","BaseImponibleOimporteNoSujeto":"5.00"}]"#
            .into(),
    );
    muestras.push((
        "04-f2-con-exenta",
        xml::construir_envio(&cabecera(false), &[con_exenta]),
    ));

    // ── Un producto al 0 %: SUJETO, con tipo y cuota a cero. El contrario del anterior. ──
    let mut al_cero = encadenado(base());
    al_cero.importe_total = Some("10.00".into());
    al_cero.cuota_total = Some("0.00".into());
    al_cero.desglose_json = Some(
        r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"0","BaseImponibleOimporteNoSujeto":"10.00","CuotaRepercutida":"0.00"}]"#
            .into(),
    );
    muestras.push((
        "05-f2-al-cero-por-ciento",
        xml::construir_envio(&cabecera(false), &[al_cero]),
    ));

    // ── Factura completa (F1) con destinatario ──
    let mut f1 = encadenado(base());
    f1.tipo_factura = Some("F1".into());
    f1.destinatario_json = Some(r#"{"NombreRazon":"Empresa Cliente SL","NIF":"B12345674"}"#.into());
    muestras.push(("06-f1-con-destinatario", xml::construir_envio(&cabecera(false), &[f1])));

    // ── Factura sustitutiva (F3): el cliente vuelve con el ticket y pide factura ──
    let mut f3 = encadenado(base());
    f3.tipo_factura = Some("F3".into());
    f3.destinatario_json = Some(r#"{"NombreRazon":"Empresa Cliente SL","NIF":"B12345674"}"#.into());
    f3.referencias_json = Some(
        r#"{"rectificadas":[],"sustituidas":[{"IDEmisorFactura":"89890001K","NumSerieFactura":"2027/000001","FechaExpedicionFactura":"15-01-2027"}]}"#
            .into(),
    );
    muestras.push(("07-f3-sustitutiva", xml::construir_envio(&cabecera(false), &[f3])));

    // ── Rectificativa por diferencias (R5): una devolución sobre una simplificada ──
    let mut r5 = encadenado(base());
    r5.tipo_factura = Some("R5".into());
    r5.tipo_rectificativa = Some("I".into());
    r5.importe_total = Some("-12.10".into());
    r5.cuota_total = Some("-1.10".into());
    r5.desglose_json = Some(
        r#"[{"ClaveRegimen":"01","CalificacionOperacion":"S1","TipoImpositivo":"10","BaseImponibleOimporteNoSujeto":"-11.00","CuotaRepercutida":"-1.10"}]"#
            .into(),
    );
    r5.referencias_json = Some(
        r#"{"rectificadas":[{"IDEmisorFactura":"89890001K","NumSerieFactura":"2027/000001","FechaExpedicionFactura":"15-01-2027"}],"sustituidas":[]}"#
            .into(),
    );
    muestras.push(("08-r5-rectificativa", xml::construir_envio(&cabecera(false), &[r5])));

    // ── Anulación: otro diseño de registro entero ──
    let mut anul = encadenado(base());
    anul.tipo = "ANULACION".into();
    muestras.push(("09-anulacion", xml::construir_envio(&cabecera(false), &[anul])));

    // ── Subsanación de un registro RECHAZADO (Subsanacion=S + RechazoPrevio=X) ──
    let mut subs = encadenado(base());
    subs.subsanacion = Some("S".into());
    subs.rechazo_previo = Some("X".into());
    muestras.push((
        "10-subsanacion-tras-rechazo",
        xml::construir_envio(&cabecera(false), &[subs]),
    ));

    // ── Subsanación de un registro ACEPTADO CON ERRORES (Subsanacion=S, sin RechazoPrevio) ──
    let mut subs2 = encadenado(base());
    subs2.subsanacion = Some("S".into());
    muestras.push((
        "11-subsanacion-de-aceptado",
        xml::construir_envio(&cabecera(false), &[subs2]),
    ));

    // ── Un lote con incidencia (el equipo estuvo sin red y esto llega tarde) ──
    muestras.push((
        "12-lote-con-incidencia",
        xml::construir_envio(&cabecera(true), &[base(), encadenado(base())]),
    ));

    // ── La cena que cruza la medianoche: se consumió el 15 y se cobró el 16 ──
    //
    // `FechaOperacion` sólo se informa cuando difiere de la de expedición (arts. 6.1.i) y 7.1.c)
    // del RD 1619/2012). Esta muestra existe para que el XSD confirme dos cosas que un test
    // unitario no puede: que el campo cabe donde lo ponemos dentro del `sequence`, y que su tipo
    // `fecha` acepta el formato `DD-MM-AAAA` que usamos en todo lo demás.
    let mut cruza_medianoche = base();
    cruza_medianoche.fecha_expedicion = "16-01-2027".into();
    cruza_medianoche.fecha_operacion = Some("15-01-2027".into());
    muestras.push((
        "13-f2-operacion-de-otro-dia",
        xml::construir_envio(&cabecera(false), &[cruza_medianoche]),
    ));

    for (nombre, contenido) in &muestras {
        let ruta = dir.join(format!("{nombre}.xml"));
        std::fs::write(&ruta, contenido).expect("escribiendo la muestra");
        println!("{}", ruta.display());
    }
    eprintln!("\n{} muestras escritas en {}", muestras.len(), dir.display());
}
