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
    pub id_comanda: String,
    pub metodo: String,
    pub importe_total: f64,
    pub id_usuario_cobrador: Option<String>,
    pub id_trabajador_cobrador: Option<String>,
    /// IDs de detalle a cobrar (no vacíos, ordenados y deduplicados).
    pub detalles: Vec<String>,
    /// FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe
    /// pasa del límite de la simplificada y entonces no hay alternativa (§2.2 del plan).
    ///
    /// `None` = ticket normal (`F2`), que es el caso de casi todo. Si el importe pasa del límite y
    /// esto viene vacío, el cobro se rechaza con `factura_completa_requerida` y la pantalla pide
    /// los datos: no es un fallo, es un dato que falta.
    pub destinatario: Option<crate::verifactu::Destinatario>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metodo_normaliza_tarjeta_y_fallback_efectivo() {
        for valor in ["tarjeta", " TARJETA ", "TaRjEtA"] { assert_eq!(normalize_metodo(valor), "Tarjeta"); }
        for valor in ["", "efectivo", "bizum", "card"] { assert_eq!(normalize_metodo(valor), "Efectivo"); }
    }

    #[test]
    fn opcional_recorta_conserva_interior_y_descarta_vacio() {
        assert_eq!(limpiar_opcional(Some(" sin  cebolla ".into())), Some("sin  cebolla".into()));
        assert_eq!(limpiar_opcional(Some("\t\n".into())), None);
        assert_eq!(limpiar_opcional(None), None);
    }
}
