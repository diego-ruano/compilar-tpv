//! Fechas de calendario que llegan como texto (RI-78).
//!
//! Un único criterio para todo el dominio (reservas, lotes, horarios), con su espejo en el worker
//! (`lib/fechas.ts`) y sus casos en `validacion_casos.json`. Antes cada módulo traía el suyo y no
//! coincidían: lo que uno rechazaba, otro lo guardaba.

use chrono::NaiveDate;

/// La fecha de `s` si es **exactamente** `YYYY-MM-DD` y existe en el calendario.
///
/// La forma se comprueba aparte porque `chrono` admite campos sin relleno (`2026-7-2`), y eso
/// SQLite no lo entiende: `date('2026-7-2')` es `NULL`. Y la fecha se parsea porque la forma sola
/// deja pasar un 31 de febrero, que `date()` convierte en 3 de marzo sin avisar.
pub fn fecha_ymd(s: &str) -> Option<NaiveDate> {
    let b = s.as_bytes();
    let forma_ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit);
    if !forma_ok {
        return None;
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acepta_fechas_reales_en_forma_canonica() {
        for valor in ["2026-07-22", "2024-02-29", "2026-12-31", "2026-01-01"] {
            assert!(fecha_ymd(valor).is_some(), "deberia aceptar {valor}");
        }
    }

    #[test]
    fn rechaza_formas_no_canonicas_y_dias_que_no_existen() {
        for valor in [
            "",
            "2026-7-2",
            "22/07/2026",
            "2026-07-22 ",
            "2026-07-22T10:00",
            "+2026-7-02",
            "2026-13-01",
            "2026-02-30",
            "2026-02-31",
            "2025-02-29",
            "2026-01-0é",
        ] {
            assert!(fecha_ymd(valor).is_none(), "deberia rechazar {valor:?}");
        }
    }
}
