//! Dominio de **mesas / salón / comandas / cocina**: validaciones y value objects puros.

/// Texto obligatorio: recorta y exige no vacío.
pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
}

/// Texto opcional normalizado: recorta y descarta vacíos.
pub fn limpiar_opcional(input: Option<String>) -> Option<String> {
    input.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

/// Normalización del método de pago: reexporta la única implementación compartida
/// (case-insensitive) para evitar divergencias entre dominios (CUENTA-03).
pub use crate::pago::normalize_metodo;

/// Normaliza el estado de cocina de una línea: "PREPARADO" o "PENDIENTE".
pub fn normalize_estado_cocina(input: &str) -> String {
    if input.trim().to_uppercase() == "PREPARADO" {
        "PREPARADO".to_string()
    } else {
        "PENDIENTE".to_string()
    }
}

/// Datos para abrir una comanda de mesa (ya validados).
#[derive(Debug, Clone)]
pub struct AbrirComandaData {
    pub id_mesa: String,
    /// Trabajador/usuario que abre (se resuelve a ID_Trabajador en infraestructura).
    pub id_trabajador_o_usuario: Option<String>,
    pub id_reserva: Option<String>,
}

/// Datos de un cobro fraccionado de venta rápida (legacy de mesas).
#[derive(Debug, Clone)]
pub struct CobroVentaRapida {
    pub metodo: String,
    pub items: Vec<(String, f64)>, // (producto_id, precio)
    pub id_usuario_cobrador: Option<String>,
    pub id_trabajador_cobrador: Option<String>,
    pub id_comanda: Option<String>,
}

/// Datos de un cobro de detalles concretos de una comanda de mesa.
#[derive(Debug, Clone)]
pub struct CobroDetalles {
    pub id_comanda: String,
    pub metodo: String,
    pub tipo: String,
    pub detalle_ids: Vec<String>,
    pub id_usuario: Option<String>,
}
