//! Dominio de **configuración**: reglas puras de los ajustes.

/// Ancho de papel del ticket: sólo 58, 80 o 112 mm (por defecto 80).
pub fn clamp_paper_width_mm(n: i64) -> i64 {
    match n {
        58 | 80 | 112 => n,
        _ => 80,
    }
}

/// Valida el porcentaje de IVA: debe ser finito y estar en el rango [0, 100].
/// Un IVA inválido afectaría al cálculo de **todos** los tickets y precios.
pub fn validate_iva_percent(iva: f64) -> Result<(), String> {
    if iva.is_finite() && (0.0..=100.0).contains(&iva) {
        Ok(())
    } else {
        Err(format!("IVA inválido: {iva} (debe ser un número entre 0 y 100)"))
    }
}

/* ── Parámetros de impresión del ticket (columnas del esquema Ticket_Settings) ── */

/// DPI de la impresora térmica: sólo 203 o 300 (por defecto 203). Espeja el `CHECK` del esquema.
pub fn clamp_paper_dpi(n: i64) -> i64 {
    match n {
        203 | 300 => n,
        _ => 203,
    }
}

/// Caracteres por línea (fuente A): 20–80 (por defecto 42). Espeja el `CHECK` del esquema.
pub fn clamp_chars_per_line(n: i64) -> i64 {
    n.clamp(20, 80)
}

/// Escala de fuente: 0.5–2.0 (por defecto 1.0). Espeja el `CHECK` del esquema.
pub fn clamp_font_scale(n: f64) -> f64 {
    if !n.is_finite() {
        1.0
    } else {
        n.clamp(0.5, 2.0)
    }
}

/// Margen del ticket en mm: no negativo y acotado a un máximo razonable (25 mm).
pub fn clamp_margin_mm(n: f64) -> f64 {
    if !n.is_finite() {
        0.0
    } else {
        n.clamp(0.0, 25.0)
    }
}
