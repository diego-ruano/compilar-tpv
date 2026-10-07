//! Contratos (DTOs) de la frontera UI<->Rust para **licensing / pairing / identidad de
//! dispositivo**. No SQLite: estado en fichero (`license_state.json`), keyring y HTTP.
//!
//! `LicenseLocalState` se unifica aquí: serializa snake_case (lo que escribe el cliente)
//! y acepta alias camelCase al leer (compat con ficheros antiguos / lecturas de pairing).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* =========================================================
   Estado de licencia (fichero local)
========================================================= */

/// Estado local NO sensible de la licencia (fichero `license_state.json`). El **token** de sesión
/// NO está aquí: es una credencial y vive solo en el keyring del SO (ver `device::*_license_token`).
/// Nada lee el token de este fichero.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseLocalState {
    #[serde(alias = "tenantId")]
    pub tenant_id: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    pub status: Option<String>,
    /// Caducidad en texto ISO (informativo para la UI).
    #[serde(alias = "expiresAt")]
    pub expires_at: Option<String>,
    /// Caducidad absoluta en ms. Es el dato con el que la UI calcula los días restantes del
    /// banner de aviso; lo fija el servidor (firmado) en cada `/status`.
    #[serde(alias = "expiresAtMs")]
    #[ts(type = "number | null")]
    pub expires_at_ms: Option<i64>,
    /// Plan de la licencia (`standard`). Lo refresca `/status`.
    pub plan: Option<String>,
    #[serde(alias = "lastServerTimeMs")]
    #[ts(type = "number | null")]
    pub last_server_time_ms: Option<i64>,
    #[serde(alias = "lastCheckOkMs")]
    #[ts(type = "number | null")]
    pub last_check_ok_ms: Option<i64>,
    #[serde(alias = "lastCheckAttemptMs")]
    #[ts(type = "number | null")]
    pub last_check_attempt_ms: Option<i64>,
    #[serde(alias = "activatedAtMs")]
    #[ts(type = "number")]
    pub activated_at_ms: i64,
    /// RI-36: tiempo sin conexión ya gastado desde la última comprobación correcta, contado de forma
    /// que atrasar el reloj del equipo no lo devuelva (`tpv_domain::licensing::sumar_tiempo_sin_conexion`).
    /// `None` en un fichero de antes: cuenta como cero.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub offline_consumido_ms: Option<i64>,
    /// RI-36: hora del reloj de pared de la última vez que se contó ese tiempo.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub marca_tiempo_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseGateResult {
    pub allowed: bool,
    pub reason: String,
    pub state: Option<LicenseLocalState>,
    /// Por qué se quedó este equipo sin licencia, cuando fue el servidor quien la rechazó
    /// (`revoked`, `device_replaced`, `license_not_found`…). Sólo viene si NO hay `state`: es lo
    /// que permite que la pantalla de activación explique por qué se está ahí en vez de parecer un
    /// primer arranque.
    #[ts(optional)]
    pub last_rejection: Option<String>,
}

/* =========================================================
   Cabeceras firmadas / identidad
========================================================= */

/// Cabeceras firmadas para tpv-server (campos camelCase, compat frontend).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ApiSignedHeaders {
    pub authorization: String,
    #[serde(rename = "xDeviceTs")]
    pub x_device_ts: String,
    #[serde(rename = "xDeviceSig")]
    pub x_device_sig: String,
}

/// Resultado de `POST /v1/pair/create`: código de emparejamiento recién generado por el
/// worker. Campos camelCase (compat frontend: `pairCode`/`pairSecret`/`expiresAtMs`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PairCreateResult {
    pub ok: bool,
    pub pair_code: String,
    pub pair_secret: String,
    #[ts(type = "number")]
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct FirmaDispositivo {
    #[ts(type = "number")]
    pub ts: i64,
    pub sig_b64: String,
}


/* =========================================================
   Args / Inputs
========================================================= */

/// Datos del formulario de activación. `activation_key` y `business_name` son los únicos
/// obligatorios; el resto son datos de contacto del negocio.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseActivateInput {
    pub activation_key: String,
    pub business_name: String,
    #[serde(default)]
    #[ts(optional)]
    pub legal_name: Option<String>,
    // Sin `email`, a propósito (LOGIN-08): el correo de recuperación es el de la compra hasta que
    // alguien lo cambie verificándolo desde Configuración → Licencia.
    #[serde(default)]
    #[ts(optional)]
    pub phone: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub country: Option<String>,
    /// Código de 6 dígitos del email. Solo hace falta al mover la licencia a otro equipo.
    #[serde(default)]
    #[ts(optional)]
    pub device_change_code: Option<String>,
}

/// Resultado de `license_activate`. Si la licencia ya estaba en otro equipo, `outcome` es
/// `"device_change_required"` y llega la pista del email para pedir el código; en el caso normal
/// es `"activated"` con el estado ya guardado.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseActivateOutcome {
    pub outcome: String,
    pub state: Option<LicenseLocalState>,
    #[ts(optional)]
    pub email_hint: Option<String>,
    /// La licencia se ha trasladado desde otro equipo: los datos de éste se traen de la nube.
    #[serde(default)]
    pub cambio_de_equipo: bool,
    /// REV-13 · El código ha sumado su tiempo a la licencia que este equipo ya tenía, en vez de
    /// estrenar un negocio nuevo. La pantalla lo dice con otras palabras («se han añadido N
    /// meses») y no hay nada más que hacer.
    #[serde(default)]
    pub tiempo_sumado: bool,
}

/// Args de `license_sumar_clave` (RI-52): una clave sin estrenar cuyo tiempo se suma a la licencia
/// de este equipo, desde Configuración → Licencia.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseSumarClaveInput {
    pub activation_key: String,
}

/// Args de `license_request_device_change`: pide al servidor que mande el OTP al email de la
/// licencia. El `device_id` lo pone el backend (es el de este equipo).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseDeviceChangeInput {
    pub activation_key: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct HandySetTokenArgs {
    pub token: String,
    pub tenant_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeviceFirmarEmparejamientoArgs {
    pub accion: AccionEmparejamiento,
    pub pair_code: String,
    pub nonce_b64: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub enum AccionEmparejamiento {
    #[serde(rename = "PAIR_FETCH")]
    Consultar,
    #[serde(rename = "PAIR_CANCEL")]
    Cancelar,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TpvServerSignedHeadersArgs {
    pub mode: String,
    pub method: String,
    pub path: String,
    /// Cuerpo exacto que se enviará con esas cabeceras (vacío si la petición no lleva). Entra en
    /// la firma (FABLE-E): pedir cabeceras para un cuerpo y mandar otro da 401 en el worker.
    #[serde(default)]
    #[ts(optional)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TpvServerPostJsonArgs {
    pub mode: String,
    pub path: String,
    #[ts(type = "unknown")]
    pub body: serde_json::Value,
}

/// Args para subir el setup inicial de la Main a la nube (tras "Guardar y continuar" en el
/// panel de configuración inicial). El `pin` viaja firmado y se hashea en el worker.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UploadInitialSetupArgs {
    // ID UUIDv7 (texto), igual que en el resto del sistema y en el worker (`idStr`).
    pub id_usuario: String,
    pub email: String,
    pub pin: String,
}
