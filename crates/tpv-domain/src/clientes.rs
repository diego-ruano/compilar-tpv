//! Dominio de **clientes**: entidad de negocio, value objects y validaciones puras.
//! No conoce SQLite, ni Tauri, ni la frontera de la UI.

use serde::{Deserialize, Serialize};

/// Criterio de ordenación del overview de clientes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClienteRanking {
    PorReservas,
    PorGasto,
    Reciente,
}

impl ClienteRanking {
    /// Mapea el argumento que envía la UI (compatibilidad con el front actual).
    pub fn from_arg(s: &str) -> Self {
        match s.trim() {
            "reservas" => ClienteRanking::PorReservas,
            "gasto" => ClienteRanking::PorGasto,
            _ => ClienteRanking::Reciente,
        }
    }
}

/// Entidad de negocio Cliente (campos editables/persistibles).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cliente {
    pub id: String,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Datos para dar de alta un cliente. `id` es opcional: si falta, la persistencia
/// genera un UUIDv7 antes del INSERT. El dominio sólo valida y normaliza los datos.
#[derive(Debug, Clone)]
pub struct NuevoCliente {
    pub id: Option<String>,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Limpia un opcional de texto: trim + descarta vacíos.
use crate::texto::limpiar_opcional as limpia_opcional;

/// Normaliza y valida un email opcional (CLI-04): trim + minúsculas; vacío => `None`.
/// Si hay un valor no vacío, debe tener formato de email válido. Se pasa a minúsculas
/// para que la unicidad sea case-insensitive (índice `ux_clientes_email` sobre `lower(Email)`).
fn normaliza_email(v: Option<String>) -> Result<Option<String>, String> {
    match v
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    {
        None => Ok(None),
        Some(email) => {
            if crate::login::validate_email_basic(&email) {
                Ok(Some(email))
            } else {
                Err("email inválido".to_string())
            }
        }
    }
}

impl NuevoCliente {
    /// Normaliza y valida. `nombre` es obligatorio.
    pub fn validar(
        id: Option<String>,
        nombre: String,
        email: Option<String>,
        telefono: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".to_string());
        }
        Ok(NuevoCliente {
            id: id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            nombre,
            email: normaliza_email(email)?,
            telefono: limpia_opcional(telefono),
            notas: limpia_opcional(notas),
        })
    }
}

impl Cliente {
    /// Normaliza y valida una edición. `id` debe ser válido y `nombre` obligatorio.
    pub fn validar_edicion(
        id: String,
        nombre: String,
        email: Option<String>,
        telefono: Option<String>,
        notas: Option<String>,
    ) -> Result<Self, String> {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err("ID_Cliente inválido.".to_string());
        }
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("nombre required".to_string());
        }
        Ok(Cliente {
            id,
            nombre,
            email: normaliza_email(email)?,
            telefono: limpia_opcional(telefono),
            notas: limpia_opcional(notas),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_mapea_argumentos_y_desconocidos() {
        assert_eq!(ClienteRanking::from_arg(" reservas "), ClienteRanking::PorReservas);
        assert_eq!(ClienteRanking::from_arg("gasto"), ClienteRanking::PorGasto);
        assert_eq!(ClienteRanking::from_arg("GASTO"), ClienteRanking::Reciente);
        assert_eq!(ClienteRanking::from_arg(""), ClienteRanking::Reciente);
    }

    #[test]
    fn nuevo_cliente_normaliza_todos_los_campos() {
        let c = NuevoCliente::validar(Some(" c1 ".into()), " Ana ".into(), Some(" ANA@EXAMPLE.COM ".into()), Some(" 600 ".into()), Some(" nota ".into())).unwrap();
        assert_eq!(c.id.as_deref(), Some("c1"));
        assert_eq!(c.nombre, "Ana");
        assert_eq!(c.email.as_deref(), Some("ana@example.com"));
        assert_eq!(c.telefono.as_deref(), Some("600"));
        assert_eq!(c.notas.as_deref(), Some("nota"));
    }

    #[test]
    fn nuevo_cliente_descarta_opcionales_vacios() {
        let c = NuevoCliente::validar(Some(" ".into()), "Ana".into(), Some(" ".into()), Some(" ".into()), None).unwrap();
        assert!(c.id.is_none() && c.email.is_none() && c.telefono.is_none() && c.notas.is_none());
    }

    #[test]
    fn clientes_rechazan_nombre_id_y_email_invalidos() {
        assert!(NuevoCliente::validar(None, " ".into(), None, None, None).is_err());
        assert!(NuevoCliente::validar(None, "Ana".into(), Some("sin-arroba".into()), None, None).is_err());
        assert!(Cliente::validar_edicion(" ".into(), "Ana".into(), None, None, None).is_err());
        assert!(Cliente::validar_edicion("c1".into(), " ".into(), None, None, None).is_err());
    }
}
