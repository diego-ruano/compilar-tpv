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
    pub id_trabajador: i64,
    pub fecha: String,
    pub id_turno: i64,
    pub area: String,
    pub hora_inicio: Option<String>,
    pub hora_fin: Option<String>,
    pub notas: Option<String>,
}

/// Cambios sobre una asignación existente (no se mueve de trabajador/fecha).
#[derive(Debug, Clone)]
pub struct AsignacionCambios {
    pub id_turno: i64,
    pub area: String,
    pub hora_inicio: Option<String>,
    pub hora_fin: Option<String>,
    pub notas: Option<String>,
}
