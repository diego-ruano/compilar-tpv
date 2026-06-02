//! Dominio de **configuración**: reglas puras de los ajustes.

/// Ancho de papel del ticket: sólo 58, 80 o 112 mm (por defecto 80).
pub fn clamp_paper_width_mm(n: i64) -> i64 {
    match n {
        58 | 80 | 112 => n,
        _ => 80,
    }
}
