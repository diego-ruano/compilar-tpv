//! Dominio de **trabajadores / horarios**: validaciones y value objects puros.

use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};

#[derive(Debug, Clone)]
pub struct IntervaloHorario {
    pub inicio: NaiveDateTime,
    pub fin: NaiveDateTime,
}

impl IntervaloHorario {
    /// Intervalos semiabiertos: terminar a las 16:00 y empezar a las 16:00 es válido.
    pub fn solapa(&self, otro: &Self) -> bool {
        self.inicio < otro.fin && otro.inicio < self.fin
    }
}

/// RI-85: una hora de fin anterior al inicio acaba al día siguiente.
pub fn intervalo_horario(fecha: &str, inicio: Option<&str>, fin: Option<&str>) -> Result<Option<IntervaloHorario>, String> {
    let dia = NaiveDate::parse_from_str(fecha, "%Y-%m-%d")
        .ok().filter(|d| d.format("%Y-%m-%d").to_string() == fecha)
        .ok_or("La fecha del horario no es válida")?;
    let (inicio, fin) = match (inicio, fin) {
        (None, None) => return Ok(None),
        (Some(i), Some(f)) => (i, f),
        _ => return Err("Debes indicar el inicio y el fin del tramo".into()),
    };
    let hora = |s: &str| -> Result<NaiveTime, String> {
        let formato = match s.len() { 5 => "%H:%M", 8 => "%H:%M:%S", _ => return Err("Hora inválida (usa HH:mm)".into()) };
        NaiveTime::parse_from_str(s, formato).map_err(|_| "Hora inválida (usa HH:mm)".into())
    };
    let i = hora(inicio)?;
    let f = hora(fin)?;
    if i == f { return Err("Inicio y fin no pueden ser iguales".into()); }
    let dia_fin = if f < i { dia.checked_add_signed(Duration::days(1)).ok_or("Fecha fuera de rango")? } else { dia };
    Ok(Some(IntervaloHorario { inicio: dia.and_time(i), fin: dia_fin.and_time(f) }))
}

pub fn validar_tramos(tramos: &[AsignacionNueva]) -> Result<(), String> {
    if !(1..=2).contains(&tramos.len()) { return Err("El horario debe tener uno o dos tramos".into()); }
    let mut intervalos: Vec<IntervaloHorario> = Vec::new();
    for tramo in tramos {
        if tramo.id_trabajador != tramos[0].id_trabajador || tramo.fecha != tramos[0].fecha {
            return Err("Los tramos deben pertenecer a la misma jornada y trabajador".into());
        }
        if let Some(intervalo) = intervalo_horario(&tramo.fecha, tramo.hora_inicio.as_deref(), tramo.hora_fin.as_deref())? {
            if intervalos.iter().any(|otro| otro.solapa(&intervalo)) {
                return Err("Los tramos del horario se solapan. Corrige las horas antes de guardar".into());
            }
            intervalos.push(intervalo);
        }
    }
    Ok(())
}

/// Texto obligatorio: recorta y exige no vacío.
pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
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

/// Datos para crear una asignación de turno (ya validados/normalizados).
#[derive(Debug, Clone)]
pub struct AsignacionNueva {
    pub id_trabajador: String,
    pub fecha: String,
    pub id_turno: String,
    pub area: String,
    pub hora_inicio: Option<String>,
    pub hora_fin: Option<String>,
    pub notas: Option<String>,
}

/// Cambios sobre una asignación existente (no se mueve de trabajador/fecha).
#[derive(Debug, Clone)]
pub struct AsignacionCambios {
    pub id_turno: String,
    pub area: String,
    pub hora_inicio: Option<String>,
    pub hora_fin: Option<String>,
    pub notas: Option<String>,
}

/// Normaliza el estado de un usuario/trabajador a "Activo" | "Inactivo".
/// Cualquier valor que no sea "Inactivo" (case-insensitive) se considera "Activo".
pub fn normalizar_estado(estado: &str) -> String {
    if estado.trim().eq_ignore_ascii_case("Inactivo") {
        "Inactivo".to_string()
    } else {
        "Activo".to_string()
    }
}

/// Datos para dar de alta un trabajador (crea Usuario + Trabajador). Ya validados.
///
/// `pin` va en claro y ya validado (`login::pin_de_teclado`): lo hashea el adaptador que lo
/// guarda, la Main en su SQLite o el worker en la nube (RI-63).
#[derive(Debug, Clone)]
pub struct TrabajadorNuevo {
    pub id_rol: String,
    pub email: String,
    pub pin: String,
    pub nombre: String,
    pub apellido: Option<String>,
    pub estado: String,
    pub dni: Option<String>,
    pub telefono: Option<String>,
    pub puesto: Option<String>,
    pub iban: Option<String>,
    pub numero_seguridad_social: Option<String>,
    pub fecha_inicio_contrato: Option<String>,
    pub fecha_fin_contrato: Option<String>,
}

/// Cambios sobre un trabajador existente. `pin` opcional (si `None`, no se cambia); como en el
/// alta, en claro y ya validado.
#[derive(Debug, Clone)]
pub struct TrabajadorCambios {
    pub id_usuario: String,
    pub id_rol: String,
    pub email: String,
    pub nombre: String,
    pub apellido: Option<String>,
    pub estado: String,
    pub dni: Option<String>,
    pub telefono: Option<String>,
    pub puesto: Option<String>,
    pub iban: Option<String>,
    pub numero_seguridad_social: Option<String>,
    pub fecha_inicio_contrato: Option<String>,
    pub fecha_fin_contrato: Option<String>,
    pub pin: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tramos_con_compartidos_con_el_worker() {
        let casos: serde_json::Value = serde_json::from_str(include_str!("horarios_casos.json")).unwrap();
        for caso in casos.as_array().unwrap() {
            let tramos: Vec<_> = caso["tramos"].as_array().unwrap().iter().map(|par| AsignacionNueva {
                id_trabajador: "t".into(), fecha: caso["fecha"].as_str().unwrap().into(), id_turno: "turno".into(), area: "Sala".into(), notas: None,
                hora_inicio: Some(par[0].as_str().unwrap().into()), hora_fin: Some(par[1].as_str().unwrap().into()),
            }).collect();
            assert_eq!(validar_tramos(&tramos).is_ok(), caso["valido"].as_bool().unwrap(), "{}", caso["nombre"]);
        }
    }

    #[test]
    fn noche_solapa_con_el_dia_siguiente_y_permite_horas_adyacentes() {
        let noche = intervalo_horario("2026-10-09", Some("22:00"), Some("02:00")).unwrap().unwrap();
        let madrugada = intervalo_horario("2026-10-10", Some("01:00"), Some("03:00")).unwrap().unwrap();
        let despues = intervalo_horario("2026-10-10", Some("02:00"), Some("03:00")).unwrap().unwrap();
        assert!(noche.solapa(&madrugada));
        assert!(!noche.solapa(&despues));
    }

    #[test]
    fn requerido_recorta_y_reporta_campo() {
        assert_eq!(requerido(" Sala ", "area").unwrap(), "Sala");
        assert_eq!(requerido("\t", "area").unwrap_err(), "area required");
    }

    #[test]
    fn opcionales_limpian_extremos_y_vacios() {
        assert_eq!(limpiar_opcional(Some(" Cocina ".into())), Some("Cocina".into()));
        assert_eq!(limpiar_opcional(Some(" \n ".into())), None);
        assert_eq!(limpiar_opcional(None), None);
    }

    #[test]
    fn estado_solo_reconoce_inactivo() {
        for valor in ["Inactivo", " INACTIVO ", "inactivo"] { assert_eq!(normalizar_estado(valor), "Inactivo"); }
        for valor in ["", "Activo", "baja", "desconocido"] { assert_eq!(normalizar_estado(valor), "Activo"); }
    }
}
