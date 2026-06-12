//! Dominio de **cuentas** (caja): validaciones y value objects.

pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
}

/// Normaliza el método de pago: sólo "Tarjeta" o "Efectivo".
pub fn normalize_metodo(input: &str) -> String {
    if input.trim() == "Tarjeta" {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    }
}

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
