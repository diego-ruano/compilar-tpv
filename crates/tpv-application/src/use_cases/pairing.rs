//! Casos de uso de **pairing / identidad de dispositivo**. Validan/normalizan la entrada
//! e invocan el `PairingService`.

use serde_json::Value as JsonValue;

use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, DeviceSignB64Args, HandySetTokenArgs, HandyWsAuth,
    PairCreateResult, SigB64, TpvServerPostJsonArgs, TpvServerSignedHeadersArgs,
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

/// Credenciales (token + tenant) para abrir el WebSocket del Handy.
pub fn handy_get_ws_auth(svc: &dyn PairingService) -> AppResult<HandyWsAuth> {
    svc.handy_get_ws_auth()
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

/// Genera (pide al worker) un nuevo código de emparejamiento para mostrarlo en el Main.
/// El dispositivo debe estar en modo TPV con licencia activa (lo exige el worker).
pub async fn pair_create(svc: &dyn PairingService) -> AppResult<PairCreateResult> {
    svc.pair_create().await
}

/// Sube una imagen al bucket R2 vía el worker (PUT firmado). `mode` = `tpv`|`handy`.
pub async fn upload_image(
    svc: &dyn PairingService,
    mode: &str,
    path: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> AppResult<()> {
    let mode = normalize_mode(mode)?;
    let path = normalize_path(path)?;
    let content_type = requerido(content_type, "content_type")?;
    svc.upload_image(&mode, &path, &content_type, bytes).await
}

/// Borra una imagen del bucket R2 vía el worker (DELETE firmado). `mode` = `tpv`|`handy`.
pub async fn delete_image(svc: &dyn PairingService, mode: &str, path: &str) -> AppResult<()> {
    let mode = normalize_mode(mode)?;
    let path = normalize_path(path)?;
    svc.delete_image(&mode, &path).await
}

/// Descarga los bytes de una imagen de R2 (R2 → Main). `mode` = `tpv`|`handy`; `rel_path` es la
/// ruta relativa de BD (`images/{subcarpeta}/{archivo}`). Devuelve `None` si aún no existe (404).
pub async fn download_image(
    svc: &dyn PairingService,
    mode: &str,
    rel_path: &str,
) -> AppResult<Option<Vec<u8>>> {
    let mode = normalize_mode(mode)?;
    let rel_path = requerido(rel_path, "rel_path")?;
    svc.download_image(&mode, &rel_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_modos_admitidos() {
        assert_eq!(normalize_mode(" TPV ").unwrap(), "tpv");
        assert_eq!(normalize_mode("handy").unwrap(), "handy");
        assert!(normalize_mode("admin").is_err());
    }

    #[test]
    fn normaliza_path_y_rechaza_rutas_no_absolutas() {
        assert_eq!(normalize_path(" /v1/images/x ").unwrap(), "/v1/images/x");
        assert!(normalize_path("v1/images/x").is_err());
        assert!(normalize_path("   ").is_err());
    }

    #[test]
    fn requerido_recorta_el_valor() {
        assert_eq!(requerido("  tenant  ", "tenant").unwrap(), "tenant");
        assert!(requerido(" ", "tenant").is_err());
    }

    #[test]
    fn modo_es_insensible_a_mayusculas() {
        assert_eq!(normalize_mode("HaNdY").unwrap(), "handy");
        assert_eq!(normalize_mode("TpV").unwrap(), "tpv");
    }

    #[test]
    fn path_conserva_query_y_subruta_canonica() {
        assert_eq!(normalize_path(" /v1/sync/changes?since=10 ").unwrap(), "/v1/sync/changes?since=10");
    }
}
