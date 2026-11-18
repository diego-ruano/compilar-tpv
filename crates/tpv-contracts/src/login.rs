//! Contratos (DTOs) de la frontera UI<->Rust para **login / auth / fichaje**.
//! Local-First: los args de entrada NO llevan op_id/outbox. Campos snake_case idénticos
//! al backend antiguo (compat frontend).

use serde::{Deserialize, Serialize};
/* =========================================================
   Salida
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UserListItem {
    pub id_usuario: String,
    pub nombre: String,
    pub apellido: Option<String>,
    pub nombre_rol: String,
    /// Entra sin PIN: la pantalla no se lo pide y el backend no lo comprueba (`Usuarios.Sin_PIN`).
    /// `default` para que una Handy nueva siga listando contra un worker que aún no lo devuelve.
    #[serde(default)]
    pub sin_pin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LoginOk {
    pub id_usuario: String,
    pub id_trabajador: Option<String>,
    pub nombre: String,
    pub apellido: Option<String>,
    pub rol: String,
    pub email: String,
    pub requiere_setup: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PunchParte {
    pub parte: i64,
    pub entrada: Option<String>,
    pub salida: Option<String>,
    pub estado: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PunchStatus {
    pub fecha: String,
    pub turno_partido: i64,
    pub partes: Vec<PunchParte>,
    /// La jornada es de un día anterior al de hoy (un turno de noche en curso). Lo decide el
    /// backend con el mismo «hoy» con el que eligió la jornada, no la pantalla con el reloj del
    /// dispositivo, que en otra zona o cerca de medianoche decía «Jornada de ayer» de la de hoy
    /// (AUT-INC-02).
    pub jornada_anterior: bool,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct LoginUserArgs {
    pub id_usuario: String,
    pub pin: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct PunchStatusArgs {
    pub id_usuario: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SetTurnoPartidoInput {
    pub id_usuario: String,
    pub turno_partido: bool,
    #[serde(default)]
    pub fecha: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
/// El setup inicial NO lleva PIN actual (REV-06). Ocurre antes del primer login, así que no hay
/// ninguno que confirmar —el que hay es el del seed, que es público—: quien autoriza es
/// `Requiere_Setup = 1`. Llegó a viajar un `pin_actual` para el camino de la Handy, que la pantalla
/// no rellenaba nunca y que sólo servía para que la nube lo verificara sin límite de intentos.
pub struct CompleteInitialSetupInput {
    pub id_usuario: String,
    pub pin_nuevo: String,
}

/// ¿Queda por hacer el setup inicial? Se consulta SIN sesión, al arrancar, para decidir cuál es la
/// primera pantalla: elegir PIN, recuperar los datos, o el login de siempre.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SetupPendiente {
    pub pendiente: bool,
    /// La BD local no tiene NI UN usuario. En una instalación nueva es imposible (el arranque
    /// siembra el admin), así que sólo se llega aquí por la guardia de aprovisionamiento: el
    /// dispositivo tiene licencia pero ha perdido su `data.db`. La primera pantalla es la de
    /// recuperación, que reconstruye la BD desde la nube.
    #[serde(default)]
    pub requiere_recuperacion: bool,
    pub id_usuario: Option<String>,
    pub nombre: Option<String>,
}

/* =========================================================
   Recuperar el PIN de un administrador (LOGIN-07)
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SolicitarCodigoPinInput {
    pub id_usuario: String,
}

/// Un código por correo ya va de camino (recuperar el PIN o confirmar un correo de recuperación).
/// Sólo la pista del correo: el correo entero no sale de la nube.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CodigoEnviado {
    /// `a***@bar.com`.
    pub email_hint: String,
    pub minutos: i64,
    /// Segundos hasta poder pedir otro. La pantalla cuenta atrás con esto; quien manda es el worker.
    #[serde(default)]
    pub reenvio_segundos: i64,
    /// Sólo al cambiar el correo de recuperación: el pedido ya era el actual, así que no se ha
    /// enviado nada ni hay que confirmar.
    #[serde(default)]
    pub sin_cambios: bool,
}

/// Código y PIN nuevo van JUNTOS, en un solo comando: si verificar el código y guardar el PIN
/// fueran dos llamadas, cualquiera con el IPC podría hacer sólo la segunda.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ConfirmarCodigoPinInput {
    pub id_usuario: String,
    pub codigo: String,
    pub pin_nuevo: String,
}

/* =========================================================
   Correo de recuperación (LOGIN-08)
========================================================= */

/// A dónde llegan los códigos para recuperar el PIN.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EstadoCorreoRecuperacion {
    /// `a***@bar.com`.
    pub email_hint: String,
    /// `true` mientras nadie lo haya cambiado: es el correo con el que se compró la licencia.
    pub es_el_de_la_compra: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SolicitarCambioCorreoInput {
    pub correo: String,
}

/// Sólo el código: la dirección que queda confirmada es la que se pidió, guardada en la nube.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ConfirmarCambioCorreoInput {
    pub codigo: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
/// El fichaje NO lleva fecha ni hora: las pone el equipo que ficha — la Main con su reloj, y la
/// Handy con el suyo vía `X-Client-Now` (CFG-04/REV-03). Estuvieron aquí, el TPV las calculaba y
/// las mandaba en cada fichaje, y los cuatro sitios que las recibían las descartaban. Un campo que
/// se envía y nadie lee es peor que no tenerlo: el día que alguien lo cablee, el control horario
/// pasa a creerse un valor del cuerpo de la petición, que es cualquier cosa.
pub struct PunchInput {
    pub id_usuario: String,
    pub pin: String,
    pub tipo: String,
}
