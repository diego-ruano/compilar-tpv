//! Dominio de **cuentas** (caja): validaciones y value objects.

pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
}

/// Normalización del método de pago: reexporta la única implementación compartida
/// (case-insensitive) para evitar divergencias entre dominios (CUENTA-03).
pub use crate::pago::normalize_metodo;

/// Datos de un gasto (sin id; el id lo gestiona la capa de persistencia / caso de uso).
#[derive(Debug, Clone)]
pub struct GastoData {
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    pub proveedor_id: Option<String>,
}

/// Datos de actualización de un pago.
#[derive(Debug, Clone)]
pub struct PagoData {
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requerido_recorta_y_nombra_el_campo_ausente() {
        assert_eq!(requerido("  concepto  ", "concepto").unwrap(), "concepto");
        assert_eq!(requerido(" \t ", "fecha").unwrap_err(), "fecha required");
    }

    #[test]
    fn metodo_compartido_es_insensible_a_mayusculas() {
        assert_eq!(normalize_metodo(" TARJETA "), "Tarjeta");
        assert_eq!(normalize_metodo("efectivo"), "Efectivo");
        assert_eq!(normalize_metodo("bizum"), "Efectivo");
    }
}
