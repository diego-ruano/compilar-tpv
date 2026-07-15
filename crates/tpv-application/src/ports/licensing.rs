//! Puertos de **licensing** e **identidad de dispositivo / pairing**.
//!
//! No SQLite: el adaptador (tpv-infra-licensing) gestiona keyring (clave ed25519 y tokens),
//! el fichero `license_state.json` y las llamadas HTTP a los workers. El comando Tauri
//! resuelve el directorio de datos (AppData) y construye el adaptador con esa ruta.

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use tpv_domain::licensing::{
    EstadoVerificado, FalloConsulta, ResultadoActivacion, SolicitudActivacion,
};

use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, HandyWsAuth, LicenseLocalState, PairCreateResult, SigB64,
};

use crate::error::AppResult;

/// Servicio de licenciamiento: **transporte y almacén**, sin política.
///
/// El adaptador trae datos del servidor (incluida la verificación ed25519 de la firma, que es
/// cripto: no cabe en el dominio puro) y lee/escribe `license_state.json`. Quién puede usar el
/// TPV lo decide el dominio (`tpv_domain::licensing`) y lo orquesta el caso de uso.
#[async_trait]
pub trait LicensingService: Send + Sync {
    /// Lee el estado local. `None` si este dispositivo no tiene licencia activada.
    fn load_state(&self) -> AppResult<Option<LicenseLocalState>>;
    /// Persiste el estado local.
    fn save_state(&self, state: &LicenseLocalState) -> AppResult<()>;
    /// Borra el estado local.
    fn delete_state(&self) -> AppResult<()>;

    /// Canjea la clave en el servidor. Persiste el **token** concedido en el keyring (es una
    /// credencial, no estado), pero no escribe `license_state.json` (eso lo hace el caso de uso con
    /// `save_state`). `device_change_code` solo se envía al mover la licencia a otro equipo (§6.4);
    /// el servidor puede responder pidiéndolo.
    async fn activar_remoto(
        &self,
        solicitud: &SolicitudActivacion,
        device_change_code: Option<&str>,
    ) -> AppResult<ResultadoActivacion>;

    /// Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia.
    async fn solicitar_cambio_dispositivo(&self, clave: &str) -> AppResult<()>;

    /// Consulta el estado de la licencia (petición firmada con el token del keyring) y **verifica
    /// la firma ed25519** contra la clave pública pineada antes de devolverla. Si el token de sesión
    /// ha caducado, lo renueva de forma transparente por device-proof (`/refresh`) y reintenta; el
    /// token renovado se guarda en el keyring. El `Err` está clasificado para que el dominio sepa
    /// qué significa el fallo.
    async fn consultar_estado(
        &self,
        state: &LicenseLocalState,
    ) -> Result<EstadoVerificado, FalloConsulta>;
}

/// Servicio de identidad de dispositivo / pairing (claves, firma, handy token, tpv-server).
#[async_trait]
pub trait PairingService: Send + Sync {
    fn device_identity(&self) -> AppResult<DeviceIdentity>;
    fn device_sign_b64(&self, payload: &str) -> AppResult<SigB64>;
    fn handy_set_token(&self, token: &str, tenant_id: &str) -> AppResult<()>;
    fn handy_clear_token(&self) -> AppResult<()>;
    fn handy_get_tenant(&self) -> AppResult<Option<String>>;
    /// Credenciales (token + tenant) para abrir el WebSocket del Handy. Error si no hay token.
    fn handy_get_ws_auth(&self) -> AppResult<HandyWsAuth>;
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

    /// Sube los bytes de una imagen al worker (PUT firmado) → bucket R2. `path` es el path
    /// canónico (`/v1/images/images/{subcarpeta}/{archivo}`); el tenant lo deriva el worker
    /// del token, no del cliente. `mode` es el de firma (`tpv`|`handy`).
    async fn upload_image(
        &self,
        mode: &str,
        path: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> AppResult<()>;

    /// Borra una imagen del bucket R2 (DELETE firmado). `path` igual que en `upload_image`.
    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()>;

    /// Descarga los bytes de una imagen desde R2 (POST firmado a `/v1/images/download`). El
    /// tenant lo deriva el worker del token; `rel_path` es la ruta relativa de BD
    /// (`images/{subcarpeta}/{archivo}`). Devuelve `None` si el objeto aún no existe (404).
    async fn download_image(&self, mode: &str, rel_path: &str) -> AppResult<Option<Vec<u8>>>;
}
