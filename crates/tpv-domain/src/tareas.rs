//! Dominio de **tareas**: validaciones y value objects puros.

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

/// Normaliza una lista de IDs: recorta, descarta vacíos, ordena y deduplica.
pub fn normalizar_ids(ids: Vec<String>) -> Vec<String> {
    let mut ids: Vec<String> = ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Datos de una tarea (sin id de creación; el id lo gestiona la persistencia).
#[derive(Debug, Clone)]
pub struct TareaData {
    pub titulo: String,
    pub descripcion: Option<String>,
    pub fecha_limite: Option<String>,
}
