//! Puertos de **licensing** e **identidad de dispositivo / pairing**.
//!
//! No SQLite: el adaptador (tpv-infra-licensing) gestiona keyring (clave ed25519 y tokens),
//! el fichero `license_state.json` y las llamadas HTTP a los workers. El comando Tauri
//! resuelve el directorio de datos (AppData) y construye el adaptador con esa ruta.

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use tpv_contracts::licensing::{
    ApiAuthHeaders, ApiSignedHeaders, DeviceIdentity, LicenseActivateInput, LicenseGateResult,
    LicenseLocalState, PairCreateResult, SigB64,
};

use crate::error::AppResult;

/// Servicio de licenciamiento (activación + verificación + estado local).
#[async_trait]
pub trait LicensingService: Send + Sync {
    /// Estado local de licencia (lee `license_state.json`).
    fn get_state(&self) -> AppResult<Option<LicenseLocalState>>;
    /// Borra el estado local de licencia.
    fn clear_state(&self) -> AppResult<()>;
    /// Cabeceras de auth firmadas para el worker de licencias.
    fn auth_headers(&self, method: &str, path: &str) -> AppResult<ApiAuthHeaders>;
    /// Activa la licencia contra el worker y persiste el estado.
    async fn activate(&self, input: LicenseActivateInput) -> AppResult<LicenseLocalState>;
    /// Verifica la licencia (gate). `force_network` fuerza la comprobación online.
    async fn gate(&self, force_network: bool) -> AppResult<LicenseGateResult>;
}

/// Servicio de identidad de dispositivo / pairing (claves, firma, handy token, tpv-server).
#[async_trait]
pub trait PairingService: Send + Sync {
    fn device_identity(&self) -> AppResult<DeviceIdentity>;
    fn device_sign_b64(&self, payload: &str) -> AppResult<SigB64>;
    fn handy_set_token(&self, token: &str, tenant_id: &str) -> AppResult<()>;
    fn handy_clear_token(&self) -> AppResult<()>;
    fn handy_get_tenant(&self) -> AppResult<Option<String>>;
    /// Cabeceras firmadas para tpv-server según el modo (anon|tpv|handy).
    fn tpv_server_signed_headers(
        &self,
        mode: &str,
        method: &str,
        path: &str,
    ) -> AppResult<ApiSignedHeaders>;
    /// POST JSON al worker tpv-server (evita CORS/WebView).
    async fn tpv_server_post_json(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<JsonValue>;
    /// Solicita al worker un nuevo código de emparejamiento (modo `tpv`, firmado).
    /// Lo expone tipado a la UI para que el Main lo muestre (QR + código).
    async fn pair_create(&self) -> AppResult<PairCreateResult>;
}
