//! Dominio de **pago**: normalización compartida del método de pago.
//!
//! Única fuente de verdad para clasificar `Metodo_Pago`. Antes existían dos implementaciones
//! divergentes (`cuentas` case-sensitive vs `mesas` case-insensitive), lo que clasificaba de
//! forma incoherente un mismo valor (`"tarjeta"`) según la ruta (CUENTA-03). Ambos módulos
//! reexportan esta función.

/// Normaliza el método de pago a exactamente `"Tarjeta"` o `"Efectivo"` (case-insensitive).
pub fn normalize_metodo(input: &str) -> String {
    if input.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    }
}

/// El tercer método, que sólo existe para devolver: una transferencia, un Bizum. Es dinero que no
/// sale del cajón ni pasa por el datáfono.
pub const METODO_OTRO: &str = "Otro";

/// Normaliza el método por el que se devuelve el dinero de una devolución: los dos de un cobro y
/// [`METODO_OTRO`].
pub fn normalize_metodo_devolucion(input: &str) -> String {
    if input.trim().eq_ignore_ascii_case(METODO_OTRO) {
        METODO_OTRO.to_string()
    } else {
        normalize_metodo(input)
    }
}

/// ¿Ese dinero pasa por el cajón? Todo lo que no sea tarjeta ni «Otro»: un método desconocido
/// cuenta como efectivo (CUENTA-03). Es la regla del arqueo, y en SQL se escribe
/// `COALESCE(Metodo_Pago,'') NOT IN ('Tarjeta','Otro')`.
pub fn es_efectivo(metodo: &str) -> bool {
    metodo != "Tarjeta" && metodo != METODO_OTRO
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tarjeta_se_normaliza_sin_importar_caso_o_espacios() {
        for valor in ["tarjeta", "Tarjeta", "TARJETA", "  TaRjEtA  "] { assert_eq!(normalize_metodo(valor), "Tarjeta"); }
    }

    #[test]
    fn cualquier_otro_valor_es_efectivo() {
        for valor in ["", " ", "efectivo", "bizum", "card", "tarjetas"] { assert_eq!(normalize_metodo(valor), "Efectivo"); }
    }

    #[test]
    fn una_devolucion_admite_ademas_otro() {
        assert_eq!(normalize_metodo_devolucion(" otro "), "Otro");
        assert_eq!(normalize_metodo_devolucion("TARJETA"), "Tarjeta");
        assert_eq!(normalize_metodo_devolucion("bizum"), "Efectivo");
        // Un cobro no: «Otro» sólo existe para devolver.
        assert_eq!(normalize_metodo("Otro"), "Efectivo");
    }

    #[test]
    fn solo_tarjeta_y_otro_no_pasan_por_el_cajon() {
        assert!(es_efectivo("Efectivo"));
        assert!(es_efectivo(""));
        assert!(!es_efectivo("Tarjeta"));
        assert!(!es_efectivo("Otro"));
    }
}
