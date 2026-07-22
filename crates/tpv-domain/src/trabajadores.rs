//! Dominio de **trabajadores / horarios**: validaciones y value objects puros.

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
#[derive(Debug, Clone)]
pub struct TrabajadorNuevo {
    pub id_rol: String,
    pub email: String,
    pub password_hash: String,
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

/// Cambios sobre un trabajador existente. `password_hash` opcional (si `None`, no se cambia).
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
    pub password_hash: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
