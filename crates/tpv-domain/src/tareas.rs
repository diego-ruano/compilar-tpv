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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requerido_recorta_y_exige_no_vacio() {
        assert_eq!(requerido("  hola  ", "titulo").unwrap(), "hola");
        assert!(requerido("   ", "titulo").is_err());
        assert!(requerido("", "titulo").is_err());
        // El mensaje de error nombra el campo que faltó.
        assert_eq!(requerido("", "titulo").unwrap_err(), "titulo required");
    }

    #[test]
    fn limpiar_opcional_descarta_vacios_y_recorta() {
        assert_eq!(limpiar_opcional(None), None);
        assert_eq!(limpiar_opcional(Some("   ".into())), None);
        assert_eq!(limpiar_opcional(Some(String::new())), None);
        assert_eq!(limpiar_opcional(Some("  x  ".into())), Some("x".to_string()));
    }

    #[test]
    fn normalizar_ids_recorta_descarta_ordena_y_dedup() {
        let out = normalizar_ids(vec![
            " b ".into(),
            "a".into(),
            "b".into(),
            String::new(),
            "  ".into(),
            "c".into(),
        ]);
        assert_eq!(out, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn normalizar_ids_todo_vacio_da_lista_vacia() {
        assert!(normalizar_ids(vec![String::new(), "   ".into()]).is_empty());
    }
}
