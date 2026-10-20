//! Contratos (DTOs) de la frontera UI<->Rust para **reservas**.
//! Campos snake_case idénticos a los structs del backend antiguo (compat frontend).

use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ZonaDto {
    pub id_zona: String,
    pub nombre_zona: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MesaDto {
    pub id_mesa: String,
    pub id_zona: String,
    pub numero_mesa: String,
    pub capacidad: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservasMetaDto {
    pub zonas: Vec<ZonaDto>,
    pub mesas: Vec<MesaDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaDto {
    pub id_reserva: String,
    pub id_mesa: String,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: Option<String>,
    pub comensales: i64,
    /// Minutos que ocupa la mesa; `None` = la duración por defecto del negocio (RI-61).
    pub duracion_min: Option<i64>,
    pub nota: Option<String>,
    pub estado: String,
    /// De dónde vino: `TPV` (la Main o una Handy) o `WEB` (la hizo el cliente desde el widget,
    /// docs/estudios/reservas-web.md). `Reservas.Origen`.
    pub origen: String,

    /// `None` si la reserva no tiene cliente (RI-61); entonces `nombre_cliente` llega vacío.
    pub id_cliente: Option<String>,
    pub nombre_cliente: String,
    pub telefono_cliente: Option<String>,
    pub email_cliente: Option<String>,

    pub id_zona: String,
    pub numero_mesa: String,
    pub capacidad: i64,
    pub nombre_zona: String,
}

/// Argumentos del rango mensual.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReservasGetMesArgs {
    pub desde: String,
    pub hasta: String,
}

/// Entrada de guardado de reserva (Local-First: sin op_id/outbox/remote_id).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReservaSaveInput {
    #[serde(default)]
    pub id_reserva: Option<String>,

    pub dia_ymd: String,
    pub hora: String,
    #[serde(default)]
    pub turno: Option<String>,

    pub comensales: i64,
    /// RI-61: minutos que ocupa la mesa. Sin ella, la duración por defecto del negocio.
    #[serde(default)]
    pub duracion_min: Option<i64>,
    /// RI-61: guardar aunque se pise con otra reserva de la mesa (o con una comanda abierta). Lo
    /// manda la pantalla después de enseñar el aviso `reserva_solapada` y de que se confirme. Con
    /// los solapes prohibidos no sirve de nada.
    #[serde(default)]
    pub forzar_solape: Option<bool>,
    #[serde(default)]
    pub nota: Option<String>,
    // El estado no viaja: una reserva nueva nace PROXIMA y una que se edita conserva el suyo. Lo
    // cambian sólo sus acciones (llegar, irse, cancelar, no vino).

    #[serde(default)]
    pub id_mesa: Option<String>,

    /// RI-61: el cliente es opcional y explícito. `id_cliente` asigna uno que ya existe (lo que se
    /// escriba abajo sólo rellena sus huecos); sin id, un `nombre_cliente` crea uno nuevo; y sin
    /// nada, la reserva va sin cliente. Antes de asignar por teléfono o email, la pantalla pregunta
    /// con `reservas_buscar_cliente`.
    #[serde(default)]
    pub id_cliente: Option<String>,
    #[serde(default)]
    pub nombre_cliente: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// RI-61: ¿el teléfono o el email que se acaban de escribir ya son de un cliente? Se pregunta antes
/// de guardar, para que la pantalla ofrezca asignarle la reserva en vez de hacerlo por detrás.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReservaBuscarClienteArgs {
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// El cliente que ya tiene ese teléfono o ese email. Se busca primero por email, que identifica
/// (índice único), y luego por teléfono. `coincide_por` es `"email"` o `"telefono"`: con el email
/// no cabe «es otra persona», porque dos clientes no pueden compartirlo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct ClienteCoincidente {
    pub id_cliente: String,
    pub nombre: String,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub coincide_por: String,
}

/// Entrada de borrado de reserva.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReservaDeleteInput {
    pub id_reserva: String,
}

/// Cancelar una reserva que aún no ha llegado: se queda en la lista, cancelada, y deja libre la
/// mesa. A la de una reserva web le llega un correo (docs/estudios/reservas-web.md §5.6).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReservaCancelarInput {
    pub id_reserva: String,
}
