//! El ticket de un cobro, compuesto desde la base (RI-29).
//!
//! Antes lo componía la pantalla: mandaba las líneas, el número y el QR, y Rust sólo maquetaba. Así
//! salieron papeles que no correspondían a su factura —la mesa entera con el número de un cobro
//! parcial, la venta siguiente con el número de la anterior—. Ahora el payload sale de aquí, del
//! pago y de su registro de facturación, y la pantalla sólo lo enseña.

use crate::error::{AppError, AppResult};
use crate::ports::configuracion::ConfiguracionRepository;
use crate::ports::tickets::{TicketDePago, TicketsRepository};
use tpv_contracts::configuracion::{BusinessSettings, TicketSettings};
use tpv_contracts::impresion::{
    DestinatarioTicket, FacturaDelCobro, PrintTicketLine, PrintTicketPayload, TicketDePagoInput, TramoTicket,
};
use tpv_domain::ticket;

/// El payload del ticket de un cobro: el que se enseña en la vista previa y el que se imprime.
pub async fn ticket_de_pago(
    tickets: &dyn TicketsRepository,
    config: &dyn ConfiguracionRepository,
    input: &TicketDePagoInput,
) -> AppResult<PrintTicketPayload> {
    let id_pago = input.id_pago.trim();
    if id_pago.is_empty() {
        return Err(AppError::validation("Falta el cobro del que sacar el ticket."));
    }
    let t = tickets
        .ticket_de_pago(id_pago, input.num_factura.as_deref())
        .await?
        .ok_or_else(|| AppError::not_found("Ese cobro no existe."))?;
    let negocio = config.get_business().await?;
    let ajustes = config.get_ticket().await?;
    Ok(componer(t, &negocio, &ajustes, input.es_copia))
}

/// Junta el cobro, su factura y los ajustes en el payload. Sin E/S, para poder probarlo.
pub fn componer(
    t: TicketDePago,
    negocio: &BusinessSettings,
    ajustes: &TicketSettings,
    es_copia: bool,
) -> PrintTicketPayload {
    let no_vacio = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());

    // La rectificativa de una devolución (y su `F3` negativa) documenta las mismas líneas que el
    // cobro, con el signo cambiado: el papel lo dice línea a línea, y su total es el declarado.
    let devuelve = t.factura.as_ref().is_some_and(|f| f.importe_total.es_negativo());
    let items = ticket::agrupar_lineas(&t.lineas)
        .into_iter()
        .map(|l| PrintTicketLine {
            nombre: l.nombre,
            cantidad: l.cantidad,
            precio_unitario: if devuelve { -l.precio_unitario } else { l.precio_unitario },
            iva_percent: l.iva_percent,
        })
        .collect();

    // Con factura, lo fiscal sale del registro: el número, el NIF y la razón social que se
    // declararon, la fecha de expedición, el QR, el desglose y el total. Sin ella (un cobro de modo
    // prueba) no hay nada que declarar y el papel sale con los datos de hoy.
    let (numero, cif, razon_social, fecha, qr_url, desglose, total) = match &t.factura {
        Some(f) => (
            no_vacio(&f.num_serie),
            f.nif_emisor.clone(),
            f.razon_emisor.clone(),
            ticket::fecha_del_papel(&f.fecha_expedicion, &f.fecha_hora_huso),
            no_vacio(&f.qr_url),
            Some(
                f.tramos
                    .iter()
                    .map(|tr| TramoTicket { tipo: tr.tipo, base: tr.base, cuota: tr.cuota })
                    .collect(),
            ),
            Some(f.importe_total),
        ),
        None => (
            no_vacio(&t.numero_ticket),
            negocio.cif.clone(),
            negocio.razon_social.clone(),
            ticket::fecha_de_cobro(&t.fecha_hora),
            None,
            None,
            None,
        ),
    };
    let qr_pruebas = qr_url
        .as_deref()
        .is_some_and(|u| u.starts_with(tpv_domain::verifactu::QR_BASE_PRUEBAS));

    // Una factura completa lleva a su cliente; una `F3`, además, el ticket que canjea.
    let tipo_factura = t.factura.as_ref().and_then(|f| no_vacio(&f.tipo_factura));
    let destinatario = t.factura.as_ref().and_then(|f| f.destinatario.clone()).map(
        |(nombre_razon, nif, domicilio)| DestinatarioTicket { nombre_razon, nif, domicilio },
    );
    let sustituye = t.factura.as_ref().and_then(|f| f.sustituye.clone());
    // Una rectificativa dice qué factura rectifica, con su fecha (arts. 7.1.h y 15.4 del RD
    // 1619/2012).
    let (rectifica, rectifica_fecha) = match t.factura.as_ref().and_then(|f| f.rectifica.clone()) {
        Some((num, fecha)) => (Some(num), Some(fecha.trim().replace('-', "/"))),
        None => (None, None),
    };
    // El cajón se abre con el ticket ORIGINAL del propio cobro pagado en efectivo, y con nada más:
    // una copia, la F3 de un canje (el cliente vuelve otro día) o la rectificativa de una devolución
    // no son el momento de meter dinero, y abrirlo sin venta es por donde se va (RI-29).
    let es_la_factura_del_cobro = match &t.factura {
        Some(f) => f.num_serie.trim() == t.numero_ticket.trim(),
        None => true,
    };
    let en_efectivo = t.metodo_pago.trim().eq_ignore_ascii_case("efectivo");
    let abre_cajon = !es_copia && es_la_factura_del_cobro && en_efectivo && !t.anulado && !devuelve;

    let facturas_del_cobro = t
        .facturas
        .into_iter()
        .map(|(num_serie, tipo_factura, importe)| FacturaDelCobro { num_serie, tipo_factura, importe })
        .collect();

    PrintTicketPayload {
        printer_name: None,
        business_name: negocio.business_name.clone(),
        direccion: negocio.direccion.clone(),
        telefono: negocio.telefono.clone(),
        cif,
        razon_social,
        mensaje_footer: negocio.mensaje_footer.clone(),
        iva_percent: negocio.iva_percent,
        show_logo: ajustes.show_logo,
        logo_path: negocio.logo_data_url.clone().filter(|s| !s.trim().is_empty()),
        show_business_name: ajustes.show_business_name,
        show_address: ajustes.show_address,
        show_phone: ajustes.show_phone,
        show_footer_message: ajustes.show_footer_message,
        qr_url,
        qr_pruebas,
        paper_width_mm: ajustes.paper_width_mm.clamp(0, u32::MAX as i64) as u32,
        paper_dpi: ajustes.paper_dpi.clamp(0, u32::MAX as i64) as u32,
        chars_per_line: ajustes.chars_per_line.clamp(0, u32::MAX as i64) as u32,
        margin_top_mm: ajustes.margin_top_mm,
        margin_bottom_mm: ajustes.margin_bottom_mm,
        margin_left_mm: ajustes.margin_left_mm,
        margin_right_mm: ajustes.margin_right_mm,
        font_scale: ajustes.font_scale,
        numero_ticket: numero,
        fecha: Some(fecha),
        // Una devolución no es un pago: sin la línea «Pago» y, sobre todo, sin el pulso que abre el
        // cajón al imprimir un cobro en efectivo.
        metodo_pago: if devuelve { None } else { no_vacio(&t.metodo_pago) },
        origen: no_vacio(&t.origen),
        es_copia,
        // ANULADO marca la copia del cobro que se dio de baja, no el papel que documenta la baja.
        es_anulado: t.anulado && !devuelve,
        abre_cajon,
        items,
        desglose,
        total,
        tipo_factura,
        destinatario,
        sustituye,
        rectifica,
        rectifica_fecha,
        facturas_del_cobro,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::tickets::FacturaDelTicket;
    use tpv_domain::dinero::Dinero;
    use tpv_domain::ticket::{LineaVendida, TramoIva};

    fn negocio() -> BusinessSettings {
        BusinessSettings {
            business_name: "Bar La Plaza".into(),
            logo_data_url: None,
            direccion: "Calle Mayor 1".into(),
            telefono: "600123456".into(),
            cif: "B00000000".into(),
            mensaje_footer: "Gracias".into(),
            iva_percent: 10.0,
            umbral_descuadre: Dinero::de_centimos(500),
            razon_social: "Razon De Hoy SL".into(),
            descripcion_op: "Hosteleria".into(),
            limite_simplif: Dinero::de_centimos(300_000),
            verifactu_entorno: "produccion".into(),
            reserva_duracion_min: 120,
            reserva_solape: "avisar".into(),
        }
    }

    fn ajustes() -> TicketSettings {
        TicketSettings {
            show_logo: false,
            show_business_name: true,
            show_address: true,
            show_phone: false,
            show_footer_message: true,
            paper_width_mm: 58,
            paper_dpi: 203,
            chars_per_line: 32,
            margin_top_mm: 0.0,
            margin_bottom_mm: 0.0,
            margin_left_mm: 0.0,
            margin_right_mm: 0.0,
            font_scale: 1.0,
        }
    }

    fn cobro(factura: Option<FacturaDelTicket>) -> TicketDePago {
        TicketDePago {
            numero_ticket: "2027/000007".into(),
            metodo_pago: "Efectivo".into(),
            origen: "Mesa 4".into(),
            anulado: false,
            fecha_hora: "2027-01-02 13:45:10".into(),
            lineas: vec![
                LineaVendida {
                    nombre: "Cafe".into(),
                    cantidad: 1.0,
                    precio_unitario: Dinero::de_centimos(110),
                    iva_percent: Some(10.0),
                },
                LineaVendida {
                    nombre: "Cafe".into(),
                    cantidad: 1.0,
                    precio_unitario: Dinero::de_centimos(110),
                    iva_percent: Some(10.0),
                },
            ],
            factura,
            facturas: vec![],
        }
    }

    fn factura() -> FacturaDelTicket {
        FacturaDelTicket {
            num_serie: "2027/000007".into(),
            tipo_factura: "F2".into(),
            nif_emisor: "B12345674".into(),
            razon_emisor: "Razon Declarada SL".into(),
            fecha_expedicion: "02-01-2027".into(),
            fecha_hora_huso: "2027-01-02T13:45:10+01:00".into(),
            qr_url: format!("{}?nif=B12345674", tpv_domain::verifactu::QR_BASE_PRODUCCION),
            importe_total: Dinero::de_centimos(220),
            tramos: vec![TramoIva {
                tipo: 10.0,
                base: Dinero::de_centimos(200),
                cuota: Dinero::de_centimos(20),
            }],
            destinatario: None,
            sustituye: None,
            rectifica: None,
        }
    }

    #[test]
    fn lo_fiscal_sale_del_registro_y_no_de_los_ajustes_de_hoy() {
        let p = componer(cobro(Some(factura())), &negocio(), &ajustes(), false);

        assert_eq!(p.numero_ticket.as_deref(), Some("2027/000007"));
        assert_eq!(p.cif, "B12345674", "el NIF es el declarado");
        assert_eq!(p.razon_social, "Razon Declarada SL");
        assert_eq!(p.fecha.as_deref(), Some("02/01/2027 13:45"), "la fecha es la de expedición");
        assert_eq!(p.total, Some(Dinero::de_centimos(220)));
        assert_eq!(p.desglose.as_ref().map(|d| d.len()), Some(1));
        assert!(p.qr_url.is_some() && !p.qr_pruebas);
    }

    #[test]
    fn las_lineas_son_las_del_cobro_agrupadas() {
        let p = componer(cobro(Some(factura())), &negocio(), &ajustes(), false);
        assert_eq!(p.items.len(), 1);
        assert_eq!(p.items[0].cantidad, 2);
    }

    #[test]
    fn un_qr_de_pruebas_se_marca_por_su_url() {
        let mut f = factura();
        f.qr_url = format!("{}?nif=B12345674", tpv_domain::verifactu::QR_BASE_PRUEBAS);
        assert!(componer(cobro(Some(f)), &negocio(), &ajustes(), false).qr_pruebas);
    }

    #[test]
    fn sin_factura_el_papel_lleva_el_numero_del_cobro_y_los_datos_de_hoy() {
        let mut t = cobro(None);
        t.numero_ticket = "PRUEBA/000003".into();
        let p = componer(t, &negocio(), &ajustes(), true);

        assert_eq!(p.numero_ticket.as_deref(), Some("PRUEBA/000003"));
        assert_eq!(p.cif, "B00000000");
        assert_eq!(p.fecha.as_deref(), Some("02/01/2027 13:45"));
        assert!(p.qr_url.is_none() && p.desglose.is_none() && p.total.is_none());
        assert!(p.es_copia);
    }

    #[test]
    fn una_f3_lleva_su_cliente_y_el_ticket_que_canjea() {
        let mut f = factura();
        f.num_serie = "F-000001".into();
        f.tipo_factura = "F3".into();
        f.destinatario = Some(("Cliente SL".into(), "B87654321".into(), Some("Calle Real 2".into())));
        f.sustituye = Some("2027/000007".into());
        let p = componer(cobro(Some(f)), &negocio(), &ajustes(), false);

        assert_eq!(p.numero_ticket.as_deref(), Some("F-000001"));
        assert_eq!(p.tipo_factura.as_deref(), Some("F3"));
        assert_eq!(p.destinatario.as_ref().map(|d| d.nif.as_str()), Some("B87654321"));
        assert_eq!(p.destinatario.and_then(|d| d.domicilio).as_deref(), Some("Calle Real 2"));
        assert_eq!(p.sustituye.as_deref(), Some("2027/000007"));
    }

    fn rectificativa() -> FacturaDelTicket {
        let mut f = factura();
        f.num_serie = "R2027/000001".into();
        f.tipo_factura = "R5".into();
        f.importe_total = Dinero::de_centimos(-220);
        f.tramos = vec![TramoIva {
            tipo: 10.0,
            base: Dinero::de_centimos(-200),
            cuota: Dinero::de_centimos(-20),
        }];
        f.rectifica = Some(("2027/000007".into(), "02-01-2027".into()));
        f
    }

    #[test]
    fn la_rectificativa_dice_que_factura_rectifica_y_cuando_se_expidio() {
        let p = componer(cobro(Some(rectificativa())), &negocio(), &ajustes(), false);
        assert_eq!(p.numero_ticket.as_deref(), Some("R2027/000001"));
        assert_eq!(p.tipo_factura.as_deref(), Some("R5"));
        assert_eq!(p.rectifica.as_deref(), Some("2027/000007"));
        assert_eq!(p.rectifica_fecha.as_deref(), Some("02/01/2027"));
    }

    #[test]
    fn las_lineas_de_una_devolucion_van_en_negativo_y_cuadran_con_el_total() {
        let p = componer(cobro(Some(rectificativa())), &negocio(), &ajustes(), false);
        assert_eq!(p.items[0].precio_unitario, Dinero::de_centimos(-110));
        let suma: Dinero = p.items.iter().map(|l| l.precio_unitario.por(l.cantidad as i64)).sum();
        assert_eq!(Some(suma), p.total);
    }

    #[test]
    fn una_devolucion_no_es_un_pago_ni_se_marca_anulada() {
        // Sin método de pago no hay línea «Pago» ni pulso de cajón; y ANULADO es para la copia del
        // cobro dado de baja, no para el papel que documenta la baja.
        let mut t = cobro(Some(rectificativa()));
        t.anulado = true;
        let p = componer(t, &negocio(), &ajustes(), false);
        assert_eq!(p.metodo_pago, None);
        assert!(!p.es_anulado);
    }

    #[test]
    fn la_copia_del_cobro_dado_de_baja_sigue_saliendo_anulada_y_con_su_metodo() {
        let mut t = cobro(Some(factura()));
        t.anulado = true;
        let p = componer(t, &negocio(), &ajustes(), true);
        assert!(p.es_anulado);
        assert_eq!(p.metodo_pago.as_deref(), Some("Efectivo"));
        assert!(p.items.iter().all(|l| !l.precio_unitario.es_negativo()));
    }

    #[test]
    fn las_facturas_del_cobro_viajan_en_orden() {
        let mut t = cobro(Some(factura()));
        t.facturas = vec![
            ("2027/000007".into(), "F2".into(), Dinero::de_centimos(220)),
            ("R2027/000001".into(), "R5".into(), Dinero::de_centimos(-220)),
        ];
        let p = componer(t, &negocio(), &ajustes(), false);
        let tipos: Vec<&str> = p.facturas_del_cobro.iter().map(|f| f.tipo_factura.as_str()).collect();
        assert_eq!(tipos, ["F2", "R5"]);
    }

    #[test]
    fn el_ticket_original_de_un_cobro_en_efectivo_abre_el_cajon() {
        let p = componer(cobro(Some(factura())), &negocio(), &ajustes(), false);
        assert!(p.abre_cajon);
    }

    #[test]
    fn una_copia_no_abre_el_cajon() {
        let p = componer(cobro(Some(factura())), &negocio(), &ajustes(), true);
        assert!(!p.abre_cajon);
        assert_eq!(p.metodo_pago.as_deref(), Some("Efectivo"), "el papel sigue diciendo cómo se pagó");
    }

    #[test]
    fn el_efectivo_se_reconoce_sin_importar_mayusculas_ni_espacios() {
        let mut t = cobro(Some(factura()));
        t.metodo_pago = "  EFECTIVO  ".into();
        assert!(componer(t, &negocio(), &ajustes(), false).abre_cajon);
    }

    #[test]
    fn un_cobro_con_tarjeta_no_abre_el_cajon() {
        let mut t = cobro(Some(factura()));
        t.metodo_pago = "Tarjeta".into();
        assert!(!componer(t, &negocio(), &ajustes(), false).abre_cajon);
    }

    #[test]
    fn la_f3_de_un_canje_no_abre_el_cajon() {
        // El cliente vuelve otro día a pedir factura: no hay dinero que meter.
        let mut f = factura();
        f.num_serie = "F-000001".into();
        f.tipo_factura = "F3".into();
        assert!(!componer(cobro(Some(f)), &negocio(), &ajustes(), false).abre_cajon);
    }

    #[test]
    fn ni_la_rectificativa_ni_la_copia_de_un_cobro_anulado_abren_el_cajon() {
        assert!(!componer(cobro(Some(rectificativa())), &negocio(), &ajustes(), false).abre_cajon);
        let mut t = cobro(Some(factura()));
        t.anulado = true;
        assert!(!componer(t, &negocio(), &ajustes(), false).abre_cajon);
    }

    #[test]
    fn un_cobro_de_modo_prueba_en_efectivo_abre_el_cajon() {
        // Sin registro fiscal sigue siendo un cobro: el dinero entra igual.
        assert!(componer(cobro(None), &negocio(), &ajustes(), false).abre_cajon);
    }

    #[test]
    fn la_personalizacion_sale_de_los_ajustes() {
        let p = componer(cobro(None), &negocio(), &ajustes(), false);
        assert_eq!((p.paper_width_mm, p.chars_per_line), (58, 32));
        assert!(p.show_business_name && p.show_address && !p.show_phone);
    }
}
