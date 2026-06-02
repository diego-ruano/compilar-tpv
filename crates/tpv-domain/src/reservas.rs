//! Dominio de **reservas**: normalización de fecha/hora/turno/estado y validación pura.

/// ¿Es una cadena YYYY-MM-DD de 10 chars válida?
fn is_ymd10(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
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
    pub id: Option<i64>,
    pub id_mesa: i64,
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
        id_reserva: Option<i64>,
        dia_ymd: &str,
        hora: &str,
        turno: Option<String>,
        comensales: i64,
        nota: Option<String>,
        estado: Option<String>,
        id_mesa: i64,
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
        if id_mesa <= 0 {
            return Err("ID_Mesa inválido".into());
        }

        let id = id_reserva.filter(|n| *n > 0);
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
