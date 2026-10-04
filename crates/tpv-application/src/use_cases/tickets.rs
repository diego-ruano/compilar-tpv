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
use tpv_contracts::impresion::{PrintTicketLine, PrintTicketPayload, TicketDePagoInput, TramoTicket};
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
        .ticket_de_pago(id_pago)
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

    let items = ticket::agrupar_lineas(&t.lineas)
        .into_iter()
        .map(|l| PrintTicketLine {
            nombre: l.nombre,
            cantidad: l.cantidad,
            precio_unitario: l.precio_unitario,
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
        metodo_pago: no_vacio(&t.metodo_pago),
        origen: no_vacio(&t.origen),
        es_copia,
        es_anulado: t.anulado,
        items,
        desglose,
        total,
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
    fn la_personalizacion_sale_de_los_ajustes() {
        let p = componer(cobro(None), &negocio(), &ajustes(), false);
        assert_eq!((p.paper_width_mm, p.chars_per_line), (58, 32));
        assert!(p.show_business_name && p.show_address && !p.show_phone);
    }
}
