//! Contratos (DTOs) de la frontera UI<->Rust para **reservas**.
//! Campos snake_case idénticos a los structs del backend antiguo (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ZonaDto {
    pub id_zona: String,
    pub nombre_zona: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesaDto {
    pub id_mesa: String,
    pub id_zona: String,
    pub numero_mesa: String,
    #[ts(type = "number")]
    pub capacidad: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservasMetaDto {
    pub zonas: Vec<ZonaDto>,
    pub mesas: Vec<MesaDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservaDto {
    pub id_reserva: String,
    pub id_mesa: String,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: Option<String>,
    #[ts(type = "number")]
    pub comensales: i64,
    pub nota: Option<String>,
    pub estado: String,

    pub nombre_cliente: String,
    pub telefono_cliente: Option<String>,
    pub email_cliente: Option<String>,

    pub id_zona: String,
    pub numero_mesa: String,
    #[ts(type = "number")]
    pub capacidad: i64,
    pub nombre_zona: String,
}

/// Argumentos del rango mensual.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservasGetMesArgs {
    pub desde: String,
    pub hasta: String,
}

/// Entrada de guardado de reserva (Local-First: sin op_id/outbox/remote_id).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservaSaveInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_reserva: Option<String>,

    pub dia_ymd: String,
    pub hora: String,
    #[serde(default)]
    #[ts(optional)]
    pub turno: Option<String>,

    #[ts(type = "number")]
    pub comensales: i64,
    #[serde(default)]
    #[ts(optional)]
    pub nota: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub estado: Option<String>,

    #[serde(default)]
    #[ts(optional)]
    pub id_mesa: Option<String>,
    pub nombre_cliente: String,
    #[serde(default)]
    #[ts(optional)]
    pub telefono: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas_cliente: Option<String>,
}

/// Entrada de borrado de reserva.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservaDeleteInput {
    pub id_reserva: String,
}
