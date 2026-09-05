//! Tests del generador de tickets ESC/POS.
//!
//! Viven en su propio fichero porque son mas largos que el generador: mezclados, cada cambio
//! del ticket obligaba a pasar por delante de setecientas lineas de asserts para encontrar el
//! codigo.

use super::*;

#[cfg(test)]
mod fixtures {
    //! Payloads de prueba compartidos por los módulos de test de este fichero.
    //!
    //! Están aquí y no duplicados en cada módulo porque `PrintTicketPayload` tiene treinta campos:
    //! cuando se añade uno, un helper único es una corrección y cinco copias son cinco olvidos.

    use super::*;

    /// Payload con TODO apagado salvo lo que interviene en el dinero (líneas, base+IVA y total).
    /// Cada test enciende lo suyo.
    pub fn payload(iva_negocio: f64, items: Vec<PrintTicketLine>) -> PrintTicketPayload {
        PrintTicketPayload {
            printer_name: None,
            business_name: String::new(),
            direccion: String::new(),
            telefono: String::new(),
            cif: String::new(),
            mensaje_footer: String::new(),
            iva_percent: iva_negocio,
            show_logo: false,
            logo_path: None,
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
            es_anulado: false,
            items,
        }
    }

    /// Como [`payload`] pero con nombre de negocio, que es el ticket "normal" de un bar.
    pub fn base(items: Vec<PrintTicketLine>) -> PrintTicketPayload {
        let mut p = payload(10.0, items);
        p.business_name = "Bar".into();
        p.show_business_name = true;
        p
    }

    pub fn linea_de(precio: f64, cantidad: u32, iva: Option<f64>) -> PrintTicketLine {
        PrintTicketLine {
            nombre: "Item".into(),
            cantidad,
            precio_unitario: precio,
            iva_percent: iva,
        }
    }

    /// Un café: la línea de ticket más corriente que existe.
    pub fn linea() -> PrintTicketLine {
        PrintTicketLine {
            nombre: "Cafe".into(),
            cantidad: 1,
            precio_unitario: 1.1,
            iva_percent: None,
        }
    }

    /// El texto del ticket, ya codificado, para poder buscar dentro.
    pub fn contiene(bytes: &[u8], texto: &str) -> bool {
        let aguja = encode_cp858(texto);
        bytes.windows(aguja.len()).any(|w| w == aguja.as_slice())
    }
}

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

    use super::fixtures::*;
    use super::*;

    /// Compara con la tolerancia de un céntimo mal redondeado.
    fn cerca(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn sin_tipos_propios_todo_va_al_del_negocio() {
        let p = payload(10.0, vec![linea_de(11.0, 1, None), linea_de(5.5, 2, None)]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 1);
        assert!(cerca(d[0].0, 10.0));
        // 22 € con IVA al 10% → base 20, IVA 2.
        assert!(cerca(d[0].1, 20.0), "base {}", d[0].1);
        assert!(cerca(d[0].2, 2.0), "iva {}", d[0].2);
    }

    #[test]
    fn el_tipo_de_la_linea_manda_sobre_el_del_negocio() {
        let p = payload(10.0, vec![linea_de(12.1, 1, Some(21.0))]);
        let d = desglose_iva(&p);

        assert_eq!(d.len(), 1);
        assert!(cerca(d[0].0, 21.0));
        assert!(cerca(d[0].1, 10.0), "base {}", d[0].1);
    }

    #[test]
    fn un_ticket_con_dos_tipos_los_separa_y_suma_lo_mismo_que_el_total() {
        // Comida al 10 y algo envasado para llevar al 21, que es el caso que obligó a esto.
        let p = payload(10.0, vec![linea_de(11.0, 1, None), linea_de(12.1, 1, Some(21.0))]);
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
            vec![linea_de(11.0, 1, Some(21.0)), linea_de(11.0, 1, Some(21.0)), linea_de(11.0, 1, None)],
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
        let p = payload(0.0, vec![linea_de(10.0, 1, Some(0.0))]);
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

    use super::fixtures::*;
    use super::*;


    /// El ticket se codifica en CP858; para buscar texto ASCII basta con leerlo como bytes.

    #[test]
    fn sin_numero_es_una_precuenta_y_lo_dice() {
        let bytes = build_ticket(&base(vec![linea()]), None);

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
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "T-000042"));
        assert!(!contiene(&bytes, "PRECUENTA"));
        assert!(!contiene(&bytes, "NO ES UN TICKET DE VENTA"));
    }

    #[test]
    fn una_reimpresion_lleva_el_mismo_numero_y_dice_COPIA() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000042".into());
        p.es_copia = true;
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "T-000042"));
        assert!(contiene(&bytes, "COPIA"));
    }

    #[test]
    fn la_copia_de_un_cobro_anulado_lo_dice_en_el_papel() {
        // Un ticket anulado se puede reimprimir —es la prueba de qué contenía— pero un papel que
        // no lo diga circularía como un cobro válido. Y sigue siendo una copia: las dos marcas
        // responden a preguntas distintas.
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000042".into());
        p.es_copia = true;
        p.es_anulado = true;
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "ANULADO"));
        assert!(contiene(&bytes, "COPIA"));
    }

    #[test]
    fn una_precuenta_nunca_se_marca_como_copia() {
        // Sin número no hay original del que ser copia: el aviso que toca es el de precuenta.
        let mut p = base(vec![linea()]);
        p.es_copia = true;
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "NO ES UN TICKET DE VENTA"));
        assert!(!contiene(&bytes, "COPIA"));
    }

    #[test]
    fn el_origen_y_el_metodo_salen_impresos() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000007".into());
        p.origen = Some("Mesa 5".into());
        p.metodo_pago = Some("Tarjeta".into());
        let bytes = build_ticket(&p, None);

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
        let bytes = build_ticket(&p, None);

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
        let bytes = build_ticket(&p, None);

        assert!(!bytes.windows(5).any(|w| w == PULSO_CAJON));
    }

    #[test]
    fn una_precuenta_no_abre_el_cajon() {
        // No hay cobro: no hay dinero que meter.
        let bytes = build_ticket(&base(vec![linea()]), None);
        assert!(!bytes.windows(5).any(|w| w == PULSO_CAJON));
    }

    #[test]
    fn el_metodo_se_reconoce_sin_importar_mayusculas_ni_espacios() {
        let mut p = base(vec![linea()]);
        p.numero_ticket = Some("T-000001".into());
        p.metodo_pago = Some("  EFECTIVO  ".into());
        let bytes = build_ticket(&p, None);

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
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "PRECUENTA"));
    }
}

#[cfg(test)]
mod tests_logo {
    //! Rasterizado del logo a ESC/POS.
    //!
    //! Una térmica es de UN BIT: cada punto se marca o no. Lo que se comprueba aquí es la
    //! cabecera del bloque —de la que depende que la impresora interprete bien la trama— y que un
    //! logo que no se pueda decodificar no reviente el ticket: sale sin logo, que es mejor que no
    //! salir.

    use super::fixtures::*;
    use super::*;

    /// PNG mínimo válido (1×1, negro), suficiente para ejercitar el decodificador.
    fn png_1x1() -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap()
    }

    #[test]
    fn el_bloque_empieza_por_la_cabecera_de_imagen_de_escpos() {
        let b = rasterizar_logo(&png_1x1(), 576).expect("un PNG válido se rasteriza");

        // GS v 0 m — sin esto la impresora escupiría la trama como si fuera texto.
        assert_eq!(&b[0..4], &[0x1D, 0x76, 0x30, 0x00]);
        assert!(b.len() > 8, "tiene que llevar datos, no solo cabecera");
    }

    #[test]
    fn el_ancho_declarado_cuadra_con_los_datos() {
        // La cabecera dice cuántos BYTES tiene cada fila y cuántas filas hay; si no cuadra con lo
        // que sigue, la impresora imprime basura o se cuelga esperando bytes.
        let b = rasterizar_logo(&png_1x1(), 576).unwrap();

        let bytes_fila = b[4] as usize | ((b[5] as usize) << 8);
        let filas = b[6] as usize | ((b[7] as usize) << 8);

        assert_eq!(b.len() - 8, bytes_fila * filas);
    }

    #[test]
    fn el_ancho_nunca_supera_el_papel() {
        // 32 columnas (58 mm) = 384 dots = 48 bytes por fila.
        let b = rasterizar_logo(&png_1x1(), ancho_logo_dots(58, 0.0, 0.0)).unwrap();
        let bytes_fila = b[4] as usize | ((b[5] as usize) << 8);

        assert!(bytes_fila * 8 <= 384, "se saldría del papel");
    }

    #[test]
    fn una_imagen_ilegible_no_rompe_el_ticket() {
        assert!(rasterizar_logo(b"esto no es una imagen", 576).is_none());
        assert!(rasterizar_logo(&[], 576).is_none());
    }

    #[test]
    fn sin_logo_el_ticket_sale_igual() {
        let mut p = base(vec![linea()]);
        p.show_logo = true;
        // Se pide logo pero no hay bytes: el ticket se imprime sin él.
        let bytes = build_ticket(&p, None);

        assert!(!bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
        assert!(bytes.len() > 0);
    }

    #[test]
    fn con_logo_el_bloque_entra_en_el_ticket() {
        let mut p = base(vec![linea()]);
        p.show_logo = true;
        let bytes = build_ticket(&p, Some(&png_1x1()));

        assert!(bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
    }

    #[test]
    fn el_logo_cierra_el_ticket_centrado() {
        // El logo es lo último del papel: después del mensaje de despedida y antes del corte. Lo
        // que va primero son los datos del negocio, a la izquierda.
        let mut p = base(vec![linea()]);
        p.show_logo = true;
        p.direccion = "Calle Mayor 1".into();
        p.show_address = true;
        p.show_footer_message = true;
        p.mensaje_footer = "Hasta pronto".into();

        let bytes = build_ticket(&p, Some(&png_1x1()));

        let pos = |aguja: &[u8]| {
            bytes
                .windows(aguja.len())
                .position(|w| w == aguja)
                .unwrap_or_else(|| panic!("no está {:?}", String::from_utf8_lossy(aguja)))
        };

        let i_logo = bytes
            .windows(4)
            .position(|w| w == [0x1D, 0x76, 0x30, 0x00])
            .expect("el logo tiene que estar");

        assert!(pos(b"Calle Mayor 1") < i_logo, "los datos van los primeros");
        assert!(pos(b"Hasta pronto") < i_logo, "el logo va después del mensaje");
        assert_eq!(
            &bytes[i_logo - 3..i_logo],
            &[0x1B, 0x61, 0x01],
            "el bloque del logo tiene que ir precedido de ESC a 1 (centrado)"
        );

        // Y antes del corte: si saliera después, la impresora ya habría cortado el papel.
        let i_corte = bytes
            .windows(2)
            .position(|w| w == [0x1D, 0x56])
            .expect("el corte tiene que estar");
        assert!(i_logo < i_corte, "el logo tiene que salir antes del corte");
    }

    #[test]
    fn con_el_logo_desactivado_no_se_imprime_aunque_haya_imagen() {
        let mut p = base(vec![linea()]);
        p.show_logo = false;
        let bytes = build_ticket(&p, Some(&png_1x1()));

        assert!(!bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
    }

}

#[cfg(test)]
mod parser {
    //! Mini-intérprete ESC/POS para los tests.
    //!
    //! El generador escupe un `Vec<u8>` donde texto y comandos van mezclados, así que buscar un
    //! texto "a ojo" puede encontrarlo dentro de los argumentos de un comando —o no encontrarlo
    //! porque un comando lo parte por la mitad. Este parser separa las dos cosas y, de paso,
    //! verifica lo más importante: que **todo** byte del trabajo de impresión sea, o parte de un
    //! comando conocido, o texto imprimible. Si algo se cuela por el medio, la impresora hace
    //! cualquier cosa con ello.

    /// Un trozo del trabajo de impresión.
    #[derive(Debug, PartialEq)]
    pub enum Trozo {
        /// Una línea de texto (sin el salto).
        Texto(String),
        /// Un comando: `(nombre, argumentos)`.
        Cmd(&'static str, Vec<u8>),
    }

    /// Longitud total (cabecera incluida) de cada comando que emite el generador.
    /// Inversa (parcial) de `encode_cp858`: el carácter que la impresora pintaría para ese byte.
    ///
    /// Solo cubre lo que aparece en un ticket español, que es lo que los tests necesitan leer. Sin
    /// esto, un importe impreso se leería como "1,70 Õ" y ningún assert sobre el texto sería
    /// legible.
    fn decodifica(b: u8) -> char {
        match b {
            0x00..=0x7F => b as char,
            0x80 => 'Ç', 0x81 => 'ü', 0x82 => 'é', 0x87 => 'ç', 0x88 => 'ê', 0x8A => 'è',
            0x90 => 'É', 0x93 => 'ô', 0x94 => 'ö', 0x96 => 'û', 0x99 => 'Ö', 0x9A => 'Ü',
            0xA0 => 'á', 0xA1 => 'í', 0xA2 => 'ó', 0xA3 => 'ú', 0xA4 => 'ñ', 0xA5 => 'Ñ',
            0xA6 => 'ª', 0xA7 => 'º', 0xA8 => '¿', 0xAD => '¡',
            0xB5 => 'Á', 0xD5 => '€', 0xD6 => 'Í', 0xE0 => 'Ó', 0xE9 => 'Ú',
            0xFA => '·',
            _ => char::REPLACEMENT_CHARACTER,
        }
    }

    fn comando(b: &[u8]) -> Option<(&'static str, usize)> {
        Some(match b {
            [0x1B, 0x40, ..] => ("init", 2),
            [0x1B, 0x74, ..] => ("codepage", 3),
            [0x1B, 0x61, ..] => ("align", 3),
            [0x1B, 0x45, ..] => ("bold", 3),
            [0x1B, 0x64, ..] => ("feed", 3),
            [0x1B, 0x4A, ..] => ("feed_dots", 3),
            [0x1B, 0x70, ..] => ("cajon", 5),
            [0x1D, 0x21, ..] => ("size", 3),
            [0x1D, 0x4C, ..] => ("margen_izq", 4),
            [0x1D, 0x56, ..] => ("corte", 3),
            [0x10, 0x14, ..] => ("cajon_rt", 5),
            _ => return None,
        })
    }

    /// Trocea el trabajo. Devuelve `Err` si encuentra un byte que no sabe leer: eso significa que
    /// el generador ha emitido algo que la impresora no va a entender.
    pub fn trocear(bytes: &[u8]) -> Result<Vec<Trozo>, String> {
        let mut out: Vec<Trozo> = Vec::new();
        let mut texto: Vec<u8> = Vec::new();
        let mut i = 0usize;

        fn volcar(texto: &mut Vec<u8>, out: &mut Vec<Trozo>) {
            if !texto.is_empty() {
                out.push(Trozo::Texto(texto.iter().map(|b| decodifica(*b)).collect()));
                texto.clear();
            }
        }

        while i < bytes.len() {
            let b = bytes[i];

            // Imagen: cabecera de 8 bytes y detrás la trama, cuyo tamaño dice la propia cabecera.
            if bytes[i..].starts_with(&[0x1D, 0x76, 0x30]) {
                volcar(&mut texto, &mut out);
                if i + 8 > bytes.len() {
                    return Err(format!("cabecera de imagen truncada en {i}"));
                }
                let ancho = bytes[i + 4] as usize | ((bytes[i + 5] as usize) << 8);
                let alto = bytes[i + 6] as usize | ((bytes[i + 7] as usize) << 8);
                let fin = i + 8 + ancho * alto;
                if fin > bytes.len() {
                    return Err(format!("trama de imagen truncada en {i}"));
                }
                out.push(Trozo::Cmd("imagen", bytes[i + 4..i + 8].to_vec()));
                i = fin;
                continue;
            }

            if let Some((nombre, largo)) = comando(&bytes[i..]) {
                volcar(&mut texto, &mut out);
                if i + largo > bytes.len() {
                    return Err(format!("comando {nombre} truncado en {i}"));
                }
                out.push(Trozo::Cmd(nombre, bytes[i + 2..i + largo].to_vec()));
                i += largo;
                continue;
            }

            // Salto de línea: cierra la línea de texto en curso.
            if b == 0x0A {
                volcar(&mut texto, &mut out);
                i += 1;
                continue;
            }

            if b < 0x20 || b == 0x7F {
                return Err(format!("byte de control suelto {b:#04X} en la posición {i}"));
            }

            texto.push(b);
            i += 1;
        }
        volcar(&mut texto, &mut out);
        Ok(out)
    }

    /// Solo las líneas de texto, en orden.
    pub fn lineas(bytes: &[u8]) -> Vec<String> {
        match trocear(bytes) {
            Ok(trozos) => trozos
                .into_iter()
                .filter_map(|t| match t {
                    Trozo::Texto(s) => Some(s),
                    _ => None,
                })
                .collect(),
            Err(e) => panic!("el ticket no es ESC/POS válido: {e}"),
        }
    }

    /// Los nombres de comando en orden, para comprobar la secuencia de las secciones.
    pub fn comandos(bytes: &[u8]) -> Vec<&'static str> {
        trocear(bytes)
            .expect("ESC/POS válido")
            .into_iter()
            .filter_map(|t| match t {
                Trozo::Cmd(n, _) => Some(n),
                _ => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests_formato {
    //! Formato del dinero y maquetado de dos columnas.
    //!
    //! Todo el ticket se apoya en `line_two`: concepto a la izquierda, importe pegado a la derecha
    //! dentro de un ancho fijo. Si esa función se pasa una columna, el importe salta de línea y el
    //! ticket deja de leerse; si corta por bytes en vez de por caracteres, un nombre con tilde
    //! descuadra la línea.

    use super::*;

    #[test]
    fn el_dinero_va_en_formato_espanol_con_dos_decimales_siempre() {
        assert_eq!(fmt_eur(1.7), "1,70 €");
        assert_eq!(fmt_eur(0.0), "0,00 €");
        assert_eq!(fmt_eur(12.0), "12,00 €");
    }

    #[test]
    fn un_importe_negativo_se_ve_como_negativo() {
        // Una devolución o un descuento tiene que leerse como tal, no como un importe normal al
        // que le falta el signo.
        assert_eq!(fmt_eur(-1.5), "-1,50 €");
    }

    #[test]
    fn los_miles_no_llevan_separador() {
        // A propósito: un punto de miles en una columna estrecha se confunde con el decimal. Este
        // test está para que cambiarlo sea una decisión y no un descuido.
        assert_eq!(fmt_eur(1234.5), "1234,50 €");
    }

    #[test]
    fn el_porcentaje_no_arrastra_decimales_inutiles() {
        assert_eq!(fmt_pct(10.0), "10");
        assert_eq!(fmt_pct(21.0), "21");
        assert_eq!(fmt_pct(0.0), "0");
        assert_eq!(fmt_pct(10.5), "10,50");
    }

    #[test]
    fn la_linea_de_dos_columnas_ocupa_exactamente_el_ancho() {
        for cols in [20usize, 32, 42, 48, 64] {
            let l = line_two("Concepto", "9,99 €", cols);
            assert_eq!(l.chars().count(), cols, "ancho {cols}: {l:?}");
            assert!(l.ends_with("9,99 €"), "el importe va pegado a la derecha: {l:?}");
            assert!(l.starts_with("Concepto"));
        }
    }

    #[test]
    fn un_nombre_largo_se_corta_para_no_empujar_el_importe() {
        let cols = 32;
        let l = line_two("Solomillo al foie con reduccion de Pedro Ximenez", "24,50 €", cols);

        assert_eq!(l.chars().count(), cols, "{l:?}");
        assert!(l.ends_with("24,50 €"), "{l:?}");
        // Y queda al menos un espacio entre nombre e importe: pegados no se leen.
        assert!(l.contains(" 24,50 €"), "{l:?}");
    }

    #[test]
    fn un_nombre_con_tildes_se_corta_por_caracteres_y_no_por_bytes() {
        // Un carácter acentuado son dos bytes en UTF-8: cortar por bytes daría un ancho distinto
        // al que se ve (y podría partir el carácter por la mitad).
        let cols = 24;
        let l = line_two("Ñoquis a la crème con jamón añejo", "9,99 €", cols);

        assert_eq!(l.chars().count(), cols, "se cuenta en caracteres: {l:?}");
        assert!(l.len() > cols, "y en bytes ocupa más, que es justo la trampa");
    }

    #[test]
    fn un_importe_mas_ancho_que_la_linea_no_revienta() {
        // Absurdo pero alcanzable con 10 columnas: lo que no se puede perder es el importe.
        let l = line_two("Concepto", "123456789,00 €", 10);
        assert!(l.ends_with("123456789,00 €"), "{l:?}");
    }

    #[test]
    fn el_separador_mide_lo_que_mide_la_linea() {
        for cols in [10usize, 32, 48, 64] {
            let mut out = Vec::new();
            sep(&mut out, cols);
            let l = super::parser::lineas(&out);
            assert_eq!(l[0].chars().count(), cols);
            assert!(l[0].chars().all(|c| c == '-'));
        }
    }

    #[test]
    fn los_milimetros_se_traducen_a_puntos_segun_el_dpi() {
        assert_eq!(mm_to_dots(25.4, 203), 203);
        assert_eq!(mm_to_dots(25.4, 300), 300);
        assert_eq!(mm_to_dots(0.0, 203), 0);
        // Un margen negativo es un error de configuración, no un avance hacia atrás.
        assert_eq!(mm_to_dots(-5.0, 203), 0);
    }

    #[test]
    fn un_margen_grande_se_trocea_porque_el_comando_solo_admite_255() {
        // ESC J admite 0..=255 puntos. 40 mm a 203 dpi son 320: sin trocear, el byte desborda y
        // el papel avanza cualquier cosa.
        let mut out = Vec::new();
        esc_feed_dots(&mut out, 320);

        assert_eq!(super::parser::comandos(&out), vec!["feed_dots", "feed_dots"]);
        let total: u32 = out.chunks(3).map(|c| c[2] as u32).sum();
        assert_eq!(total, 320);
    }

    #[test]
    fn sin_margen_no_se_emite_avance() {
        let mut out = Vec::new();
        esc_feed_dots(&mut out, 0);
        assert!(out.is_empty());
    }
}

#[cfg(test)]
mod tests_codificacion {
    //! Codificación del texto a CP858.
    //!
    //! La impresora no habla UTF-8: se le manda un byte por carácter y una tabla de códigos. De
    //! esto dependen dos cosas, y ninguna se ve hasta que sale el papel: que las tildes salgan
    //! como tildes, y que **un carácter ocupe exactamente un byte** — porque todo el maquetado por
    //! columnas está contado en caracteres.

    use super::*;

    fn bytes(s: &str) -> Vec<u8> {
        encode_cp858(s)
    }

    #[test]
    fn el_ascii_pasa_tal_cual() {
        assert_eq!(bytes("Cafe con leche 1,20"), b"Cafe con leche 1,20".to_vec());
    }

    #[test]
    fn cada_caracter_ocupa_un_byte() {
        // Es la invariante de la que vive el maquetado: un carácter en dos bytes acortaría la
        // línea respecto de lo calculado y el importe dejaría de cuadrar a la derecha.
        for s in ["Cafe", "Ñoquis", "jamón ibérico", "€ 12,00", "¿Qué?", "PAELLA"] {
            assert_eq!(bytes(s).len(), s.chars().count(), "{s:?}");
        }
    }

    #[test]
    fn las_minusculas_acentuadas_del_espanol_tienen_su_byte() {
        for (c, b) in [
            ('á', 0xA0u8),
            ('í', 0xA1),
            ('ó', 0xA2),
            ('ú', 0xA3),
            ('ñ', 0xA4),
            ('é', 0x82),
            ('ü', 0x81),
            ('ç', 0x87),
        ] {
            assert_eq!(bytes(&c.to_string())[0], b, "{c} debería ser {b:#04X}");
        }
    }

    #[test]
    fn las_mayusculas_acentuadas_tambien() {
        // "JAMÓN IBÉRICO" es un nombre de producto de lo más corriente en una carta escrita en
        // mayúsculas. Sin estas entradas salía "JAM?N IB?RICO".
        for (c, b) in [
            ('Á', 0xB5u8),
            ('É', 0x90),
            ('Í', 0xD6),
            ('Ó', 0xE0),
            ('Ú', 0xE9),
            ('Ñ', 0xA5),
            ('Ü', 0x9A),
            ('Ç', 0x80),
        ] {
            assert_eq!(bytes(&c.to_string())[0], b, "{c} debería ser {b:#04X}");
        }
    }

    #[test]
    fn nombres_reales_de_carta_no_pierden_ni_una_letra() {
        for s in ["JAMÓN IBÉRICO", "Crème brûlée", "Ñoño", "PIMIENTOS DEL PIQUILLO", "SIDRA NATURAL"] {
            let b = bytes(s);
            assert!(!b.contains(&b'?'), "{s:?} pierde caracteres: {b:02X?}");
        }
    }

    #[test]
    fn los_signos_que_lleva_un_ticket_espanol_estan() {
        assert_eq!(bytes("€")[0], 0xD5);
        assert_eq!(bytes("¿")[0], 0xA8);
        assert_eq!(bytes("¡")[0], 0xAD);
        assert_eq!(bytes("º")[0], 0xA7);
        assert_eq!(bytes("ª")[0], 0xA6);
    }

    #[test]
    fn lo_que_no_esta_en_la_tabla_cae_a_un_interrogante_y_no_a_dos_bytes() {
        // Un emoji en el nombre de un producto no puede descuadrar la columna.
        let texto = "Cafe A";
        let con_emoji = texto.replace('A', "\u{1F37A}");
        let b = bytes(&con_emoji);

        assert_eq!(b.len(), con_emoji.chars().count());
        assert_eq!(*b.last().unwrap(), b'?');
    }

    #[test]
    fn un_byte_de_control_no_puede_colarse_en_el_texto() {
        // El nombre de un producto lo escribe el usuario. Si un salto de línea o un ESC llegaran
        // crudos a la impresora, partirían la línea o —peor— se leerían como un comando: el resto
        // del ticket saldría en otro tamaño, o se ordenaría un corte a media venta.
        let sucio = format!("Cafe{}!{}GRANDE{}robado", '\u{1B}', '\u{01}', '\u{0A}');
        let b = bytes(&sucio);

        assert!(
            b.iter().all(|x| *x >= 0x20 && *x != 0x7F),
            "se han colado bytes de control: {b:02X?}"
        );
        assert_eq!(b.len(), sucio.chars().count(), "y sigue ocupando un byte por carácter");
    }
}

#[cfg(test)]
mod tests_cuadre {
    //! Que las cifras del papel cuadren entre ellas.
    //!
    //! Este es el módulo que más importa de todo el fichero. Un ticket es un documento
    //! contable: el cliente suma las líneas, y Hacienda mira que base + IVA sea el total. Los dos
    //! números se calculan por separado y se **redondean por separado** al imprimirlos, que es
    //! justo donde aparece el céntimo que no cuadra — el clásico "el ticket suma 12,34 pero pone
    //! 12,35".
    //!
    //! Por eso aquí no se comprueba el `f64` que calcula la función, sino **el número que sale
    //! impreso**: se genera el ticket de verdad, se leen sus líneas y se suman.

    use super::fixtures::*;
    use super::*;

    /// Céntimos de un importe tal y como aparece impreso ("12,34 €" → 1234).
    fn centimos(texto: &str) -> i64 {
        let limpio = texto.trim().trim_end_matches('€').trim().replace(',', ".");
        (limpio.parse::<f64>().unwrap_or_else(|_| panic!("no es un importe: {texto:?}")) * 100.0)
            .round() as i64
    }

    /// `(concepto, céntimos)` de cada línea del ticket que lleva un importe a la derecha.
    fn importes(bytes: &[u8]) -> Vec<(String, i64)> {
        super::parser::lineas(bytes)
            .into_iter()
            .filter(|l| l.trim_end().ends_with('€'))
            .map(|l| {
                // La línea acaba en "<concepto>   12,34 €": los dos últimos tokens son el importe.
                let mut trozos = l.trim_end().rsplitn(3, ' ');
                trozos.next(); // el símbolo
                let importe = trozos.next().unwrap_or_default();
                let concepto = trozos.next().unwrap_or_default().trim().to_string();
                (concepto, centimos(importe))
            })
            .collect()
    }

    fn valor(bytes: &[u8], prefijo: &str) -> i64 {
        importes(bytes)
            .into_iter()
            .find(|(c, _)| c.starts_with(prefijo))
            .unwrap_or_else(|| panic!("no hay línea que empiece por {prefijo:?}"))
            .1
    }

    /// Suma de las líneas de producto: las que llevan importe y no son un concepto del pie.
    fn suma_productos(bytes: &[u8]) -> i64 {
        importes(bytes)
            .into_iter()
            .filter(|(c, _)| {
                !c.starts_with("BASE") && !c.starts_with("IVA") && !c.starts_with("TOTAL")
                    && !c.ends_with(" x")
            })
            .map(|(_, v)| v)
            .sum()
    }

    #[test]
    fn las_lineas_impresas_suman_el_total_impreso() {
        // Precios de barra de verdad, con las cantidades que salen de pinchar varias veces el
        // mismo producto.
        let p = payload(
            10.0,
            vec![
                linea_de(1.1, 3, None),
                linea_de(2.45, 1, None),
                linea_de(0.95, 7, None),
                linea_de(13.9, 2, None),
            ],
        );
        let bytes = build_ticket(&p, None);

        assert_eq!(suma_productos(&bytes), valor(&bytes, "TOTAL"));
    }

    #[test]
    fn el_importe_de_una_linea_es_su_precio_por_su_cantidad() {
        let p = payload(10.0, vec![linea_de(1.15, 3, None)]);
        let bytes = build_ticket(&p, None);

        // 3 × 1,15 = 3,45. Si se imprimiera el precio unitario, el cliente pagaría de más.
        assert_eq!(valor(&bytes, "Item"), 345);
        assert_eq!(valor(&bytes, "TOTAL"), 345);
    }

    #[test]
    fn la_cantidad_y_el_precio_unitario_salen_debajo_de_cada_linea() {
        let p = payload(10.0, vec![linea_de(1.15, 3, None)]);
        let lineas = super::parser::lineas(&build_ticket(&p, None));

        assert!(
            lineas.iter().any(|l| l.contains("3 x 1,15 €")),
            "falta el desglose de la línea: {lineas:#?}"
        );
    }

    #[test]
    fn base_mas_iva_impresos_dan_el_total_impreso_en_todos_los_tipos() {
        // El barrido que caza el céntimo perdido: los tres tipos de IVA que existen en hostelería
        // contra cada importe posible hasta 200 €. Si en alguno base+IVA no da el total, el
        // ticket es incorrecto ante Hacienda aunque el cobro haya sido bueno.
        for tipo in [4.0f64, 10.0, 21.0] {
            let mut fallos: Vec<String> = Vec::new();

            for c in (1..=3_000i64).chain((3_001..=20_000).step_by(7)) {
                let total = c as f64 / 100.0;
                let p = payload(tipo, vec![linea_de(total, 1, None)]);
                let bytes = build_ticket(&p, None);

                let base = valor(&bytes, "BASE");
                let iva = valor(&bytes, "IVA");
                let tot = valor(&bytes, "TOTAL");

                if base + iva != tot {
                    fallos.push(format!("{total:.2} al {tipo}%: {base} + {iva} != {tot}"));
                    if fallos.len() > 5 {
                        break;
                    }
                }
            }
            assert!(fallos.is_empty(), "descuadres al {tipo}%: {fallos:#?}");
        }
    }

    #[test]
    fn los_importes_del_espejo_dan_lo_mismo_aqui_que_en_la_vista_previa() {
        // Estas seis filas están duplicadas a propósito en `test/ticketMath.test.ts`. Son los
        // importes que sacó el barrido cuando la cuota se redondeaba por su cuenta, así que son
        // los que más fácil vuelven a divergir. Que los dos lados los claven es lo que garantiza
        // que la vista previa enseña el ticket que se va a imprimir.
        let golden: [(f64, f64, i64, i64); 6] = [
            // (total, tipo, base en céntimos, IVA en céntimos)
            (0.39, 4.0, 38, 1),
            (0.91, 4.0, 88, 3),
            (1.17, 4.0, 113, 4),
            (1.69, 4.0, 163, 6),
            (2.21, 4.0, 213, 8),
            (2.47, 4.0, 238, 9),
        ];

        for (total, tipo, base_esperada, iva_esperado) in golden {
            let bytes = build_ticket(&payload(tipo, vec![linea_de(total, 1, None)]), None);
            assert_eq!(valor(&bytes, "BASE"), base_esperada, "base de {total:.2} al {tipo}%");
            assert_eq!(valor(&bytes, "IVA"), iva_esperado, "IVA de {total:.2} al {tipo}%");
        }
    }

    #[test]
    fn con_varios_tipos_la_suma_de_los_tramos_da_el_total() {
        // Un ticket mixto (comida al 10, algo envasado al 21) recorriendo muchas combinaciones:
        // cada tramo se redondea por su cuenta, así que aquí es donde más fácil se descuadra.
        let mut fallos: Vec<String> = Vec::new();

        for a in 1..=140i64 {
            for b in 1..=140i64 {
                let x = a as f64 / 10.0;
                let y = b as f64 / 10.0;
                let p = payload(10.0, vec![linea_de(x, 1, None), linea_de(y, 1, Some(21.0))]);
                let bytes = build_ticket(&p, None);

                let suma: i64 = importes(&bytes)
                    .into_iter()
                    .filter(|(c, _)| c.starts_with("BASE") || c.starts_with("IVA"))
                    .map(|(_, v)| v)
                    .sum();
                let tot = valor(&bytes, "TOTAL");

                if suma != tot {
                    fallos.push(format!("{x:.2} al 10% + {y:.2} al 21%: {suma} != {tot}"));
                    if fallos.len() > 5 {
                        break;
                    }
                }
            }
        }
        assert!(fallos.is_empty(), "descuadres mezclando tipos: {fallos:#?}");
    }

    #[test]
    fn el_total_no_depende_de_que_las_lineas_se_vean() {
        // Hay quien imprime el ticket sin detalle. El total tiene que ser el mismo papel a papel.
        let items = vec![linea_de(1.1, 3, None), linea_de(2.45, 1, None)];
        let con = build_ticket(&payload(10.0, items.clone()), None);

        let mut sin_lineas = payload(10.0, items);
        sin_lineas.show_line_items = false;
        let sin = build_ticket(&sin_lineas, None);

        assert_eq!(valor(&con, "TOTAL"), valor(&sin, "TOTAL"));
    }

    #[test]
    fn un_ticket_sin_productos_imprime_cero_y_lo_dice() {
        let bytes = build_ticket(&payload(10.0, vec![]), None);

        assert_eq!(valor(&bytes, "TOTAL"), 0);
        assert!(contiene(&bytes, "No hay productos"));
    }

    #[test]
    fn un_tipo_de_iva_raro_no_descuadra_el_ticket() {
        // Los tipos los teclea el usuario en la ficha del producto: puede meter un 7,5 %.
        let p = payload(7.5, vec![linea_de(9.99, 1, None), linea_de(3.33, 2, None)]);
        let bytes = build_ticket(&p, None);

        assert_eq!(valor(&bytes, "BASE") + valor(&bytes, "IVA"), valor(&bytes, "TOTAL"));
    }

    #[test]
    fn un_descuento_en_negativo_resta_del_total() {
        // No hay UI para esto hoy, pero el payload lo admite y el día que la haya el ticket debe
        // seguir cuadrando en vez de imprimir un total que no es el cobrado.
        let p = payload(10.0, vec![linea_de(10.0, 1, None), linea_de(-2.0, 1, None)]);
        let bytes = build_ticket(&p, None);

        assert_eq!(valor(&bytes, "TOTAL"), 800);
        assert_eq!(valor(&bytes, "BASE") + valor(&bytes, "IVA"), 800);
    }
}

#[cfg(test)]
mod tests_secciones {
    //! Qué sale y qué no según la personalización, y que nada se salga del papel.
    //!
    //! Cada casilla del panel de configuración apaga o enciende un trozo del ticket. Son once
    //! interruptores que nadie prueba a mano uno por uno, y un ticket al que le falta el CIF o el
    //! mensaje del pie es una queja del cliente, no un fallo visible en desarrollo.

    use super::fixtures::*;
    use super::*;

    /// Ticket completo, con todo encendido y relleno.
    fn completo() -> PrintTicketPayload {
        let mut p = base(vec![linea()]);
        p.direccion = "Calle Mayor 1".into();
        p.telefono = "600123456".into();
        p.cif = "B12345678".into();
        p.mensaje_footer = "Vuelva pronto".into();
        p.show_address = true;
        p.show_phone = true;
        p.show_cif = true;
        p.show_date_time = true;
        p.show_footer_message = true;
        p
    }

    #[test]
    fn cada_casilla_apagada_quita_su_trozo_y_encendida_lo_pone() {
        // (texto que debe salir, apagar)
        let casos: Vec<(&str, fn(&mut PrintTicketPayload))> = vec![
            ("Bar", |p| p.show_business_name = false),
            ("Calle Mayor 1", |p| p.show_address = false),
            ("600123456", |p| p.show_phone = false),
            ("B12345678", |p| p.show_cif = false),
            ("Vuelva pronto", |p| p.show_footer_message = false),
            ("BASE", |p| p.show_base_and_iva = false),
            ("TOTAL", |p| p.show_total = false),
        ];

        for (texto, apagar) in casos {
            let encendido = build_ticket(&completo(), None);
            assert!(contiene(&encendido, texto), "encendido debería imprimir {texto:?}");

            let mut p = completo();
            apagar(&mut p);
            let apagado = build_ticket(&p, None);
            assert!(!contiene(&apagado, texto), "apagado no debería imprimir {texto:?}");
        }
    }

    #[test]
    fn los_datos_vacios_no_dejan_etiquetas_huerfanas() {
        // Con la casilla encendida pero el dato en blanco, imprimir "Tel: " o "CIF: " a secas
        // queda como un error de la aplicación delante del cliente.
        let mut p = completo();
        p.telefono = "   ".into();
        p.cif = String::new();
        p.direccion = String::new();
        let bytes = build_ticket(&p, None);

        assert!(!contiene(&bytes, "Tel:"), "sobra la etiqueta del teléfono");
        assert!(!contiene(&bytes, "CIF:"), "sobra la etiqueta del CIF");
    }

    #[test]
    fn sin_nombre_de_negocio_se_imprime_algo_en_vez_de_una_linea_en_blanco() {
        let mut p = completo();
        p.business_name = "   ".into();
        assert!(contiene(&build_ticket(&p, None), "TPV"));
    }

    #[test]
    fn sin_mensaje_propio_el_pie_lleva_el_de_cortesia() {
        let mut p = completo();
        p.mensaje_footer = String::new();
        assert!(contiene(&build_ticket(&p, None), "Gracias"));
    }

    #[test]
    fn ocultar_las_lineas_lo_dice_en_vez_de_dejar_un_hueco() {
        let mut p = completo();
        p.show_line_items = false;
        let bytes = build_ticket(&p, None);

        assert!(contiene(&bytes, "ocultas"));
        assert!(!contiene(&bytes, "Cafe"));
    }

    #[test]
    fn ninguna_linea_del_cuerpo_se_sale_del_papel() {
        // La invariante de maquetado. Se comprueba en los tres formatos y con datos largos de
        // verdad: el nombre del negocio y el TOTAL se imprimen a doble ancho, así que ocupan el
        // doble de columnas de las que miden.
        for (mm, cols_esperadas) in [(58u32, 32usize), (80, 48), (112, 64)] {
            let mut p = completo();
            p.paper_width_mm = mm;
            p.chars_per_line = 80; // el usuario pidiendo más de lo que cabe
            p.business_name = "RESTAURANTE LA BUENA MESA DE LA PLAYA".into();
            p.direccion = "Avenida de la Constitucion 145, 3 izquierda, Alcala de Henares".into();
            p.mensaje_footer = "Gracias por su visita, le esperamos de nuevo muy pronto".into();
            p.items = vec![PrintTicketLine {
                nombre: "Solomillo de ternera al foie con reduccion de Pedro Ximenez".into(),
                cantidad: 12,
                precio_unitario: 24.5,
                iva_percent: None,
            }];

            let bytes = build_ticket(&p, None);
            assert_eq!(effective_cols(&p), cols_esperadas);

            for l in super::parser::lineas(&bytes) {
                assert!(
                    l.chars().count() <= cols_esperadas,
                    "en {mm} mm ({cols_esperadas} col) esta línea se sale: {l:?} ({} car)",
                    l.chars().count()
                );
            }
        }
    }

    #[test]
    fn lo_que_va_a_doble_ancho_cabe_en_la_mitad_de_columnas() {
        // El nombre del negocio y el TOTAL se imprimen con GS ! 0x11 (doble alto y ancho): cada
        // carácter ocupa dos columnas. Medirlos contra el ancho entero es como no medirlos.
        let mut p = completo();
        p.paper_width_mm = 58; // 32 columnas: el caso estrecho
        p.business_name = "RESTAURANTE LA BUENA MESA DE LA PLAYA".into();
        let bytes = build_ticket(&p, None);

        let cols = effective_cols(&p);
        let trozos = super::parser::trocear(&bytes).expect("ESC/POS válido");

        // Se recorre el ticket llevando la cuenta del tamaño activo, como hace la impresora.
        let mut doble = false;
        for t in trozos {
            match t {
                super::parser::Trozo::Cmd("size", args) => doble = args[0] == 0x11,
                super::parser::Trozo::Texto(s) if doble => assert!(
                    s.chars().count() <= cols / 2,
                    "a doble ancho solo caben {} columnas y esta línea mide {}: {s:?}",
                    cols / 2,
                    s.chars().count()
                ),
                _ => {}
            }
        }
    }

    #[test]
    fn el_trabajo_de_impresion_termina_cortando_el_papel() {
        // Sin corte, el ticket se queda colgando y el siguiente sale pegado al anterior.
        let cmds = super::parser::comandos(&build_ticket(&completo(), None));
        assert_eq!(*cmds.last().unwrap(), "corte", "{cmds:?}");
    }

    #[test]
    fn el_cajon_va_despues_del_corte() {
        // Si el pulso fuera antes, el cajón se abriría con el ticket aún dentro de la impresora.
        let mut p = completo();
        p.numero_ticket = Some("T-000001".into());
        p.metodo_pago = Some("EFECTIVO".into());
        let cmds = super::parser::comandos(&build_ticket(&p, None));

        let corte = cmds.iter().position(|c| *c == "corte").unwrap();
        let cajon = cmds.iter().position(|c| *c == "cajon").unwrap();
        assert!(cajon > corte, "{cmds:?}");
    }

    #[test]
    fn el_ticket_empieza_reseteando_la_impresora_y_fijando_la_tabla_de_caracteres() {
        // Sin el reset, el ticket hereda el estado que dejara el anterior (negrita, doble ancho);
        // sin la tabla, las tildes salen como símbolos raros.
        let cmds = super::parser::comandos(&build_ticket(&completo(), None));
        assert_eq!(&cmds[..2], &["init", "codepage"], "{cmds:?}");
    }

    #[test]
    fn el_trabajo_es_escpos_valido_de_principio_a_fin() {
        // El parser falla si encuentra un byte que no es ni comando conocido ni texto imprimible.
        // Se recorre una batería de configuraciones raras para que ninguna emita basura.
        for mm in [58u32, 80, 112] {
            for cpl in [20u32, 42, 80] {
                for escala in [1.0f64, 1.5] {
                    let mut p = completo();
                    p.paper_width_mm = mm;
                    p.chars_per_line = cpl;
                    p.font_scale = escala;
                    p.margin_top_mm = 12.0;
                    p.margin_bottom_mm = 12.0;
                    p.margin_left_mm = 3.0;
                    p.numero_ticket = Some("T-000042".into());
                    p.metodo_pago = Some("EFECTIVO".into());
                    p.es_copia = true;

                    let bytes = build_ticket(&p, None);
                    super::parser::trocear(&bytes)
                        .unwrap_or_else(|e| panic!("{mm}mm/{cpl}col/x{escala}: {e}"));
                }
            }
        }
    }

    #[test]
    fn el_ticket_de_prueba_de_impresora_tambien_es_valido() {
        let bytes = build_test_ticket("EPSON TM-T20");
        super::parser::trocear(&bytes).expect("ESC/POS válido");
        assert!(contiene(&bytes, "EPSON TM-T20"), "debe decir a qué impresora salió");
    }
}

#[cfg(test)]
mod tests_envoltura {
    //! Envoltura del texto libre.
    //!
    //! El nombre del negocio, la dirección y el mensaje del pie los escribe el usuario en un panel
    //! donde no ve el papel. La impresora no envuelve: corta por donde llega, a mitad de palabra.

    use super::*;

    #[test]
    fn lo_que_cabe_se_queda_en_una_linea() {
        assert_eq!(envolver("Bar Pepe", 32), vec!["Bar Pepe"]);
    }

    #[test]
    fn se_corta_por_los_espacios_y_ninguna_linea_pasa_del_ancho() {
        let l = envolver("Avenida de la Constitucion 145, 3 izquierda, Alcala de Henares", 32);

        assert!(l.len() > 1);
        for x in &l {
            assert!(x.chars().count() <= 32, "{x:?}");
        }
        // Ni una palabra partida: cada trozo del original sigue entero en alguna línea.
        let recompuesto = l.join(" ");
        assert_eq!(recompuesto, "Avenida de la Constitucion 145, 3 izquierda, Alcala de Henares");
    }

    #[test]
    fn una_palabra_mas_larga_que_la_linea_se_parte_en_vez_de_perderse() {
        // Un correo o una URL en el pie del ticket. Feo, pero perderlo es peor.
        let l = envolver("reservas@restaurantelabuenamesadelaplaya.example", 16);

        for x in &l {
            assert!(x.chars().count() <= 16, "{x:?}");
        }
        assert_eq!(l.concat(), "reservas@restaurantelabuenamesadelaplaya.example");
    }

    #[test]
    fn las_tildes_cuentan_como_un_caracter() {
        let l = envolver("Menú del día con ñoquis y crème brûlée al horno", 16);
        for x in &l {
            assert!(x.chars().count() <= 16, "{x:?} mide {}", x.chars().count());
        }
    }

    #[test]
    fn un_texto_vacio_no_deja_el_ticket_a_medias() {
        assert_eq!(envolver("", 32), vec![""]);
        assert_eq!(envolver("    ", 32), vec![""]);
    }

    #[test]
    fn un_ancho_absurdo_no_entra_en_bucle() {
        // `cols / 2` puede valer 0 si alguien fuerza un ancho mínimo.
        let l = envolver("hola mundo", 0);
        assert!(!l.is_empty());
        assert_eq!(l.concat(), "holamundo");
    }
}

#[cfg(test)]
mod tests_logo_imagen {
    //! El rasterizado del logo con imágenes de verdad.
    //!
    //! Lo que se comprueba aquí es la conversión a un bit: cuántos puntos acaban marcados. Un logo
    //! que sale todo negro no es "un poco peor": es un rectángulo de tinta que se come el rollo y
    //! deja el ticket ilegible, y no se descubre hasta que alguien lo imprime.

    use super::*;
    use image::{ImageBuffer, Rgba};

    /// Codifica una imagen RGBA a PNG en memoria, como la que llegaría del disco.
    fn png(ancho: u32, alto: u32, pixel: impl Fn(u32, u32) -> Rgba<u8>) -> Vec<u8> {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(ancho, alto, |x, y| pixel(x, y));
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).expect("codificar PNG");
        buf.into_inner()
    }

    /// Proporción de puntos marcados (0.0 = papel en blanco, 1.0 = todo tinta).
    fn tinta(bloque: &[u8]) -> f64 {
        let datos = &bloque[8..];
        let marcados: u32 = datos.iter().map(|b| b.count_ones()).sum();
        marcados as f64 / (datos.len() as f64 * 8.0)
    }

    #[test]
    fn un_logo_blanco_no_gasta_tinta() {
        let b = rasterizar_logo(&png(64, 64, |_, _| Rgba([255, 255, 255, 255])), 576).unwrap();
        assert!(tinta(&b) < 0.01, "un fondo blanco no puede salir marcado: {}", tinta(&b));
    }

    #[test]
    fn un_logo_negro_sale_negro() {
        let b = rasterizar_logo(&png(64, 64, |_, _| Rgba([0, 0, 0, 255])), 576).unwrap();
        assert!(tinta(&b) > 0.99, "{}", tinta(&b));
    }

    #[test]
    fn un_logo_con_transparencia_no_sale_como_un_tocho_negro() {
        // El caso real: casi todos los logos son un PNG con fondo transparente. Si la
        // transparencia se ignora, los píxeles de fuera del dibujo (RGB negro, alfa 0) se leen
        // como negro y el ticket sale con un rectángulo de tinta encima.
        let b = rasterizar_logo(
            &png(64, 64, |_, _| Rgba([0, 0, 0, 0])), // todo transparente
            576,
        )
        .unwrap();

        assert!(
            tinta(&b) < 0.01,
            "lo transparente tiene que quedar en blanco, y ha salido {:.0}% marcado",
            tinta(&b) * 100.0
        );
    }

    #[test]
    fn el_dibujo_sobre_fondo_transparente_si_se_imprime() {
        // Mitad opaca negra, mitad transparente: tiene que salir medio ticket marcado, no entero.
        let b = rasterizar_logo(
            &png(64, 64, |_, y| {
                if y < 32 {
                    Rgba([0, 0, 0, 255])
                } else {
                    Rgba([0, 0, 0, 0])
                }
            }),
            576,
        )
        .unwrap();

        let t = tinta(&b);
        assert!((0.3..0.7).contains(&t), "debería salir medio marcado y ha salido {t:.2}");
    }

    #[test]
    fn un_gris_medio_se_difumina_en_vez_de_desaparecer() {
        // Sin difuminado, un 50 % de gris cae entero a un lado del umbral: o todo blanco o todo
        // negro. Con Floyd-Steinberg queda aproximadamente la mitad de los puntos marcados.
        let b = rasterizar_logo(&png(64, 64, |_, _| Rgba([128, 128, 128, 255])), 576).unwrap();

        let t = tinta(&b);
        assert!((0.3..0.7).contains(&t), "el difuminado no está actuando: {t:.2}");
    }

    #[test]
    fn una_imagen_mas_ancha_que_el_papel_se_reduce() {
        // 1200 px de ancho sobre un papel de 80 mm (576 dots).
        let b = rasterizar_logo(&png(1200, 300, |_, _| Rgba([0, 0, 0, 255])), 576).unwrap();

        let bytes_fila = b[4] as usize | ((b[5] as usize) << 8);
        assert_eq!(bytes_fila * 8, 576, "tiene que ocupar justo el ancho del papel");

        // Y conserva la proporción: 1200x300 reducido a 576 de ancho son ~144 de alto.
        let alto = b[6] as usize | ((b[7] as usize) << 8);
        assert!((140..=148).contains(&alto), "alto {alto}");
    }

    #[test]
    fn una_imagen_estrecha_no_se_estira() {
        // Ampliar un logo de 40 px a 576 lo dejaría como un mosaico. Mejor pequeño y nítido.
        let b = rasterizar_logo(&png(40, 40, |_, _| Rgba([0, 0, 0, 255])), 576).unwrap();

        let bytes_fila = b[4] as usize | ((b[5] as usize) << 8);
        assert_eq!(bytes_fila * 8, 40, "40 ya es múltiplo de 8: se queda como está");
    }

    #[test]
    fn el_ancho_siempre_es_multiplo_de_ocho() {
        // Cada byte de la trama son 8 puntos: un ancho que no sea múltiplo de 8 desplaza la
        // imagen media fila y sale en diagonal.
        for ancho in [37u32, 100, 255, 999] {
            let b = rasterizar_logo(&png(ancho, 20, |_, _| Rgba([0, 0, 0, 255])), 576).unwrap();
            let bytes_fila = b[4] as usize | ((b[5] as usize) << 8);
            assert_eq!((bytes_fila * 8) % 8, 0);
            assert!(bytes_fila * 8 <= ancho.max(8) as usize);
        }
    }

    #[test]
    fn un_logo_larguisimo_no_se_come_el_rollo() {
        // Una imagen 100x4000 escalada por proporción daría metros de papel.
        let b = rasterizar_logo(&png(100, 4000, |_, _| Rgba([0, 0, 0, 255])), 576).unwrap();
        let alto = b[6] as usize | ((b[7] as usize) << 8);

        assert!(alto <= 1024, "alto {alto}: hay un tope por algo");
    }

    #[test]
    fn el_logo_no_descoloca_el_resto_del_ticket() {
        // El bloque de imagen lleva su propia longitud declarada; si no cuadrara con los datos, la
        // impresora se comería el texto de detrás tomándolo por trama.
        let mut p = super::fixtures::base(vec![super::fixtures::linea()]);
        p.show_logo = true;
        let bytes = build_ticket(&p, Some(&png(64, 64, |_, _| Rgba([0, 0, 0, 255]))));

        assert!(super::fixtures::contiene(&bytes, "Cafe"), "el texto sigue detrás del logo");
        super::parser::trocear(&bytes).expect("el trabajo sigue siendo ESC/POS válido");
    }
}

#[cfg(test)]
mod tests_ancho_del_logo {
    //! Cuánto papel puede ocupar el logo.
    //!
    //! Salía de las columnas de texto efectivas, así que bajar `chars_per_line` —una opción sobre
    //! la densidad de las LETRAS— encogía el logo. Quien pide 20 caracteres por línea quiere el
    //! texto más grande, no un logo del tercio del papel.

    use super::fixtures::*;
    use super::*;

    #[test]
    fn cada_formato_usa_su_cabezal_entero() {
        assert_eq!(ancho_logo_dots(58, 0.0, 0.0), 384);
        assert_eq!(ancho_logo_dots(80, 0.0, 0.0), 576);
        assert_eq!(ancho_logo_dots(112, 0.0, 0.0), 768);
    }

    #[test]
    fn no_depende_de_los_caracteres_por_linea() {
        // La comprobación que motiva el cambio: el mismo papel, con el texto apretado o suelto,
        // da el mismo logo.
        for cpl in [20u32, 32, 42, 60, 80] {
            let mut p = base(vec![linea()]);
            p.show_logo = true;
            p.chars_per_line = cpl;

            assert_eq!(
                ancho_logo_dots(p.paper_width_mm, p.margin_left_mm, p.margin_right_mm),
                576,
                "con {cpl} caracteres por línea"
            );
        }
    }

    #[test]
    fn los_margenes_si_lo_encogen() {
        // Un margen es papel que no se puede marcar: ahí el logo tampoco cabe.
        let sin = ancho_logo_dots(80, 0.0, 0.0);
        let con = ancho_logo_dots(80, 5.0, 5.0);

        assert!(con < sin, "{con} debería ser menor que {sin}");
        // 10 mm de 72 útiles son ~14 %: 576 → ~496.
        assert!((488..=504).contains(&con), "{con}");
    }

    #[test]
    fn los_margenes_negativos_se_ignoran() {
        assert_eq!(ancho_logo_dots(80, -5.0, -5.0), 576);
    }

    #[test]
    fn unos_margenes_absurdos_no_dejan_el_logo_en_cero() {
        // Un ancho de 0 daría una trama vacía y una cabecera que declara 0 filas: la impresora se
        // queda esperando bytes que no llegan.
        let a = ancho_logo_dots(80, 200.0, 200.0);

        assert!(a >= 8, "{a}");
        assert_eq!(a % 8, 0);
    }

    #[test]
    fn siempre_es_multiplo_de_ocho() {
        for mm in [58u32, 80, 112] {
            for margen in [0.0f64, 1.0, 2.5, 7.3, 13.7] {
                let a = ancho_logo_dots(mm, margen, margen / 2.0);
                assert_eq!(a % 8, 0, "{mm} mm con {margen} mm de margen dio {a}");
            }
        }
    }

    #[test]
    fn el_logo_impreso_ocupa_ese_ancho_y_no_el_de_las_columnas() {
        // De punta a punta: el bloque que acaba en el ticket declara el ancho que sale del papel
        // aunque el texto vaya a 20 columnas.
        use image::{ImageBuffer, Rgba};

        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(800, 200, |_, _| Rgba([0, 0, 0, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let png = png.into_inner();

        let mut p = base(vec![linea()]);
        p.show_logo = true;
        p.chars_per_line = 20;
        let bytes = build_ticket(&p, Some(&png));

        // Se busca la cabecera de imagen y se lee el ancho que declara.
        let i = bytes
            .windows(4)
            .position(|w| w == [0x1D, 0x76, 0x30, 0x00])
            .expect("el logo tiene que estar");
        let bytes_fila = bytes[i + 4] as usize | ((bytes[i + 5] as usize) << 8);

        assert_eq!(bytes_fila * 8, 576, "el logo se ha encogido con el texto");
    }
}

#[cfg(test)]
mod tests_espejo_del_frontend {
    //! Los importes y el truncado, contra los MISMOS casos que prueba la vista previa.
    //!
    //! `TicketPaper` tiene que enseñar exactamente lo que se va a imprimir; es contra la previa
    //! contra lo que el usuario configura el ticket y contra lo que compara cuando algo le parece
    //! raro. Esta tabla está duplicada a propósito en `test/ticketMath.test.ts`: si uno de los dos
    //! lados cambia de criterio, el otro falla.
    //!
    //! Lo que sacó esta tabla al escribirla: la previa usaba `Intl.NumberFormat`, que a partir de
    //! cinco cifras mete el punto de los miles ("12.345,67 €") donde el papel imprime
    //! "12345,67 €"; y `{:.2}` de Rust rompía los empates al par ("1,125" → "1,12") donde
    //! JavaScript redondea hacia arriba.

    use super::*;

    /// `(importe, como se imprime)`. Gemelo de `GOLDEN_EUR` en el test del frontend.
    const GOLDEN_EUR: &[(f64, &str)] = &[
        (0.0, "0,00 €"),
        (1.7, "1,70 €"),
        (12.0, "12,00 €"),
        (0.005, "0,01 €"),
        // Sin separador de miles: en 32 columnas se confundiría con el decimal.
        (1234.5, "1234,50 €"),
        (12345.67, "12345,67 €"),
        // Empates: hacia arriba, como los haría cualquiera a mano.
        (1.125, "1,13 €"),
        (2.675, "2,68 €"),
        // Y los que NO son empates aunque lo parezcan (0,145 en binario es 0,14499…).
        (0.145, "0,14 €"),
        // Negativos: una devolución tiene que leerse como tal.
        (-1.5, "-1,50 €"),
        // Un negativo por debajo del céntimo no es "menos cero".
        (-0.001, "0,00 €"),
    ];

    #[test]
    fn el_importe_se_imprime_igual_que_en_la_vista_previa() {
        for (n, esperado) in GOLDEN_EUR {
            assert_eq!(&fmt_eur(*n), esperado, "importe {n}");
        }
    }

    #[test]
    fn formatear_a_secas_no_habria_bastado() {
        // Este test no prueba nuestro código: fija el comportamiento de la biblioteca estándar del
        // que viene la corrección, para que quien "simplifique" `fmt_eur` de vuelta vea por qué no
        // puede. `{:.2}` rompe los empates al PAR, y la vista previa (y cualquiera con un lápiz)
        // los rompe hacia arriba.
        assert_eq!(format!("{:.2}", 1.125), "1.12");
        assert_eq!(fmt_eur(1.125), "1,13 €");

        // Y el negativo minúsculo, que salía como "menos cero".
        assert_eq!(format!("{:.2}", -0.001), "-0.00");
        assert_eq!(fmt_eur(-0.001), "0,00 €");
    }

    /// `(nombre, importe, columnas, lo que queda del nombre)`. Gemelo de `GOLDEN_RECORTE`.
    const GOLDEN_RECORTE: &[(&str, &str, usize, &str)] = &[
        ("Cafe", "1,70 €", 32, "Cafe"),
        // Justo lo que cabe: 32 - 6 - 1 = 25 caracteres.
        ("Solomillo al foie con reduccion", "1,70 €", 32, "Solomillo al foie con red"),
        // Con tildes se cuenta en caracteres, no en bytes.
        ("Ñoquis a la crème con jamón", "9,99 €", 20, "Ñoquis a la c"),
        // Un emoji es UN carácter y aquí cabe justo: 13 - 6 - 1 = 6. Es el corte exacto que en
        // JavaScript partía el par sustituto por la mitad y pintaba un rombo.
        ("Cafe 🍺 grande", "1,70 €", 13, "Cafe 🍺"),
        // Importe más ancho que la línea: no queda nombre, pero no revienta.
        ("Cafe", "123456789,00 €", 10, ""),
    ];

    #[test]
    fn el_nombre_se_recorta_igual_que_en_la_vista_previa() {
        for (nombre, importe, cols, esperado) in GOLDEN_RECORTE {
            // Es lo que hace `line_two` con la parte izquierda; se compara sobre la línea entera
            // para probar la función de verdad y no una copia suya.
            let linea = line_two(nombre, importe, *cols);
            let recortado = linea.trim_end_matches(importe).trim_end();

            assert_eq!(recortado, *esperado, "{nombre:?} en {cols} columnas");
        }
    }
}

#[cfg(test)]
mod tests_spooler {
    //! Las dos conversiones de texto que separan la app de la API de Windows.
    //!
    //! El resto del módulo son llamadas FFI (`OpenPrinter`, `WritePrinter`…) que no se pueden
    //! probar sin una impresora, y mockearlas sería probar el mock. Estas dos sí son puras, y son
    //! justo donde duele: la API espera UTF-16 **terminado en cero**, y si falta ese cero lee
    //! memoria hasta que encuentra uno — el nombre de la impresora sale con basura detrás y no
    //! coincide con ninguna.

    use super::imp::{to_wide, wide_to_string};

    #[test]
    fn el_texto_va_terminado_en_cero() {
        let w = to_wide("EPSON");

        assert_eq!(*w.last().unwrap(), 0, "sin el terminador, la API lee de más");
        assert_eq!(w.len(), "EPSON".len() + 1);
    }

    #[test]
    fn una_cadena_vacia_sigue_siendo_una_cadena() {
        // Es lo que se manda cuando no hay impresora seleccionada: tiene que ser "" y no un
        // puntero a nada.
        assert_eq!(to_wide(""), vec![0]);
    }

    #[test]
    fn los_acentos_de_un_nombre_de_impresora_no_se_pierden() {
        // "Impresora Cocina Ñ" es un nombre perfectamente normal en un bar español.
        let w = to_wide("Ñ");

        assert_eq!(w, vec![0x00D1, 0]);
    }

    #[test]
    fn un_caracter_fuera_del_plano_basico_ocupa_dos_unidades() {
        // UTF-16 no es "un carácter, una unidad": un emoji son dos. Si alguien contara caracteres
        // en vez de unidades para dimensionar el buffer, se quedaría corto.
        let w = to_wide("🍺");

        assert_eq!(w.len(), 3, "dos unidades + terminador: {w:04X?}");
        assert_eq!(*w.last().unwrap(), 0);
    }

    #[test]
    fn la_vuelta_para_en_el_terminador() {
        let buf: Vec<u16> = vec![b'E' as u16, b'P' as u16, 0, b'X' as u16, b'X' as u16];

        // Lo que hay detrás del cero es basura del buffer que devuelve Windows: no puede colarse
        // en el nombre.
        assert_eq!(unsafe { wide_to_string(buf.as_ptr()) }, "EP");
    }

    #[test]
    fn un_puntero_nulo_no_revienta() {
        // `GetDefaultPrinterW` puede fallar y dejar el buffer sin tocar.
        assert_eq!(unsafe { wide_to_string(std::ptr::null()) }, "");
    }

    #[test]
    fn ida_y_vuelta_de_un_nombre_real() {
        for nombre in ["EPSON TM-T20III", "Impresora Cocina Ñ", "Star TSP100 (copia 2)"] {
            let w = to_wide(nombre);
            assert_eq!(unsafe { wide_to_string(w.as_ptr()) }, nombre);
        }
    }
}

#[cfg(test)]
mod tests_arqueo {
    //! El papel del cierre de caja (CUENTA-06).
    //!
    //! Es un documento INTERNO, y los tests van sobre todo a eso: que no se comporte como un ticket
    //! de venta. Lo que se imprime de un arqueo es un dato contable de la casa, y confundirlo con un
    //! recibo tiene consecuencias -numeración gastada, cajón abierto de más-.

    use super::fixtures::contiene;
    use super::*;

    fn arqueo() -> PrintArqueoPayload {
        PrintArqueoPayload {
            business_name: "Bar Paco".into(),
            fecha_hora: "2026-05-10 23:45:00".into(),
            desde: Some("2026-05-09 23:30:00".into()),
            usuario: Some("Ana Gomez".into()),
            fondo_inicial: 150.0,
            ventas_efectivo: 420.5,
            esperado: 570.5,
            contado: 550.5,
            descuadre: -20.0,
            dejado: 150.0,
            retirado: 400.5,
            motivo: Some("se pago un pedido en efectivo".into()),
            contado_denoms: vec![(50.0, 10), (20.0, 2), (0.5, 21)],
            paper_width_mm: 80,
            paper_dpi: 203,
            chars_per_line: 42,
            ..Default::default()
        }
    }

    #[test]
    fn el_arqueo_es_escpos_valido_en_todos_los_anchos() {
        for mm in [58u32, 80, 112] {
            for cpl in [20u32, 42, 80] {
                let mut p = arqueo();
                p.paper_width_mm = mm;
                p.chars_per_line = cpl;
                p.margin_top_mm = 8.0;
                p.margin_bottom_mm = 8.0;
                p.margin_left_mm = 3.0;
                let bytes = build_arqueo(&p);
                super::parser::trocear(&bytes)
                    .unwrap_or_else(|e| panic!("{mm}mm/{cpl}col: {e}"));
            }
        }
    }

    #[test]
    fn dice_lo_que_es_y_de_quien() {
        let bytes = build_arqueo(&arqueo());
        assert!(contiene(&bytes, "CIERRE DE CAJA"), "tiene que decir que es");
        assert!(contiene(&bytes, "Bar Paco"));
        assert!(contiene(&bytes, "2026-05-10 23:45:00"));
        assert!(contiene(&bytes, "Ana Gomez"));
    }

    #[test]
    fn el_descuadre_sale_con_su_signo_en_palabras() {
        // Un numero con signo se lee mal a las dos de la manana. "FALTAN" y "SOBRAN" no.
        let mut p = arqueo();
        assert!(contiene(&build_arqueo(&p), "FALTAN"), "descuadre negativo");

        p.descuadre = 12.5;
        assert!(contiene(&build_arqueo(&p), "SOBRAN"), "descuadre positivo");

        p.descuadre = 0.0;
        let b = build_arqueo(&p);
        assert!(contiene(&b, "CUADRA"));
        assert!(!contiene(&b, "FALTAN") && !contiene(&b, "SOBRAN"));
    }

    #[test]
    fn lleva_el_desglose_del_recuento() {
        // Es lo que convierte "faltan 50" en "falta un billete de 50".
        let bytes = build_arqueo(&arqueo());
        assert!(contiene(&bytes, "Recuento"));
        assert!(contiene(&bytes, "10 x"), "las unidades de cada denominacion");
    }

    #[test]
    fn el_motivo_se_imprime_y_se_envuelve() {
        let mut p = arqueo();
        p.chars_per_line = 24;
        p.motivo = Some("se pago en efectivo un pedido de bebidas que llego sin previo aviso".into());
        let bytes = build_arqueo(&p);
        assert!(contiene(&bytes, "Motivo:"));
        // Ninguna linea puede pasarse del ancho: la termica no envuelve, corta.
        for t in super::parser::lineas(&bytes) {
            assert!(t.chars().count() <= 24, "linea de {} chars: {t:?}", t.chars().count());
        }
    }

    #[test]
    fn sin_motivo_no_aparece_la_etiqueta() {
        let mut p = arqueo();
        p.motivo = None;
        assert!(!contiene(&build_arqueo(&p), "Motivo:"));
        p.motivo = Some("   ".into());
        assert!(!contiene(&build_arqueo(&p), "Motivo:"), "un motivo en blanco no es un motivo");
    }

    #[test]
    fn no_abre_el_cajon_ni_gasta_numero_de_ticket() {
        // Las dos cosas que lo separan de un ticket de venta. El cajon ya esta abierto -se acaba de
        // contar-, y gastar un correlativo dejaria un hueco sin explicacion en la serie de ventas.
        let bytes = build_arqueo(&arqueo());
        let cmds = super::parser::comandos(&bytes);
        assert!(!cmds.contains(&"cajon"), "un arqueo no abre el cajon: {cmds:?}");
        assert!(!contiene(&bytes, "TICKET"), "no lleva numero de ticket");
        assert!(!contiene(&bytes, "IVA"), "un arqueo no lleva desglose fiscal");
    }

    #[test]
    fn termina_cortando_el_papel() {
        let cmds = super::parser::comandos(&build_arqueo(&arqueo()));
        assert_eq!(cmds.last(), Some(&"corte"), "{cmds:?}");
    }
}
