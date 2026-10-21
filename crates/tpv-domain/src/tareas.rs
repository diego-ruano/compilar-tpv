//! Dominio de **tareas**: validaciones y value objects puros.

/// Texto obligatorio: recorta y exige no vacío.
pub use crate::texto::requerido;

/// Texto opcional normalizado: recorta y descarta vacíos.
pub use crate::texto::limpiar_opcional;

/// Normaliza una lista de IDs: recorta, descarta vacíos, ordena y deduplica.
pub use crate::texto::normalizar_ids;

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
        assert_eq!(requerido("", "Escribe el título de la tarea.").unwrap_err(), "Escribe el título de la tarea.");
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
