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
