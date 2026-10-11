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

/// Un día `YYYY-MM-DD` a partir de lo que llegue: recorta los espacios y descarta lo que siga a los
/// diez primeros caracteres (una hora). `None` si eso no es una fecha real.
pub fn normalizar_dia(raw: &str) -> Option<String> {
    // RI-40: el texto puede traer UTF-8; un límite por bytes no siempre es un carácter.
    let candidato = raw.trim().get(..10)?;
    fecha_ymd(candidato).map(|_| candidato.to_string())
}

/// La fecha de un instante: `YYYY-MM-DD HH:MM:SS` (la hora local canónica del esquema) o una fecha
/// sola. `None` si no es ninguna de las dos cosas **entero**: mirar sólo los diez primeros
/// caracteres dejaba pasar un `2026-12-31basura`, que se guardaba tal cual y para SQLite es `NULL`.
pub fn fecha_de_instante(s: &str) -> Option<NaiveDate> {
    if let Some(fecha) = fecha_ymd(s) {
        return Some(fecha);
    }
    let (dia, hora) = (s.get(..10)?, s.get(10..)?.as_bytes());
    let dos = |i: usize| -> Option<u8> {
        (hora[i].is_ascii_digit() && hora[i + 1].is_ascii_digit())
            .then(|| (hora[i] - b'0') * 10 + (hora[i + 1] - b'0'))
    };
    if hora.len() != 9 || hora[0] != b' ' || hora[3] != b':' || hora[6] != b':' {
        return None;
    }
    let (hh, mm, ss) = (dos(1)?, dos(4)?, dos(7)?);
    if hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    fecha_ymd(dia)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizar_un_dia_recorta_y_se_queda_con_la_fecha() {
        assert_eq!(normalizar_dia(" 2026-07-22 ").as_deref(), Some("2026-07-22"));
        assert_eq!(normalizar_dia("2026-07-22T18:30:00Z").as_deref(), Some("2026-07-22"));
        for valor in ["", "2026-7-2", "2026-02-31T18:30:00Z", "2026-01-0é", "🦀🦀🦀"] {
            assert_eq!(normalizar_dia(valor), None, "deberia rechazar {valor:?}");
        }
    }

    #[test]
    fn un_instante_es_una_fecha_sola_o_con_su_hora_completa() {
        let dia = fecha_ymd("2026-07-22");
        for valor in ["2026-07-22", "2026-07-22 00:00:00", "2026-07-22 23:59:59"] {
            assert_eq!(fecha_de_instante(valor), dia, "deberia aceptar {valor}");
        }
        for valor in [
            "",
            "fecha mala",
            "2026-07-22basura",
            "2026-07-22 basura",
            "2026-07-22T10:00:00",
            "2026-07-22 10:00",
            "2026-07-22 24:00:00",
            "2026-07-22 10:60:00",
            "2026-07-22 10:00:60",
            "2026-07-22 10:00:00 ",
            "2026-02-31 10:00:00",
            "2026-07-22 1é:00:00",
        ] {
            assert!(fecha_de_instante(valor).is_none(), "deberia rechazar {valor:?}");
        }
    }

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
