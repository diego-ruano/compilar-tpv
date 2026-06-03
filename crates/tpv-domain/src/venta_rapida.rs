//! Dominio de **venta rápida** (barra): validaciones y value objects puros.

/// Normaliza el método de pago: sólo "Tarjeta" o "Efectivo".
pub fn normalize_metodo(input: &str) -> String {
    if input.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    }
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

/// Datos de un cobro fraccionado ya validados/normalizados (sin op_id/outbox).
#[derive(Debug, Clone)]
pub struct CobroFraccionado {
    pub id_comanda: i64,
    pub metodo: String,
    pub importe_total: f64,
    pub id_usuario_cobrador: Option<i64>,
    pub id_trabajador_cobrador: Option<i64>,
    /// IDs de detalle a cobrar (>0, ordenados y deduplicados).
    pub detalles: Vec<i64>,
}
