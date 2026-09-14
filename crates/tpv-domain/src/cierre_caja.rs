//! Dominio del **cierre de caja** (arqueo). CUENTA-06 · CAJA-01.
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

/// ¿Son dos importes distintos? Se compara en céntimos: dos sumas en coma flotante que dan lo mismo
/// no pueden pedir un motivo por una diferencia de 0,0000001 €.
pub fn centimos_distintos(a: f64, b: f64) -> bool {
    (a * 100.0).round() as i64 != (b * 100.0).round() as i64
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

/// Lo que entró y salió del cajón: la parte del arqueo que sale de los apuntes (CAJA-01).
///
/// Vale igual para un periodo entero que para un solo apunte —lo que ese apunte le aporta al
/// cajón—, y por eso previsualizar un cambio es restar lo que el apunte aportaba y sumar lo que va
/// a aportar.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TotalesCaja {
    pub ventas_efectivo: f64,
    pub gastos_caja: f64,
}

impl TotalesCaja {
    /// Lo que aporta un cobro: su importe a las ventas en efectivo, si sigue activo y no fue con
    /// tarjeta.
    ///
    /// Es **la misma regla** que el SQL que suma un periodo: todo lo que no sea exactamente
    /// `Tarjeta` cuenta como efectivo (CUENTA-03), y un cobro anulado no cuenta (CUENTA-07). Si se
    /// separaran, lo que la pantalla enseña antes de confirmar un cambio y la rectificación que se
    /// guarda al hacerlo dirían cifras distintas.
    pub fn de_cobro(activo: bool, metodo: &str, importe: f64) -> Self {
        let efectivo = activo && metodo != "Tarjeta";
        TotalesCaja {
            ventas_efectivo: if efectivo { a_centimos(importe) } else { 0.0 },
            gastos_caja: 0.0,
        }
    }

    /// Lo que aporta un gasto: sólo si el dinero salió del cajón.
    pub fn de_gasto(pagado_con_caja: bool, importe: f64) -> Self {
        TotalesCaja {
            ventas_efectivo: 0.0,
            gastos_caja: if pagado_con_caja { a_centimos(importe) } else { 0.0 },
        }
    }

    pub fn mas(self, otro: Self) -> Self {
        TotalesCaja {
            ventas_efectivo: a_centimos(self.ventas_efectivo + otro.ventas_efectivo),
            gastos_caja: a_centimos(self.gastos_caja + otro.gastos_caja),
        }
    }

    pub fn menos(self, otro: Self) -> Self {
        TotalesCaja {
            ventas_efectivo: a_centimos(self.ventas_efectivo - otro.ventas_efectivo),
            gastos_caja: a_centimos(self.gastos_caja - otro.gastos_caja),
        }
    }
}

/// El arqueo ya resuelto: lo que la pantalla pinta y lo que se guarda en la fila del cierre.
#[derive(Debug, Clone, PartialEq)]
pub struct CierreCalculado {
    /// Con cuánto empezó el periodo (lo que dejó el cierre anterior).
    pub fondo_inicial: f64,
    /// Cobros en efectivo del periodo.
    pub ventas_efectivo: f64,
    /// Gastos pagados con dinero del cajón durante el periodo (CAJA-01).
    pub gastos_caja: f64,
    /// Lo que debería haber en el cajón: fondo + ventas en efectivo − gastos pagados con caja.
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

/// Calcula el arqueo a partir del fondo heredado, lo que entró y salió del cajón, y los dos
/// recuentos.
///
/// **Sólo restan los gastos pagados con dinero del cajón** (CAJA-01). Una factura pagada por banco
/// no ha tocado el cajón, y restarla haría decir al arqueo que sobra ese dinero. Antes no restaba
/// ninguno —se había decidido que de esta caja no se paga a proveedores— y el hueco era el
/// contrario: pagar el hielo con el dinero del cajón salía como que faltaba.
pub fn calcular(
    fondo_inicial: f64,
    ventas_efectivo: f64,
    gastos_caja: f64,
    contado: f64,
    dejado: f64,
) -> CierreCalculado {
    let fondo_inicial = a_centimos(fondo_inicial);
    let ventas_efectivo = a_centimos(ventas_efectivo);
    let gastos_caja = a_centimos(gastos_caja);
    let contado = a_centimos(contado);
    let dejado = a_centimos(dejado);

    let esperado = a_centimos(fondo_inicial + ventas_efectivo - gastos_caja);

    CierreCalculado {
        fondo_inicial,
        ventas_efectivo,
        gastos_caja,
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

/// La fecha de un apunte de caja en la forma con la que se compara contra un cierre (CAJA-01).
///
/// Las fechas se comparan en SQLite con `datetime()`, que sólo entiende unas pocas formas. La fecha
/// que llega al editar un cobro la teclea una persona, y lo que no está en esa lista —un
/// `10/05/2026 21:30`— no es una fecha para SQLite: `datetime()` devuelve `NULL` y ese cobro deja de
/// contar en el esperado de **cualquier** periodo. Por eso se valida antes de guardarla.
///
/// Devuelve `YYYY-MM-DD` si sólo hay día, y `YYYY-MM-DD HH:MM:SS` si hay hora (con o sin segundos,
/// separada por espacio o por `T`). Todo lo demás es `None`, también una fecha que no existe, como el
/// 30 de febrero. La forma se comprueba carácter a carácter antes de parsear porque `chrono` es más
/// tolerante que SQLite (acepta, por ejemplo, un mes de una cifra).
pub fn fecha_de_apunte(texto: &str) -> Option<String> {
    let t = texto.trim().replacen('T', " ", 1);

    if tiene_forma(&t, "9999-99-99") {
        return chrono::NaiveDate::parse_from_str(&t, "%Y-%m-%d")
            .ok()
            .map(|d| d.format("%Y-%m-%d").to_string());
    }

    let formato = if tiene_forma(&t, "9999-99-99 99:99:99") {
        "%Y-%m-%d %H:%M:%S"
    } else if tiene_forma(&t, "9999-99-99 99:99") {
        "%Y-%m-%d %H:%M"
    } else {
        return None;
    };
    chrono::NaiveDateTime::parse_from_str(&t, formato)
        .ok()
        .map(|f| f.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// `patron` usa `9` para «un dígito» y cualquier otro carácter para sí mismo.
fn tiene_forma(texto: &str, patron: &str) -> bool {
    texto.len() == patron.len()
        && texto
            .bytes()
            .zip(patron.bytes())
            .all(|(c, p)| if p == b'9' { c.is_ascii_digit() } else { c == p })
}

/// La hora a la que se da por hecho un gasto al decidir en qué cierre cae (CAJA-01).
///
/// Un gasto sólo guarda el día y un cierre es un instante, así que hace falta una hora. El mediodía
/// es la que acierta en los dos horarios normales de un bar: si se cierra a las 23:00, el gasto de
/// esa tarde cae en el cierre de esa noche; si se cierra a la 01:30 del día siguiente, también — y no
/// en el de la madrugada anterior, que es donde caería tomando las 00:00. Lo que no puede acertar es
/// un bar con dos cierres el mismo día: con sólo la fecha, el gasto va al primero.
///
/// La usan el SQL que suma los gastos de un periodo y el que busca a qué cierre pertenece un gasto.
/// Si cada uno eligiera su hora, un gasto podría contar en un cierre y rectificar otro.
pub const HORA_DE_UN_GASTO: &str = "12:00:00";

/// El instante con el que un gasto se compara contra los cierres. `None` si la fecha no es válida.
pub fn momento_de_gasto(fecha: &str) -> Option<String> {
    let f = fecha_de_apunte(fecha)?;
    Some(format!("{} {HORA_DE_UN_GASTO}", f.get(..10)?))
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
        let c = calcular(150.0, 320.45, 0.0, 470.45, 150.0);
        assert_eq!(c.esperado, 470.45);
        assert_eq!(c.descuadre, 0.0);
        assert_eq!(c.retirado, 320.45);
    }

    #[test]
    fn los_gastos_pagados_con_caja_restan_del_esperado() {
        // CAJA-01: 18 € de hielo pagados con el dinero del cajón. Si no restaran, el recuento
        // cuadrado saldría como que faltan 18 €.
        let c = calcular(150.0, 320.45, 18.0, 452.45, 150.0);
        assert_eq!(c.gastos_caja, 18.0);
        assert_eq!(c.esperado, 452.45);
        assert_eq!(c.descuadre, 0.0);
    }

    #[test]
    fn el_descuadre_es_negativo_cuando_falta_dinero() {
        let c = calcular(100.0, 200.0, 0.0, 280.0, 100.0);
        assert_eq!(c.esperado, 300.0);
        assert_eq!(c.descuadre, -20.0);
    }

    #[test]
    fn el_descuadre_es_positivo_cuando_sobra() {
        let c = calcular(100.0, 200.0, 0.0, 305.5, 100.0);
        assert_eq!(c.descuadre, 5.5);
    }

    #[test]
    fn lo_que_se_deja_es_el_fondo_del_periodo_siguiente() {
        // Es la propiedad que encadena los periodos: el `dejado` de hoy es el `fondo_inicial` de
        // mañana, y por eso el retirado sale de la resta y no se declara aparte.
        let hoy = calcular(100.0, 500.0, 0.0, 600.0, 120.0);
        assert_eq!(hoy.retirado, 480.0);

        let manana = calcular(hoy.dejado, 300.0, 0.0, 420.0, 100.0);
        assert_eq!(manana.fondo_inicial, 120.0);
        assert_eq!(manana.esperado, 420.0);
        assert_eq!(manana.descuadre, 0.0);
    }

    #[test]
    fn rectificar_un_cierre_no_mueve_el_fondo_del_siguiente() {
        // CAJA-01. Lo que encadena los periodos es lo DEJADO, que es dinero contado a mano. Si
        // mañana se descubre que un cobro de hoy fue con tarjeta, cambia lo que hoy debería haber
        // habido, no lo que se contó ni lo que se dejó.
        let foto = calcular(100.0, 500.0, 0.0, 600.0, 120.0);
        let rectificado = calcular(foto.fondo_inicial, 480.0, 0.0, foto.contado, foto.dejado);
        assert_eq!(rectificado.descuadre, 20.0);
        assert_eq!(rectificado.dejado, foto.dejado);
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
        let c = calcular(100.0, 200.0, 0.0, 250.0, 100.0);
        let err = validar(&c, None, 5.0).unwrap_err();
        assert!(err.contains("descuadre"), "{err}");

        assert_eq!(
            validar(&c, Some("  se pago un pedido en efectivo  "), 5.0).unwrap(),
            Some("se pago un pedido en efectivo".to_string())
        );
    }

    #[test]
    fn un_motivo_en_blanco_no_cuenta_como_motivo() {
        let c = calcular(100.0, 200.0, 0.0, 250.0, 100.0);
        assert!(validar(&c, Some("   "), 5.0).is_err());
    }

    #[test]
    fn no_se_puede_dejar_mas_de_lo_contado() {
        let c = calcular(100.0, 50.0, 0.0, 150.0, 200.0);
        let err = validar(&c, None, 5.0).unwrap_err();
        assert!(err.contains("más de lo que se ha contado"), "{err}");
    }

    #[test]
    fn un_cierre_cuadrado_no_necesita_motivo_y_lo_deja_en_none() {
        let c = calcular(150.0, 100.0, 0.0, 250.0, 150.0);
        assert_eq!(validar(&c, None, 5.0).unwrap(), None);
        assert_eq!(validar(&c, Some(""), 5.0).unwrap(), None);
    }

    #[test]
    fn un_cobro_aporta_lo_mismo_que_cuenta_el_sql_del_periodo() {
        assert_eq!(TotalesCaja::de_cobro(true, "Efectivo", 12.5).ventas_efectivo, 12.5);
        assert_eq!(TotalesCaja::de_cobro(true, "Tarjeta", 12.5).ventas_efectivo, 0.0);
        assert_eq!(
            TotalesCaja::de_cobro(false, "Efectivo", 12.5).ventas_efectivo,
            0.0,
            "un cobro anulado no es una venta"
        );
        // Como el SQL: sólo `Tarjeta` exacto va al banco; cualquier otra cosa entra en el cajón,
        // que es el lado seguro (saldría como descuadre en vez de desaparecer).
        assert_eq!(TotalesCaja::de_cobro(true, "Bizum", 12.5).ventas_efectivo, 12.5);
    }

    #[test]
    fn un_gasto_solo_aporta_si_salio_del_cajon() {
        assert_eq!(TotalesCaja::de_gasto(true, 18.0).gastos_caja, 18.0);
        assert_eq!(TotalesCaja::de_gasto(false, 400.0).gastos_caja, 0.0);
    }

    #[test]
    fn quitar_y_poner_un_apunte_no_arrastra_error_de_coma_flotante() {
        let periodo = TotalesCaja { ventas_efectivo: 0.3, gastos_caja: 0.0 };
        let cobro = TotalesCaja::de_cobro(true, "Efectivo", 0.1);
        let sin = periodo.menos(cobro);
        assert_eq!(sin.ventas_efectivo, 0.2);
        assert_eq!(sin.mas(cobro), periodo);
    }

    #[test]
    fn los_importes_se_comparan_en_centimos() {
        assert!(!centimos_distintos(0.1 + 0.2, 0.3));
        assert!(centimos_distintos(20.0, 20.01));
    }

    #[test]
    fn la_fecha_de_un_apunte_toma_la_forma_que_entiende_sqlite() {
        // Todas las maneras razonables de escribir el mismo instante acaban en el mismo texto.
        assert_eq!(fecha_de_apunte("2026-05-10").as_deref(), Some("2026-05-10"));
        assert_eq!(fecha_de_apunte("2026-05-10 21:30").as_deref(), Some("2026-05-10 21:30:00"));
        assert_eq!(fecha_de_apunte("2026-05-10T21:30").as_deref(), Some("2026-05-10 21:30:00"));
        assert_eq!(
            fecha_de_apunte("  2026-05-10 21:30:15 ").as_deref(),
            Some("2026-05-10 21:30:15")
        );
    }

    #[test]
    fn lo_que_no_es_una_fecha_que_sqlite_sepa_leer_no_tiene_forma() {
        // Las de formato ajeno llegaban a guardarse y salían de cualquier periodo: `datetime()` de
        // SQLite devuelve NULL con ellas.
        for mala in [
            "",
            "ayer",
            "10/05/2026 21:30",
            "2026-5-10",
            "26-05-10",
            "2026-02-30",
            "2026-05-10 24:00",
            "2026-05-10 21:30:00.5",
        ] {
            assert_eq!(fecha_de_apunte(mala), None, "{mala:?}");
        }
    }

    #[test]
    fn un_gasto_cuenta_como_hecho_a_mediodia() {
        assert_eq!(momento_de_gasto("2026-05-10").as_deref(), Some("2026-05-10 12:00:00"));
        // Si llega con hora, la hora se ignora: al guardarse, `date()` la tira igual.
        assert_eq!(
            momento_de_gasto("2026-05-10 23:30").as_deref(),
            Some("2026-05-10 12:00:00")
        );
        assert_eq!(momento_de_gasto("10/05/2026"), None);
    }
}
