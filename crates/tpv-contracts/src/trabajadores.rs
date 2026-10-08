//! Contratos (DTOs) de la frontera UI<->Rust para **trabajadores / horarios**.
//! Los DTOs de salida conservan los nombres PascalCase vía `#[serde(rename)]`.
//! Local-First: los args de entrada NO llevan op_id/outbox/remote_id.

use serde::{Deserialize, Serialize};
/* =========================================================
   Salida (read models)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RolRow {
    #[serde(rename = "ID_Rol")]
    pub id_rol: String,
    #[serde(rename = "Nombre_Rol")]
    pub nombre_rol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadorRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: String,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Email")]
    pub email: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Nombre_Rol")]
    pub nombre_rol: String,
    #[serde(rename = "Telefono")]
    pub telefono: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadorDetailRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: String,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: String,
    #[serde(rename = "ID_Rol")]
    pub id_rol: String,
    #[serde(rename = "Email")]
    pub email: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "DNI")]
    pub dni: Option<String>,
    #[serde(rename = "Telefono")]
    pub telefono: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "IBAN")]
    pub iban: Option<String>,
    #[serde(rename = "Numero_Seguridad_Social")]
    pub numero_seguridad_social: Option<String>,
    #[serde(rename = "Fecha_Inicio_Contrato")]
    pub fecha_inicio_contrato: Option<String>,
    #[serde(rename = "Fecha_Fin_Contrato")]
    pub fecha_fin_contrato: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TurnoRow {
    #[serde(rename = "ID_Turno")]
    pub id_turno: String,
    #[serde(rename = "Nombre_Turno")]
    pub nombre_turno: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AsignacionRow {
    #[serde(rename = "ID_Grupo", default)]
    pub id_grupo: Option<String>,
    #[serde(rename = "ID_Asignacion")]
    pub id_asignacion: String,
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: String,
    #[serde(rename = "Fecha")]
    pub fecha: String,
    #[serde(rename = "ID_Turno")]
    pub id_turno: String,
    #[serde(rename = "Area")]
    pub area: String,
    #[serde(rename = "Hora_Inicio")]
    pub hora_inicio: Option<String>,
    #[serde(rename = "Hora_Fin")]
    pub hora_fin: Option<String>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Nombre_Turno")]
    pub nombre_turno: String,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TrabajadorDetailArgs {
    pub id_trabajador: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TrabajadorIdByUsuarioArgs {
    pub id_usuario: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct HorariosSemanaArgs {
    pub fecha_lunes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TramoHorarioInput {
    pub hora_inicio: String,
    pub hora_fin: String,
}

/// RI-85: crear o sustituir el conjunto de tramos en una única transacción.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AsignacionGuardarInput {
    #[serde(default)]
    pub id_asignacion: Option<String>,
    pub id_trabajador: String,
    pub fecha: String,
    pub id_turno: String,
    pub area: String,
    #[serde(default)]
    pub notas: Option<String>,
    pub tramos: Vec<TramoHorarioInput>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct AsignacionCreateInput {
    pub id_trabajador: String,
    pub fecha: String,
    pub id_turno: String,
    pub area: String,
    #[serde(default)]
    pub hora_inicio: Option<String>,
    #[serde(default)]
    pub hora_fin: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct AsignacionUpdateInput {
    pub id_asignacion: String,
    pub id_turno: String,
    pub area: String,
    #[serde(default)]
    pub hora_inicio: Option<String>,
    #[serde(default)]
    pub hora_fin: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct AsignacionDeleteInput {
    pub id_asignacion: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CopySemanaInput {
    pub from_monday: String,
    pub to_monday: String,
    #[serde(default)]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SetPredeterminadoInput {
    pub fecha_lunes: String,
}

/// Alta de trabajador (crea Usuario + Trabajador en local). Local-First.
///
/// RI-63: llega el PIN, no su hash. Lo hashea quien lo guarda (la Main o el worker), que así puede
/// exigir la política del PIN y no guarda un hash con las iteraciones que alguien quiera.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TrabajadorCreateInput {
    pub id_rol: String,
    pub email: String,
    pub pin: String,
    pub nombre: String,
    #[serde(default)]
    pub apellido: Option<String>,
    pub estado: String,
    #[serde(default)]
    pub dni: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub puesto: Option<String>,
    #[serde(default)]
    pub iban: Option<String>,
    #[serde(default)]
    pub numero_seguridad_social: Option<String>,
    #[serde(default)]
    pub fecha_inicio_contrato: Option<String>,
    #[serde(default)]
    pub fecha_fin_contrato: Option<String>,
}

/// Edición de trabajador (actualiza Usuario + Trabajador). `pin` opcional: si viene, cambia el
/// PIN; si no, se mantiene el actual. Como en el alta, llega el PIN y no su hash (RI-63).
/// Local-First.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TrabajadorUpdateInput {
    pub id_trabajador: String,
    pub id_usuario: String,
    pub id_rol: String,
    pub email: String,
    pub nombre: String,
    #[serde(default)]
    pub apellido: Option<String>,
    pub estado: String,
    #[serde(default)]
    pub dni: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub puesto: Option<String>,
    #[serde(default)]
    pub iban: Option<String>,
    #[serde(default)]
    pub numero_seguridad_social: Option<String>,
    #[serde(default)]
    pub fecha_inicio_contrato: Option<String>,
    #[serde(default)]
    pub fecha_fin_contrato: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
}
