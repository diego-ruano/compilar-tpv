//! Dominio del **cierre de caja** (arqueo). CUENTA-06.
//!
//! Aquí vive la aritmética del arqueo y nada más: sin BD, sin red, sin reloj. Es la capa donde se
//! puede probar barato lo único que de verdad duele si se equivoca —el dinero—, y por eso el grueso
//! de los tests del cierre está aquí y no más arriba.
//!
//! **El principio que ordena todo:** el programa no puede saber si el dinero está en el cajón. Sólo
//! puede registrar lo que alguien declara y enseñar la diferencia. Estas funciones calculan esa
//! diferencia; decidir qué hacer con ella es de quien lleva el bar.

/// Umbral por defecto (en euros) a partir del cual el descuadre exige un motivo escrito.
///
/// 5 € deja pasar el céntimo de redondeo y el error de vuelta sin dar la lata, y obliga a explicar
/// lo que ya es dinero de verdad. Es configurable por negocio; esto es sólo el arranque.
pub const UMBRAL_DESCUADRE_POR_DEFECTO: f64 = 5.0;

/// Una moneda o billete contado: su valor facial y cuántos hay.
#[derive(Debug, Clone, PartialEq)]
pub struct Denominacion {
    pub valor: f64,
    pub unidades: i64,
}

/// Redondeo a céntimos. Todo importe que salga de este módulo pasa por aquí.
///
/// El TPV trabaja el dinero en `f64` (igual que `Importe_Total` o `Total_Comanda`); no se introduce
/// aquí un tipo de dinero nuevo porque sería el único del repo y la inconsistencia costaría más que
/// el rigor que aporta. Lo que sí se hace es redondear en cada frontera, que es lo que evita que el
/// error de coma flotante se acumule y acabe enseñando un descuadre de 0,004 €.
pub fn a_centimos(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Total de un recuento por denominaciones.
///
/// Las unidades negativas se ignoran (no existe "menos tres billetes"), y el resultado se redondea:
/// sumar 0,01 setenta veces en coma flotante no da 0,70 exacto.
pub fn total_recuento(denoms: &[Denominacion]) -> f64 {
    let bruto: f64 = denoms
        .iter()
        .filter(|d| d.unidades > 0 && d.valor > 0.0)
        .map(|d| d.valor * d.unidades as f64)
        .sum();
    a_centimos(bruto)
}

/// El arqueo ya resuelto: lo que la pantalla pinta y lo que se guarda en la fila del cierre.
#[derive(Debug, Clone, PartialEq)]
pub struct CierreCalculado {
    /// Con cuánto empezó el periodo (lo que dejó el cierre anterior).
    pub fondo_inicial: f64,
    /// Cobros en efectivo del periodo.
    pub ventas_efectivo: f64,
    /// Lo que debería haber en el cajón: fondo + ventas en efectivo.
    pub esperado: f64,
    /// Lo que hay de verdad, según el recuento.
    pub contado: f64,
    /// Contado − esperado. Negativo = falta dinero.
    pub descuadre: f64,
    /// Lo que se deja para el periodo siguiente (será su fondo inicial).
    pub dejado: f64,
    /// Contado − dejado: lo que sale del cajón.
    pub retirado: f64,
}

/// Calcula el arqueo a partir del fondo heredado, las ventas y los dos recuentos.
///
/// **De aquí NO se restan los gastos**, y es a propósito: de esta caja no se paga a proveedores ni a
/// nómina. Si alguien saca dinero del cajón para otra cosa, el arqueo lo cantará como que falta, y
/// eso se resuelve diciéndolo en la pantalla, no cambiando la fórmula. La decisión está escrita en
/// `docs/PLAN_CIERRE_CAJA.md`.
pub fn calcular(fondo_inicial: f64, ventas_efectivo: f64, contado: f64, dejado: f64) -> CierreCalculado {
    let fondo_inicial = a_centimos(fondo_inicial);
    let ventas_efectivo = a_centimos(ventas_efectivo);
    let contado = a_centimos(contado);
    let dejado = a_centimos(dejado);

    let esperado = a_centimos(fondo_inicial + ventas_efectivo);

    CierreCalculado {
        fondo_inicial,
        ventas_efectivo,
        esperado,
        contado,
        descuadre: a_centimos(contado - esperado),
        dejado,
        retirado: a_centimos(contado - dejado),
    }
}

/// ¿Hace falta escribir un motivo para este descuadre?
///
/// Se compara el valor **absoluto**: sobrar 40 € es tan raro como que falten, y las dos cosas
/// merecen una explicación. Un umbral de 0 o negativo se lee como "siempre pide motivo".
pub fn exige_motivo(descuadre: f64, umbral: f64) -> bool {
    if umbral <= 0.0 {
        return descuadre.abs() > 0.0;
    }
    descuadre.abs() > umbral
}

/// Valida lo que se va a guardar. Devuelve el motivo ya recortado (o `None` si no hay).
///
/// Dos reglas, y las dos son de negocio:
/// - **No se puede dejar más de lo que hay.** Dejar 200 € habiendo contado 150 no es un cierre
///   posible: sería una retirada negativa, o sea meter dinero que nadie ha contado.
/// - **Un descuadre grande exige motivo.** Si no, el campo de texto no significaría nada el día que
///   sí aparece.
pub fn validar(
    calculo: &CierreCalculado,
    motivo: Option<&str>,
    umbral: f64,
) -> Result<Option<String>, String> {
    if calculo.contado < 0.0 {
        return Err("El recuento no puede ser negativo".into());
    }
    if calculo.dejado < 0.0 {
        return Err("Lo que se deja en el cajón no puede ser negativo".into());
    }
    if calculo.dejado > calculo.contado {
        return Err("No se puede dejar en el cajón más de lo que se ha contado".into());
    }

    let motivo = motivo.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);

    if exige_motivo(calculo.descuadre, umbral) && motivo.is_none() {
        return Err(format!(
            "El descuadre supera {umbral:.2} €: hace falta explicar por qué"
        ));
    }

    Ok(motivo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(valor: f64, unidades: i64) -> Denominacion {
        Denominacion { valor, unidades }
    }

    #[test]
    fn el_recuento_suma_valor_por_unidades() {
        let caja = vec![d(50.0, 2), d(20.0, 3), d(0.5, 4)];
        assert_eq!(total_recuento(&caja), 162.0);
    }

    #[test]
    fn el_recuento_ignora_lo_que_no_existe() {
        // Unidades a cero o negativas y valores no positivos no son dinero: no suman ni restan.
        let caja = vec![d(20.0, 0), d(10.0, -3), d(0.0, 99), d(5.0, 2)];
        assert_eq!(total_recuento(&caja), 10.0);
    }

    #[test]
    fn el_recuento_de_calderilla_no_arrastra_error_de_coma_flotante() {
        // 70 monedas de un céntimo son 0,70 €. En f64 esa suma da 0,7000000000000001 y, sin
        // redondear, el arqueo enseñaria un descuadre que no existe.
        let caja = vec![d(0.01, 70)];
        assert_eq!(total_recuento(&caja), 0.7);
    }

    #[test]
    fn el_esperado_es_el_fondo_mas_las_ventas_en_efectivo() {
        let c = calcular(150.0, 320.45, 470.45, 150.0);
        assert_eq!(c.esperado, 470.45);
        assert_eq!(c.descuadre, 0.0);
        assert_eq!(c.retirado, 320.45);
    }

    #[test]
    fn el_descuadre_es_negativo_cuando_falta_dinero() {
        let c = calcular(100.0, 200.0, 280.0, 100.0);
        assert_eq!(c.esperado, 300.0);
        assert_eq!(c.descuadre, -20.0);
    }

    #[test]
    fn el_descuadre_es_positivo_cuando_sobra() {
        let c = calcular(100.0, 200.0, 305.5, 100.0);
        assert_eq!(c.descuadre, 5.5);
    }

    #[test]
    fn lo_que_se_deja_es_el_fondo_del_periodo_siguiente() {
        // Es la propiedad que encadena los periodos: el `dejado` de hoy es el `fondo_inicial` de
        // mañana, y por eso el retirado sale de la resta y no se declara aparte.
        let hoy = calcular(100.0, 500.0, 600.0, 120.0);
        assert_eq!(hoy.retirado, 480.0);

        let manana = calcular(hoy.dejado, 300.0, 420.0, 100.0);
        assert_eq!(manana.fondo_inicial, 120.0);
        assert_eq!(manana.esperado, 420.0);
        assert_eq!(manana.descuadre, 0.0);
    }

    #[test]
    fn el_umbral_mira_el_valor_absoluto() {
        assert!(!exige_motivo(-4.99, 5.0));
        assert!(!exige_motivo(5.0, 5.0)); // justo en el umbral no salta
        assert!(exige_motivo(-5.01, 5.0));
        assert!(exige_motivo(40.0, 5.0), "sobrar 40 euros es tan raro como que falten");
    }

    #[test]
    fn con_umbral_cero_cualquier_descuadre_pide_motivo() {
        assert!(exige_motivo(0.01, 0.0));
        assert!(!exige_motivo(0.0, 0.0));
    }

    #[test]
    fn un_descuadre_grande_sin_motivo_no_se_guarda() {
        let c = calcular(100.0, 200.0, 250.0, 100.0);
        let err = validar(&c, None, 5.0).unwrap_err();
        assert!(err.contains("descuadre"), "{err}");

        assert_eq!(
            validar(&c, Some("  se pago un pedido en efectivo  "), 5.0).unwrap(),
            Some("se pago un pedido en efectivo".to_string())
        );
    }

    #[test]
    fn un_motivo_en_blanco_no_cuenta_como_motivo() {
        let c = calcular(100.0, 200.0, 250.0, 100.0);
        assert!(validar(&c, Some("   "), 5.0).is_err());
    }

    #[test]
    fn no_se_puede_dejar_mas_de_lo_contado() {
        let c = calcular(100.0, 50.0, 150.0, 200.0);
        let err = validar(&c, None, 5.0).unwrap_err();
        assert!(err.contains("más de lo que se ha contado"), "{err}");
    }

    #[test]
    fn un_cierre_cuadrado_no_necesita_motivo_y_lo_deja_en_none() {
        let c = calcular(150.0, 100.0, 250.0, 150.0);
        assert_eq!(validar(&c, None, 5.0).unwrap(), None);
        assert_eq!(validar(&c, Some(""), 5.0).unwrap(), None);
    }
}
