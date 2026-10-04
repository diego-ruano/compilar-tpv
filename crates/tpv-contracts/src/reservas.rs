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
    /// Minutos que ocupa la mesa; `None` = la duración por defecto del negocio (RI-61).
    #[ts(type = "number | null")]
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub estado: String,

    /// `None` si la reserva no tiene cliente (RI-61); entonces `nombre_cliente` llega vacío.
    pub id_cliente: Option<String>,
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
    /// RI-61: minutos que ocupa la mesa. Sin ella, la duración por defecto del negocio.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub duracion_min: Option<i64>,
    /// RI-61: guardar aunque se pise con otra reserva de la mesa (o con una comanda abierta). Lo
    /// manda la pantalla después de enseñar el aviso `reserva_solapada` y de que se confirme. Con
    /// los solapes prohibidos no sirve de nada.
    #[serde(default)]
    #[ts(optional)]
    pub forzar_solape: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub nota: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub estado: Option<String>,

    #[serde(default)]
    #[ts(optional)]
    pub id_mesa: Option<String>,

    /// RI-61: el cliente es opcional y explícito. `id_cliente` asigna uno que ya existe (lo que se
    /// escriba abajo sólo rellena sus huecos); sin id, un `nombre_cliente` crea uno nuevo; y sin
    /// nada, la reserva va sin cliente. Antes de asignar por teléfono o email, la pantalla pregunta
    /// con `reservas_buscar_cliente`.
    #[serde(default)]
    #[ts(optional)]
    pub id_cliente: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub nombre_cliente: Option<String>,
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

/// RI-61: ¿el teléfono o el email que se acaban de escribir ya son de un cliente? Se pregunta antes
/// de guardar, para que la pantalla ofrezca asignarle la reserva en vez de hacerlo por detrás.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservaBuscarClienteArgs {
    #[serde(default)]
    #[ts(optional)]
    pub telefono: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
}

/// El cliente que ya tiene ese teléfono o ese email. Se busca primero por email, que identifica
/// (índice único), y luego por teléfono. `coincide_por` es `"email"` o `"telefono"`: con el email
/// no cabe «es otra persona», porque dos clientes no pueden compartirlo.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ClienteCoincidente {
    pub id_cliente: String,
    pub nombre: String,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub coincide_por: String,
}

/// Entrada de borrado de reserva.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReservaDeleteInput {
    pub id_reserva: String,
}
