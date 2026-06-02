//! Contratos (DTOs) de la frontera UI<->Rust para **clientes**.
//!
//! Los nombres de campo son snake_case e IDÉNTICOS a los structs del backend antiguo
//! (`ClienteRow`, `ClienteFormRow`, …) para que el frontend actual siga funcionando sin
//! cambios. Los IDs `i64` se anotan `#[ts(type = "number")]` (los ID de SQLite caben en
//! number) para mantener compatibilidad con el frontend (que usa `number`, no `bigint`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Fila del overview de clientes (read model con campos calculados).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClienteOverview {
    #[ts(type = "number")]
    pub id_cliente: i64,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,

    pub ultima_reserva_fecha: Option<String>,
    pub ultima_reserva_hora: Option<String>,
    #[ts(type = "number | null")]
    pub ultima_reserva_num_personas: Option<i64>,
    pub ultima_reserva_mesa: Option<String>,

    pub total_gastado_calculado: f64,
    pub total_gastado_stored: f64,

    #[ts(type = "number")]
    pub total_reservas: i64,
    #[ts(type = "number")]
    pub reservas_pendientes: i64,
}

/// Datos del formulario de edición de un cliente.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClienteForm {
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Argumentos del overview.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClientesOverviewArgs {
    pub ranking: String,
}

/// Argumento con sólo el id de cliente.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClienteIdArgs {
    #[ts(type = "number")]
    pub id_cliente: i64,
}

/// Entrada para crear un cliente (Local-First: sin op_id ni outbox).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CreateClienteInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_cliente: Option<i64>,
    pub nombre: String,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub telefono: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}

/// Entrada para actualizar un cliente (Local-First: sin op_id ni outbox).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdateClienteInput {
    #[ts(type = "number")]
    pub id_cliente: i64,
    pub nombre: String,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub telefono: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}
