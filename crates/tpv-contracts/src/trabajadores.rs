//! Contratos (DTOs) de la frontera UI<->Rust para **trabajadores / horarios**.
//! Los DTOs de salida conservan los nombres PascalCase vía `#[serde(rename)]`.
//! Local-First: los args de entrada NO llevan op_id/outbox/remote_id.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* =========================================================
   Salida (read models)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct RolRow {
    #[serde(rename = "ID_Rol")]
    #[ts(type = "number")]
    pub id_rol: i64,
    #[serde(rename = "Nombre_Rol")]
    pub nombre_rol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TrabajadorRow {
    #[serde(rename = "ID_Trabajador")]
    #[ts(type = "number")]
    pub id_trabajador: i64,
    #[serde(rename = "ID_Usuario")]
    #[ts(type = "number")]
    pub id_usuario: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TrabajadorDetailRow {
    #[serde(rename = "ID_Trabajador")]
    #[ts(type = "number")]
    pub id_trabajador: i64,
    #[serde(rename = "ID_Usuario")]
    #[ts(type = "number")]
    pub id_usuario: i64,
    #[serde(rename = "ID_Rol")]
    #[ts(type = "number")]
    pub id_rol: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TurnoRow {
    #[serde(rename = "ID_Turno")]
    #[ts(type = "number")]
    pub id_turno: i64,
    #[serde(rename = "Nombre_Turno")]
    pub nombre_turno: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AsignacionRow {
    #[serde(rename = "ID_Asignacion")]
    #[ts(type = "number")]
    pub id_asignacion: i64,
    #[serde(rename = "ID_Trabajador")]
    #[ts(type = "number")]
    pub id_trabajador: i64,
    #[serde(rename = "Fecha")]
    pub fecha: String,
    #[serde(rename = "ID_Turno")]
    #[ts(type = "number")]
    pub id_turno: i64,
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

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TrabajadorDetailArgs {
    #[ts(type = "number")]
    pub id_trabajador: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TrabajadorIdByUsuarioArgs {
    #[ts(type = "number")]
    pub id_usuario: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct HorariosSemanaArgs {
    pub fecha_lunes: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AsignacionCreateInput {
    #[ts(type = "number")]
    pub id_trabajador: i64,
    pub fecha: String,
    #[ts(type = "number")]
    pub id_turno: i64,
    pub area: String,
    #[serde(default)]
    #[ts(optional)]
    pub hora_inicio: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub hora_fin: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AsignacionUpdateInput {
    #[ts(type = "number")]
    pub id_asignacion: i64,
    #[ts(type = "number")]
    pub id_turno: i64,
    pub area: String,
    #[serde(default)]
    #[ts(optional)]
    pub hora_inicio: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub hora_fin: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AsignacionDeleteInput {
    #[ts(type = "number")]
    pub id_asignacion: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CopySemanaInput {
    pub from_monday: String,
    pub to_monday: String,
    #[serde(default)]
    #[ts(optional)]
    pub overwrite: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SetPredeterminadoInput {
    pub fecha_lunes: String,
}
