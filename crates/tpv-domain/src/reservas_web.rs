//! Reservas desde la web (docs/estudios/reservas-web.md): las reglas puras de su configuración.

/// La zona horaria IANA del negocio a partir de lo que su reloj se separa de UTC en invierno y en
/// verano, en minutos. La nube la necesita para saber qué es «hoy» cuando no hay un dispositivo que
/// se lo diga (las reservas desde la web).
///
/// No se lee el nombre de la zona del sistema: en Windows sólo se puede con las API de WinRT, que no
/// existen en Windows 7, y el TPV tiene una variante para él. Con los dos desfases basta, porque lo
/// único que la nube hace con la zona es pasar de UTC a la hora local, y dos zonas con los mismos
/// desfases y las mismas reglas de horario de verano dan la misma hora.
///
/// Hoy se reconocen las dos de España. Con otros desfases no hay respuesta, y quien llama deja la que
/// hubiera.
pub fn zona_por_desfases(invierno_min: i32, verano_min: i32) -> Option<&'static str> {
    match (invierno_min, verano_min) {
        (60, 120) => Some("Europe/Madrid"),
        (0, 60) => Some("Atlantic/Canary"),
        _ => None,
    }
}

/// Lo más largo que puede ser el motivo de un día cerrado: es una nota para el propio negocio.
pub const MOTIVO_CIERRE_MAX: usize = 100;

/// Un día en que la web no acepta reservas, ya normalizado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CierreValidado {
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

impl CierreValidado {
    pub fn validar(dia_ymd: &str, motivo: Option<String>) -> Result<Self, String> {
        let dia_ymd = crate::fechas::normalizar_dia(dia_ymd).ok_or_else(|| {
            format!("Formato de día inválido: '{}'. Esperado YYYY-MM-DD.", dia_ymd.trim())
        })?;
        let motivo = crate::texto::limpiar_opcional(motivo);
        if motivo.as_deref().is_some_and(|m| m.chars().count() > MOTIVO_CIERRE_MAX) {
            return Err(format!("El motivo no puede pasar de {MOTIVO_CIERRE_MAX} caracteres"));
        }
        Ok(CierreValidado { dia_ymd, motivo })
    }
}

/// Todos los días de la semana en la máscara de `Reserva_Web_Franjas.Dias_Semana`.
pub const TODOS_LOS_DIAS: i64 = 127;

/// Cuándo se puede reservar una mesa desde la web.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FranjaValidada {
    /// Máscara: 1 lunes, 2 martes, 4 miércoles … 64 domingo.
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    /// `HH:MM`, menor que `hora_hasta`.
    pub hora_desde: String,
    pub hora_hasta: String,
}

/// La configuración de una mesa para la web, ya validada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MesaWebValidada {
    pub id_mesa: String,
    pub activa: bool,
    /// Sin horas no hay franja: una mesa apagada puede no tenerla.
    pub franja: Option<FranjaValidada>,
}

/// Lo que llega de la pantalla para una mesa, con los campos nombrados.
#[derive(Debug, Clone)]
pub struct MesaWebEntrada {
    pub id_mesa: String,
    pub activa: bool,
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    pub hora_desde: Option<String>,
    pub hora_hasta: Option<String>,
}

fn dia_opcional(raw: Option<String>, que: &str) -> Result<Option<String>, String> {
    match crate::texto::limpiar_opcional(raw) {
        None => Ok(None),
        Some(dia) => crate::fechas::normalizar_dia(&dia)
            .map(Some)
            .ok_or_else(|| format!("La fecha {que} no es válida: '{dia}'. Esperado YYYY-MM-DD.")),
    }
}

impl MesaWebValidada {
    /// Una mesa que se puede reservar necesita sus horas y al menos un día de la semana. Apagada,
    /// lo que tenga tiene que seguir siendo válido (se guarda para volver a encenderla), pero
    /// puede no tener horas.
    pub fn validar(e: MesaWebEntrada) -> Result<Self, String> {
        let id_mesa = e.id_mesa.trim().to_string();
        if id_mesa.is_empty() {
            return Err("Falta la mesa".into());
        }
        let desde = crate::texto::limpiar_opcional(e.hora_desde);
        let hasta = crate::texto::limpiar_opcional(e.hora_hasta);
        let franja = match (desde, hasta) {
            (None, None) => None,
            (Some(desde), Some(hasta)) => {
                let hora_desde = crate::reservas::normalize_hora_hhmm(&desde)?;
                let hora_hasta = crate::reservas::normalize_hora_hhmm(&hasta)?;
                if hora_desde >= hora_hasta {
                    return Err("La hora de cierre tiene que ser posterior a la de apertura".into());
                }
                if !(1..=TODOS_LOS_DIAS).contains(&e.dias_semana) {
                    return Err("Elige al menos un día de la semana".into());
                }
                let fecha_desde = dia_opcional(e.fecha_desde, "de inicio")?;
                let fecha_hasta = dia_opcional(e.fecha_hasta, "de fin")?;
                if let (Some(d), Some(h)) = (&fecha_desde, &fecha_hasta) {
                    if d > h {
                        return Err("La fecha de fin no puede ser anterior a la de inicio".into());
                    }
                }
                Some(FranjaValidada {
                    dias_semana: e.dias_semana,
                    fecha_desde,
                    fecha_hasta,
                    hora_desde,
                    hora_hasta,
                })
            }
            _ => return Err("Indica la hora de apertura y la de cierre".into()),
        };
        if e.activa && franja.is_none() {
            return Err("Para reservarla desde la web, indica entre qué horas".into());
        }
        Ok(MesaWebValidada { id_mesa, activa: e.activa, franja })
    }
}

/// Topes de lo que escribe el visitante en el formulario público: son datos para el restaurante, y
/// un formulario abierto a internet no puede meter un libro en la base.
pub const NOMBRE_MAX: usize = 80;
pub const NOTA_MAX: usize = 200;
pub const EMAIL_MAX: usize = 254;
/// Más que esto no es una mesa: es un grupo, y se llama por teléfono.
pub const PERSONAS_MAX: i64 = 50;

/// El alta de una reserva desde la web, tal como llega del widget.
#[derive(Debug, Clone)]
pub struct AltaWebEntrada {
    pub dia_ymd: String,
    pub hora: String,
    pub personas: i64,
    pub id_mesa: String,
    pub nombre: String,
    pub email: String,
    pub telefono: String,
    pub nota: Option<String>,
}

/// El alta ya normalizada. La valida el worker antes de guardarla en la agenda y otra vez la Main al
/// registrarla, con el mismo criterio (`validacion_casos.json`, dominio `reserva_web`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AltaWebValidada {
    pub dia_ymd: String,
    pub hora: String,
    pub personas: i64,
    pub id_mesa: String,
    pub nombre: String,
    /// En minúsculas: identifica al cliente (`ux_clientes_email`).
    pub email: String,
    /// Sólo las cifras, con el `+` delante si lo llevaba.
    pub telefono: String,
    pub nota: Option<String>,
}

/// El teléfono sólo con sus cifras (y el `+` del prefijo internacional), o `None` si no lo parece:
/// entre 6 y 15 cifras, y como separadores sólo espacios, guiones, puntos y paréntesis.
pub fn normalizar_telefono(raw: &str) -> Option<String> {
    let t = raw.trim();
    let (mas, resto) = match t.strip_prefix('+') {
        Some(r) => ("+", r),
        None => ("", t),
    };
    if !resto.chars().all(|c| c.is_ascii_digit() || " -.()".contains(c)) {
        return None;
    }
    let cifras: String = resto.chars().filter(char::is_ascii_digit).collect();
    (6..=15).contains(&cifras.len()).then(|| format!("{mas}{cifras}"))
}

impl AltaWebValidada {
    pub fn validar(e: AltaWebEntrada) -> Result<Self, String> {
        let dia_ymd = crate::fechas::normalizar_dia(&e.dia_ymd).ok_or_else(|| {
            format!("Formato de día inválido: '{}'. Esperado YYYY-MM-DD.", e.dia_ymd.trim())
        })?;
        let hora = crate::reservas::normalize_hora_hhmm(&e.hora)?;
        if !(1..=PERSONAS_MAX).contains(&e.personas) {
            return Err(format!("El número de personas tiene que estar entre 1 y {PERSONAS_MAX}"));
        }
        let id_mesa = e.id_mesa.trim().to_string();
        if id_mesa.is_empty() {
            return Err("Elige una mesa".into());
        }
        let nombre = e.nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("Escribe tu nombre".into());
        }
        if nombre.chars().count() > NOMBRE_MAX {
            return Err(format!("El nombre no puede pasar de {NOMBRE_MAX} caracteres"));
        }
        let email = e.email.trim().to_lowercase();
        if email.chars().count() > EMAIL_MAX || !crate::login::validate_email_basic(&email) {
            return Err("El correo no es válido".into());
        }
        let telefono = normalizar_telefono(&e.telefono).ok_or("El teléfono no es válido")?;
        let nota = crate::texto::limpiar_opcional(e.nota);
        if nota.as_deref().is_some_and(|n| n.chars().count() > NOTA_MAX) {
            return Err(format!("La nota no puede pasar de {NOTA_MAX} caracteres"));
        }
        Ok(AltaWebValidada { dia_ymd, hora, personas: e.personas, id_mesa, nombre, email, telefono, nota })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_telefono_se_queda_con_sus_cifras_y_el_prefijo() {
        assert_eq!(normalizar_telefono(" 600 11 22 33 ").as_deref(), Some("600112233"));
        assert_eq!(normalizar_telefono("+34 (600) 112-233").as_deref(), Some("+34600112233"));
        for malo in ["", "12345", "600abc111", "+", "1234567890123456", "600+112233"] {
            assert_eq!(normalizar_telefono(malo), None, "{malo}");
        }
    }

    fn entrada(activa: bool, desde: Option<&str>, hasta: Option<&str>) -> MesaWebEntrada {
        MesaWebEntrada {
            id_mesa: " m1 ".into(),
            activa,
            dias_semana: TODOS_LOS_DIAS,
            fecha_desde: None,
            fecha_hasta: None,
            hora_desde: desde.map(str::to_string),
            hora_hasta: hasta.map(str::to_string),
        }
    }

    #[test]
    fn una_mesa_reservable_tiene_horas_y_dias() {
        let ok = MesaWebValidada::validar(entrada(true, Some("12:00"), Some("16:00"))).unwrap();
        assert_eq!(ok.id_mesa, "m1");
        assert_eq!(ok.franja.unwrap().hora_hasta, "16:00");

        assert!(MesaWebValidada::validar(entrada(true, None, None)).is_err(), "sin horas");
        assert!(MesaWebValidada::validar(entrada(true, Some("16:00"), Some("12:00"))).is_err());
        assert!(MesaWebValidada::validar(entrada(true, Some("12:00"), Some("12:00"))).is_err());
        assert!(MesaWebValidada::validar(entrada(true, Some("12:00"), None)).is_err(), "media franja");
        let sin_dias = MesaWebEntrada { dias_semana: 0, ..entrada(true, Some("12:00"), Some("16:00")) };
        assert!(MesaWebValidada::validar(sin_dias).is_err());
        let de_mas = MesaWebEntrada { dias_semana: 128, ..entrada(true, Some("12:00"), Some("16:00")) };
        assert!(MesaWebValidada::validar(de_mas).is_err());
    }

    /// Apagada se puede guardar sin horas (nunca la configuraron) o con las que tenía, para que
    /// encenderla otra vez no obligue a escribirlas de nuevo.
    #[test]
    fn una_mesa_apagada_conserva_su_franja_si_la_tiene() {
        assert_eq!(MesaWebValidada::validar(entrada(false, None, None)).unwrap().franja, None);
        assert!(MesaWebValidada::validar(entrada(false, Some("13:00"), Some("16:00"))).unwrap().franja.is_some());
        assert!(MesaWebValidada::validar(entrada(false, Some("25:00"), Some("16:00"))).is_err());
    }

    #[test]
    fn las_fechas_son_opcionales_pero_reales_y_en_orden() {
        let con = |desde: Option<&str>, hasta: Option<&str>| MesaWebEntrada {
            fecha_desde: desde.map(str::to_string),
            fecha_hasta: hasta.map(str::to_string),
            ..entrada(true, Some("12:00"), Some("16:00"))
        };
        let solo_desde = MesaWebValidada::validar(con(Some("2026-11-01"), Some("  "))).unwrap();
        let franja = solo_desde.franja.unwrap();
        assert_eq!(franja.fecha_desde.as_deref(), Some("2026-11-01"));
        assert_eq!(franja.fecha_hasta, None);
        assert!(MesaWebValidada::validar(con(Some("2026-02-30"), None)).is_err());
        assert!(MesaWebValidada::validar(con(Some("2026-11-02"), Some("2026-11-01"))).is_err());
        assert!(MesaWebValidada::validar(con(Some("2026-11-01"), Some("2026-11-01"))).is_ok());
    }

    #[test]
    fn un_dia_cerrado_es_una_fecha_real_con_un_motivo_opcional() {
        assert_eq!(
            CierreValidado::validar(" 2026-12-24 ", Some("  Nochebuena ".into())),
            Ok(CierreValidado { dia_ymd: "2026-12-24".into(), motivo: Some("Nochebuena".into()) })
        );
        assert_eq!(CierreValidado::validar("2026-12-31", Some("   ".into())).unwrap().motivo, None);
        for malo in ["", "24/12/2026", "2026-02-30"] {
            assert!(CierreValidado::validar(malo, None).is_err(), "{malo}");
        }
        assert!(CierreValidado::validar("2026-12-24", Some("x".repeat(MOTIVO_CIERRE_MAX + 1))).is_err());
        assert!(CierreValidado::validar("2026-12-24", Some("ñ".repeat(MOTIVO_CIERRE_MAX))).is_ok());
    }

    #[test]
    fn la_peninsula_y_canarias_se_distinguen_por_sus_desfases() {
        assert_eq!(zona_por_desfases(60, 120), Some("Europe/Madrid"));
        assert_eq!(zona_por_desfases(0, 60), Some("Atlantic/Canary"));
    }

    /// Un PC en UTC, uno sin horario de verano o uno de fuera: no se adivina nada.
    #[test]
    fn unos_desfases_que_no_son_de_espana_no_dan_zona() {
        for (invierno, verano) in [(0, 0), (60, 60), (-300, -240), (120, 180)] {
            assert_eq!(zona_por_desfases(invierno, verano), None, "{invierno}/{verano}");
        }
    }
}
