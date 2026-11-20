//! OPS-02 · Contrato del **paquete de diagnóstico** para soporte.
//!
//! Cuando el bar no tiene internet y la telemetría no ha salido, lo que soporte necesita saber del
//! equipo sale en un fichero que la persona guarda donde quiera y lo manda como pueda. Qué lleva y
//! por qué cada cosa se puede sacar: docs/arquitectura/observabilidad.md.

use serde::{Deserialize, Serialize};

/// El paquete ya compuesto. Nunca es un error: lo que no se ha podido leer va dentro, explicado, y
/// su nombre en `secciones_con_error`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PaqueteDiagnostico {
    /// Nombre propuesto para el fichero (`diagnostico-tpv-20261120-1030.json`).
    pub nombre_fichero: String,
    /// El fichero entero: JSON legible, ya filtrado de datos personales y acotado de tamaño.
    pub contenido: String,
    /// Las partes que no se han podido leer (su motivo va dentro del paquete).
    pub secciones_con_error: Vec<String>,
}
