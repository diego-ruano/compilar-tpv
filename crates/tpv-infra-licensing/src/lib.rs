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

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cloud_sync::CloudSyncService;
use tpv_application::ports::licensing::{LicensingService, PairingService};
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, HandyWsAuth, LicenseLocalState, PairCreateResult, SigB64,
};
use tpv_domain::licensing::{
    Concesion, EstadoServidor, FalloConsulta, RespuestaEstado, SolicitudActivacion,
};

use device::{
    get_handy_token, get_or_create_device_id, get_or_create_device_keypair, sign_device_proof,
    sign_payload_b64,
};

/// Worker unificado `tpv-api` (fusión de los antiguos `tpv-licensing` + `tpv-server`): sirve
/// licencia (`/v1/license/*`), pairing (`/v1/pair/*`), revoke, imágenes, WS y el DO TenantHub.
/// Es el **único** host de la nube: `tpv-infra-http` lo reexporta para el resto del backend.
pub const CLOUD_API_BASE: &str = "https://tpv-api.altarialights.workers.dev";

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateErr {
    #[allow(dead_code)]
    ok: bool,
    error: String,
    details: Option<JsonValue>,
}

/// Datos del negocio que acompañan a la activación. El worker los espera en camelCase y bajo
/// el nombre `displayName` (contrato actual del endpoint).
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
    instance_name: Option<&'a str>,
    tenant_info: TenantInfo<'a>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusOk {
    ok: bool,
    state: StatusState,
    #[serde(rename = "serverTime")]
    server_time_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct StatusState {
    #[allow(dead_code)]
    tenant_id: String,
    status: String,
    expires_at: Option<String>,
    disabled: bool,
    #[allow(dead_code)]
    test_mode: bool,
    #[allow(dead_code)]
    key_short: String,
    #[allow(dead_code)]
    updated_at_ms: i64,
    #[allow(dead_code)]
    created_at_ms: i64,
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
        delete_state(&self.app_data_dir)
    }

    async fn activar_remoto(&self, solicitud: &SolicitudActivacion) -> AppResult<Concesion> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (_sk, pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;

        let req = ActivateReq {
            activation_key: &solicitud.clave,
            device_id: &device_id,
            device_pub_key: &pub_b64,
            instance_name: None,
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

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            if let Ok(e) = serde_json::from_str::<ActivateErr>(&text) {
                let details = e.details.map(|v| v.to_string()).unwrap_or_default();
                return Err(AppError::external(format!(
                    "{}{}{}",
                    e.error,
                    if details.is_empty() { "" } else { " - " },
                    details
                )));
            }
            return Err(AppError::external(format!(
                "activate_failed_http_{}: {}",
                status.as_u16(),
                text
            )));
        }

        let ok: ActivateOk = serde_json::from_str(&text)
            .map_err(|e| ext(format!("Respuesta JSON inválida del servidor: {e} | body={text}")))?;

        if !ok.ok || ok.token.trim().is_empty() || ok.tenant_id.trim().is_empty() {
            return Err(AppError::external(format!(
                "Respuesta inesperada del servidor: {text}"
            )));
        }

        // Anti-copia: el token concedido va ligado a la clave de ESTE dispositivo. Si el
        // servidor nos devuelve otro `deviceId`, la firma de las siguientes peticiones no
        // cuadraría: mejor fallar aquí que arrastrar un estado inservible.
        if let Some(server_device) = ok.device_id.as_deref().map(str::trim) {
            if !server_device.is_empty() && server_device != device_id {
                return Err(AppError::external(
                    "deviceId mismatch (server devolvió otro deviceId)",
                ));
            }
        }

        Ok(Concesion {
            tenant_id: ok.tenant_id.trim().to_string(),
            device_id,
            token: ok.token.trim().to_string(),
            status: ok.status,
            expires_at: ok.expires_at,
        })
    }

    async fn consultar_estado(
        &self,
        state: &LicenseLocalState,
    ) -> Result<RespuestaEstado, FalloConsulta> {
        const PATH: &str = "/v1/license/status";

        // Un fallo local (keyring, firma, construcción del cliente) es indistinguible de no
        // tener red desde el punto de vista del gate: en ambos casos no sabemos qué dice el
        // servidor, así que se trata como `Inalcanzable` y decide la gracia offline.
        let client = http_client().map_err(|_| FalloConsulta::Inalcanzable)?;
        let ts = now_ms();

        let (sk, _) = get_or_create_device_keypair(&state.device_id)
            .map_err(|_| FalloConsulta::Inalcanzable)?;
        let sig = sign_device_proof(&sk, ts, "GET", PATH, &state.token)
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let resp = client
            .get(api_url(PATH))
            .bearer_auth(&state.token)
            .header("X-Device-Ts", ts.to_string())
            .header("X-Device-Sig", sig)
            .send()
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        let http = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        if (400..=499).contains(&http) {
            return Err(FalloConsulta::Rechazada { http });
        }
        if (500..=599).contains(&http) {
            return Err(FalloConsulta::Inalcanzable);
        }

        let ok: StatusOk =
            serde_json::from_str(&text).map_err(|e| FalloConsulta::Ilegible {
                http,
                detalle: format!("invalid_json: {e} | body={text}"),
            })?;

        Ok(RespuestaEstado {
            ok: ok.ok,
            estado: EstadoServidor {
                status: ok.state.status,
                expires_at: ok.state.expires_at,
                disabled: ok.state.disabled,
            },
            server_time_ms: ok.server_time_ms,
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

    fn license_token(&self) -> AppResult<String> {
        let st = load_state(&self.app_data_dir)
            .ok_or_else(|| AppError::not_found("license_state_missing"))?;
        let token = st.token.trim().to_string();
        if token.is_empty() {
            return Err(AppError::not_found("license_token required"));
        }
        Ok(token)
    }

    fn signed_headers_inner(
        &self,
        mode: &str,
        method: &str,
        path: &str,
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
        let sig =
            sign_device_proof(&sk, ts, &method.to_uppercase(), path, token.trim()).map_err(ext)?;

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
    ) -> AppResult<ApiSignedHeaders> {
        self.signed_headers_inner(mode, method, path)
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

        if mode == "tpv" || mode == "handy" {
            let signed = self.signed_headers_inner(mode, "POST", path)?;

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
            .json(&body)
            .send()
            .await
            .map_err(|e| ext(format!("reqwest_send_failed:{e}")))?;

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        let parsed: JsonValue =
            serde_json::from_str(&text).unwrap_or(JsonValue::Object(Default::default()));

        // Fidelidad con el monolito: los códigos de error de negocio del worker se
        // propagan VERBATIM (sin prefijo de AppError), porque el frontend los compara
        // por igualdad estricta (p. ej. `not_approved` en el polling de pairing Handy).
        if !(200..300).contains(&status) {
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(AppError::raw(err.to_string()));
            }
            return Err(AppError::raw(format!("http_{}", status)));
        }

        if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
                return Err(AppError::raw(err.to_string()));
            }
            return Err(AppError::raw("api_error"));
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
        let signed = self.signed_headers_inner(mode, "PUT", path)?;
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
            return Err(AppError::raw(err));
        }
        Err(AppError::external(format!(
            "image_upload_http_{}: {}",
            status, text
        )))
    }

    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()> {
        let url = api_url(path);
        let signed = self.signed_headers_inner(mode, "DELETE", path)?;
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
        // la Main no necesita conocerlo; `rel_path` viaja en el cuerpo (no entra en la firma, que
        // es sobre método+path). 404 → None (el binario aún no está en R2).
        let path = "/v1/images/download";
        let url = api_url(path);
        let signed = self.signed_headers_inner(mode, "POST", path)?;
        let client = http_client()?;

        let resp = client
            .post(&url)
            .header(AUTHORIZATION, signed.authorization)
            .header("x-device-ts", signed.x_device_ts)
            .header("x-device-sig", signed.x_device_sig)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .json(&serde_json::json!({ "rel_path": rel_path }))
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
