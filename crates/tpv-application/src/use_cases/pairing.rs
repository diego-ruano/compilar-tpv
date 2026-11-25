//! Casos de uso de **pairing / identidad de dispositivo**. Validan/normalizan la entrada
//! e invocan el `PairingService`.

use serde_json::Value as JsonValue;

use tpv_contracts::licensing::{
    ApiSignedHeaders, DesfaseReloj, DeviceIdentity, DeviceFirmarEmparejamientoArgs, HandySetTokenArgs,
    PairCreateResult, FirmaDispositivo, TpvServerPostJsonArgs, TpvServerSignedHeadersArgs,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::{PairingService, ResultadoSubidaImagen};

fn requerido(input: &str, mensaje: &str) -> AppResult<String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(AppError::validation(mensaje));
    }
    Ok(out)
}

fn normalize_mode(mode: &str) -> AppResult<String> {
    let m = requerido(mode, "Falta el modo del dispositivo.")?.to_lowercase();
    match m.as_str() {
        "anon" | "tpv" | "handy" => Ok(m),
        _ => Err(AppError::validation("Modo de dispositivo inválido.")),
    }
}

fn normalize_path(path: &str) -> AppResult<String> {
    let out = requerido(path, "Falta la ruta de la petición.")?;
    if !out.starts_with('/') {
        return Err(AppError::validation("La ruta de la petición tiene que empezar por «/»."));
    }
    Ok(out)
}

pub fn device_identity(svc: &dyn PairingService) -> AppResult<DeviceIdentity> {
    svc.device_identity()
}

pub fn firmar_emparejamiento(svc: &dyn PairingService, args: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> {
    if args.pair_code.len() != 6 || !args.pair_code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::validation("El código debe tener seis cifras"));
    }
    svc.firmar_emparejamiento(args)
}

/// RELOJ-01: el desfase medido del reloj, para el aviso de la pantalla.
pub fn desfase_del_reloj(svc: &dyn PairingService) -> DesfaseReloj {
    DesfaseReloj { desfase_ms: svc.desfase_del_reloj_ms() }
}

pub fn handy_set_token(svc: &dyn PairingService, args: HandySetTokenArgs) -> AppResult<()> {
    let token = requerido(&args.token, "Falta el token de la Handy.")?;
    let tenant_id = requerido(&args.tenant_id, "Falta el negocio de la Handy.")?;
    svc.handy_set_token(&token, &tenant_id)
}

pub fn handy_get_tenant(svc: &dyn PairingService) -> AppResult<Option<String>> {
    svc.handy_get_tenant()
}


pub fn tpv_server_signed_headers(
    svc: &dyn PairingService,
    args: TpvServerSignedHeadersArgs,
) -> AppResult<ApiSignedHeaders> {
    let mode = normalize_mode(&args.mode)?;
    let method = requerido(&args.method, "Falta el método de la petición.")?;
    let path = normalize_path(&args.path)?;
    let body = args.body.unwrap_or_default();
    svc.tpv_server_signed_headers(&mode, &method, &path, body.as_bytes())
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
///
/// AUD-06 · `negocio` es el del equipo al empezar la subida: el adaptador no la firma con el token
/// de otro negocio (ver el puerto).
pub async fn upload_image(
    svc: &dyn PairingService,
    mode: &str,
    path: &str,
    content_type: &str,
    bytes: Vec<u8>,
    negocio: &str,
) -> AppResult<ResultadoSubidaImagen> {
    let mode = normalize_mode(mode)?;
    let path = normalize_path(path)?;
    let content_type = requerido(content_type, "Falta el tipo de la imagen.")?;
    let negocio = requerido(negocio, "No se sabe de qué negocio es la imagen.")?;
    svc.upload_image(&mode, &path, &content_type, bytes, &negocio).await
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
    let rel_path = requerido(rel_path, "Falta la ruta de la imagen.")?;
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
