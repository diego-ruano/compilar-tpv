//! Contratos (DTOs) de la frontera UI<->Rust para **clientes**.
//!
//! Los nombres de campo son snake_case e IDÉNTICOS a los structs del backend antiguo
//! (`ClienteRow`, `ClienteFormRow`, …) para que el frontend actual siga funcionando sin
//! cambios. Los IDs `i64` se anotan `` (los ID de SQLite caben en
//! number) para mantener compatibilidad con el frontend (que usa `number`, no `bigint`).

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
/// Fila del overview de clientes (read model con campos calculados).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClienteOverview {
    pub id_cliente: String,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,

    pub ultima_reserva_fecha: Option<String>,
    pub ultima_reserva_hora: Option<String>,
    pub ultima_reserva_num_personas: Option<i64>,
    pub ultima_reserva_mesa: Option<String>,

    pub total_gastado_stored: Dinero,

    pub total_reservas: i64,
    pub reservas_pendientes: i64,
}

/// Datos del formulario de edición de un cliente.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ClienteForm {
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/// Argumentos del overview.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ClientesOverviewArgs {
    pub ranking: String,
}

/// Argumento con sólo el id de cliente.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ClienteIdArgs {
    pub id_cliente: String,
}

/// Entrada para crear un cliente (Local-First: sin op_id ni outbox).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CreateClienteInput {
    #[serde(default)]
    pub id_cliente: Option<String>,
    pub nombre: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}

/// Entrada para actualizar un cliente (Local-First: sin op_id ni outbox).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct UpdateClienteInput {
    pub id_cliente: String,
    pub nombre: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}
