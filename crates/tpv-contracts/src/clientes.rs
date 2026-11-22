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

// ── Las facturas de un cliente (sólo en la Main) ─────────────────────────────────────────────────
//
// La ficha enseña las facturas completas cuyo destinatario tiene el NIF de la ficha, con su PDF
// (docs/arquitectura/tickets.md § El PDF de una factura completa). Piden `clientes.gestionar`.

/// Qué es una factura completa, para nombrarla en la lista.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ClaseFactura {
    /// `F1`: la factura completa de un cobro.
    Factura,
    /// `R1`..`R5`: corrige otra.
    Rectificativa,
    /// `F3`: sustituye a uno o varios tickets (o anula una sustitutiva, en negativo).
    Sustitutiva,
}

/// Una factura completa del cliente.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct FacturaDelCliente {
    /// El registro de facturación: es lo que se pide para el PDF.
    pub id_registro: String,
    pub num_serie: String,
    /// La fecha de expedición, `DD-MM-AAAA`, como la declara la factura.
    pub fecha_expedicion: String,
    /// `F1`, `F3` o `R1`..`R5`.
    pub tipo_factura: String,
    pub clase: ClaseFactura,
    pub importe: Dinero,
    /// El cobro con el que se reimprime su papel. `None` si no está en esta base (una `F3` de
    /// tickets cuyos cobros no han bajado todavía).
    pub id_pago: Option<String>,
    /// Anulada después de emitirla (la baja de su cobro por error): fiscalmente ya no existe. La
    /// lista lo dice; su PDF es el que se emitió, sin marca (`tickets.md`).
    pub anulada: bool,
    /// El número de la factura que la sustituye tras corregir los datos del cliente (la
    /// rectificativa de una `F1`, o la `F3` nueva de una `F3`): ya no es la vigente, y la lista lo
    /// dice como dice una anulada.
    pub sustituida_por: Option<String>,
    /// En la `F3` negativa de esa corrección de una `F3`, el número de la errónea que
    /// contrarresta: la lista dice lo que es en vez de «Sustitutiva» suelta.
    pub contrarresta: Option<String>,
}

/// Las facturas de una ficha, de la más reciente a la más antigua.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct FacturasDelCliente {
    /// El NIF de la ficha, normalizado. `None` si no tiene: sin él no se sabe cuáles son las suyas.
    pub nif: Option<String>,
    pub facturas: Vec<FacturaDelCliente>,
    /// Hay más antiguas que no caben en la lista.
    pub hay_mas: bool,
}

/// El PDF de una factura completa.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct FacturaPdfArgs {
    pub id_registro: String,
}
