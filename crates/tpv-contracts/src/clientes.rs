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
    /// FISCAL-02: los datos para facturarle, si los tiene.
    pub nif: Option<String>,
    pub razon_social: Option<String>,
    pub direccion_fiscal: Option<String>,
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
    /// FISCAL-02: los datos para facturarle. Opcionales; se normalizan como el destinatario de la
    /// factura (`tpv_domain::clientes::DatosFiscales`).
    #[serde(default)]
    pub nif: Option<String>,
    #[serde(default)]
    pub razon_social: Option<String>,
    #[serde(default)]
    pub direccion_fiscal: Option<String>,
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
    /// FISCAL-02: los datos para facturarle. Opcionales; se normalizan como el destinatario de la
    /// factura (`tpv_domain::clientes::DatosFiscales`).
    #[serde(default)]
    pub nif: Option<String>,
    #[serde(default)]
    pub razon_social: Option<String>,
    #[serde(default)]
    pub direccion_fiscal: Option<String>,
}

// ── FISCAL-02: los clientes en el formulario de la factura completa ──────────────────────────────
//
// Quien cobra puede no tener `clientes.gestionar`, y aun así tiene que poder elegir la ficha del
// cliente que pide la factura y guardarle los datos. Por eso estos dos van aparte, con el permiso del
// cobro y sólo en la Main, que es la que cobra: lo que se lee es lo justo para facturar (ni el correo
// ni el teléfono) y lo que se escribe, sólo los tres datos fiscales.

/// Una ficha de cliente, con lo que hace falta para elegirla y facturarle.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct ClienteParaFactura {
    pub id_cliente: String,
    pub nombre: String,
    pub nif: Option<String>,
    pub razon_social: Option<String>,
    pub direccion_fiscal: Option<String>,
}

/// Las fichas entre las que se elige, y la del cliente de la comanda si se sabe (el de su reserva).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct ClientesParaFactura {
    pub clientes: Vec<ClienteParaFactura>,
    pub id_cliente_de_la_comanda: Option<String>,
}

/// La comanda que se cobra, si la hay: de ella sale su cliente (comanda → reserva → cliente).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ClientesParaFacturaArgs {
    #[serde(default)]
    pub id_comanda: Option<String>,
}

/// Guardar en la ficha los datos con los que se acaba de facturar. Con `id_cliente`, se actualizan
/// los de esa ficha; sin él, los de la ficha con ese NIF y, si no hay, se da de alta una con la razón
/// social de nombre.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct GuardarDatosFiscalesInput {
    #[serde(default)]
    pub id_cliente: Option<String>,
    pub nif: String,
    pub razon_social: String,
    #[serde(default)]
    pub direccion_fiscal: Option<String>,
}
