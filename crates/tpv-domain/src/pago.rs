//! Métodos de pago cerrados y compartidos por todos los caminos de cobro (RI-48).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetodoPago { Efectivo, Tarjeta }
impl MetodoPago {
    pub fn como_texto(self) -> &'static str { match self { Self::Efectivo => "Efectivo", Self::Tarjeta => "Tarjeta" } }
}
impl std::fmt::Display for MetodoPago {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.como_texto()) }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MetodoDevolucion { Efectivo, Tarjeta, Otro }
impl MetodoDevolucion {
    pub fn como_texto(self) -> &'static str { match self { Self::Efectivo => "Efectivo", Self::Tarjeta => "Tarjeta", Self::Otro => "Otro" } }
}
impl std::fmt::Display for MetodoDevolucion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.como_texto()) }
}
pub const METODO_OTRO: &str = "Otro";
pub fn normalize_metodo(input: &str) -> Result<MetodoPago, String> {
    match input.trim().to_ascii_lowercase().as_str() {
        "efectivo" => Ok(MetodoPago::Efectivo), "tarjeta" => Ok(MetodoPago::Tarjeta),
        _ => Err(format!("Método de pago no admitido: '{input}'")),
    }
}
pub fn normalize_metodo_devolucion(input: &str) -> Result<MetodoDevolucion, String> {
    match input.trim().to_ascii_lowercase().as_str() {
        "efectivo" => Ok(MetodoDevolucion::Efectivo), "tarjeta" => Ok(MetodoDevolucion::Tarjeta), "otro" => Ok(MetodoDevolucion::Otro),
        _ => Err(format!("Método de devolución no admitido: '{input}'")),
    }
}
/// El arqueo cuenta sólo dinero identificado expresamente como efectivo, igual que SQL.
pub fn es_efectivo(metodo: &str) -> bool { metodo == "Efectivo" }
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn los_metodos_desconocidos_no_se_convierten_en_efectivo() {
        for v in ["", " ", "bizum", "card", "tarjetas", "Otro"] { assert!(normalize_metodo(v).is_err()); assert!(!es_efectivo(v)); }
        assert_eq!(normalize_metodo(" TARJETA ").unwrap(), MetodoPago::Tarjeta);
        assert_eq!(normalize_metodo(" efectivo ").unwrap(), MetodoPago::Efectivo);
        assert_eq!(normalize_metodo_devolucion(" otro ").unwrap(), MetodoDevolucion::Otro);
        assert!(normalize_metodo_devolucion("bizum").is_err());
    }
}
