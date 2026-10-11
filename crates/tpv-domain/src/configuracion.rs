//! Dominio de **configuración**: reglas puras de los ajustes.

/// Ancho de papel del ticket: sólo 58, 80 o 112 mm (por defecto 80).
pub fn clamp_paper_width_mm(n: i64) -> i64 {
    match n {
        58 | 80 | 112 => n,
        _ => 80,
    }
}

/// Mismo texto en el worker (`lib/iva.ts`) y en la webview (`shared/lib/iva.ts`).
pub const MSG_IVA: &str = "El IVA tiene que ser un número entre 0 y 100";

/// Valida un tipo de IVA —el del negocio o el propio de un producto—: finito y en [0, 100].
/// Un IVA inválido afectaría al cálculo de **todos** los tickets y precios.
///
/// RI-78: el mismo rango en la Main, en el worker y en la webview (antes eran 0–100, 0–30 y un
/// recorte silencioso a 0–30), con sus casos en `validacion_casos.json`. Fuera de rango se
/// **rechaza**: un tipo impositivo distinto del que se tecleó no lo ha decidido nadie.
pub fn validate_iva_percent(iva: f64) -> Result<(), String> {
    if iva.is_finite() && (0.0..=100.0).contains(&iva) {
        Ok(())
    } else {
        Err(MSG_IVA.into())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ancho_y_dpi_solo_admiten_valores_soportados() {
        for width in [58, 80, 112] { assert_eq!(clamp_paper_width_mm(width), width); }
        for width in [-1, 0, 57, 81, 999] { assert_eq!(clamp_paper_width_mm(width), 80); }
        assert_eq!(clamp_paper_dpi(203), 203);
        assert_eq!(clamp_paper_dpi(300), 300);
        assert_eq!(clamp_paper_dpi(600), 203);
    }

    #[test]
    fn iva_admite_limites_y_rechaza_no_finitos_o_fuera_de_rango() {
        for iva in [0.0, 4.0, 10.0, 21.0, 100.0] { assert!(validate_iva_percent(iva).is_ok()); }
        for iva in [-0.01, 100.01, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] { assert!(validate_iva_percent(iva).is_err()); }
    }

    #[test]
    fn caracteres_escala_y_margen_se_acotan() {
        assert_eq!(clamp_chars_per_line(-1), 20);
        assert_eq!(clamp_chars_per_line(42), 42);
        assert_eq!(clamp_chars_per_line(100), 80);
        assert_eq!(clamp_font_scale(0.1), 0.5);
        assert_eq!(clamp_font_scale(1.25), 1.25);
        assert_eq!(clamp_font_scale(9.0), 2.0);
        assert_eq!(clamp_font_scale(f64::NAN), 1.0);
        assert_eq!(clamp_margin_mm(-1.0), 0.0);
        assert_eq!(clamp_margin_mm(12.5), 12.5);
        assert_eq!(clamp_margin_mm(100.0), 25.0);
        assert_eq!(clamp_margin_mm(f64::INFINITY), 0.0);
    }
}
