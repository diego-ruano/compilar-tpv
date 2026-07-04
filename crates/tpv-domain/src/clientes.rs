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

/// Datos para dar de alta un cliente. `id` es opcional: si falta, lo asigna la
/// persistencia (siguiente ID libre).
#[derive(Debug, Clone)]
pub struct NuevoCliente {
    pub id: Option<String>,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Limpia un opcional de texto: trim + descarta vacíos.
fn limpia_opcional(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

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
