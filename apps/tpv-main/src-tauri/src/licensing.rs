// src-tauri/src/licensing.rs
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tokio::time::Duration;

use reqwest::Client;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use keyring::Entry;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const LICENSE_API_BASE: &str = "https://tpv-licensing.altarialights.workers.dev";

const OFFLINE_GRACE_MS: i64 = 48 * 60 * 60 * 1000;
const HTTP_TIMEOUT_SECS: u64 = 20;

const CLOCK_ROLLBACK_TOLERANCE_MS: i64 = 2 * 60 * 1000;

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

fn normalize_required(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();

    if out.is_empty() {
        return Err(format!("{field} required"));
    }

    Ok(out)
}

fn clean_opt_string(input: Option<String>) -> Option<String> {
    input.and_then(|s| {
        let t = s.trim().to_string();

        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();

    out.iter().map(|b| format!("{:02x}", b)).collect()
}

fn license_state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("license_state.json")
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/* =========================================================
   Tipos locales
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub last_server_time_ms: Option<i64>,

    #[serde(alias = "lastCheckOkMs")]
    pub last_check_ok_ms: Option<i64>,

    #[serde(alias = "lastCheckAttemptMs")]
    pub last_check_attempt_ms: Option<i64>,

    #[serde(alias = "activatedAtMs")]
    pub activated_at_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct LicenseGateResult {
    pub allowed: bool,
    pub reason: String,
    pub state: Option<LicenseLocalState>,
}

#[derive(Debug, Serialize)]
pub struct ApiAuthHeaders {
    pub token: String,
    pub device_ts: i64,
    pub device_sig: String,
}

/* =========================================================
   Args comandos Tauri
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct ApiGetAuthHeadersArgs {
    pub method: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LicenseActivateArgs {
    pub activation_key: String,

    #[serde(default)]
    pub restaurant_name: Option<String>,

    #[serde(default)]
    pub business_name: Option<String>,

    #[serde(default)]
    pub legal_name: Option<String>,

    #[serde(default)]
    pub display_name: Option<String>,

    #[serde(default)]
    pub email: Option<String>,

    #[serde(default)]
    pub phone: Option<String>,

    #[serde(default)]
    pub country: Option<String>,
}

/* =========================================================
   Tipos API licencias
========================================================= */

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
    ok: bool,
    error: String,
    details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TenantInfo {
    display_name: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    legal_name: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    phone: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    country: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivateReq<'a> {
    activation_key: &'a str,
    device_id: &'a str,
    device_pub_key: &'a str,

    #[serde(skip_serializing_if = "Option::is_none")]
    instance_name: Option<&'a str>,

    tenant_info: TenantInfo,
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
    tenant_id: String,
    status: String,
    expires_at: Option<String>,
    disabled: bool,
    test_mode: bool,
    key_short: String,
    updated_at_ms: i64,
    created_at_ms: i64,
}

/* =========================================================
   Estado local
========================================================= */

fn load_state(app_data_dir: &Path) -> Option<LicenseLocalState> {
    let p = license_state_path(app_data_dir);
    let txt = fs::read_to_string(p).ok()?;

    serde_json::from_str::<LicenseLocalState>(&txt).ok()
}

fn save_state(app_data_dir: &Path, st: &LicenseLocalState) -> Result<(), String> {
    let p = license_state_path(app_data_dir);
    let txt = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;

    fs::write(&p, txt).map_err(|e| format!("Error escribiendo {:?}: {e}", p))?;

    Ok(())
}

fn delete_state(app_data_dir: &Path) -> Result<(), String> {
    let p = license_state_path(app_data_dir);

    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("Error borrando {:?}: {e}", p))?;
    }

    Ok(())
}

/* =========================================================
   HTTP / validación
========================================================= */

async fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Error creando HTTP client: {e}"))
}

fn server_allows_use(state: &StatusState) -> bool {
    if state.disabled {
        return false;
    }

    state.status.trim().eq_ignore_ascii_case("active")
}

fn grace_ok(st: &LicenseLocalState) -> Result<bool, String> {
    let base = st.last_check_ok_ms.unwrap_or(st.activated_at_ms);
    let now = now_ms();

    if now + CLOCK_ROLLBACK_TOLERANCE_MS < base {
        return Err("clock_rollback_detected".into());
    }

    Ok(now.saturating_sub(base) <= OFFLINE_GRACE_MS)
}

/* =========================================================
   Device keys / Keychain
========================================================= */

fn key_entry_device_id() -> Result<Entry, String> {
    Entry::new("tpv-licensing", "device-id").map_err(|e| e.to_string())
}

fn get_or_create_device_id() -> Result<String, String> {
    let entry = key_entry_device_id()?;

    if let Ok(v) = entry.get_password() {
        let t = v.trim().to_string();

        if !t.is_empty() {
            return Ok(t);
        }
    }

    let id = Uuid::new_v4().to_string();

    entry.set_password(&id).map_err(|e| e.to_string())?;

    Ok(id)
}

fn key_entry_privkey(device_id: &str) -> Result<Entry, String> {
    Entry::new("tpv-licensing-devicekey", device_id).map_err(|e| e.to_string())
}

fn get_or_create_device_keypair(device_id: &str) -> Result<(SigningKey, String), String> {
    let entry = key_entry_privkey(device_id)?;

    if let Ok(b64) = entry.get_password() {
        let bytes = B64.decode(b64.trim()).map_err(|e| e.to_string())?;

        if bytes.len() != 32 {
            return Err("bad_private_key_len".into());
        }

        let arr: [u8; 32] = bytes[..]
            .try_into()
            .map_err(|_| "bad_private_key_len".to_string())?;

        let sk = SigningKey::from_bytes(&arr);
        let pub_b64 = B64.encode(sk.verifying_key().to_bytes());

        return Ok((sk, pub_b64));
    }

    use rand::rngs::OsRng;

    let mut rng = OsRng;
    let sk = SigningKey::generate(&mut rng);

    let sk_b64 = B64.encode(sk.to_bytes());
    entry.set_password(&sk_b64).map_err(|e| e.to_string())?;

    let pub_b64 = B64.encode(sk.verifying_key().to_bytes());

    Ok((sk, pub_b64))
}

fn sign_device_proof(
    sk: &SigningKey,
    ts_ms: i64,
    method: &str,
    path: &str,
    token: &str,
) -> Result<String, String> {
    let token_hash = sha256_hex(token);

    let msg = format!(
        "{}\n{}\n{}\n{}",
        ts_ms,
        method.to_uppercase(),
        path,
        token_hash
    );

    let sig: Signature = sk.sign(msg.as_bytes());

    Ok(B64.encode(sig.to_bytes()))
}

/* =========================================================
   Commands auth API
========================================================= */

#[tauri::command]
pub fn api_get_auth_headers(
    app: AppHandle,
    args: ApiGetAuthHeadersArgs,
) -> Result<ApiAuthHeaders, String> {
    let dir = app_data_dir(&app)?;
    let st = load_state(&dir).ok_or_else(|| "missing_license_state".to_string())?;

    let method = normalize_required(&args.method, "method")?;
    let path = normalize_required(&args.path, "path")?;

    let path_only = path.split('?').next().unwrap_or("").trim().to_string();

    if path_only.is_empty() {
        return Err("bad_path".into());
    }

    let ts = now_ms();

    let (sk, _) = get_or_create_device_keypair(&st.device_id)?;
    let sig = sign_device_proof(&sk, ts, &method, &path_only, &st.token)?;

    Ok(ApiAuthHeaders {
        token: st.token,
        device_ts: ts,
        device_sig: sig,
    })
}

/* =========================================================
   Calls con proof
========================================================= */

async fn call_status(st: &LicenseLocalState) -> Result<StatusOk, (u16, String)> {
    let client = http_client().await.map_err(|e| (0, e))?;

    let url = format!(
        "{}/v1/license/status",
        LICENSE_API_BASE.trim_end_matches('/')
    );

    let ts = now_ms();

    let (sk, _) = get_or_create_device_keypair(&st.device_id).map_err(|e| (0, e))?;
    let sig =
        sign_device_proof(&sk, ts, "GET", "/v1/license/status", &st.token).map_err(|e| (0, e))?;

    let resp = client
        .get(url)
        .bearer_auth(&st.token)
        .header("X-Device-Ts", ts.to_string())
        .header("X-Device-Sig", sig)
        .send()
        .await
        .map_err(|e| (0, format!("offline: {e}")))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err((status.as_u16(), text));
    }

    let ok: StatusOk = serde_json::from_str(&text)
        .map_err(|e| (status.as_u16(), format!("invalid_json: {e} | body={text}")))?;

    Ok(ok)
}

async fn call_validate(st: &LicenseLocalState) -> Result<(String, Option<String>), (u16, String)> {
    let client = http_client().await.map_err(|e| (0, e))?;

    let url = format!(
        "{}/v1/license/validate",
        LICENSE_API_BASE.trim_end_matches('/')
    );

    let ts = now_ms();

    let (sk, _) = get_or_create_device_keypair(&st.device_id).map_err(|e| (0, e))?;
    let sig = sign_device_proof(&sk, ts, "POST", "/v1/license/validate", &st.token)
        .map_err(|e| (0, e))?;

    let resp = client
        .post(url)
        .bearer_auth(&st.token)
        .header("X-Device-Ts", ts.to_string())
        .header("X-Device-Sig", sig)
        .send()
        .await
        .map_err(|e| (0, format!("offline: {e}")))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err((status.as_u16(), text));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| (status.as_u16(), format!("invalid_json: {e} | body={text}")))?;

    let stt = v
        .get("status")
        .and_then(|x| x.as_str())
        .unwrap_or("active")
        .to_string();

    let exp = v
        .get("expiresAt")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    Ok((stt, exp))
}

async fn gate_inner(app: &AppHandle, force_network: bool) -> Result<LicenseGateResult, String> {
    if LICENSE_API_BASE.trim().is_empty() {
        return Err("LICENSE_API_BASE vacío en Rust (licensing.rs)".into());
    }

    let dir = app_data_dir(app)?;

    let mut st = match load_state(&dir) {
        Some(s) => s,
        None => {
            return Ok(LicenseGateResult {
                allowed: false,
                reason: "needs_activation".into(),
                state: None,
            })
        }
    };

    st.last_check_attempt_ms = Some(now_ms());

    match call_status(&st).await {
        Ok(sok) => {
            st.status = Some(sok.state.status.clone());
            st.expires_at = sok.state.expires_at.clone();
            st.last_server_time_ms = Some(sok.server_time_ms);
            st.last_check_ok_ms = Some(now_ms());

            save_state(&dir, &st)?;

            if !sok.ok || !server_allows_use(&sok.state) {
                delete_state(&dir)?;

                return Ok(LicenseGateResult {
                    allowed: false,
                    reason: "invalid".into(),
                    state: None,
                });
            }

            Ok(LicenseGateResult {
                allowed: true,
                reason: "ok".into(),
                state: Some(st),
            })
        }

        Err((code, body)) => {
            if code == 0 || (500..=599).contains(&code) {
                save_state(&dir, &st)?;

                match grace_ok(&st) {
                    Ok(true) => Ok(LicenseGateResult {
                        allowed: true,
                        reason: "offline_grace".into(),
                        state: Some(st),
                    }),
                    Ok(false) => Ok(LicenseGateResult {
                        allowed: false,
                        reason: "offline_expired".into(),
                        state: Some(st),
                    }),
                    Err(r) => Ok(LicenseGateResult {
                        allowed: false,
                        reason: r,
                        state: Some(st),
                    }),
                }
            } else if code == 401 || code == 404 || (400..=499).contains(&code) {
                delete_state(&dir)?;

                Ok(LicenseGateResult {
                    allowed: false,
                    reason: format!("invalid_http_{code}"),
                    state: None,
                })
            } else {
                if !force_network {
                    save_state(&dir, &st)?;

                    if grace_ok(&st).unwrap_or(false) {
                        return Ok(LicenseGateResult {
                            allowed: true,
                            reason: "offline_grace".into(),
                            state: Some(st),
                        });
                    }
                }

                Err(format!("status_failed_http_{}: {}", code, body))
            }
        }
    }
}

/* =========================================================
   Commands licencia
========================================================= */

#[tauri::command]
pub fn license_get_state(app: AppHandle) -> Result<Option<LicenseLocalState>, String> {
    let dir = app_data_dir(&app)?;

    Ok(load_state(&dir))
}

#[tauri::command]
pub fn license_clear_state(app: AppHandle) -> Result<String, String> {
    let dir = app_data_dir(&app)?;

    delete_state(&dir)?;

    Ok("OK".into())
}

#[tauri::command]
pub async fn license_gate(app: AppHandle) -> Result<LicenseGateResult, String> {
    gate_inner(&app, false).await
}

#[tauri::command]
pub async fn license_check_now(app: AppHandle) -> Result<LicenseGateResult, String> {
    gate_inner(&app, true).await
}

#[tauri::command]
pub async fn license_activate(
    app: AppHandle,
    args: LicenseActivateArgs,
) -> Result<LicenseLocalState, String> {
    let activation_key = normalize_required(&args.activation_key, "activation_key")?;

    if LICENSE_API_BASE.trim().is_empty() {
        return Err("LICENSE_API_BASE vacío en Rust (licensing.rs)".into());
    }

    let display_name = clean_opt_string(args.display_name);
    let restaurant_name = clean_opt_string(args.restaurant_name);
    let business_name = clean_opt_string(args.business_name);

    let final_display_name = display_name
        .or(restaurant_name)
        .or(business_name)
        .ok_or_else(|| "display_name/restaurant_name/business_name requerido".to_string())?;

    let dir = app_data_dir(&app)?;

    let device_id = get_or_create_device_id()?;
    let (_sk, pub_b64) = get_or_create_device_keypair(&device_id)?;

    let client = http_client().await?;

    let url = format!(
        "{}/v1/license/activate",
        LICENSE_API_BASE.trim_end_matches('/')
    );

    let req = ActivateReq {
        activation_key: &activation_key,
        device_id: &device_id,
        device_pub_key: &pub_b64,
        instance_name: None,
        tenant_info: TenantInfo {
            display_name: final_display_name,
            legal_name: clean_opt_string(args.legal_name),
            email: clean_opt_string(args.email),
            phone: clean_opt_string(args.phone),
            country: clean_opt_string(args.country),
        },
    };

    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con el servidor de licencias: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        if let Ok(e) = serde_json::from_str::<ActivateErr>(&text) {
            let details = e.details.map(|v| v.to_string()).unwrap_or_default();

            return Err(format!(
                "{}{}{}",
                e.error,
                if details.is_empty() { "" } else { " - " },
                details
            ));
        }

        return Err(format!(
            "activate_failed_http_{}: {}",
            status.as_u16(),
            text
        ));
    }

    let ok: ActivateOk = serde_json::from_str(&text)
        .map_err(|e| format!("Respuesta JSON inválida del servidor: {e} | body={text}"))?;

    if !ok.ok || ok.token.trim().is_empty() || ok.tenant_id.trim().is_empty() {
        return Err(format!("Respuesta inesperada del servidor: {}", text));
    }

    if let Some(server_device) = ok.device_id.as_ref() {
        let s = server_device.trim();

        if !s.is_empty() && s != device_id {
            return Err("deviceId mismatch (server devolvió otro deviceId)".into());
        }
    }

    let local = LicenseLocalState {
        tenant_id: ok.tenant_id.trim().to_string(),
        device_id: device_id.clone(),
        token: ok.token.trim().to_string(),
        status: Some(ok.status),
        expires_at: ok.expires_at,
        last_server_time_ms: None,
        last_check_ok_ms: None,
        last_check_attempt_ms: None,
        activated_at_ms: now_ms(),
    };

    save_state(&dir, &local)?;

    Ok(local)
}
