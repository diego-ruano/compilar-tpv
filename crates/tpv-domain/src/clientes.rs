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
    pub fiscal: DatosFiscales,
}

/// Lo que hace falta para emitirle una **factura completa** a un cliente (FISCAL-02): las columnas
/// `NIF`, `Razon_Social` y `Direccion_Fiscal` de `Clientes`. Las tres son opcionales: casi ningún
/// cliente de un bar pide factura.
///
/// Se normalizan como el destinatario de la factura (`verifactu::validar_destinatario`), para que lo
/// que se guarda en la ficha sea lo que saldría en el papel: el NIF sin blancos, guiones ni
/// minúsculas y con su control comprobado; la razón social y la dirección saneadas y recortadas a
/// [`MAX_RAZON_SOCIAL`] y [`MAX_DIRECCION_FISCAL`] caracteres. El worker hace lo mismo
/// (`clientes.schemas.ts`), con los casos en `validacion_casos.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DatosFiscales {
    pub nif: Option<String>,
    pub razon_social: Option<String>,
    pub direccion_fiscal: Option<String>,
}

/// El tope de la razón social: el del nombre del destinatario en el registro de facturación.
pub const MAX_RAZON_SOCIAL: usize = 120;
/// El tope del domicilio del destinatario, que sólo va al papel.
pub const MAX_DIRECCION_FISCAL: usize = 250;
/// Un NIF que no pasa el control. Lo mismo en el worker.
pub const MSG_NIF_NO_VALIDO: &str = "El NIF no es válido: revisa las cifras y la letra.";

impl DatosFiscales {
    /// Normaliza y valida. Vacío (o sólo blancos y símbolos que se quitan) es `None`; un NIF que
    /// queda con algo tiene que ser válido.
    pub fn validar(
        nif: Option<String>,
        razon_social: Option<String>,
        direccion_fiscal: Option<String>,
    ) -> Result<Self, String> {
        use crate::verifactu::{nif_valido, normalizar_nif, sanear_texto};
        let nif = nif.map(|v| normalizar_nif(&v)).filter(|v| !v.is_empty());
        if nif.as_deref().is_some_and(|v| !nif_valido(v)) {
            return Err(MSG_NIF_NO_VALIDO.to_string());
        }
        let saneado = |v: Option<String>, max: usize| v.map(|t| sanear_texto(&t, max)).filter(|t| !t.is_empty());
        Ok(DatosFiscales {
            nif,
            razon_social: saneado(razon_social, MAX_RAZON_SOCIAL),
            direccion_fiscal: saneado(direccion_fiscal, MAX_DIRECCION_FISCAL),
        })
    }
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
    pub fiscal: DatosFiscales,
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
                Err("El correo no es válido.".to_string())
            }
        }
    }
}

impl NuevoCliente {
    /// Normaliza y valida. `nombre` es obligatorio. `fiscal` llega tal cual se escribió.
    pub fn validar(
        id: Option<String>,
        nombre: String,
        email: Option<String>,
        telefono: Option<String>,
        notas: Option<String>,
        fiscal: DatosFiscales,
    ) -> Result<Self, String> {
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("Escribe el nombre del cliente.".to_string());
        }
        Ok(NuevoCliente {
            id: id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            nombre,
            email: normaliza_email(email)?,
            telefono: limpia_opcional(telefono),
            // AUD-36: con un máximo, como en el worker.
            notas: crate::texto::texto_libre(notas)?,
            fiscal: DatosFiscales::validar(fiscal.nif, fiscal.razon_social, fiscal.direccion_fiscal)?,
        })
    }
}

impl Cliente {
    /// Normaliza y valida una edición. `id` debe ser válido y `nombre` obligatorio. `fiscal` llega
    /// tal cual se escribió.
    pub fn validar_edicion(
        id: String,
        nombre: String,
        email: Option<String>,
        telefono: Option<String>,
        notas: Option<String>,
        fiscal: DatosFiscales,
    ) -> Result<Self, String> {
        let id = id.trim().to_string();
        if id.is_empty() {
            return Err("Falta el cliente.".to_string());
        }
        let nombre = nombre.trim().to_string();
        if nombre.is_empty() {
            return Err("Escribe el nombre del cliente.".to_string());
        }
        Ok(Cliente {
            id,
            nombre,
            email: normaliza_email(email)?,
            telefono: limpia_opcional(telefono),
            // AUD-36: con un máximo, como en el worker.
            notas: crate::texto::texto_libre(notas)?,
            fiscal: DatosFiscales::validar(fiscal.nif, fiscal.razon_social, fiscal.direccion_fiscal)?,
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
        let c = NuevoCliente::validar(Some(" c1 ".into()), " Ana ".into(), Some(" ANA@EXAMPLE.COM ".into()), Some(" 600 ".into()), Some(" nota ".into()), DatosFiscales::default()).unwrap();
        assert_eq!(c.id.as_deref(), Some("c1"));
        assert_eq!(c.nombre, "Ana");
        assert_eq!(c.email.as_deref(), Some("ana@example.com"));
        assert_eq!(c.telefono.as_deref(), Some("600"));
        assert_eq!(c.notas.as_deref(), Some("nota"));
    }

    #[test]
    fn nuevo_cliente_descarta_opcionales_vacios() {
        let c = NuevoCliente::validar(Some(" ".into()), "Ana".into(), Some(" ".into()), Some(" ".into()), None, DatosFiscales::default()).unwrap();
        assert!(c.id.is_none() && c.email.is_none() && c.telefono.is_none() && c.notas.is_none());
    }

    #[test]
    fn clientes_rechazan_nombre_id_y_email_invalidos() {
        let sin = DatosFiscales::default;
        assert!(NuevoCliente::validar(None, " ".into(), None, None, None, sin()).is_err());
        assert!(NuevoCliente::validar(None, "Ana".into(), Some("sin-arroba".into()), None, None, sin()).is_err());
        assert!(Cliente::validar_edicion(" ".into(), "Ana".into(), None, None, None, sin()).is_err());
        assert!(Cliente::validar_edicion("c1".into(), " ".into(), None, None, None, sin()).is_err());
    }

    #[test]
    fn los_datos_fiscales_se_guardan_como_saldrian_en_la_factura() {
        // FISCAL-02: el NIF normalizado como el del destinatario, y la razón social y la dirección
        // saneadas igual que en `validar_destinatario`.
        let f = DatosFiscales::validar(
            Some(" b-1234567 4 ".into()),
            Some("  Bar  <Pepe>  SL ".into()),
            Some("Calle\nMayor 1".into()),
        )
        .unwrap();
        assert_eq!(f.nif.as_deref(), Some("B12345674"));
        assert_eq!(f.razon_social.as_deref(), Some("Bar Pepe SL"));
        assert_eq!(f.direccion_fiscal.as_deref(), Some("Calle Mayor 1"));

        let vacio = DatosFiscales::validar(Some(" - ".into()), Some(" <> ".into()), Some("".into())).unwrap();
        assert_eq!(vacio, DatosFiscales::default());

        assert_eq!(DatosFiscales::validar(Some("12345678A".into()), None, None).unwrap_err(), MSG_NIF_NO_VALIDO);
        let larga = "a".repeat(MAX_RAZON_SOCIAL + 5);
        let f = DatosFiscales::validar(None, Some(larga), Some("b".repeat(MAX_DIRECCION_FISCAL + 5))).unwrap();
        assert_eq!(f.razon_social.map(|t| t.chars().count()), Some(MAX_RAZON_SOCIAL));
        assert_eq!(f.direccion_fiscal.map(|t| t.chars().count()), Some(MAX_DIRECCION_FISCAL));
    }
}
