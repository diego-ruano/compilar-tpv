// src-tauri/src/pairing.rs

// LA PARTE DE LA PETICIÓN DEL CÓDIGO PARA EL EMPAREJAMIENTO NO FUNCIONA
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::{AppHandle, Manager};

// crypto + keychain
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use keyring::Entry;
use sha2::{Digest, Sha256};
use uuid::Uuid;

// HTTP
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

// ===============
// Constants
// ===============

const TPV_SERVER_BASE: &str = "https://tpv-server.altarialights.workers.dev";
const HTTP_TIMEOUT_SECS: u64 = 20;

// ===============
// Shared structs
// ===============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseLocalState {
    pub tenant_id: String,
    pub device_id: String,
    pub token: String,

    // caché UI
    pub status: Option<String>,
    pub expires_at: Option<String>,
    pub last_server_time_ms: Option<i64>,

    pub last_check_ok_ms: Option<i64>,
    pub last_check_attempt_ms: Option<i64>,

    pub activated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSignedHeaders {
    pub authorization: String,
    #[serde(rename = "xDeviceTs")]
    pub x_device_ts: String,
    #[serde(rename = "xDeviceSig")]
    pub x_device_sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigB64 {
    pub sig_b64: String,
}

// ===============
// Args
// ===============

#[derive(Debug, Clone, Deserialize)]
pub struct HandySetTokenArgs {
    pub token: String,
    pub tenant_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceSignB64Args {
    pub payload: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TpvServerSignedHeadersArgs {
    pub mode: String,
    pub method: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TpvServerPostJsonArgs {
    pub mode: String,
    pub path: String,
    pub body: JsonValue,
}

// ===============
// Paths / storage
// ===============

fn license_state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("license_state.json")
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

fn load_license_state(app_data_dir: &Path) -> Option<LicenseLocalState> {
    let p = license_state_path(app_data_dir);
    let txt = fs::read_to_string(p).ok()?;
    serde_json::from_str::<LicenseLocalState>(&txt).ok()
}

fn now_ms() -> i64 {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    ms as i64
}

fn normalize_required(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();

    if out.is_empty() {
        return Err(format!("{field} required"));
    }

    Ok(out)
}

fn normalize_path(path: &str) -> Result<String, String> {
    let out = normalize_required(path, "path")?;

    if !out.starts_with('/') {
        return Err("path debe empezar por '/'".into());
    }

    Ok(out)
}

fn normalize_mode(mode: &str) -> Result<String, String> {
    let m = normalize_required(mode, "mode")?.to_lowercase();

    match m.as_str() {
        "anon" | "tpv" | "handy" => Ok(m),
        _ => Err("bad_mode (use: anon|tpv|handy)".into()),
    }
}

// ===============
// Device keys (Keychain)
// ===============

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

/// Devuelve SigningKey (priv) desde keychain, si no existe lo crea.
/// También devuelve pubkey (b64).
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

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());

    let out = h.finalize();

    out.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Firma para proof headers:
/// {ts}\n{METHOD}\n{PATH}\n{sha256(token)}
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

fn sign_payload_b64(sk: &SigningKey, payload: &str) -> Result<String, String> {
    let sig: Signature = sk.sign(payload.as_bytes());

    Ok(B64.encode(sig.to_bytes()))
}

// ===============
// Handy token storage (Keyring)
// ===============

fn key_entry_handy_token() -> Result<Entry, String> {
    Entry::new("tpv-auth", "handy-token").map_err(|e| e.to_string())
}

fn key_entry_handy_tenant() -> Result<Entry, String> {
    Entry::new("tpv-auth", "handy-tenant-id").map_err(|e| e.to_string())
}

fn get_handy_token() -> Result<String, String> {
    let entry = key_entry_handy_token()?;

    let token = entry
        .get_password()
        .map_err(|_| "handy_token_missing".to_string())?;

    let token = normalize_required(&token, "handy_token")?;

    Ok(token)
}

fn get_tpv_license_token(app: &AppHandle) -> Result<String, String> {
    let dir = app_data_dir(app)?;

    let st = load_license_state(&dir).ok_or_else(|| "license_state_missing".to_string())?;

    let token = normalize_required(&st.token, "license_token")?;

    Ok(token)
}

#[tauri::command]
pub fn handy_set_token(args: HandySetTokenArgs) -> Result<String, String> {
    let token = normalize_required(&args.token, "token")?;
    let tenant_id = normalize_required(&args.tenant_id, "tenant_id")?;

    key_entry_handy_token()?
        .set_password(&token)
        .map_err(|e| e.to_string())?;

    key_entry_handy_tenant()?
        .set_password(&tenant_id)
        .map_err(|e| e.to_string())?;

    Ok("OK".into())
}

#[tauri::command]
pub fn handy_clear_token() -> Result<String, String> {
    let _ = key_entry_handy_token()?.delete_password();
    let _ = key_entry_handy_tenant()?.delete_password();

    Ok("OK".into())
}

// ===============
// Identity + signature commands
// ===============

#[tauri::command]
pub fn device_get_identity() -> Result<DeviceIdentity, String> {
    let device_id = get_or_create_device_id()?;
    let (_sk, pub_b64) = get_or_create_device_keypair(&device_id)?;

    Ok(DeviceIdentity {
        device_id,
        device_pubkey_b64: pub_b64,
    })
}

#[tauri::command]
pub fn device_sign_b64(args: DeviceSignB64Args) -> Result<SigB64, String> {
    let payload = normalize_required(&args.payload, "payload")?;

    let device_id = get_or_create_device_id()?;
    let (sk, _pub_b64) = get_or_create_device_keypair(&device_id)?;

    let sig_b64 = sign_payload_b64(&sk, &payload)?;

    Ok(SigB64 { sig_b64 })
}

// ===============
// Signed headers for tpv-server
// ===============

#[tauri::command]
pub fn tpv_server_signed_headers(
    app: AppHandle,
    args: TpvServerSignedHeadersArgs,
) -> Result<ApiSignedHeaders, String> {
    let mode = normalize_mode(&args.mode)?;
    let method = normalize_required(&args.method, "method")?.to_uppercase();
    let path = normalize_path(&args.path)?;

    let device_id = get_or_create_device_id()?;
    let (sk, _pub_b64) = get_or_create_device_keypair(&device_id)?;

    let token = if mode == "handy" {
        get_handy_token()?
    } else if mode == "tpv" {
        get_tpv_license_token(&app)?
    } else {
        return Err("bad_mode_for_signed_headers (use: tpv|handy)".into());
    };

    let ts = now_ms();
    let sig = sign_device_proof(&sk, ts, &method, &path, token.trim())?;

    Ok(ApiSignedHeaders {
        authorization: format!("Bearer {}", token.trim()),
        x_device_ts: ts.to_string(),
        x_device_sig: sig,
    })
}

/// POST al worker desde Rust (evita CORS/WebView)
///
/// mode:
/// - "anon"  => no añade Authorization ni proof
/// - "tpv"   => añade Authorization + x-device-* usando license_state token
/// - "handy" => añade Authorization + x-device-* usando handy token del keyring
#[tauri::command]
pub async fn tpv_server_post_json(
    app: AppHandle,
    args: TpvServerPostJsonArgs,
) -> Result<JsonValue, String> {
    let mode = normalize_mode(&args.mode)?;
    let path = normalize_path(&args.path)?;

    let url = format!("{}{}", TPV_SERVER_BASE, path);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("reqwest_build_failed:{e}"))?;

    let mut headers = HeaderMap::new();

    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if mode == "tpv" || mode == "handy" {
        let signed = tpv_server_signed_headers(
            app.clone(),
            TpvServerSignedHeadersArgs {
                mode: mode.clone(),
                method: "POST".to_string(),
                path: path.clone(),
            },
        )?;

        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&signed.authorization).map_err(|_| "bad_authorization_header")?,
        );

        headers.insert(
            "x-device-ts",
            HeaderValue::from_str(&signed.x_device_ts).map_err(|_| "bad_x_device_ts")?,
        );

        headers.insert(
            "x-device-sig",
            HeaderValue::from_str(&signed.x_device_sig).map_err(|_| "bad_x_device_sig")?,
        );
    }

    let resp = client
        .post(&url)
        .headers(headers)
        .json(&args.body)
        .send()
        .await
        .map_err(|e| format!("reqwest_send_failed:{e}"))?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    let parsed: JsonValue =
        serde_json::from_str(&text).unwrap_or(JsonValue::Object(Default::default()));

    if status < 200 || status >= 300 {
        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }

        return Err(format!("http_{}", status));
    }

    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
            return Err(err.to_string());
        }

        return Err("api_error".into());
    }

    Ok(parsed)
}

// ===============
// Debug UI
// ===============

#[tauri::command]
pub fn license_read_state_for_ui(app: AppHandle) -> Result<Option<LicenseLocalState>, String> {
    let dir = app_data_dir(&app)?;

    Ok(load_license_state(&dir))
}

#[tauri::command]
pub fn handy_get_tenant() -> Result<Option<String>, String> {
    let entry = key_entry_handy_tenant()?;

    match entry.get_password() {
        Ok(v) => {
            let tenant_id = v.trim().to_string();

            if tenant_id.is_empty() {
                Ok(None)
            } else {
                Ok(Some(tenant_id))
            }
        }
        Err(_) => Ok(None),
    }
}
