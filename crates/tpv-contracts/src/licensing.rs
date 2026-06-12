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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseLocalState {
    #[serde(alias = "tenantId")]
    pub tenant_id: String,
    #[serde(alias = "deviceId")]
    pub device_id: String,
    pub token: String,
    pub status: Option<String>,
    #[serde(alias = "expiresAt")]
    pub expires_at: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseGateResult {
    pub allowed: bool,
    pub reason: String,
    pub state: Option<LicenseLocalState>,
}

/* =========================================================
   Cabeceras firmadas / identidad
========================================================= */

/// Cabeceras de auth para el worker de licencias (campos snake_case).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ApiAuthHeaders {
    pub token: String,
    #[ts(type = "number")]
    pub device_ts: i64,
    pub device_sig: String,
}

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
pub struct SigB64 {
    pub sig_b64: String,
}

/// Credenciales del Handy para abrir el WebSocket con el worker (`/ws?token=`). El token
/// vive en el keyring (lo guarda el pairing); el frontend lo necesita para el query string.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct HandyWsAuth {
    pub token: String,
    pub tenant_id: String,
}

/* =========================================================
   Args / Inputs
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ApiGetAuthHeadersArgs {
    pub method: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LicenseActivateInput {
    pub activation_key: String,
    #[serde(default)]
    #[ts(optional)]
    pub restaurant_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub business_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub legal_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub display_name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub phone: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub country: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct HandySetTokenArgs {
    pub token: String,
    pub tenant_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeviceSignB64Args {
    pub payload: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TpvServerSignedHeadersArgs {
    pub mode: String,
    pub method: String,
    pub path: String,
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
    #[ts(type = "number")]
    pub id_usuario: i64,
    pub email: String,
    pub pin: String,
}
