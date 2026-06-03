//! Casos de uso de **pairing / identidad de dispositivo**. Validan/normalizan la entrada
//! e invocan el `PairingService`.

use serde_json::Value as JsonValue;

use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, DeviceSignB64Args, HandySetTokenArgs, SigB64,
    TpvServerPostJsonArgs, TpvServerSignedHeadersArgs,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;

fn requerido(input: &str, field: &str) -> AppResult<String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(AppError::validation(format!("{field} required")));
    }
    Ok(out)
}

fn normalize_mode(mode: &str) -> AppResult<String> {
    let m = requerido(mode, "mode")?.to_lowercase();
    match m.as_str() {
        "anon" | "tpv" | "handy" => Ok(m),
        _ => Err(AppError::validation("bad_mode (use: anon|tpv|handy)")),
    }
}

fn normalize_path(path: &str) -> AppResult<String> {
    let out = requerido(path, "path")?;
    if !out.starts_with('/') {
        return Err(AppError::validation("path debe empezar por '/'"));
    }
    Ok(out)
}

pub fn device_identity(svc: &dyn PairingService) -> AppResult<DeviceIdentity> {
    svc.device_identity()
}

pub fn device_sign_b64(svc: &dyn PairingService, args: DeviceSignB64Args) -> AppResult<SigB64> {
    let payload = requerido(&args.payload, "payload")?;
    svc.device_sign_b64(&payload)
}

pub fn handy_set_token(svc: &dyn PairingService, args: HandySetTokenArgs) -> AppResult<()> {
    let token = requerido(&args.token, "token")?;
    let tenant_id = requerido(&args.tenant_id, "tenant_id")?;
    svc.handy_set_token(&token, &tenant_id)
}

pub fn handy_clear_token(svc: &dyn PairingService) -> AppResult<()> {
    svc.handy_clear_token()
}

pub fn handy_get_tenant(svc: &dyn PairingService) -> AppResult<Option<String>> {
    svc.handy_get_tenant()
}

pub fn tpv_server_signed_headers(
    svc: &dyn PairingService,
    args: TpvServerSignedHeadersArgs,
) -> AppResult<ApiSignedHeaders> {
    let mode = normalize_mode(&args.mode)?;
    let method = requerido(&args.method, "method")?;
    let path = normalize_path(&args.path)?;
    svc.tpv_server_signed_headers(&mode, &method, &path)
}

pub async fn tpv_server_post_json(
    svc: &dyn PairingService,
    args: TpvServerPostJsonArgs,
) -> AppResult<JsonValue> {
    let mode = normalize_mode(&args.mode)?;
    let path = normalize_path(&args.path)?;
    svc.tpv_server_post_json(&mode, &path, args.body).await
}
