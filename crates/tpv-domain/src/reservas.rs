//! Dominio de **reservas**: normalización de fecha/hora/turno/estado y validación pura.

/// ¿Es una cadena YYYY-MM-DD de 10 chars y **fecha de calendario real**?
///
/// La comprobación de forma (10 chars, guiones en su sitio, todo dígitos con relleno de ceros)
/// descarta formatos no canónicos como `2026-7-2`. Además parseamos con `chrono` para rechazar
/// fechas imposibles (`2026-13-01`, `2026-02-30`), igual que `inventario::fecha_lote_valida`. Sin
/// esto, un mes/día fuera de rango entraba tal cual en la BD y rompía el orden por fecha.
fn is_ymd10(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let forma_ok = b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit());
    forma_ok && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// Normaliza un día a `YYYY-MM-DD` (acepta sufijos tras `T`/espacio).
pub fn normalize_dia_ymd(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.len() >= 10 {
        let candidate = &s[..10];
        if is_ymd10(candidate) {
            return Ok(candidate.to_string());
        }
    }
    if let Some(pos) = s.find('T').or_else(|| s.find(' ')) {
        if pos >= 10 {
            let candidate = &s[..10];
            if is_ymd10(candidate) {
                return Ok(candidate.to_string());
            }
        }
    }
    Err(format!("Formato de día inválido: '{s}'. Esperado YYYY-MM-DD."))
}

/// Normaliza una hora a `HH:MM` validando rangos.
pub fn normalize_hora_hhmm(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.len() >= 5 {
        let hhmm = &s[..5];
        let b = hhmm.as_bytes();
        if b[2] != b':' {
            return Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."));
        }
        if !b[0].is_ascii_digit()
            || !b[1].is_ascii_digit()
            || !b[3].is_ascii_digit()
            || !b[4].is_ascii_digit()
        {
            return Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."));
        }
        let hh: i64 = hhmm[0..2].parse().unwrap_or(-1);
        let mm: i64 = hhmm[3..5].parse().unwrap_or(-1);
        if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) {
            return Err(format!("Hora fuera de rango: '{s}'. Esperado 00:00..23:59."));
        }
        return Ok(hhmm.to_string());
    }
    Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."))
}

/// Normaliza el estado de una reserva (valores conocidos; por defecto PROXIMA).
pub fn normalize_estado(raw: Option<String>) -> String {
    let s = raw.unwrap_or_else(|| "PROXIMA".to_string());
    match s.trim().to_uppercase().as_str() {
        "PROXIMA" => "PROXIMA",
        "ACTIVA" => "ACTIVA",
        "FINALIZADA" => "FINALIZADA",
        "CANCELADA" => "CANCELADA",
        "NO_SHOW" => "NO_SHOW",
        _ => "PROXIMA",
    }
    .to_string()
}

fn turno_por_hora(hhmm: &str) -> String {
    let parts: Vec<&str> = hhmm.trim().split(':').collect();
    let hh: i64 = parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mm: i64 = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mins = hh * 60 + mm;
    if mins < 13 * 60 {
        "DESAYUNO"
    } else if mins < 16 * 60 {
        "COMIDA"
    } else if mins < 19 * 60 {
        "CAFE"
    } else {
        "CENA"
    }
    .to_string()
}

/// Normaliza el turno: usa el valor dado si es válido, si no lo deriva de la hora.
pub fn normalize_turno(raw: Option<String>, hora_hhmm: &str) -> String {
    let maybe = raw.map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
    match maybe.as_deref() {
        Some("DESAYUNO") => "DESAYUNO".to_string(),
        Some("COMIDA") => "COMIDA".to_string(),
        Some("CAFE") => "CAFE".to_string(),
        Some("CENA") => "CENA".to_string(),
        _ => turno_por_hora(hora_hhmm),
    }
}

fn limpia(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Datos de cliente embebidos en una reserva (para el upsert de cliente).
#[derive(Debug, Clone)]
pub struct ClienteReserva {
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Reserva ya normalizada y validada, lista para persistir.
/// `id = Some` => upsert por id (edición); `None` => alta nueva (autoincrement).
#[derive(Debug, Clone)]
pub struct ReservaValidada {
    pub id: Option<String>,
    pub id_mesa: String,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: String,
    pub comensales: i64,
    pub nota: Option<String>,
    pub estado: String,
    pub cliente: ClienteReserva,
}

impl ReservaValidada {
    #[allow(clippy::too_many_arguments)]
    pub fn validar(
        id_reserva: Option<String>,
        dia_ymd: &str,
        hora: &str,
        turno: Option<String>,
        comensales: i64,
        nota: Option<String>,
        estado: Option<String>,
        id_mesa: String,
        nombre_cliente: String,
        telefono: Option<String>,
        email: Option<String>,
        notas_cliente: Option<String>,
    ) -> Result<Self, String> {
        let dia = normalize_dia_ymd(dia_ymd)?;
        let hora = normalize_hora_hhmm(hora)?;

        let nombre = nombre_cliente.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre_cliente required".into());
        }
        if comensales <= 0 {
            return Err("Comensales inválidos".into());
        }
        let id_mesa = id_mesa.trim().to_string();
        if id_mesa.is_empty() {
            return Err("ID_Mesa inválido".into());
        }

        let id = id_reserva.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let estado = if id.is_none() {
            "PROXIMA".to_string()
        } else {
            normalize_estado(estado)
        };
        let turno = normalize_turno(turno, &hora);

        Ok(ReservaValidada {
            id,
            id_mesa,
            dia_ymd: dia,
            hora,
            turno,
            comensales,
            nota: limpia(nota),
            estado,
            cliente: ClienteReserva {
                nombre,
                email: limpia(email),
                telefono: limpia(telefono),
                notas: limpia(notas_cliente),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dia_acepta_iso_y_timestamp() {
        assert_eq!(normalize_dia_ymd(" 2026-07-22 ").unwrap(), "2026-07-22");
        assert_eq!(normalize_dia_ymd("2026-07-22T18:30:00Z").unwrap(), "2026-07-22");
        assert_eq!(normalize_dia_ymd("2026-07-22 18:30:00").unwrap(), "2026-07-22");
    }

    #[test]
    fn dia_rechaza_formato_y_fechas_calendario_imposibles() {
        for valor in ["", "22/07/2026", "2026-7-2", "2026-13-01", "2026-02-30"] {
            assert!(normalize_dia_ymd(valor).is_err(), "deberia rechazar {valor}");
        }
    }

    #[test]
    fn hora_acepta_limites_y_elimina_segundos() {
        assert_eq!(normalize_hora_hhmm("00:00").unwrap(), "00:00");
        assert_eq!(normalize_hora_hhmm("23:59").unwrap(), "23:59");
        assert_eq!(normalize_hora_hhmm(" 14:35:59 ").unwrap(), "14:35");
    }

    #[test]
    fn hora_rechaza_formato_y_rangos_invalidos() {
        for valor in ["", "9:30", "0930", "24:00", "23:60", "aa:bb", "-1:00"] {
            assert!(normalize_hora_hhmm(valor).is_err(), "deberia rechazar {valor}");
        }
    }

    #[test]
    fn estados_conocidos_se_normalizan_y_desconocido_va_a_proxima() {
        for (raw, esperado) in [("proxima", "PROXIMA"), (" ACTIVA ", "ACTIVA"), ("finalizada", "FINALIZADA"), ("cancelada", "CANCELADA"), ("no_show", "NO_SHOW")] {
            assert_eq!(normalize_estado(Some(raw.into())), esperado);
        }
        assert_eq!(normalize_estado(None), "PROXIMA");
        assert_eq!(normalize_estado(Some("otro".into())), "PROXIMA");
    }

    #[test]
    fn turno_se_deriva_en_todos_los_limites_horarios() {
        for (hora, esperado) in [("00:00", "DESAYUNO"), ("12:59", "DESAYUNO"), ("13:00", "COMIDA"), ("15:59", "COMIDA"), ("16:00", "CAFE"), ("18:59", "CAFE"), ("19:00", "CENA"), ("23:59", "CENA")] {
            assert_eq!(normalize_turno(None, hora), esperado);
        }
    }

    #[test]
    fn turno_explicito_valido_prevalece_y_desconocido_se_deriva() {
        assert_eq!(normalize_turno(Some(" cena ".into()), "09:00"), "CENA");
        assert_eq!(normalize_turno(Some("otro".into()), "14:00"), "COMIDA");
    }

    fn reserva_base(id: Option<String>, comensales: i64, mesa: &str, nombre: &str) -> Result<ReservaValidada, String> {
        ReservaValidada::validar(id, "2026-07-22", "14:30", None, comensales, Some(" terraza ".into()), Some("CANCELADA".into()), mesa.into(), nombre.into(), Some(" 600 ".into()), Some(" a@b.es ".into()), Some(" cliente habitual ".into()))
    }

    #[test]
    fn reserva_nueva_normaliza_y_fuerza_estado_proxima() {
        let r = reserva_base(None, 4, " m1 ", " Ana ").unwrap();
        assert!(r.id.is_none());
        assert_eq!(r.id_mesa, "m1");
        assert_eq!(r.turno, "COMIDA");
        assert_eq!(r.estado, "PROXIMA");
        assert_eq!(r.nota.as_deref(), Some("terraza"));
        assert_eq!(r.cliente.nombre, "Ana");
        assert_eq!(r.cliente.telefono.as_deref(), Some("600"));
    }

    #[test]
    fn reserva_editada_conserva_estado_normalizado() {
        let r = reserva_base(Some(" r1 ".into()), 2, "m1", "Ana").unwrap();
        assert_eq!(r.id.as_deref(), Some("r1"));
        assert_eq!(r.estado, "CANCELADA");
    }

    #[test]
    fn reserva_rechaza_comensales_mesa_y_cliente_invalidos() {
        assert!(reserva_base(None, 0, "m1", "Ana").is_err());
        assert!(reserva_base(None, -1, "m1", "Ana").is_err());
        assert!(reserva_base(None, 1, " ", "Ana").is_err());
        assert!(reserva_base(None, 1, "m1", " ").is_err());
    }
}
