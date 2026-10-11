//! Dominio de **reservas**: normalización de fecha/hora/turno/estado y validación pura.

/// Normaliza un día a `YYYY-MM-DD` (acepta sufijos tras `T`/espacio). Los diez primeros caracteres
/// tienen que ser una fecha real (`fechas::fecha_ymd`): un mes o un día fuera de rango entraba tal
/// cual en la BD y rompía el orden por fecha.
pub fn normalize_dia_ymd(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    // RI-40: el formulario puede contener UTF-8; un límite por bytes no siempre es un carácter.
    if let Some(candidate) = s.get(..10) {
        if crate::fechas::fecha_ymd(candidate).is_some() {
            return Ok(candidate.to_string());
        }
    }
    Err(format!("Formato de día inválido: '{s}'. Esperado YYYY-MM-DD."))
}

/// Normaliza una hora a `HH:MM` validando rangos.
pub fn normalize_hora_hhmm(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if let Some(hhmm) = s.get(..5) {
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
pub fn normalize_estado(raw: Option<String>) -> Result<crate::estados::EstadoReserva, String> {
    crate::estados::EstadoReserva::desde_texto(raw.as_deref().unwrap_or("PROXIMA"))
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

use crate::texto::limpiar_opcional as limpia;

/// Igual que `limpia` pero **pasando a minúsculas**: el email identifica al cliente y la unicidad
/// es case-insensitive (índice `ux_clientes_email` sobre `lower(Email)`, y el dominio de clientes
/// normaliza igual). Sin esto, reservar con `Juan@Mail.com` no encontraba al cliente guardado como
/// `juan@mail.com` y el alta chocaba contra ese índice.
///
/// Nota: aquí NO se valida el formato del email (a diferencia de `tpv_domain::clientes`). Una
/// reserva se toma a menudo por teléfono y con datos incompletos; rechazarla por un email mal
/// escrito sería peor que aceptarlo.
fn limpia_email(o: Option<String>) -> Option<String> {
    o.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty())
}

/// El cliente de una reserva (RI-61).
///
/// Una reserva **puede no tener cliente**: no se obliga al negocio a dar de alta a nadie para
/// apuntar una mesa. Y aquí ya no se casa nada por detrás: antes, un teléfono o un email que ya
/// eran de otro cliente le asignaban la reserva sin decir nada (Luis reservaba con el teléfono de
/// Ana y el calendario decía «Ana»). Ahora la pantalla pregunta antes (`buscar_cliente`) y lo que
/// llega aquí es la respuesta: asignarla a ese cliente, crear uno nuevo o dejarla sin cliente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClienteReserva {
    /// Sin ficha de cliente.
    Ninguno,
    /// Un cliente que ya existe. Lo escrito sólo rellena sus huecos (RES-01): no lo renombra ni
    /// le cambia un dato que ya tenga.
    ///
    /// RI-84: ninguna de las dos variantes lleva notas. La nota de la reserva es de esa noche
    /// («cumpleaños, trae tarta») y antes se copiaba también a la ficha, donde se quedaba para
    /// siempre. Las notas del cliente se escriben sólo desde su ficha.
    Existente {
        id: String,
        telefono: Option<String>,
        email: Option<String>,
    },
    /// Una ficha nueva, aunque haya otra con el mismo teléfono (dos personas pueden compartirlo).
    /// El email sí identifica: si ya es de otro cliente, el repositorio lo rechaza.
    Nuevo {
        nombre: String,
        telefono: Option<String>,
        email: Option<String>,
    },
}

/// Mismo texto en el worker (`reservas.schemas.ts`).
pub const MSG_CLIENTE_SIN_NOMBRE: &str = "Para dar de alta al cliente hace falta su nombre. Si no \
     quieres ficha de cliente, deja vacíos el teléfono y el email.";

impl ClienteReserva {
    /// Decide el cliente a partir de lo que trae la pantalla: un `id_cliente` es asignar uno que ya
    /// existe; un nombre sin id, crear uno; y nada, ninguno. Un teléfono o un email sin nombre no
    /// bastan para dar de alta a nadie, y tirarlos en silencio sería peor que decirlo.
    pub fn desde(
        id_cliente: Option<String>,
        nombre: Option<String>,
        telefono: Option<String>,
        email: Option<String>,
    ) -> Result<Self, String> {
        let telefono = limpia(telefono);
        let email = limpia_email(email);
        if let Some(id) = limpia(id_cliente) {
            return Ok(ClienteReserva::Existente { id, telefono, email });
        }
        if let Some(nombre) = limpia(nombre) {
            return Ok(ClienteReserva::Nuevo { nombre, telefono, email });
        }
        if telefono.is_some() || email.is_some() {
            return Err(MSG_CLIENTE_SIN_NOMBRE.into());
        }
        Ok(ClienteReserva::Ninguno)
    }
}

/// RI-61: lo que dura una reserva que no elige su duración, si el negocio no lo ha cambiado
/// (`Business_Settings.Reserva_Duracion_Min`, el mismo valor por defecto).
pub const DURACION_POR_DEFECTO_MIN: i64 = 120;

/// Lo más que puede durar una reserva: un día entero. Más es una errata (horas por minutos).
pub const DURACION_MAXIMA_MIN: i64 = 24 * 60;

/// La duración propia de una reserva, en minutos: `None` es «la del negocio».
pub fn duracion_valida(minutos: Option<i64>) -> Result<Option<i64>, String> {
    match minutos {
        None => Ok(None),
        Some(m) if (1..=DURACION_MAXIMA_MIN).contains(&m) => Ok(Some(m)),
        Some(_) => Err("La duración de la reserva tiene que estar entre 1 minuto y 24 horas".into()),
    }
}

/// RI-61: qué pasa cuando una reserva se pisa con otra de la misma mesa (o con una comanda abierta
/// en ella). Lo elige cada negocio en Configuración; por defecto, avisar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModoSolape {
    /// Se avisa, y se guarda si quien reserva lo confirma.
    Avisar,
    /// No se guarda.
    Prohibir,
}

impl ModoSolape {
    /// Lo guardado en `Business_Settings.Reserva_Solape`. Cualquier otra cosa es avisar: es lo que
    /// no le quita nada a nadie.
    pub fn desde(s: &str) -> Self {
        if s.trim().eq_ignore_ascii_case("prohibir") {
            ModoSolape::Prohibir
        } else {
            ModoSolape::Avisar
        }
    }

    pub fn como_texto(self) -> &'static str {
        match self {
            ModoSolape::Avisar => "avisar",
            ModoSolape::Prohibir => "prohibir",
        }
    }
}

/// Reserva ya normalizada y validada, lista para persistir.
/// `id = Some` => upsert por id; `None` => alta nueva, con UUIDv7 generado por la
/// persistencia antes del INSERT. El dominio sólo valida y normaliza el identificador.
#[derive(Debug, Clone)]
pub struct ReservaValidada {
    pub id: Option<String>,
    pub id_mesa: Option<String>,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: String,
    pub comensales: i64,
    /// Minutos que ocupa la mesa; `None` = la duración por defecto del negocio (RI-61).
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub estado: crate::estados::EstadoReserva,
    pub cliente: ClienteReserva,
}

/// Datos crudos con campos nombrados (RI-48); validar produce el objeto de dominio.
#[derive(Debug, Clone)]
pub struct ReservaEntrada<'a> {
    pub id_reserva: Option<String>,
    pub dia_ymd: &'a str,
    pub hora: &'a str,
    pub turno: Option<String>,
    pub comensales: i64,
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub estado: Option<String>,
    pub id_mesa: Option<String>,
    pub id_cliente: Option<String>,
    pub nombre_cliente: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
}

impl ReservaValidada {
    pub fn validar(input: ReservaEntrada<'_>) -> Result<Self, String> {
        let ReservaEntrada {
            id_reserva,
            dia_ymd,
            hora,
            turno,
            comensales,
            duracion_min,
            nota,
            estado,
            id_mesa,
            id_cliente,
            nombre_cliente,
            telefono,
            email,
        } = input;
        let dia = normalize_dia_ymd(dia_ymd)?;
        let hora = normalize_hora_hhmm(hora)?;

        let cliente =
            ClienteReserva::desde(id_cliente, nombre_cliente, telefono, email)?;
        if comensales <= 0 {
            return Err("Comensales inválidos".into());
        }
        let duracion_min = duracion_valida(duracion_min)?;
        // Sin mesa es un estado válido: la reserva existe y ya se le asignará una.
        let id_mesa = limpia(id_mesa);

        let id = id_reserva.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let estado = if id.is_none() {
            crate::estados::EstadoReserva::Proxima
        } else {
            normalize_estado(estado)?
        };
        let turno = normalize_turno(turno, &hora);

        Ok(ReservaValidada {
            id,
            id_mesa,
            dia_ymd: dia,
            hora,
            turno,
            comensales,
            duracion_min,
            nota: limpia(nota),
            estado,
            cliente,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texto_unicode_invalido_devuelve_error_sin_panico() {
        for dia in ["2026-01-0é", "2026-01-€T12:00", "🦀🦀🦀"] {
            assert!(normalize_dia_ymd(dia).is_err());
        }
        for hora in ["12:0é", "12:€", "🦀🦀"] {
            assert!(normalize_hora_hhmm(hora).is_err());
        }
    }

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
    fn estados_conocidos_se_normalizan_y_desconocidos_se_rechazan() {
        for (raw, esperado) in [("proxima", "PROXIMA"), (" ACTIVA ", "ACTIVA"), ("finalizada", "FINALIZADA"), ("cancelada", "CANCELADA"), ("no_show", "NO_SHOW")] {
            assert_eq!(normalize_estado(Some(raw.into())).unwrap().como_texto(), esperado);
        }
        assert_eq!(normalize_estado(None).unwrap().como_texto(), "PROXIMA");
        assert!(normalize_estado(Some("otro".into())).is_err());
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

    fn reserva_base(id: Option<String>, comensales: i64, mesa: Option<&str>, nombre: &str) -> Result<ReservaValidada, String> {
        ReservaValidada::validar(crate::reservas::ReservaEntrada {
            id_reserva: id,
            dia_ymd: "2026-07-22",
            hora: "14:30",
            turno: None,
            comensales,
            duracion_min: None,
            nota: Some(" terraza ".into()),
            estado: Some("CANCELADA".into()),
            id_mesa: mesa.map(str::to_string),
            id_cliente: None,
            nombre_cliente: Some(nombre.into()),
            telefono: Some(" 600 ".into()),
            email: Some(" a@b.es ".into()),
        })
    }

    fn email_de(r: &ReservaValidada) -> Option<String> {
        match &r.cliente {
            ClienteReserva::Nuevo { email, .. } | ClienteReserva::Existente { email, .. } => {
                email.clone()
            }
            ClienteReserva::Ninguno => None,
        }
    }

    /// El email del cliente identifica de forma única (índice `ux_clientes_email` sobre
    /// `lower(Email)`), así que tiene que llegar en minúsculas: si no, reservar con `Juan@Mail.com`
    /// no encuentra al cliente guardado como `juan@mail.com` y el alta choca contra el índice.
    #[test]
    fn email_del_cliente_se_normaliza_a_minusculas() {
        let r = ReservaValidada::validar(crate::reservas::ReservaEntrada {
            id_reserva: None,
            dia_ymd: "2026-07-22",
            hora: "14:30",
            turno: None,
            comensales: 2,
            duracion_min: None,
            nota: None,
            estado: None,
            id_mesa: Some("m1".into()),
            id_cliente: None,
            nombre_cliente: Some("Ana".into()),
            telefono: None,
            email: Some("  Juan@Mail.COM  ".into()),
        })
        .unwrap();
        assert_eq!(email_de(&r).as_deref(), Some("juan@mail.com"));
    }

    #[test]
    fn email_vacio_o_ausente_queda_en_none() {
        for valor in [None, Some("".to_string()), Some("   ".to_string())] {
            let r = ReservaValidada::validar(crate::reservas::ReservaEntrada {
                id_reserva: None,
                dia_ymd: "2026-07-22",
                hora: "14:30",
                turno: None,
                comensales: 2,
                duracion_min: None,
                nota: None,
                estado: None,
                id_mesa: Some("m1".into()),
                id_cliente: None,
                nombre_cliente: Some("Ana".into()),
                telefono: None,
                email: valor,
            })
            .unwrap();
            assert_eq!(email_de(&r), None);
        }
    }

    #[test]
    fn reserva_nueva_normaliza_y_fuerza_estado_proxima() {
        let r = reserva_base(None, 4, Some(" m1 "), " Ana ").unwrap();
        assert!(r.id.is_none());
        assert_eq!(r.id_mesa.as_deref(), Some("m1"));
        assert_eq!(r.turno, "COMIDA");
        assert_eq!(r.estado.como_texto(), "PROXIMA");
        assert_eq!(r.nota.as_deref(), Some("terraza"));
        assert_eq!(
            r.cliente,
            ClienteReserva::Nuevo {
                nombre: "Ana".into(),
                telefono: Some("600".into()),
                email: Some("a@b.es".into()),
            }
        );
    }

    #[test]
    fn reserva_editada_conserva_estado_normalizado() {
        let r = reserva_base(Some(" r1 ".into()), 2, Some("m1"), "Ana").unwrap();
        assert_eq!(r.id.as_deref(), Some("r1"));
        assert_eq!(r.estado.como_texto(), "CANCELADA");
    }

    #[test]
    fn reserva_rechaza_comensales_invalidos() {
        assert!(reserva_base(None, 0, Some("m1"), "Ana").is_err());
        assert!(reserva_base(None, -1, Some("m1"), "Ana").is_err());
    }

    /// RI-61: no se obliga a dar de alta a nadie. Sin id, sin nombre, sin teléfono y sin email, la
    /// reserva va sin cliente; con id, se asigna a ese; con nombre, se crea uno nuevo.
    #[test]
    fn el_cliente_de_una_reserva_es_opcional_y_explicito() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(ClienteReserva::desde(None, None, None, None), Ok(ClienteReserva::Ninguno));
        assert_eq!(
            ClienteReserva::desde(None, s("  "), s(""), s(" ")),
            Ok(ClienteReserva::Ninguno)
        );
        assert_eq!(
            ClienteReserva::desde(s(" c1 "), s("Luis"), s("600"), None),
            Ok(ClienteReserva::Existente {
                id: "c1".into(),
                telefono: s("600"),
                email: None,
            })
        );
        assert!(matches!(
            ClienteReserva::desde(None, s("Luis"), s("600"), None),
            Ok(ClienteReserva::Nuevo { .. })
        ));
    }

    #[test]
    fn un_telefono_o_email_sin_nombre_no_da_de_alta_a_nadie() {
        let s = |v: &str| Some(v.to_string());
        assert!(ClienteReserva::desde(None, None, s("600"), None).is_err());
        assert!(ClienteReserva::desde(None, s(" "), None, s("a@b.es")).is_err());
    }

    /// Apuntar la reserva y decidir la mesa después es un caso normal: una mesa en blanco es lo
    /// mismo que no traerla, y ninguna de las dos cosas es un error.
    #[test]
    fn reserva_sin_mesa_es_valida() {
        assert_eq!(reserva_base(None, 2, None, "Ana").unwrap().id_mesa, None);
        assert_eq!(reserva_base(None, 2, Some("   "), "Ana").unwrap().id_mesa, None);
    }

    /// RI-61: la duración propia de una reserva. Ninguna es «la del negocio»; una absurda (cero,
    /// negativa o más de un día, que suele ser horas escritas como minutos) se rechaza.
    #[test]
    fn la_duracion_de_una_reserva_es_opcional_y_razonable() {
        assert_eq!(duracion_valida(None), Ok(None));
        assert_eq!(duracion_valida(Some(90)), Ok(Some(90)));
        assert_eq!(duracion_valida(Some(DURACION_MAXIMA_MIN)), Ok(Some(DURACION_MAXIMA_MIN)));
        for mala in [0, -30, DURACION_MAXIMA_MIN + 1] {
            assert!(duracion_valida(Some(mala)).is_err(), "{mala} no debería valer");
        }
    }

    #[test]
    fn el_modo_de_solape_por_defecto_es_avisar() {
        assert_eq!(ModoSolape::desde(" Prohibir "), ModoSolape::Prohibir);
        for otro in ["avisar", "", "lo que sea"] {
            assert_eq!(ModoSolape::desde(otro), ModoSolape::Avisar);
        }
        assert_eq!(ModoSolape::desde(ModoSolape::Prohibir.como_texto()), ModoSolape::Prohibir);
    }
}
