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
    /// Sólo lo manda el camino que llega CON sesión (el Handy, vía worker). El setup del primer
    /// arranque ocurre ANTES del login: ahí no hay PIN que confirmar y el permiso es otro
    /// (`Requiere_Setup`), así que llega vacío.
    #[serde(default)]
    #[ts(optional)]
    pub pin_actual: Option<String>,
    pub pin_nuevo: String,
    pub email_nuevo: String,
}

/// ¿Queda por hacer el setup inicial? Se consulta SIN sesión, al arrancar, para decidir cuál es la
/// primera pantalla: elegir PIN, recuperar los datos, o el login de siempre.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SetupPendiente {
    pub pendiente: bool,
    /// La BD local no tiene NI UN usuario. En una instalación nueva es imposible (el arranque
    /// siembra el admin), así que sólo se llega aquí por la guardia de aprovisionamiento: el
    /// dispositivo tiene licencia pero ha perdido su `data.db`. La primera pantalla es la de
    /// recuperación, que reconstruye la BD desde la nube.
    #[serde(default)]
    pub requiere_recuperacion: bool,
    #[ts(optional)]
    pub id_usuario: Option<String>,
    #[ts(optional)]
    pub nombre: Option<String>,
    #[ts(optional)]
    pub email: Option<String>,
}

/* =========================================================
   Recuperar el PIN de un administrador (LOGIN-07)
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SolicitarCodigoPinInput {
    pub id_usuario: String,
}

/// Un código por correo ya va de camino (recuperar el PIN o confirmar un correo de recuperación).
/// Sólo la pista del correo: el correo entero no sale de la nube.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CodigoEnviado {
    /// `a***@bar.com`.
    pub email_hint: String,
    #[ts(type = "number")]
    pub minutos: i64,
    /// Segundos hasta poder pedir otro. La pantalla cuenta atrás con esto; quien manda es el worker.
    #[serde(default)]
    #[ts(type = "number")]
    pub reenvio_segundos: i64,
    /// Sólo al cambiar el correo de recuperación: el pedido ya era el actual, así que no se ha
    /// enviado nada ni hay que confirmar.
    #[serde(default)]
    pub sin_cambios: bool,
}

/// Código y PIN nuevo van JUNTOS, en un solo comando: si verificar el código y guardar el PIN
/// fueran dos llamadas, cualquiera con el IPC podría hacer sólo la segunda.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConfirmarCodigoPinInput {
    pub id_usuario: String,
    pub codigo: String,
    pub pin_nuevo: String,
}

/* =========================================================
   Correo de recuperación (LOGIN-08)
========================================================= */

/// A dónde llegan los códigos para recuperar el PIN.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EstadoCorreoRecuperacion {
    /// `a***@bar.com`.
    pub email_hint: String,
    /// `true` mientras nadie lo haya cambiado: es el correo con el que se compró la licencia.
    pub es_el_de_la_compra: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SolicitarCambioCorreoInput {
    pub correo: String,
}

/// Sólo el código: la dirección que queda confirmada es la que se pidió, guardada en la nube.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConfirmarCambioCorreoInput {
    pub codigo: String,
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
