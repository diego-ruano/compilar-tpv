//! Contratos (DTOs) de la frontera UI<->Rust para **login / auth / fichaje**.
//! Local-First: los args de entrada NO llevan op_id/outbox. Campos snake_case idénticos
//! al backend antiguo (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* =========================================================
   Salida
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UserListItem {
    pub id_usuario: String,
    pub nombre: String,
    pub apellido: Option<String>,
    pub nombre_rol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LoginOk {
    pub id_usuario: String,
    pub id_trabajador: Option<String>,
    pub nombre: String,
    pub apellido: Option<String>,
    pub rol: String,
    pub email: String,
    #[ts(type = "number")]
    pub requiere_setup: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PunchParte {
    #[ts(type = "number")]
    pub parte: i64,
    pub entrada: Option<String>,
    pub salida: Option<String>,
    pub estado: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PunchStatus {
    pub fecha: String,
    #[ts(type = "number")]
    pub turno_partido: i64,
    pub partes: Vec<PunchParte>,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LoginUserArgs {
    pub id_usuario: String,
    pub pin: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PunchStatusArgs {
    pub id_usuario: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SetTurnoPartidoInput {
    pub id_usuario: String,
    pub turno_partido: bool,
    #[serde(default)]
    #[ts(optional)]
    pub fecha: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CompleteInitialSetupInput {
    pub id_usuario: String,
    pub pin_actual: String,
    pub pin_nuevo: String,
    pub email_nuevo: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PunchInput {
    pub id_usuario: String,
    pub pin: String,
    pub tipo: String,
    #[serde(default)]
    #[ts(optional)]
    pub fecha: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub hora_evento: Option<String>,
}
