//! Desglose de IVA de un ticket: **un único cálculo para el papel, la vista previa y el registro
//! de facturación**.
//!
//! Vivía en `printing.rs` y sube aquí porque desde Veri\*factu tiene tres consumidores y no dos:
//! el generador ESC/POS, `TicketPaper.tsx` (que es su espejo) y el `Desglose` del registro que se
//! remite a la AEAT. Tres copias de esta cuenta es exactamente el tipo de divergencia que no se ve
//! hasta que la AEAT devuelve un «aceptado con errores» meses después.
//!
//! ## La regla que importa: la cuota se despeja, no se redondea
//!
//! Se redondea la **base** y la cuota es **lo que falta** hasta el total. Redondear las dos por
//! separado hace que a veces suban ambas y el papel diga `0,38 + 0,02 = 0,39`. Pasa de verdad:
//! 0,39 € al 4 % es el primer caso. Un ticket cuya base más su IVA no dan el total es un documento
//! mal emitido — y en el registro es además el error admisible 2005 de la AEAT.
//!
//! ## Y desde Veri\*factu el desglose tiene DOS clases de tramo
//!
//! Las líneas **sujetas** se agrupan por tipo impositivo y llevan `CalificacionOperacion` + tipo +
//! cuota. Las **exentas** se agrupan por **causa de exención** y no llevan ni tipo ni cuota
//! (informarlos es el error 1238). No es lo mismo un producto al 0 % que uno exento, y por eso el
//! tramo es un enum y no una tupla con un `tipo` que a veces se ignora.

/// Redondeo a céntimos. Misma función que usa el resto del dominio del dinero.
fn a_centimos(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Una línea vendida, con lo que necesita el desglose y nada más.
///
/// Los cuatro datos vienen **congelados de `Detalle_Comanda`**, no del catálogo de hoy: una
/// reimpresión del año pasado tiene que enseñar lo que se cobró aquel día, y el registro fiscal ya
/// emitido no puede cambiar de sentido porque alguien edite el producto.
#[derive(Debug, Clone, PartialEq)]
pub struct LineaTicket {
    /// Total de la línea **con IVA incluido** (precio unitario × cantidad).
    pub total_con_iva: f64,
    /// Tipo de IVA de la línea. Se ignora si `exento`.
    pub tipo_iva: f64,
    pub exento: bool,
    /// `E1`..`E6`. Sólo se mira si `exento`.
    pub causa_exencion: Option<String>,
}

/// Un tramo del desglose. Las dos variantes existen porque el XSD las pone en un `<choice>`:
/// `CalificacionOperacion` **o** `OperacionExenta`, nunca las dos.
#[derive(Debug, Clone, PartialEq)]
pub enum TramoIva {
    /// Sujeta y no exenta (`CalificacionOperacion = S1`). Un producto al **0 %** es esto, con
    /// `tipo = 0` y `cuota = 0`: es un tipo real —fue lo que se aplicó al pan y la leche en
    /// 2023-24—, no una exención.
    Sujeta { tipo: f64, base: f64, cuota: f64 },
    /// Exenta (`OperacionExenta = causa`). Sin tipo y sin cuota, que es lo que exige la norma: la
    /// base es todo el importe.
    Exenta { causa: String, base: f64 },
}

impl TramoIva {
    /// Base imponible del tramo, sea de la clase que sea.
    pub fn base(&self) -> f64 {
        match self {
            TramoIva::Sujeta { base, .. } => *base,
            TramoIva::Exenta { base, .. } => *base,
        }
    }

    /// Cuota repercutida. Cero en un tramo exento — y en el XML ese cero **no se informa**, que es
    /// distinto de informar un 0.
    pub fn cuota(&self) -> f64 {
        match self {
            TramoIva::Sujeta { cuota, .. } => *cuota,
            TramoIva::Exenta { .. } => 0.0,
        }
    }
}

/// Causa de exención por defecto cuando una línea está marcada como exenta pero nadie eligió cuál.
///
/// `E1` es el art. 20 LIVA (operaciones interiores), la única realista en hostelería. Se pone un
/// defecto en vez de fallar porque el registro **tiene** que salir: la alternativa sería no poder
/// cobrar por un desplegable que alguien no tocó.
pub const CAUSA_EXENCION_POR_DEFECTO: &str = "E1";

/// Reparte un importe COBRADO entre las líneas, conservando el peso de cada tipo de IVA (REV-16).
///
/// Hace falta cuando lo que se cobra no es la suma de las líneas enteras: un cobro parcial. Lo que
/// se hacía antes era colapsarlo todo en una línea **al tipo de la primera**, y eso declara mal el
/// IVA en cuanto el ticket mezcla tipos — que en un bar es lo normal, comida al 10 % y alcohol al
/// 21 %. Peor todavía con las exentas: la condición era «exento sólo si lo son TODAS», así que un
/// ticket con una línea exenta y otra no se declaraba entero como *sujeto* y al tipo de la exenta.
///
/// ⚠️ **Y nadie de fuera lo habría cazado.** Se comprobó contra la AEAT mandando una `CuotaTotal`
/// descuadrada a propósito: la acepta sin decir nada (ver `docs/PRUEBAS_AEAT.md`). Un desglose mal
/// repartido sale por la puerta como si tal cosa.
///
/// El reparto es proporcional y **cuadra al céntimo**: se redondea cada línea y el resto que sobra
/// o falta va a la línea más grande, que es donde menos se nota y donde no puede dejar un importe
/// en negativo. Lo que sale tiene que sumar exactamente `cobrado`, porque de esa suma salen la
/// base y la cuota del registro.
///
/// Casos de borde, todos hacia poder facturar:
///   * sin líneas, o con líneas que suman cero, no hay proporción que repartir: se devuelve una
///     sola línea con el importe cobrado y la forma de la primera (o del tipo general si no hay
///     ninguna);
///   * las líneas que se quedan en `0,00` al redondear se descartan, para no emitir un tramo de
///     base cero que no dice nada.
pub fn prorratear(lineas: &[LineaTicket], cobrado: f64, tipo_general: f64) -> Vec<LineaTicket> {
    let unica = |modelo: Option<&LineaTicket>| {
        vec![LineaTicket {
            total_con_iva: a_centimos(cobrado),
            tipo_iva: modelo.map(|l| l.tipo_iva).unwrap_or(tipo_general),
            exento: modelo.map(|l| l.exento).unwrap_or(false),
            causa_exencion: modelo.and_then(|l| l.causa_exencion.clone()),
        }]
    };

    let suma: f64 = lineas.iter().map(|l| l.total_con_iva).sum();
    if lineas.is_empty() || suma <= 0.0 {
        return unica(lineas.first());
    }

    // Se trabaja en céntimos enteros: repartir en coma flotante y confiar en que cuadre es cómo se
    // llega a un ticket que dice `0,38 + 0,02 = 0,39`.
    let objetivo = (cobrado * 100.0).round() as i64;
    let mut centimos: Vec<i64> = lineas
        .iter()
        .map(|l| (l.total_con_iva / suma * cobrado * 100.0).round() as i64)
        .collect();

    let resto = objetivo - centimos.iter().sum::<i64>();
    if resto != 0 {
        // A la más grande: es la que absorbe un céntimo sin cambiar de signo ni de sentido.
        let mayor = centimos
            .iter()
            .enumerate()
            .max_by_key(|(_, c)| **c)
            .map(|(i, _)| i)
            .unwrap_or(0);
        centimos[mayor] += resto;
    }

    let out: Vec<LineaTicket> = lineas
        .iter()
        .zip(centimos)
        .filter(|(_, c)| *c != 0)
        .map(|(l, c)| LineaTicket {
            total_con_iva: c as f64 / 100.0,
            tipo_iva: l.tipo_iva,
            exento: l.exento,
            causa_exencion: l.causa_exencion.clone(),
        })
        .collect();

    // Todo se fue a cero (un cobro de céntimos repartido entre muchas líneas): mejor una línea con
    // el importe que ninguna, porque el registro tiene que salir igualmente.
    if out.is_empty() {
        return unica(lineas.first());
    }
    out
}

/// Calcula el desglose a partir de las líneas.
///
/// `tipo_general` es el del negocio (`Business_Settings.IVA_Percent`), que usan las líneas sin tipo
/// propio — el caso de casi todo en hostelería.
///
/// El resultado sale **ordenado de forma estable**: primero las sujetas por tipo ascendente, luego
/// las exentas por causa. Sin un orden fijo, dos ejecuciones sobre las mismas líneas podrían
/// producir dos XML distintos, y aunque el desglose no entra en la huella, sí entra en lo que un
/// tercero coteja al auditar la exportación.
pub fn desglose(lineas: &[LineaTicket]) -> Vec<TramoIva> {
    // (tipo, total con IVA) de las sujetas.
    let mut sujetas: Vec<(f64, f64)> = Vec::new();
    // (causa, total) de las exentas.
    let mut exentas: Vec<(String, f64)> = Vec::new();

    for l in lineas {
        if l.exento {
            let causa = l
                .causa_exencion
                .clone()
                .unwrap_or_else(|| CAUSA_EXENCION_POR_DEFECTO.to_string());
            match exentas.iter_mut().find(|(c, _)| *c == causa) {
                Some((_, acc)) => *acc += l.total_con_iva,
                None => exentas.push((causa, l.total_con_iva)),
            }
        } else {
            // Se agrupa con tolerancia: un 10.0 y un 10.000000001 son el mismo tipo.
            match sujetas.iter_mut().find(|(t, _)| (*t - l.tipo_iva).abs() < 1e-9) {
                Some((_, acc)) => *acc += l.total_con_iva,
                None => sujetas.push((l.tipo_iva, l.total_con_iva)),
            }
        }
    }

    sujetas.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    exentas.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out: Vec<TramoIva> = Vec::with_capacity(sujetas.len() + exentas.len());
    for (tipo, total) in sujetas {
        let total = a_centimos(total);
        let divisor = 1.0 + tipo / 100.0;
        let base = if divisor.abs() < f64::EPSILON {
            total
        } else {
            a_centimos(total / divisor)
        };
        // La cuota es lo que falta, no un redondeo aparte. Ver la nota de cabecera.
        out.push(TramoIva::Sujeta {
            tipo,
            base,
            cuota: a_centimos(total - base),
        });
    }
    for (causa, total) in exentas {
        out.push(TramoIva::Exenta {
            causa,
            base: a_centimos(total),
        });
    }
    out
}

/// Suma de las bases del desglose.
pub fn base_total(tramos: &[TramoIva]) -> f64 {
    a_centimos(tramos.iter().map(|t| t.base()).sum())
}

/// Suma de las cuotas del desglose. Es el `CuotaTotal` del registro.
pub fn cuota_total(tramos: &[TramoIva]) -> f64 {
    a_centimos(tramos.iter().map(|t| t.cuota()).sum())
}

/// `base + cuota` de todos los tramos. Es el `ImporteTotal` del registro, y la AEAT valida que
/// cuadre con la suma del desglose (±10 €, errores 2005 y 2006). Con la cuota despejada nunca
/// difiere de la suma de las líneas: si esta comprobación salta, el cálculo está roto de verdad.
pub fn importe_total(tramos: &[TramoIva]) -> f64 {
    a_centimos(base_total(tramos) + cuota_total(tramos))
}

#[cfg(test)]
// Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
// (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn sujeta(total: f64, tipo: f64) -> LineaTicket {
        LineaTicket {
            total_con_iva: total,
            tipo_iva: tipo,
            exento: false,
            causa_exencion: None,
        }
    }
    fn exenta(total: f64, causa: &str) -> LineaTicket {
        LineaTicket {
            total_con_iva: total,
            tipo_iva: 0.0,
            exento: true,
            causa_exencion: Some(causa.to_string()),
        }
    }

    #[test]
    fn la_cuota_se_despeja_para_que_base_mas_cuota_de_el_total() {
        // 0,39 € al 4 % es el primer caso donde redondear las dos por separado da 0,38 + 0,02.
        let d = desglose(&[sujeta(0.39, 4.0)]);
        assert_eq!(d.len(), 1);
        match &d[0] {
            TramoIva::Sujeta { base, cuota, .. } => {
                assert!((base + cuota - 0.39).abs() < 1e-9, "{base} + {cuota}");
            }
            _ => panic!("debería ser sujeta"),
        }
        assert_eq!(importe_total(&d), 0.39);
    }

    #[test]
    fn agrupa_por_tipo_y_ordena_ascendente() {
        let d = desglose(&[sujeta(121.0, 21.0), sujeta(11.0, 10.0), sujeta(110.0, 10.0)]);
        assert_eq!(d.len(), 2);
        match (&d[0], &d[1]) {
            (TramoIva::Sujeta { tipo: t0, base: b0, .. }, TramoIva::Sujeta { tipo: t1, .. }) => {
                assert_eq!(*t0, 10.0);
                assert_eq!(*t1, 21.0);
                assert_eq!(*b0, 110.0); // (11 + 110) / 1.10
            }
            _ => panic!("dos tramos sujetos"),
        }
    }

    #[test]
    fn un_producto_al_cero_por_ciento_es_SUJETO_no_exento() {
        // El test existe para que nadie los unifique "simplificando". Son dos afirmaciones legales
        // distintas y el XSD las pone en un <choice>.
        let d = desglose(&[sujeta(10.0, 0.0)]);
        assert_eq!(d, vec![TramoIva::Sujeta { tipo: 0.0, base: 10.0, cuota: 0.0 }]);
    }

    #[test]
    fn una_linea_exenta_no_lleva_tipo_ni_cuota() {
        let d = desglose(&[exenta(10.0, "E1")]);
        assert_eq!(d, vec![TramoIva::Exenta { causa: "E1".into(), base: 10.0 }]);
        assert_eq!(cuota_total(&d), 0.0);
        assert_eq!(base_total(&d), 10.0);
    }

    #[test]
    fn las_exentas_se_agrupan_por_causa_y_van_despues_de_las_sujetas() {
        let d = desglose(&[
            exenta(5.0, "E2"),
            sujeta(11.0, 10.0),
            exenta(3.0, "E1"),
            exenta(2.0, "E1"),
        ]);
        assert_eq!(d.len(), 3);
        assert!(matches!(d[0], TramoIva::Sujeta { .. }));
        assert_eq!(d[1], TramoIva::Exenta { causa: "E1".into(), base: 5.0 });
        assert_eq!(d[2], TramoIva::Exenta { causa: "E2".into(), base: 5.0 });
    }

    #[test]
    fn una_exenta_sin_causa_cae_en_E1() {
        // Sin defecto, un desplegable que nadie tocó impediría cobrar. E1 (art. 20 LIVA) es la
        // única exención realista en hostelería.
        let d = desglose(&[LineaTicket {
            total_con_iva: 7.0,
            tipo_iva: 0.0,
            exento: true,
            causa_exencion: None,
        }]);
        assert_eq!(d, vec![TramoIva::Exenta { causa: "E1".into(), base: 7.0 }]);
    }

    #[test]
    fn el_importe_total_siempre_cuadra_con_la_suma_de_lineas() {
        // La AEAT lo valida con ±10 € (errores 2005/2006). Con la cuota despejada, el margen sobra.
        let lineas = vec![
            sujeta(1.70, 10.0),
            sujeta(2.30, 10.0),
            sujeta(12.10, 21.0),
            exenta(4.00, "E1"),
        ];
        let suma_lineas = (lineas.iter().map(|l| l.total_con_iva).sum::<f64>() * 100.0).round() / 100.0;
        assert_eq!(importe_total(&desglose(&lineas)), suma_lineas);
    }

    #[test]
    fn sin_lineas_no_hay_tramos() {
        assert!(desglose(&[]).is_empty());
        assert_eq!(importe_total(&[]), 0.0);
    }

    #[test]
    fn el_desglose_no_pasa_de_doce_tramos_en_un_ticket_realista() {
        // El XSD acota `DetalleDesglose` a maxOccurs=12. En hostelería son 2 o 3 (10 %, 21 % y a lo
        // sumo un exento); este test es el recordatorio de que el límite existe.
        let lineas: Vec<LineaTicket> = (0..40).map(|i| sujeta(10.0, (i % 3) as f64 * 10.0)).collect();
        assert!(desglose(&lineas).len() <= 12);
    }

    /* ── REV-16 · prorrateo de un cobro parcial ──────────────────────────── */

    #[test]
    fn un_cobro_parcial_conserva_el_peso_de_CADA_tipo() {
        // Comida al 10 % y alcohol al 21 %: el ticket de cualquier bar. Antes todo se declaraba al
        // tipo de la PRIMERA línea, así que la mitad del IVA salía mal.
        let lineas = [sujeta(110.0, 10.0), sujeta(121.0, 21.0)];
        let p = prorratear(&lineas, 115.5, 21.0);

        assert_eq!(p.len(), 2);
        assert_eq!(p[0].tipo_iva, 10.0);
        assert_eq!(p[1].tipo_iva, 21.0);
        // La mitad de cada una: 110 y 121 suman 231, y se cobra 115,50.
        assert_eq!(p[0].total_con_iva, 55.0);
        assert_eq!(p[1].total_con_iva, 60.5);
    }

    #[test]
    fn el_reparto_suma_EXACTAMENTE_lo_cobrado() {
        // Tres líneas iguales y un importe que no se divide entre tres: el céntimo que sobra tiene
        // que caer en alguna parte, o base + cuota dejan de dar el total (error 2005 de la AEAT).
        let lineas = [sujeta(10.0, 10.0), sujeta(10.0, 10.0), sujeta(10.0, 10.0)];
        let p = prorratear(&lineas, 10.0, 10.0);

        let total: f64 = p.iter().map(|l| l.total_con_iva).sum();
        assert!((total - 10.0).abs() < 1e-9, "{total}");
    }

    #[test]
    fn una_linea_exenta_sigue_siendo_exenta_aunque_la_otra_no_lo_sea() {
        // El caso peor de los de antes: `exento` sólo era cierto si lo eran TODAS, así que esto se
        // declaraba entero como sujeto y al tipo de la exenta (0 %). Dos afirmaciones legales
        // falsas de una vez.
        let lineas = [exenta(50.0, "E1"), sujeta(50.0, 21.0)];
        let p = prorratear(&lineas, 50.0, 21.0);

        assert_eq!(p.len(), 2);
        assert!(p[0].exento);
        assert_eq!(p[0].causa_exencion.as_deref(), Some("E1"));
        assert!(!p[1].exento);
        assert_eq!(p[1].tipo_iva, 21.0);

        // Y el desglose que sale de ahí tiene sus dos tramos, cada uno de su clase.
        let d = desglose(&p);
        assert_eq!(d.len(), 2);
        assert!(matches!(d[0], TramoIva::Sujeta { tipo: 21.0, .. }));
        assert!(matches!(&d[1], TramoIva::Exenta { causa, .. } if causa == "E1"));
    }

    #[test]
    fn sin_lineas_se_declara_el_importe_al_tipo_general() {
        // No debería pasar, pero el registro tiene que salir igualmente: el cobro es el hecho
        // fiscal y no puede quedarse sin factura porque falte el detalle.
        let p = prorratear(&[], 12.5, 21.0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].total_con_iva, 12.5);
        assert_eq!(p[0].tipo_iva, 21.0);
        assert!(!p[0].exento);
    }

    #[test]
    fn unas_lineas_que_suman_cero_no_bloquean_la_factura() {
        // Invitaciones a 0,00 y un cobro por encima: no hay proporción que repartir. Se declara el
        // importe con la forma de la primera línea en vez de dividir por cero.
        let p = prorratear(&[sujeta(0.0, 10.0)], 5.0, 21.0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].total_con_iva, 5.0);
        assert_eq!(p[0].tipo_iva, 10.0);
    }

    #[test]
    fn las_lineas_que_se_quedan_en_cero_no_generan_un_tramo_vacio() {
        // Un cobro de céntimos sobre un ticket grande: la línea pequeña redondea a 0,00 y un tramo
        // de base cero no dice nada. Lo que no puede cambiar es la suma.
        let lineas = [sujeta(1000.0, 10.0), sujeta(0.05, 21.0)];
        let p = prorratear(&lineas, 0.10, 10.0);

        assert!(p.iter().all(|l| l.total_con_iva != 0.0));
        let total: f64 = p.iter().map(|l| l.total_con_iva).sum();
        assert!((total - 0.10).abs() < 1e-9, "{total}");
    }

    #[test]
    fn cobrar_el_total_exacto_no_cambia_nada() {
        // La garantía de que esto no toca el camino normal: si se cobra la suma de las líneas, el
        // reparto devuelve las mismas líneas.
        let lineas = [sujeta(110.0, 10.0), sujeta(121.0, 21.0)];
        let p = prorratear(&lineas, 231.0, 21.0);
        assert_eq!(p[0].total_con_iva, 110.0);
        assert_eq!(p[1].total_con_iva, 121.0);
    }

}
