//! # tpv-infra-licensing
//!
//! Adaptador de **licenciamiento e identidad de dispositivo**: clave ed25519 (keyring), firma
//! de cabeceras, fichero `license_state.json` y llamadas HTTP (reqwest) al worker `tpv-api`.
//! Implementa los puertos `LicensingService` / `PairingService` de `tpv-application`.
//!
//! Aquí **no se decide nada**: la política del gate (qué licencia vale, cuánta gracia offline
//! hay, cuándo se descarta el estado local) vive en `tpv_domain::licensing` y la orquesta
//! `tpv_application::use_cases::licensing`. Este adaptador trae los datos y ejecuta la acción.
//!
//! NO depende de Tauri: el directorio de datos (AppData) lo inyecta el comando al construirlo.

pub mod device;
mod secret_store;

/// Reexport para que el `JNI_OnLoad` del cdylib de la app pueda inicializar la `JavaVM` del proceso,
/// que el almacén de secretos de Android (Keystore) necesita. En otras plataformas no existe.
#[cfg(target_os = "android")]
pub use secret_store::init_java_vm;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cloud_sync::CloudSyncService;
use tpv_application::ports::licensing::{LicensingService, PairingService};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, HandyWsAuth, LicenseLocalState, PairCreateResult, SigB64,
};
use tpv_domain::licensing::{
    self as dom, AssertionVerificada, Concesion, EstadoLicencia, EstadoVerificado, FalloConsulta,
    ResultadoActivacion, SolicitudActivacion,
};

use device::{
    clear_license_token, get_handy_token, get_license_token, get_or_create_device_id,
    get_or_create_device_keypair, set_license_token, sign_device_proof, sign_payload_b64,
};

/// Worker unificado `tpv-api` (fusión de los antiguos `tpv-licensing` + `tpv-server`): sirve
/// licencia (`/v1/license/*`), pairing (`/v1/pair/*`), revoke, imágenes, WS y el DO TenantHub.
/// Es el **único** host de la nube: `tpv-infra-http` lo reexporta para el resto del backend.
pub const CLOUD_API_BASE: &str = "https://tpv-api.altarialights.workers.dev";

/// Clave pública ed25519 (base64) con la que el worker firma el estado de licencia. Va **pineada**
/// en el binario: no se descarga de ningún sitio. Es lo que cierra LIC-01 —un servidor falso, un
/// MITM con CA de confianza o un DNS envenenado no tienen la privada, así que no pueden forjar un
/// `active`. La privada vive SOLO en el worker (secreto `LICENSE_SIGNING_PRIVATE_KEY`).
///
/// Rotarla invalida a todos los clientes con esta versión: para rotar sin cortar, pinear dos
/// claves a la vez durante una ventana (§5.7 del plan). Generada con `pnpm license:keypair`.
pub const LICENSE_SIGNING_PUBLIC_KEY_B64: &str = "WKG8YsOKSGSDhzauiqeMih0zCwNhwYRVQOE4Ywcvm1I=";

const HTTP_TIMEOUT_SECS: u64 = 20;

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

fn ext(e: impl std::fmt::Display) -> AppError {
    AppError::external(e.to_string())
}

/* ===== Estado local (license_state.json) ===== */

fn license_state_path(dir: &Path) -> PathBuf {
    dir.join("license_state.json")
}

fn load_state(dir: &Path) -> Option<LicenseLocalState> {
    let txt = fs::read_to_string(license_state_path(dir)).ok()?;
    serde_json::from_str::<LicenseLocalState>(&txt).ok()
}

fn save_state(dir: &Path, st: &LicenseLocalState) -> AppResult<()> {
    let p = license_state_path(dir);
    let txt = serde_json::to_string_pretty(st).map_err(ext)?;
    fs::write(&p, txt).map_err(|e| ext(format!("Error escribiendo {:?}: {e}", p)))?;
    Ok(())
}

fn delete_state(dir: &Path) -> AppResult<()> {
    let p = license_state_path(dir);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| ext(format!("Error borrando {:?}: {e}", p)))?;
    }
    Ok(())
}

/* ===== HTTP ===== */

fn http_client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| ext(format!("Error creando HTTP client: {e}")))
}

fn api_url(path: &str) -> String {
    format!("{}{}", CLOUD_API_BASE.trim_end_matches('/'), path)
}

/* ===== Tipos de la API de licencias (internos del adaptador) ===== */

/// Respuesta de error del worker: `{ ok:false, error, details? }`.
#[derive(Debug, Deserialize)]
struct ApiErr {
    error: String,
    details: Option<JsonValue>,
}

impl ApiErr {
    fn parse(text: &str) -> Option<Self> {
        serde_json::from_str::<ApiErr>(text).ok()
    }
}

/// Respuesta OK de `/v1/license/activate`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateOk {
    ok: bool,
    tenant_id: String,
    token: String,
    status: String,
    expires_at: Option<String>,
    device_id: Option<String>,
}

/// Datos del negocio que acompañan a la activación (el worker los espera en camelCase).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TenantInfo<'a> {
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    legal_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phone: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    country: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivateReq<'a> {
    activation_key: &'a str,
    device_id: &'a str,
    device_pub_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_change_code: Option<&'a str>,
    tenant_info: TenantInfo<'a>,
}

/// Respuesta de `/v1/license/status`: la aserción firmada + token renovado + info no crítica.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusOk {
    #[allow(dead_code)]
    ok: bool,
    assertion: SignedAssertionDto,
    token: Option<String>,
    server_time: i64,
}

/// La aserción tal cual viaja por el cable. La firma se verifica antes de creerse nada.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedAssertionDto {
    v: u8,
    tenant_id: String,
    device_id: String,
    license_id: String,
    state: String,
    plan: String,
    expires_at_ms: Option<i64>,
    issued_at_ms: i64,
    assertion_expires_at_ms: i64,
    client_ts: i64,
    sig: String,
}

#[derive(Debug, Deserialize)]
struct RefreshOk {
    token: String,
}

/* =========================================================
   Verificación de la firma (el control central del gate)
========================================================= */

fn pinned_verifying_key() -> Result<VerifyingKey, FalloConsulta> {
    let bytes = B64
        .decode(LICENSE_SIGNING_PUBLIC_KEY_B64)
        .map_err(|_| FalloConsulta::FirmaInvalida)?;
    let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| FalloConsulta::FirmaInvalida)?;
    VerifyingKey::from_bytes(&arr).map_err(|_| FalloConsulta::FirmaInvalida)
}

/// Verifica la firma ed25519 contra la clave pineada, comprueba que la aserción es de ESTA
/// petición (`client_ts`) y que no ha caducado, y solo entonces construye el estado de fiar.
fn verificar_assertion(
    dto: SignedAssertionDto,
    client_ts_enviado: i64,
    ahora_ms: i64,
) -> Result<AssertionVerificada, FalloConsulta> {
    let estado = EstadoLicencia::from_code(&dto.state).ok_or_else(|| FalloConsulta::Ilegible {
        detalle: format!("estado_desconocido: {}", dto.state),
    })?;

    let assertion = AssertionVerificada {
        version: dto.v,
        tenant_id: dto.tenant_id,
        device_id: dto.device_id,
        license_id: dto.license_id,
        estado,
        plan: dto.plan,
        expires_at_ms: dto.expires_at_ms,
        issued_at_ms: dto.issued_at_ms,
        assertion_expires_at_ms: dto.assertion_expires_at_ms,
        client_ts: dto.client_ts,
    };

    let vk = pinned_verifying_key()?;
    let sig_bytes = B64.decode(&dto.sig).map_err(|_| FalloConsulta::FirmaInvalida)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| FalloConsulta::FirmaInvalida)?;

    let msg = dom::mensaje_canonico(&assertion);
    vk.verify(msg.as_bytes(), &sig)
        .map_err(|_| FalloConsulta::FirmaInvalida)?;

    // Firma buena, pero ¿es de esta petición y sigue vigente? (anti-replay)
    if !dom::assertion_fresca(&assertion, client_ts_enviado, ahora_ms) {
        return Err(FalloConsulta::FirmaInvalida);
    }

    Ok(assertion)
}

/// Clasifica el error del worker según lo que implica para el gate: un rechazo definitivo de la
/// licencia (borra) vs. una incidencia de auth/reloj (se trata como offline, no borra).
fn clasificar_error(http: u16, code: &str) -> FalloConsulta {
    match code {
        // La licencia ya no vale en este equipo: hay que borrar el estado local.
        "license_not_found" | "license_revoked" | "device_replaced" => {
            FalloConsulta::Rechazada { code: code.to_string() }
        }
        // Todo lo demás (token/reloj/proof/5xx): transitorio o ambiguo. No se tira la licencia;
        // decide la gracia offline. Si persiste > 72 h, la gracia expira y bloquea igual.
        _ => {
            let _ = http;
            FalloConsulta::Inalcanzable
        }
    }
}

/* =========================================================
   LicensingAdapter
========================================================= */

pub struct LicensingAdapter {
    app_data_dir: PathBuf,
}

impl LicensingAdapter {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    /// Guarda en el keyring el token de sesión efectivo tras un `/status`: el que renovó el
    /// servidor (`renovado`) o, si no vino, el que ya se estaba usando (`actual`). Un fallo de
    /// escritura del keyring no invalida el gate (la petición ya se hizo con el token válido): se
    /// ignora y se reintentará en la siguiente comprobación.
    fn persistir_token(&self, renovado: Option<&str>, actual: &str) {
        let efectivo = renovado.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(actual);
        let _ = set_license_token(efectivo);
    }

    /// GET `/v1/license/status` firmado con device-proof. Devuelve el cuerpo parseado, o el error
    /// ya clasificado. NO verifica la firma todavía (eso es del llamante, que conoce el `ts`).
    async fn get_status(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<(StatusOk, i64), FalloConsulta> {
        const PATH: &str = "/v1/license/status";

        // Un fallo local (keyring, firma, cliente HTTP) es indistinguible de no tener red para el
        // gate: en ambos casos no sabemos qué dice el servidor → `Inalcanzable` (gracia offline).
        let client = http_client().map_err(|_| FalloConsulta::Inalcanzable)?;
        let ts = now_ms();

        let (sk, _) =
            get_or_create_device_keypair(device_id).map_err(|_| FalloConsulta::Inalcanzable)?;
        // GET sin cuerpo → se firma la cadena vacía.
        let sig = sign_device_proof(&sk, ts, "GET", PATH, token, b"")
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let resp = client
            .get(api_url(PATH))
            .bearer_auth(token)
            .header("X-Device-Ts", ts.to_string())
            .header("X-Device-Sig", sig)
            .send()
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let http = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if !(200..300).contains(&http) {
            let code = ApiErr::parse(&text).map(|e| e.error).unwrap_or_default();
            return Err(clasificar_error(http, &code));
        }

        let ok: StatusOk = serde_json::from_str(&text).map_err(|e| FalloConsulta::Ilegible {
            detalle: format!("invalid_json: {e} | body={text}"),
        })?;

        Ok((ok, ts))
    }

    /// POST `/v1/license/refresh` (device-proof). Reemite el token de sesión cuando el viejo ha
    /// caducado. `Ok(None)` si el refresco falló por red (se cae a la gracia offline).
    async fn refrescar_token(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<String, FalloConsulta> {
        const PATH: &str = "/v1/license/refresh";

        let client = http_client().map_err(|_| FalloConsulta::Inalcanzable)?;
        let ts = now_ms();

        let (sk, _) =
            get_or_create_device_keypair(device_id).map_err(|_| FalloConsulta::Inalcanzable)?;
        // `/v1/license/refresh` se manda sin cuerpo: se firma la cadena vacía.
        let sig = sign_device_proof(&sk, ts, "POST", PATH, token, b"")
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let resp = client
            .post(api_url(PATH))
            .bearer_auth(token)
            .header("X-Device-Ts", ts.to_string())
            .header("X-Device-Sig", sig)
            .send()
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let http = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if !(200..300).contains(&http) {
            let code = ApiErr::parse(&text).map(|e| e.error).unwrap_or_default();
            return Err(clasificar_error(http, &code));
        }

        serde_json::from_str::<RefreshOk>(&text)
            .map(|r| r.token)
            .map_err(|_| FalloConsulta::Inalcanzable)
    }
}

#[async_trait]
impl LicensingService for LicensingAdapter {
    fn load_state(&self) -> AppResult<Option<LicenseLocalState>> {
        Ok(load_state(&self.app_data_dir))
    }

    fn save_state(&self, state: &LicenseLocalState) -> AppResult<()> {
        save_state(&self.app_data_dir, state)
    }

    fn delete_state(&self) -> AppResult<()> {
        // Borrar la licencia también retira su credencial del keyring (si no, quedaría un token
        // huérfano y utilizable).
        clear_license_token().map_err(ext)?;
        delete_state(&self.app_data_dir)
    }

    async fn activar_remoto(
        &self,
        solicitud: &SolicitudActivacion,
        device_change_code: Option<&str>,
    ) -> AppResult<ResultadoActivacion> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (_sk, pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;

        let req = ActivateReq {
            activation_key: &solicitud.clave,
            device_id: &device_id,
            device_pub_key: &pub_b64,
            device_change_code,
            tenant_info: TenantInfo {
                display_name: &solicitud.business_name,
                legal_name: solicitud.legal_name.as_deref(),
                email: solicitud.email.as_deref(),
                phone: solicitud.phone.as_deref(),
                country: solicitud.country.as_deref(),
            },
        };

        let resp = http_client()?
            .post(api_url("/v1/license/activate"))
            .header(CONTENT_TYPE, "application/json")
            .json(&req)
            .send()
            .await
            .map_err(|e| ext(format!("No se pudo conectar con el servidor de licencias: {e}")))?;

        let http = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if !(200..300).contains(&http) {
            if let Some(e) = ApiErr::parse(&text) {
                // El servidor pide el OTP: la licencia ya está en otro Main. No es un error para el
                // usuario, es un paso más del flujo → lo devolvemos como resultado, con la pista.
                if e.error == "device_change_required" {
                    let email_hint = e
                        .details
                        .as_ref()
                        .and_then(|d| d.get("emailHint"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    return Ok(ResultadoActivacion::CambioDispositivoRequerido { email_hint });
                }

                // ARCH-05: el código sale del catálogo (a partir del `error` del worker) y el
                // texto queda como diagnóstico. Si el worker adjunta un `details` (p. ej. el
                // error de Turso en `tenant_db_provision_failed`), se anexa al mensaje para
                // que siga siendo diagnosticable en la UI, sin afectar al código.
                let detalle = e.details.as_ref().and_then(|d| match d {
                    JsonValue::String(s) => Some(s.clone()),
                    JsonValue::Null => None,
                    other => Some(other.to_string()),
                });
                let code = ErrorCode::from_wire(&e.error);
                return Err(AppError::coded(
                    code,
                    match detalle {
                        Some(d) if !d.trim().is_empty() => format!("{}: {}", e.error, d),
                        _ => e.error,
                    },
                ));
            }
            return Err(AppError::external(format!(
                "activate_failed_http_{http}: {text}"
            )));
        }

        let ok: ActivateOk = serde_json::from_str(&text)
            .map_err(|e| ext(format!("Respuesta JSON inválida del servidor: {e} | body={text}")))?;

        if !ok.ok || ok.token.trim().is_empty() || ok.tenant_id.trim().is_empty() {
            return Err(AppError::external(format!(
                "Respuesta inesperada del servidor: {text}"
            )));
        }

        // Anti-copia: el token concedido va ligado a la clave de ESTE dispositivo. Si el servidor
        // devuelve otro `deviceId`, la firma de las siguientes peticiones no cuadraría.
        if let Some(server_device) = ok.device_id.as_deref().map(str::trim) {
            if !server_device.is_empty() && server_device != device_id {
                return Err(AppError::external(
                    "deviceId mismatch (server devolvió otro deviceId)",
                ));
            }
        }

        // El token es una credencial: va directo al keyring, nunca a `license_state.json`.
        set_license_token(ok.token.trim()).map_err(ext)?;

        Ok(ResultadoActivacion::Activada(Concesion {
            tenant_id: ok.tenant_id.trim().to_string(),
            device_id,
            status: ok.status,
            expires_at: ok.expires_at,
            // La activación devuelve `expiresAt` en ISO; el número absoluto lo fija el primer
            // `/status` firmado. Aquí queda pendiente (None) hasta esa comprobación.
            expires_at_ms: None,
            plan: None,
        }))
    }

    async fn solicitar_cambio_dispositivo(&self, clave: &str) -> AppResult<()> {
        let device_id = get_or_create_device_id().map_err(ext)?;

        // La respuesta es constante (siempre 200) por diseño del worker: no filtra si la clave
        // existe. Basta con no fallar en el transporte.
        let body = serde_json::json!({ "activationKey": clave, "deviceId": device_id });

        http_client()?
            .post(api_url("/v1/license/device-change/request"))
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ext(format!("No se pudo pedir el código: {e}")))?;

        Ok(())
    }

    async fn consultar_estado(
        &self,
        state: &LicenseLocalState,
    ) -> Result<EstadoVerificado, FalloConsulta> {
        let ahora = now_ms();

        // El token vive en el keyring. Si no está, no podemos consultar: se trata como offline
        // (gracia) en vez de tirar la licencia por un problema puntual de acceso al keyring.
        let token = get_license_token().map_err(|_| FalloConsulta::Inalcanzable)?;

        // 1er intento con el token actual.
        let (ok, ts) = match self.get_status(&token, &state.device_id).await {
            Ok(v) => v,
            Err(fallo) => {
                // Un token de sesión caducado NO debe borrar la licencia: se renueva por
                // device-proof (`/refresh`) y se reintenta una vez. El worker devuelve
                // `token_expired`, que `clasificar_error` mete en `Inalcanzable`; distinguimos ese
                // caso reintentando el refresco, que sí sabe si el problema es el token.
                if !matches!(fallo, FalloConsulta::Inalcanzable) {
                    return Err(fallo);
                }
                let nuevo = self.refrescar_token(&token, &state.device_id).await?;
                let (ok, ts) = self.get_status(&nuevo, &state.device_id).await?;
                let assertion = verificar_assertion(ok.assertion, ts, ahora)?;
                // Persistir el token efectivo (el que renovó /status, o el del refresh si no).
                self.persistir_token(ok.token.as_deref(), &nuevo);
                return Ok(EstadoVerificado {
                    assertion,
                    server_time_ms: ok.server_time,
                });
            }
        };

        let assertion = verificar_assertion(ok.assertion, ts, ahora)?;
        // El worker renueva el token en cada /status: se guarda en el keyring (fin del muro de 30d).
        self.persistir_token(ok.token.as_deref(), &token);
        Ok(EstadoVerificado {
            assertion,
            server_time_ms: ok.server_time,
        })
    }
}

/* =========================================================
   PairingAdapter
========================================================= */

pub struct PairingAdapter {
    app_data_dir: PathBuf,
}

impl PairingAdapter {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    /// Token de sesión de la Main (modo `tpv`), leído del **keyring** (ya no de
    /// `license_state.json`). Es la credencial que firma las llamadas a la nube.
    fn license_token(&self) -> AppResult<String> {
        get_license_token().map_err(AppError::not_found)
    }

    /// Cabeceras device-proof. `body` son los bytes EXACTOS del cuerpo que se va a enviar (cadena
    /// vacía si no hay): entran en la firma, así que quien las use tiene que mandar **ese mismo**
    /// cuerpo, sin volver a serializarlo por su cuenta (ver FABLE-E en `device.rs`).
    fn signed_headers_inner(
        &self,
        mode: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> AppResult<ApiSignedHeaders> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (sk, _pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;

        let token = if mode == "handy" {
            get_handy_token().map_err(AppError::external)?
        } else if mode == "tpv" {
            self.license_token()?
        } else {
            return Err(AppError::validation(
                "bad_mode_for_signed_headers (use: tpv|handy)",
            ));
        };

        let ts = now_ms();
        let sig = sign_device_proof(&sk, ts, &method.to_uppercase(), path, token.trim(), body)
            .map_err(ext)?;

        Ok(ApiSignedHeaders {
            authorization: format!("Bearer {}", token.trim()),
            x_device_ts: ts.to_string(),
            x_device_sig: sig,
        })
    }
}

#[async_trait]
impl PairingService for PairingAdapter {
    fn device_identity(&self) -> AppResult<DeviceIdentity> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (_sk, pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;
        Ok(DeviceIdentity {
            device_id,
            device_pubkey_b64: pub_b64,
        })
    }

    fn device_sign_b64(&self, payload: &str) -> AppResult<SigB64> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (sk, _pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;
        let sig_b64 = sign_payload_b64(&sk, payload).map_err(ext)?;
        Ok(SigB64 { sig_b64 })
    }

    fn handy_set_token(&self, token: &str, tenant_id: &str) -> AppResult<()> {
        device::handy_set_token(token, tenant_id).map_err(ext)
    }

    fn handy_clear_token(&self) -> AppResult<()> {
        device::handy_clear_token().map_err(ext)
    }

    fn handy_get_tenant(&self) -> AppResult<Option<String>> {
        device::handy_get_tenant().map_err(ext)
    }

    fn handy_get_ws_auth(&self) -> AppResult<HandyWsAuth> {
        let token = get_handy_token().map_err(ext)?;
        let tenant_id = device::handy_get_tenant()
            .map_err(ext)?
            .ok_or_else(|| ext("handy_tenant_missing"))?;
        Ok(HandyWsAuth { token, tenant_id })
    }

    fn tpv_server_signed_headers(
        &self,
        mode: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> AppResult<ApiSignedHeaders> {
        self.signed_headers_inner(mode, method, path, body)
    }

    async fn tpv_server_post_json(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<JsonValue> {
        let url = api_url(path);

        let client = Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| ext(format!("reqwest_build_failed:{e}")))?;

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        // El reloj lo pone el dispositivo emisor (Main o Handy), NO el servidor: el worker usa
        // esta hora local para resolver los `datetime('now')` de las escrituras a un literal fijo,
        // de modo que la fila sea idéntica en nube/Main/Handy (replicación determinista).
        let client_now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        if let Ok(v) = HeaderValue::from_str(&client_now) {
            headers.insert("x-client-now", v);
        }

        // El cuerpo se serializa UNA vez: es lo que se firma y lo que se envía. Si se dejase que
        // reqwest lo volviera a serializar con `.json(&body)`, cualquier diferencia de bytes
        // (orden, espacios) invalidaría la firma en el worker.
        let body_str =
            serde_json::to_string(&body).map_err(|e| ext(format!("bad_json_body:{e}")))?;

        if mode == "tpv" || mode == "handy" {
            let signed = self.signed_headers_inner(mode, "POST", path, body_str.as_bytes())?;

            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&signed.authorization)
                    .map_err(|_| AppError::external("bad_authorization_header"))?,
            );
            headers.insert(
                "x-device-ts",
                HeaderValue::from_str(&signed.x_device_ts)
                    .map_err(|_| AppError::external("bad_x_device_ts"))?,
            );
            headers.insert(
                "x-device-sig",
                HeaderValue::from_str(&signed.x_device_sig)
                    .map_err(|_| AppError::external("bad_x_device_sig"))?,
            );
        }

        let resp = client
            .post(&url)
            .headers(headers)
            .body(body_str)
            .send()
            .await
            .map_err(|e| ext(format!("reqwest_send_failed:{e}")))?;

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        let parsed: JsonValue =
            serde_json::from_str(&text).unwrap_or(JsonValue::Object(Default::default()));

        // ARCH-05: los códigos de negocio del worker se traducen al catálogo compartido
        // (`ErrorCode::from_wire`). El string original sigue viajando como `message`, pero
        // ya no es lo que el frontend compara: eso lo hace por `code`.
        if !(200..300).contains(&status) {
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(AppError::from_wire(err));
            }
            return Err(AppError::external(format!("http_{}", status)));
        }

        if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(AppError::from_wire(err));
            }
            return Err(AppError::external("api_error"));
        }

        Ok(parsed)
    }

    async fn pair_create(&self) -> AppResult<PairCreateResult> {
        // Reutiliza el POST firmado en modo `tpv` (el worker exige rol TPV + licencia activa)
        // y tipa la respuesta `{ ok, pairCode, pairSecret, expiresAtMs }`.
        let parsed = self
            .tpv_server_post_json("tpv", "/v1/pair/create", JsonValue::Object(Default::default()))
            .await?;
        serde_json::from_value(parsed).map_err(|e| ext(format!("bad_pair_create_response:{e}")))
    }

    async fn upload_image(
        &self,
        mode: &str,
        path: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> AppResult<()> {
        // PUT firmado (device-proof sobre el path canónico, sin query). El tenant lo deriva el
        // worker del token: aislamiento por tenant garantizado. NO usa idempotency-key: es una
        // escritura directa a R2 (no pasa por el hub).
        let url = api_url(path);
        let signed = self.signed_headers_inner(mode, "PUT", path, &bytes)?;
        let client = http_client()?;

        let resp = client
            .put(&url)
            .header(AUTHORIZATION, signed.authorization)
            .header("x-device-ts", signed.x_device_ts)
            .header("x-device-sig", signed.x_device_sig)
            .header(CONTENT_TYPE, content_type)
            .body(bytes)
            .send()
            .await
            .map_err(|e| ext(format!("image_upload_send_failed:{e}")))?;

        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        if let Some(err) = serde_json::from_str::<JsonValue>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        {
            return Err(AppError::from_wire(err));
        }
        Err(AppError::external(format!(
            "image_upload_http_{}: {}",
            status, text
        )))
    }

    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()> {
        let url = api_url(path);
        let signed = self.signed_headers_inner(mode, "DELETE", path, b"")?;
        let client = http_client()?;

        let resp = client
            .delete(&url)
            .header(AUTHORIZATION, signed.authorization)
            .header("x-device-ts", signed.x_device_ts)
            .header("x-device-sig", signed.x_device_sig)
            .send()
            .await
            .map_err(|e| ext(format!("image_delete_send_failed:{e}")))?;

        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        Err(AppError::external(format!(
            "image_delete_http_{}: {}",
            status, text
        )))
    }

    async fn download_image(&self, mode: &str, rel_path: &str) -> AppResult<Option<Vec<u8>>> {
        // POST firmado a `/v1/images/download`. El tenant lo deriva el worker del token, así que
        // la Main no necesita conocerlo; `rel_path` viaja en el cuerpo, que **ahora sí entra en la
        // firma** (FABLE-E). 404 → None (el binario aún no está en R2).
        let path = "/v1/images/download";
        let url = api_url(path);
        let body_str = serde_json::to_string(&serde_json::json!({ "rel_path": rel_path }))
            .map_err(|e| ext(format!("bad_json_body:{e}")))?;
        let signed = self.signed_headers_inner(mode, "POST", path, body_str.as_bytes())?;
        let client = http_client()?;

        let resp = client
            .post(&url)
            .header(AUTHORIZATION, signed.authorization)
            .header("x-device-ts", signed.x_device_ts)
            .header("x-device-sig", signed.x_device_sig)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .body(body_str)
            .send()
            .await
            .map_err(|e| ext(format!("image_download_send_failed:{e}")))?;

        let status = resp.status().as_u16();
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::external(format!(
                "image_download_http_{}: {}",
                status, text
            )));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ext(format!("image_download_body_failed:{e}")))?;
        Ok(Some(bytes.to_vec()))
    }
}

#[async_trait]
impl CloudSyncService for PairingAdapter {
    async fn upload_initial_setup(
        &self,
        id_usuario: &str,
        email: &str,
        pin: &str,
    ) -> AppResult<()> {
        // POST firmado en modo `tpv` (el worker comprueba rol TPV y escribe directo en Turso,
        // sin pasar por el hub → no se topa con `main_offline`).
        let body = serde_json::json!({
            "id_usuario": id_usuario,
            "email": email,
            "pin": pin,
        });
        let _ = self
            .tpv_server_post_json("tpv", "/v1/login/sync-initial-setup", body)
            .await?;
        Ok(())
    }
}
