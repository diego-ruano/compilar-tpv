//! Desglose de IVA de un ticket: **un único cálculo para el papel, la vista previa y el registro
//! de facturación**.
//!
//! Vivía en `printing.rs` y sube aquí porque desde Veri\*factu tiene tres consumidores y no dos:
//! el generador ESC/POS, `TicketPaper.tsx` (que es su espejo) y el `Desglose` del registro de
//! facturación. Tres copias de esta cuenta es exactamente el tipo de divergencia que no se ve
//! hasta que el papel y el registro dicen cosas distintas del mismo cobro.
//!
//! ## La regla que importa: la cuota se despeja, no se redondea
//!
//! Se redondea la **base** y la cuota es **lo que falta** hasta el total. Redondear las dos por
//! separado hace que a veces suban ambas y el papel diga `0,38 + 0,02 = 0,39`. Pasa de verdad:
//! 0,39 € al 4 % es el primer caso. Un ticket cuya base más su IVA no dan el total es un documento
//! mal emitido — y en el registro es además el error admisible 2005 de la AEAT.
//!
//! ## Todo tramo es sujeto
//!
//! Las líneas se agrupan por tipo impositivo y cada tramo va al registro como sujeto y no exento
//! (`CalificacionOperacion = S1`) con su tipo y su cuota. No hay tramos exentos: en hostelería no
//! hay ventas exentas, y la única que un bar puede hacer —la lotería a su valor facial— la AEAT
//! la deja fuera del registro, como un suplido.

use crate::dinero::Dinero;

/// Una línea vendida, con lo que necesita el desglose y nada más.
///
/// Los datos vienen **congelados de `Detalle_Comanda`**, no del catálogo de hoy: una reimpresión del
/// año pasado tiene que enseñar lo que se cobró aquel día, y el registro fiscal ya emitido no puede
/// cambiar de sentido porque alguien edite el producto.
#[derive(Debug, Clone, PartialEq)]
pub struct LineaTicket {
    /// Total de la línea **con IVA incluido** (precio unitario × cantidad).
    pub total_con_iva: Dinero,
    /// Tipo de IVA de la línea.
    pub tipo_iva: f64,
}

/// Un tramo del desglose: todo lo vendido a un mismo tipo. Un producto al **0 %** es un tramo con
/// `tipo = 0` y `cuota = 0`: es un tipo real —fue lo que se aplicó al pan y la leche en 2023-24—, y
/// en el registro lleva su tipo y su cuota informados.
#[derive(Debug, Clone, PartialEq)]
pub struct TramoIva {
    pub tipo: f64,
    pub base: Dinero,
    pub cuota: Dinero,
}

/// Reparte un importe COBRADO entre las líneas, conservando el peso de cada tipo de IVA (REV-16).
///
/// Hace falta cuando lo que se cobra no es la suma de las líneas enteras: un cobro parcial. Lo que
/// se hacía antes era colapsarlo todo en una línea **al tipo de la primera**, y eso declara mal el
/// IVA en cuanto el ticket mezcla tipos — que en un bar es lo normal, comida al 10 % y alcohol al
/// 21 %.
///
/// ⚠️ **Y nadie de fuera lo habría cazado.** Se comprobó contra la AEAT mandando una `CuotaTotal`
/// descuadrada a propósito: la acepta sin decir nada (ver `docs/PRUEBAS_AEAT.md` en `con-verifactu`). Un desglose mal
/// repartido sale por la puerta como si tal cosa.
///
/// El reparto es proporcional y **cuadra al céntimo**: se redondea cada línea y el resto que sobra
/// o falta va a la línea más grande, que es donde menos se nota y donde no puede dejar un importe
/// en negativo. Lo que sale tiene que sumar exactamente `cobrado`, porque de esa suma salen la
/// base y la cuota del registro. Esta función ya trabajaba en céntimos enteros por dentro antes de
/// que el dinero lo fuera: era la única forma de que cuadrase.
///
/// Casos de borde, todos hacia poder facturar:
///   * sin líneas, o con líneas que suman cero, no hay proporción que repartir: se devuelve una
///     sola línea con el importe cobrado y el tipo de la primera (o el general si no hay ninguna);
///   * las líneas que se quedan en `0,00` al redondear se descartan, para no emitir un tramo de
///     base cero que no dice nada.
pub fn prorratear(lineas: &[LineaTicket], cobrado: Dinero, tipo_general: f64) -> Vec<LineaTicket> {
    let unica = |modelo: Option<&LineaTicket>| {
        vec![LineaTicket {
            total_con_iva: cobrado,
            tipo_iva: modelo.map(|l| l.tipo_iva).unwrap_or(tipo_general),
        }]
    };

    let suma: Dinero = lineas.iter().map(|l| l.total_con_iva).sum();
    if lineas.is_empty() || suma <= Dinero::CERO {
        return unica(lineas.first());
    }

    // El reparto es la única parte que necesita una proporción, o sea un flotante. Se hace sobre
    // los céntimos y se vuelve a entero en el acto: repartir en coma flotante y confiar en que
    // cuadre es cómo se llega a un ticket que dice `0,38 + 0,02 = 0,39`.
    let objetivo = cobrado.centimos();
    let mut centimos: Vec<i64> = lineas
        .iter()
        .map(|l| {
            (l.total_con_iva.centimos() as f64 / suma.centimos() as f64 * objetivo as f64).round()
                as i64
        })
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
            total_con_iva: Dinero::de_centimos(c),
            tipo_iva: l.tipo_iva,
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
/// El resultado sale **ordenado de forma estable**, por tipo ascendente. Sin un orden fijo, dos
/// ejecuciones sobre las mismas líneas podrían producir dos XML distintos, y aunque el desglose no
/// entra en la huella, sí entra en lo que un tercero coteja al auditar la exportación.
pub fn desglose(lineas: &[LineaTicket]) -> Vec<TramoIva> {
    // (tipo, total con IVA).
    let mut por_tipo: Vec<(f64, Dinero)> = Vec::new();

    for l in lineas {
        // Se agrupa con tolerancia: un 10.0 y un 10.000000001 son el mismo tipo.
        match por_tipo.iter_mut().find(|(t, _)| (*t - l.tipo_iva).abs() < 1e-9) {
            Some((_, acc)) => *acc += l.total_con_iva,
            None => por_tipo.push((l.tipo_iva, l.total_con_iva)),
        }
    }

    por_tipo.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    por_tipo
        .into_iter()
        .map(|(tipo, total)| {
            let divisor = 1.0 + tipo / 100.0;
            let base = if divisor.abs() < f64::EPSILON {
                total
            } else {
                total.entre(divisor)
            };
            // La cuota es lo que falta, no un redondeo aparte. Ver la nota de cabecera.
            TramoIva {
                tipo,
                base,
                cuota: total - base,
            }
        })
        .collect()
}

/// Suma de las bases del desglose.
pub fn base_total(tramos: &[TramoIva]) -> Dinero {
    tramos.iter().map(|t| t.base).sum()
}

/// Suma de las cuotas del desglose. Es el `CuotaTotal` del registro.
pub fn cuota_total(tramos: &[TramoIva]) -> Dinero {
    tramos.iter().map(|t| t.cuota).sum()
}

/// `base + cuota` de todos los tramos. Es el `ImporteTotal` del registro, y la AEAT valida que
/// cuadre con la suma del desglose (±10 €, errores 2005 y 2006). Con la cuota despejada nunca
/// difiere de la suma de las líneas: si esta comprobación salta, el cálculo está roto de verdad.
pub fn importe_total(tramos: &[TramoIva]) -> Dinero {
    base_total(tramos) + cuota_total(tramos)
}

// ─────────────────────────────────────────────────────────────────────────────
// Las líneas del papel (RI-29)
// ─────────────────────────────────────────────────────────────────────────────

/// Una línea tal como se vendió: la de `Detalle_Comanda`, con sus valores congelados.
#[derive(Debug, Clone, PartialEq)]
pub struct LineaVendida {
    pub nombre: String,
    /// Unidades. Un producto al peso trae una cantidad fraccionaria (0,35 kg).
    pub cantidad: f64,
    pub precio_unitario: Dinero,
    /// `None` = el tipo general del negocio.
    pub iva_percent: Option<f64>,
}

/// Una línea ya agrupada, como se imprime: `3 x 1,10`.
#[derive(Debug, Clone, PartialEq)]
pub struct LineaAgrupada {
    pub nombre: String,
    pub cantidad: u32,
    pub precio_unitario: Dinero,
    pub iva_percent: Option<f64>,
}

/// Junta las unidades idénticas en una línea con su cantidad. Gemelo de `agruparLineas` en
/// `ticketMath.ts`, que agrupa la precuenta.
///
/// El criterio es **nombre + precio + tipo de IVA**: dos unidades del mismo producto vendidas a
/// precios o tipos distintos son dos líneas, porque juntarlas obligaría a inventarse un precio
/// unitario que no es ninguno de los dos.
///
/// Una cantidad fraccionada (un producto al peso) no cabe en un papel que cuenta unidades enteras,
/// así que se pliega a una unidad por el importe de la línea, redondeado como lo redondea el SQL
/// del cobro (`CAST(ROUND(Cantidad * Precio_Unitario))`): se pierde el detalle, no el dinero.
pub fn agrupar_lineas(lineas: &[LineaVendida]) -> Vec<LineaAgrupada> {
    let mut out: Vec<LineaAgrupada> = Vec::new();
    for l in lineas {
        let entera = l.cantidad.fract() == 0.0 && l.cantidad >= 1.0 && l.cantidad <= u32::MAX as f64;
        let (unidades, precio) = if entera {
            (l.cantidad as u32, l.precio_unitario)
        } else {
            (1, l.precio_unitario.escala(l.cantidad))
        };
        let mismo_iva = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-9,
            (None, None) => true,
            _ => false,
        };
        match out.iter_mut().find(|g| {
            g.nombre == l.nombre && g.precio_unitario == precio && mismo_iva(g.iva_percent, l.iva_percent)
        }) {
            Some(g) => g.cantidad += unidades,
            None => out.push(LineaAgrupada {
                nombre: l.nombre.clone(),
                cantidad: unidades,
                precio_unitario: precio,
                iva_percent: l.iva_percent,
            }),
        }
    }
    out
}

/// La fecha que lleva el papel de una factura: la de **expedición**, con la hora en que se generó
/// el registro. `fecha_expedicion` va como en el XML (`DD-MM-AAAA`) y `fecha_hora_huso` como en el
/// registro (`2027-01-02T13:45:10+01:00`).
///
/// Sale del registro y no del reloj: una reimpresión de la semana que viene tiene que decir el día
/// de la factura, no el de la copia (RI-29).
pub fn fecha_del_papel(fecha_expedicion: &str, fecha_hora_huso: &str) -> String {
    let dia = fecha_expedicion.trim().replace('-', "/");
    match fecha_hora_huso.trim().get(11..16) {
        Some(hora) if hora.as_bytes().get(2) == Some(&b':') => format!("{dia} {hora}"),
        _ => dia,
    }
}

/// La fecha de un cobro sin registro de facturación (uno anterior a la numeración): `Pagos.Fecha_Hora`
/// (`AAAA-MM-DD HH:MM:SS`) como la escribe el papel (`DD/MM/AAAA HH:MM`). Si no tiene esa forma se
/// devuelve tal cual: una fecha rara en el papel es mejor que ninguna.
pub fn fecha_de_cobro(fecha_hora: &str) -> String {
    let f = fecha_hora.trim();
    match (f.get(0..4), f.get(5..7), f.get(8..10), f.get(11..16)) {
        (Some(a), Some(m), Some(d), Some(hm)) if f.as_bytes().get(4) == Some(&b'-') => {
            format!("{d}/{m}/{a} {hm}")
        }
        _ => f.to_string(),
    }
}

#[cfg(test)]
// Los nombres de estos tests usan MAYUSCULAS para enfatizar la afirmacion que fijan
// (`..._NO_gasta_numero`, `..._por_RANGO_...`). Es deliberado y no es snake case.
#[allow(non_snake_case)]
mod tests {
    use super::*;

    /// Euros → `Dinero`. Los supuestos se escriben en euros; lo que se compara son céntimos.
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    fn linea(total: f64, tipo: f64) -> LineaTicket {
        LineaTicket {
            total_con_iva: eur(total),
            tipo_iva: tipo,
        }
    }

    #[test]
    fn la_cuota_se_despeja_para_que_base_mas_cuota_de_el_total() {
        // 0,39 € al 4 % es el primer caso donde redondear las dos por separado da 0,38 + 0,02.
        let d = desglose(&[linea(0.39, 4.0)]);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].base + d[0].cuota, eur(0.39), "{} + {}", d[0].base, d[0].cuota);
        assert_eq!(importe_total(&d), eur(0.39));
    }

    #[test]
    fn agrupa_por_tipo_y_ordena_ascendente() {
        let d = desglose(&[linea(121.0, 21.0), linea(11.0, 10.0), linea(110.0, 10.0)]);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].tipo, 10.0);
        assert_eq!(d[1].tipo, 21.0);
        assert_eq!(d[0].base, eur(110.0)); // (11 + 110) / 1.10
    }

    #[test]
    fn un_producto_al_cero_por_ciento_lleva_tipo_y_cuota_a_cero() {
        let d = desglose(&[linea(10.0, 0.0)]);
        assert_eq!(d, vec![TramoIva { tipo: 0.0, base: eur(10.0), cuota: Dinero::CERO }]);
    }

    #[test]
    fn el_importe_total_siempre_cuadra_con_la_suma_de_lineas() {
        // La AEAT lo valida con ±10 € (errores 2005/2006). Con la cuota despejada, el margen sobra.
        let lineas = vec![
            linea(1.70, 10.0),
            linea(2.30, 10.0),
            linea(12.10, 21.0),
            linea(4.00, 0.0),
        ];
        let suma_lineas: Dinero = lineas.iter().map(|l| l.total_con_iva).sum();
        assert_eq!(importe_total(&desglose(&lineas)), suma_lineas);
    }

    #[test]
    fn sin_lineas_no_hay_tramos() {
        assert!(desglose(&[]).is_empty());
        assert_eq!(importe_total(&[]), Dinero::CERO);
    }

    #[test]
    fn el_desglose_no_pasa_de_doce_tramos_en_un_ticket_realista() {
        // El XSD acota `DetalleDesglose` a maxOccurs=12. En hostelería son 2 o 3 (10 % y 21 %, y a
        // lo sumo algún 4 %); este test es el recordatorio de que el límite existe.
        let lineas: Vec<LineaTicket> = (0..40).map(|i| linea(10.0, (i % 3) as f64 * 10.0)).collect();
        assert!(desglose(&lineas).len() <= 12);
    }

    /* ── REV-16 · prorrateo de un cobro parcial ──────────────────────────── */

    #[test]
    fn un_cobro_parcial_conserva_el_peso_de_CADA_tipo() {
        // Comida al 10 % y alcohol al 21 %: el ticket de cualquier bar. Antes todo se declaraba al
        // tipo de la PRIMERA línea, así que la mitad del IVA salía mal.
        let lineas = [linea(110.0, 10.0), linea(121.0, 21.0)];
        let p = prorratear(&lineas, eur(115.5), 21.0);

        assert_eq!(p.len(), 2);
        assert_eq!(p[0].tipo_iva, 10.0);
        assert_eq!(p[1].tipo_iva, 21.0);
        // La mitad de cada una: 110 y 121 suman 231, y se cobra 115,50.
        assert_eq!(p[0].total_con_iva, eur(55.0));
        assert_eq!(p[1].total_con_iva, eur(60.5));
    }

    #[test]
    fn el_reparto_suma_EXACTAMENTE_lo_cobrado() {
        // Tres líneas iguales y un importe que no se divide entre tres: el céntimo que sobra tiene
        // que caer en alguna parte, o base + cuota dejan de dar el total (error 2005 de la AEAT).
        let lineas = [linea(10.0, 10.0), linea(10.0, 10.0), linea(10.0, 10.0)];
        let p = prorratear(&lineas, eur(10.0), 10.0);

        let total: Dinero = p.iter().map(|l| l.total_con_iva).sum();
        assert_eq!(total, eur(10.0), "el reparto tiene que cuadrar al centimo");
    }

    #[test]
    fn sin_lineas_se_declara_el_importe_al_tipo_general() {
        // No debería pasar, pero el registro tiene que salir igualmente: el cobro es el hecho
        // fiscal y no puede quedarse sin factura porque falte el detalle.
        let p = prorratear(&[], eur(12.5), 21.0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].total_con_iva, eur(12.5));
        assert_eq!(p[0].tipo_iva, 21.0);
    }

    #[test]
    fn unas_lineas_que_suman_cero_no_bloquean_la_factura() {
        // Invitaciones a 0,00 y un cobro por encima: no hay proporción que repartir. Se declara el
        // importe con el tipo de la primera línea en vez de dividir por cero.
        let p = prorratear(&[linea(0.0, 10.0)], eur(5.0), 21.0);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].total_con_iva, eur(5.0));
        assert_eq!(p[0].tipo_iva, 10.0);
    }

    #[test]
    fn las_lineas_que_se_quedan_en_cero_no_generan_un_tramo_vacio() {
        // Un cobro de céntimos sobre un ticket grande: la línea pequeña redondea a 0,00 y un tramo
        // de base cero no dice nada. Lo que no puede cambiar es la suma.
        let lineas = [linea(1000.0, 10.0), linea(0.05, 21.0)];
        let p = prorratear(&lineas, eur(0.10), 10.0);

        assert!(p.iter().all(|l| !l.total_con_iva.es_cero()));
        let total: Dinero = p.iter().map(|l| l.total_con_iva).sum();
        assert_eq!(total, eur(0.10), "el reparto tiene que cuadrar al centimo");
    }

    #[test]
    fn cobrar_el_total_exacto_no_cambia_nada() {
        // La garantía de que esto no toca el camino normal: si se cobra la suma de las líneas, el
        // reparto devuelve las mismas líneas.
        let lineas = [linea(110.0, 10.0), linea(121.0, 21.0)];
        let p = prorratear(&lineas, eur(231.0), 21.0);
        assert_eq!(p[0].total_con_iva, eur(110.0));
        assert_eq!(p[1].total_con_iva, eur(121.0));
    }
    fn vendida(nombre: &str, cantidad: f64, precio: f64, iva: Option<f64>) -> LineaVendida {
        LineaVendida {
            nombre: nombre.into(),
            cantidad,
            precio_unitario: eur(precio),
            iva_percent: iva,
        }
    }

    #[test]
    fn agrupar_junta_las_unidades_iguales_y_suma_las_cantidades_ya_contadas() {
        let g = agrupar_lineas(&[
            vendida("Cafe", 1.0, 1.1, None),
            vendida("Cafe", 2.0, 1.1, None),
            vendida("Tostada", 1.0, 2.4, None),
        ]);
        assert_eq!(g.len(), 2);
        assert_eq!((g[0].nombre.as_str(), g[0].cantidad), ("Cafe", 3));
        assert_eq!(g[1].nombre, "Tostada");
    }

    #[test]
    fn agrupar_no_junta_precios_ni_tipos_distintos() {
        let g = agrupar_lineas(&[
            vendida("Vino", 1.0, 12.0, Some(10.0)),
            vendida("Vino", 1.0, 12.0, Some(21.0)),
            vendida("Vino", 1.0, 13.0, Some(10.0)),
            vendida("Cafe", 1.0, 1.1, None),
            vendida("Cafe", 1.0, 1.1, Some(10.0)),
        ]);
        assert_eq!(g.len(), 5);
    }

    #[test]
    fn agrupar_pliega_lo_vendido_al_peso_a_una_unidad_con_el_importe_redondeado() {
        // El caso de RI-53: 12,34 € × 0,333 son 410,92 céntimos, y el cobro los guardó como 411.
        let g = agrupar_lineas(&[vendida("Jamon", 0.333, 12.34, None)]);
        assert_eq!(g[0].cantidad, 1);
        assert_eq!(g[0].precio_unitario.centimos(), 411);
    }

    #[test]
    fn la_fecha_del_papel_es_la_de_expedicion_con_la_hora_del_registro() {
        assert_eq!(
            fecha_del_papel("02-01-2027", "2027-01-02T13:45:10+01:00"),
            "02/01/2027 13:45"
        );
        // Sin hora legible, al menos el día.
        assert_eq!(fecha_del_papel("02-01-2027", ""), "02/01/2027");
    }

    #[test]
    fn la_fecha_de_un_cobro_se_escribe_como_en_el_papel() {
        assert_eq!(fecha_de_cobro("2027-01-02 13:45:10"), "02/01/2027 13:45");
        assert_eq!(fecha_de_cobro("raro"), "raro");
    }
}
