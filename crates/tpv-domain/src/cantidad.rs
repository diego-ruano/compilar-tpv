//! Cantidades de stock (RI-26).
//!
//! Son `REAL` a propósito: se vende medio kilo ([decisión 0005]). Pero un `f64` no representa 0,1, y
//! los residuos se acumulan: un kilo vendido en diez raciones de 0,1 deja `1,39e-16` en el lote. Ese
//! lote seguía «con existencias» para el FEFO, que apuntaba un consumo de esa cantidad, y un residuo
//! negativo (`-2,8e-17`) lo sacaba como stock negativo.
//!
//! Por eso cada cantidad que se escribe se redondea a **milésimas** (un gramo, un mililitro): en Rust
//! con [`redondear_cantidad`] y en SQL con `ROUND(…, 3)` ([`DECIMALES_CANTIDAD`]). El worker hace lo
//! mismo (`lib/cantidad.ts`), y la tabla `cantidad_casos.json` los mantiene iguales.
//!
//! [decisión 0005]: ../../../docs/decisiones/0005-dinero-en-centimos.md

/// Decimales con los que se guarda una cantidad de stock. Es el `3` de los `ROUND(…, 3)` del SQL.
pub const DECIMALES_CANTIDAD: i32 = 3;

/// Redondea una cantidad a milésimas, con la mitad lejos del cero. El cero negativo sale como cero.
pub fn redondear_cantidad(x: f64) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    let r = (x * 1000.0).round() / 1000.0;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redondear_cuadra_con_la_tabla_compartida() {
        let casos: serde_json::Value =
            serde_json::from_str(include_str!("cantidad_casos.json")).expect("cantidad_casos.json no es JSON válido");
        let lista = casos["redondear"].as_array().expect("falta «redondear»");
        assert!(!lista.is_empty());
        for caso in lista {
            let (x, esperado) = (caso[0].as_f64().unwrap(), caso[1].as_f64().unwrap());
            let r = redondear_cantidad(x);
            assert_eq!(r, esperado, "redondear_cantidad({x})");
            assert!(!(r == 0.0 && r.is_sign_negative()), "redondear_cantidad({x}) dio -0");
        }
    }

    #[test]
    fn diez_raciones_de_un_decimo_agotan_el_kilo() {
        let mut stock = 1.0;
        for _ in 0..10 {
            stock = redondear_cantidad(stock - 0.1);
        }
        assert_eq!(stock, 0.0);
    }
}
