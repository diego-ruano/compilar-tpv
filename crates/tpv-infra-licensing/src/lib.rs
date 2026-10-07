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
pub mod field_crypto;
pub mod reloj;
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
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cloud_sync::CloudSyncService;
use tpv_application::ports::licensing::{LicensingService, PairingService};
use tpv_application::ports::correo_recuperacion::CorreoRecuperacionService;
use tpv_application::ports::recuperacion_pin::RecuperacionPinService;
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity, HandyWsAuth, LicenseLocalState, PairCreateResult, SigB64,
};
use tpv_contracts::login::{CodigoEnviado, EstadoCorreoRecuperacion};
use tpv_domain::licensing::{
    self as dom, AssertionVerificada, Concesion, EstadoLicencia, EstadoVerificado, FalloConsulta,
    ResultadoActivacion, SolicitudActivacion,
};

use device::{
    clear_license_token, get_handy_token, get_license_token, get_or_create_device_id,
    get_or_create_device_keypair, leer_device_keypair, leer_identidad, set_license_token,
    sign_device_proof, sign_payload_b64, token_caducado,
};

/// Worker unificado `tpv-api` (fusión de los antiguos `tpv-licensing` + `tpv-server`): sirve
/// licencia (`/v1/license/*`), pairing (`/v1/pair/*`), revoke, imágenes, WS y el DO TenantHub.
/// Es el **único** host de la nube: `tpv-infra-http` lo reexporta para el resto del backend.
pub const CLOUD_API_BASE: &str = "https://tpv-api.altarialights.workers.dev";

/// Claves públicas ed25519 (base64) con las que el worker puede firmar el estado de licencia. Van
/// **pineadas** en el binario: no se descargan de ningún sitio. Es lo que cierra LIC-01 —un servidor
/// falso, un MITM con CA de confianza o un DNS envenenado no tienen la privada, así que no pueden
/// forjar un `active`—. Una aserción vale si la verifica cualquiera de ellas.
///
/// RI-09 · Son dos para poder rotar sin cortar a nadie:
/// - La **en uso**: su privada es el secreto `LICENSE_SIGNING_PRIVATE_KEY` del worker.
/// - La **de reserva**: su privada NO está en Cloudflare, se guarda fuera de línea. Si la en uso se
///   filtra, se sube la de reserva al worker y todos los equipos la aceptan al momento, sin esperar
///   a que se actualicen. En la versión siguiente se quita la filtrada y se genera otra reserva.
///
/// Con una sola, cambiarla dejaba en `bad_signature` (bloqueado) a todo equipo que no se hubiera
/// actualizado antes. El procedimiento está en `docs/arquitectura/licencias.md`. Se generan con
/// `pnpm license:keypair`.
pub const LICENSE_SIGNING_PUBLIC_KEYS_B64: &[&str] = &[
    // En uso.
    "9/GH9g7BSTP2wu2lq6I99LZgsIHZFMPcrdU3IIKyZ6s=",
    // Reserva.
    "Y1vpMISE5evp8q8iMJaNpoJmDg3uo3lW/Mh30xVNfcg=",
];

const HTTP_TIMEOUT_SECS: u64 = 20;

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

/* ===== Motivo del último rechazo (license_rejection.txt) ===== */

/// Fichero aparte y no un campo del estado: precisamente existe para el rato en que NO hay estado.
fn license_rejection_path(dir: &Path) -> PathBuf {
    dir.join("license_rejection.txt")
}

fn load_rejection(dir: &Path) -> Option<String> {
    let code = fs::read_to_string(license_rejection_path(dir)).ok()?;
    let code = code.trim().to_string();
    if code.is_empty() {
        None
    } else {
        Some(code)
    }
}

fn save_rejection(dir: &Path, code: &str) -> AppResult<()> {
    let p = license_rejection_path(dir);
    fs::write(&p, code).map_err(|e| ext(format!("Error escribiendo {:?}: {e}", p)))
}

fn delete_rejection(dir: &Path) -> AppResult<()> {
    let p = license_rejection_path(dir);
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

/// Lo que vuelve de una petición device-proof sin cuerpo, con la hora que llevaba firmada el
/// intento que contestó: la aserción de `/status` va ligada a ella (`client_ts`).
struct Respondida {
    http: u16,
    texto: String,
    ts: i64,
}

/// Petición device-proof SIN cuerpo (`/v1/license/status` y `/v1/license/refresh`, de la Main y de
/// la Handy), firmada con la hora de la nube y repetida UNA vez si la nube la rechaza por la hora
/// (PROD-04, ver [`reloj`]). El rechazo trae ya la hora buena, así que la repetición entra.
async fn peticion_con_prueba(
    metodo: Method,
    path: &str,
    token: &str,
    sk: &SigningKey,
) -> Result<Respondida, String> {
    let client = http_client().map_err(|e| e.to_string())?;
    let mut repetida = false;

    loop {
        let ts = reloj::ahora_ms();
        // Sin cuerpo: se firma la cadena vacía.
        let sig = sign_device_proof(sk, ts, metodo.as_str(), path, token, b"")?;

        let resp = reloj::enviar(
            client
                .request(metodo.clone(), api_url(path))
                .bearer_auth(token)
                .header("X-Device-Ts", ts.to_string())
                .header("X-Device-Sig", sig),
        )
        .await
        .map_err(|e| e.to_string())?;

        let http = resp.status().as_u16();
        let texto = resp.text().await.unwrap_or_default();

        if !repetida && reloj::es_rechazo_por_reloj(http, &texto) {
            repetida = true;
            continue;
        }
        return Ok(Respondida { http, texto, ts });
    }
}

/* ===== Tipos de la API de licencias (internos del adaptador) ===== */

/// Respuesta de error del worker: `{ ok:false, error, code?, message?, details? }`.
#[derive(Debug, Deserialize)]
struct ApiErr {
    error: String,
    /// ARCH-05: código ya resuelto por el worker. `Option` porque un worker anterior no lo
    /// manda; en ese caso se traduce el `error` con `ErrorCode::from_wire`.
    code: Option<String>,
    /// La frase para quien está delante, si el worker la tiene (`lib/errorCodes.ts`).
    message: Option<String>,
    details: Option<JsonValue>,
}

impl ApiErr {
    fn parse(text: &str) -> Option<Self> {
        serde_json::from_str::<ApiErr>(text).ok()
    }

    /// Lo que se enseña: la frase del worker si la trae y, si no, su identificador (que
    /// `AppErrorDto` convierte en la frase genérica de su código). El `details` va detrás, entre
    /// paréntesis, para diagnosticar: p. ej. el error de Turso de `tenant_db_provision_failed`.
    fn texto(&self) -> String {
        let base = self
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(&self.error);
        let detalle = self.details.as_ref().and_then(|d| match d {
            JsonValue::String(s) => Some(s.clone()),
            JsonValue::Null => None,
            other => Some(other.to_string()),
        });
        match detalle {
            Some(d) if !d.trim().is_empty() => format!("{base} ({d})"),
            _ => base.to_string(),
        }
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
    /// TRAB-03: DEK del tenant para cifrar la PII del personal. `Option` porque un worker
    /// anterior a este cambio no la manda; en ese caso el cifrado queda inactivo y las
    /// columnas se leen/escriben en claro, como antes.
    field_dek: Option<String>,
    /// Si la activación ha trasladado la licencia desde otro equipo. `default` para un worker
    /// anterior que no lo manda: sin él no se sabe, y se sigue como hasta ahora.
    #[serde(default)]
    cambio_de_equipo: bool,
    /// REV-13: la clave ha sumado su tiempo a la licencia que ya había en este equipo. `default`
    /// para un worker anterior que no lo manda — ahí no existía el canje, así que `false` es lo
    /// que era verdad.
    #[serde(default)]
    tiempo_sumado: bool,
}

/// Datos del negocio que acompañan a la activación (el worker los espera en camelCase).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TenantInfo<'a> {
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    legal_name: Option<&'a str>,
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
    /// RI-52: canje desde Configuración. Sólo viaja cuando es `true`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    solo_sumar: bool,
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

fn verifying_key(b64: &str) -> Option<VerifyingKey> {
    let bytes = B64.decode(b64).ok()?;
    let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// ¿Firma `sig` el mensaje con alguna de las claves? Una clave pineada que no se pueda leer no cuenta
/// (y la prueba `las_claves_pineadas_son_validas` impide que llegue a compilarse una así).
fn firmado_por_alguna(claves: &[&str], msg: &[u8], sig: &Signature) -> bool {
    claves
        .iter()
        .filter_map(|c| verifying_key(c))
        .any(|vk| vk.verify(msg, sig).is_ok())
}

/// Verifica la firma ed25519 contra las claves pineadas, comprueba que la aserción es de ESTA
/// petición (`client_ts`) y que no ha caducado, y solo entonces construye el estado de fiar.
fn verificar_assertion(
    dto: SignedAssertionDto,
    client_ts_enviado: i64,
    ahora_ms: i64,
) -> Result<AssertionVerificada, FalloConsulta> {
    verificar_assertion_con(LICENSE_SIGNING_PUBLIC_KEYS_B64, dto, client_ts_enviado, ahora_ms)
}

fn verificar_assertion_con(
    claves: &[&str],
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

    let sig_bytes = B64.decode(&dto.sig).map_err(|_| FalloConsulta::FirmaInvalida)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| FalloConsulta::FirmaInvalida)?;

    let msg = dom::mensaje_canonico(&assertion);
    if !firmado_por_alguna(claves, msg.as_bytes(), &sig) {
        return Err(FalloConsulta::FirmaInvalida);
    }

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
        // REV-10: el reloj de este equipo va más de 2 min desfasado, así que el worker no acepta
        // su firma. Se trataba como «no llego», y por eso el usuario veía una cuenta atrás de 72 h
        // y después un bloqueo que hablaba de la conexión — mientras ni el WebSocket ni la Handy
        // conectaban, por lo mismo, y nada decía que la culpa era de la hora. La licencia sigue
        // siendo buena: el veredicto no cambia, cambia lo que se le cuenta a quien puede arreglarlo.
        "device_ts_out_of_range" | "timestamp_out_of_range" => FalloConsulta::RelojDesfasado,

        // Todo lo demás (token/proof/5xx): transitorio o ambiguo. No se tira la licencia;
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
        // RI-72: la clave se LEE. Si el almacén no contesta, se vuelve a intentar en el siguiente
        // pulso; crear otra aquí era perder la identidad del equipo para siempre.
        let sk = leer_device_keypair(device_id).map_err(|e| {
            log::warn!("[licencia] sin la clave del dispositivo: {e}");
            FalloConsulta::Inalcanzable
        })?;
        let r = peticion_con_prueba(Method::GET, PATH, token, &sk)
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        if !(200..300).contains(&r.http) {
            let code = ApiErr::parse(&r.texto).map(|e| e.error).unwrap_or_default();
            return Err(clasificar_error(r.http, &code));
        }

        let ok: StatusOk = serde_json::from_str(&r.texto).map_err(|e| FalloConsulta::Ilegible {
            detalle: format!("invalid_json: {e} | body={}", r.texto),
        })?;

        Ok((ok, r.ts))
    }

    /// POST `/v1/license/refresh` (device-proof). Reemite el token de sesión cuando el viejo ha
    /// caducado. `Ok(None)` si el refresco falló por red (se cae a la gracia offline).
    async fn refrescar_token(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<String, FalloConsulta> {
        const PATH: &str = "/v1/license/refresh";

        let sk = leer_device_keypair(device_id).map_err(|e| {
            log::warn!("[licencia] sin la clave del dispositivo: {e}");
            FalloConsulta::Inalcanzable
        })?;
        let r = peticion_con_prueba(Method::POST, PATH, token, &sk)
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        if !(200..300).contains(&r.http) {
            let code = ApiErr::parse(&r.texto).map(|e| e.error).unwrap_or_default();
            return Err(clasificar_error(r.http, &code));
        }

        serde_json::from_str::<RefreshOk>(&r.texto)
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
        // Con una licencia válida delante no hay rechazo pendiente que contar: la nota se va con
        // ella. Esto es lo que hace que reactivar limpie el aviso sin que nadie tenga que acordarse.
        delete_rejection(&self.app_data_dir)?;
        save_state(&self.app_data_dir, state)
    }

    fn delete_state(&self, motivo: Option<&str>) -> AppResult<()> {
        // Borrar la licencia también retira su credencial del keyring (si no, quedaría un token
        // huérfano y utilizable).
        clear_license_token().map_err(ext)?;
        delete_state(&self.app_data_dir)?;

        match motivo {
            Some(code) => save_rejection(&self.app_data_dir, code),
            None => delete_rejection(&self.app_data_dir),
        }
    }

    fn last_rejection(&self) -> AppResult<Option<String>> {
        Ok(load_rejection(&self.app_data_dir))
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
                phone: solicitud.phone.as_deref(),
                country: solicitud.country.as_deref(),
            },
            solo_sumar: solicitud.solo_sumar,
        };

        // Sin firma, pero su respuesta es la primera hora de la nube que ve un equipo recién
        // estrenado: el primer `/status` ya sale con ella (PROD-04).
        let resp = reloj::enviar(
            http_client()?
                .post(api_url("/v1/license/activate"))
                .header(CONTENT_TYPE, "application/json")
                .json(&req),
        )
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

                // ARCH-05: manda el `code` del worker; si no viene (o no se reconoce), se traduce
                // el string de negocio. Mismo criterio que `AppError::from_api_body`.
                let code = e
                    .code
                    .as_deref()
                    .and_then(ErrorCode::from_code)
                    .unwrap_or_else(|| ErrorCode::from_wire(&e.error));
                return Err(AppError::coded(code, e.texto()));
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

        // TRAB-03: la clave de cifrado de campo, al almacén de secretos del sistema. Va aquí y
        // no en `license_state.json` porque guardarla junto a la base de datos que protege no
        // serviría de nada. Si falla, se registra y se sigue: la activación NO se aborta —
        // quedarse sin poder activar por esto sería peor que operar sin cifrado.
        if let Some(dek) = ok.field_dek.as_deref().map(str::trim) {
            if !dek.is_empty() {
                if let Err(e) = device::set_field_dek(dek) {
                    log::warn!("no se pudo guardar la field_dek: {e}");
                }
            }
        }

        Ok(ResultadoActivacion::Activada(Concesion {
            tenant_id: ok.tenant_id.trim().to_string(),
            device_id,
            status: ok.status,
            expires_at: ok.expires_at,
            // La activación devuelve `expiresAt` en ISO; el número absoluto lo fija el primer
            // `/status` firmado. Aquí queda pendiente (None) hasta esa comprobación.
            expires_at_ms: None,
            plan: None,
            cambio_de_equipo: ok.cambio_de_equipo,
            tiempo_sumado: ok.tiempo_sumado,
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
                let assertion = verificar_assertion(ok.assertion, ts, reloj::ahora_ms())?;
                // Persistir el token efectivo (el que renovó /status, o el del refresh si no).
                self.persistir_token(ok.token.as_deref(), &nuevo);
                return Ok(EstadoVerificado {
                    assertion,
                    server_time_ms: ok.server_time,
                });
            }
        };

        // PROD-04: la caducidad de la aserción la pone la nube con SU reloj, así que se compara con
        // la hora de la nube. Con la del equipo, uno adelantado más de cinco minutos daría por
        // caducada una aserción recién firmada, justo cuando la petición ya había entrado.
        let assertion = verificar_assertion(ok.assertion, ts, reloj::ahora_ms())?;
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

/// Este adaptador **ya no guarda nada en disco**: sus dos credenciales —el token de sesión de la
/// Main y el del Handy— viven en el almacén de secretos de la plataforma desde que se movieron ahí
/// (`secret_store`), así que no le queda estado que llevar. Se quedó con una `app_data_dir` dentro
/// que nadie leía, y eso es lo que ha cazado clippy.
///
/// El **parámetro** del constructor se conserva a propósito: lo pasan quince sitios y quitarlo sería
/// tocarlos todos para no ganar nada. Si algún día vuelve a hacer falta la ruta, está ahí.
pub struct PairingAdapter;

impl PairingAdapter {
    pub fn new(_app_data_dir: PathBuf) -> Self {
        Self
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
        // RI-72: firmar sólo lee la identidad; nunca la crea.
        let (_, sk) = leer_identidad().map_err(ext)?;

        let token = if mode == "handy" {
            get_handy_token().map_err(AppError::external)?
        } else if mode == "tpv" {
            self.license_token()?
        } else {
            return Err(AppError::validation(
                "bad_mode_for_signed_headers (use: tpv|handy)",
            ));
        };

        // PROD-04: la hora de la nube, no la del equipo (ver `reloj`).
        let ts = reloj::ahora_ms();
        let sig = sign_device_proof(&sk, ts, &method.to_uppercase(), path, token.trim(), body)
            .map_err(ext)?;

        Ok(ApiSignedHeaders {
            authorization: format!("Bearer {}", token.trim()),
            x_device_ts: ts.to_string(),
            x_device_sig: sig,
        })
    }

    /// Manda el POST ya firmado y devuelve el par crudo `(status, cuerpo)`.
    ///
    /// Está aparte de `tpv_server_post_json` porque esa petición puede hacerse **dos veces**: si
    /// la nube contesta 401 a una Handy, se renueva su token y se repite. Y repetirla exige volver
    /// a firmar —la firma cubre el token, y el token es justo lo que ha cambiado—, así que no vale
    /// con reenviar las mismas cabeceras.
    async fn enviar_post(&self, mode: &str, path: &str, body_str: &str) -> AppResult<(u16, String)> {
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

        // También las anónimas del emparejamiento: la respuesta al `claim` es lo que le da a la
        // Handy la hora con la que firmará después la recogida del token.
        let resp = reloj::enviar(
            client
                .post(api_url(path))
                .headers(headers)
                .body(body_str.to_string()),
        )
        .await
        .map_err(AppError::sin_conexion)?;

        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        Ok((status, text))
    }

    /// REV-02: reemite el token de la Handy por `/v1/license/refresh` y lo guarda en el
    /// almacén de secretos.
    ///
    /// El token de una Handy se emite al emparejarla y dura 30 días. Nadie lo renovaba: al
    /// caducar, TODAS sus peticiones pasaban a contestar 401 y la aplicación lo leía como falta de
    /// red, así que se quedaba en «Conectando…» para siempre y había que volver a vincularla a
    /// mano. Lo que la autentica aquí no es el token —que puede estar caducado, y es el caso— sino
    /// la firma de su clave privada, la misma con la que firma todo lo demás.
    ///
    /// Si el equipo está revocado o ya no está en este negocio, la nube contesta con un código del
    /// catálogo (`device_revoked`) y quien llamó deja de insistir, que es lo contrario de lo que
    /// hacía antes.
    ///
    /// Lo llaman los DOS transportes de la Handy —este `tpv_server_post_json` (ticket del
    /// WebSocket, emparejamiento) y el `CloudClient` de `tpv-infra-http` (todas sus lecturas y
    /// escrituras)—, cada uno ante su 401. Uno solo no bastaba: el ticket se pide al reconectar, y
    /// un equipo que cruza la caducidad con el socket abierto se quedaba con la pantalla conectada
    /// y todas sus lecturas fallando.
    pub async fn renovar_token_handy(&self) -> AppResult<()> {
        const PATH: &str = "/v1/license/refresh";

        let token = get_handy_token().map_err(AppError::external)?;
        let tenant_id = device::handy_get_tenant()
            .map_err(ext)?
            .ok_or_else(|| ext("handy_tenant_missing"))?;

        let (_, sk) = leer_identidad().map_err(ext)?;

        // Mismo camino que el `/refresh` de la Main: sin cuerpo y con la hora de la nube.
        let r = peticion_con_prueba(Method::POST, PATH, token.trim(), &sk)
            .await
            .map_err(AppError::sin_conexion)?;

        if !(200..300).contains(&r.http) {
            return Err(AppError::from_api_body(r.http, &r.texto));
        }

        let nuevo = serde_json::from_str::<RefreshOk>(&r.texto)
            .map_err(|e| ext(format!("bad_refresh_response:{e}")))?;

        device::handy_set_token(nuevo.token.trim(), &tenant_id).map_err(ext)
    }

    /// Manda una petición firmada (las de imágenes: PUT, DELETE y el POST de descarga) y, si la nube
    /// contesta 401 con el token de la Handy caducado, la repite UNA vez con el token renovado
    /// (REV-02).
    ///
    /// Recibe los ingredientes y no una petición ya montada porque hay que **firmarla otra vez**:
    /// la firma cubre el token, y el token es justo lo que ha cambiado.
    ///
    /// Devuelve el estado y los bytes del cuerpo, que es lo que separa a estos tres del POST de
    /// JSON: la descarga de una imagen quiere los bytes, no el texto. Van ya leídos porque saber si
    /// un 401 fue por la hora (PROD-04) exige leer el cuerpo, y uno leído no se puede devolver.
    async fn enviar_firmado(
        &self,
        mode: &str,
        metodo: Method,
        path: &str,
        cuerpo: &[u8],
        content_type: Option<&str>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let (mut status, mut bytes) = self
            .una_peticion_firmada(mode, metodo.clone(), path, cuerpo, content_type)
            .await?;

        // PROD-04: igual que en el POST de JSON.
        if reloj::es_rechazo_por_reloj(status, &String::from_utf8_lossy(&bytes)) {
            (status, bytes) = self
                .una_peticion_firmada(mode, metodo.clone(), path, cuerpo, content_type)
                .await?;
        }

        if status != 401 || mode != "handy" {
            return Ok((status, bytes));
        }
        if !self.renovar_si_el_token_ha_caducado().await {
            return Ok((status, bytes));
        }

        self.una_peticion_firmada(mode, metodo, path, cuerpo, content_type)
            .await
    }

    /// Un intento: firma con el token que haya AHORA y manda.
    async fn una_peticion_firmada(
        &self,
        mode: &str,
        metodo: Method,
        path: &str,
        cuerpo: &[u8],
        content_type: Option<&str>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let signed = self.signed_headers_inner(mode, metodo.as_str(), path, cuerpo)?;

        let mut rb = http_client()?
            .request(metodo, api_url(path))
            .header(AUTHORIZATION, signed.authorization)
            .header("x-device-ts", signed.x_device_ts)
            .header("x-device-sig", signed.x_device_sig);

        if let Some(ct) = content_type {
            rb = rb.header(
                CONTENT_TYPE,
                HeaderValue::from_str(ct).map_err(|_| AppError::validation("bad_content_type"))?,
            );
        }
        if !cuerpo.is_empty() {
            rb = rb.body(cuerpo.to_vec());
        }

        let resp = reloj::enviar(rb).await.map_err(AppError::sin_conexion)?;
        let status = resp.status().as_u16();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ext(format!("respuesta_ilegible:{e}")))?;
        Ok((status, bytes.to_vec()))
    }

    /// Renueva el token de la Handy **sólo si el que llevamos ya no vale por fecha**, y dice si
    /// merece la pena repetir la petición que se llevó el 401.
    ///
    /// Los dos transportes preguntan esto y no «ha fallado, renueva», por lo que explica
    /// `token_caducado`: por ellos viajan escrituras y el login de la Handy, y repetir una petición
    /// que la nube sí procesó no es gratis. Con el token caducado el 401 lo puso la autenticación
    /// del worker **antes** de tocar nada, así que repetir es seguro por construcción.
    pub async fn renovar_si_el_token_ha_caducado(&self) -> bool {
        match get_handy_token() {
            Ok(token) if token_caducado(&token) => self.renovar_token_handy().await.is_ok(),
            _ => false,
        }
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

    /// Siempre va después de `device_identity` (el emparejamiento y el saludo del WebSocket la piden
    /// antes de firmar), así que aquí sólo se lee.
    fn device_sign_b64(&self, payload: &str) -> AppResult<SigB64> {
        let (_, sk) = leer_identidad().map_err(ext)?;
        let sig_b64 = sign_payload_b64(&sk, payload).map_err(ext)?;
        Ok(SigB64 { sig_b64 })
    }

    fn hora_para_firmar(&self) -> i64 {
        reloj::ahora_ms()
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
        // El cuerpo se serializa UNA vez: es lo que se firma y lo que se envía. Si se dejase que
        // reqwest lo volviera a serializar con `.json(&body)`, cualquier diferencia de bytes
        // (orden, espacios) invalidaría la firma en el worker.
        let body_str =
            serde_json::to_string(&body).map_err(|e| ext(format!("bad_json_body:{e}")))?;

        let (mut status, mut text) = self.enviar_post(mode, path, &body_str).await?;

        // PROD-04. Rechazada por la hora de la firma: el rechazo ya ha traído la hora de la nube,
        // así que se firma otra vez y se repite UNA. Sólo si la firma la pone Rust: en las anónimas
        // del emparejamiento la hora va firmada dentro del cuerpo, y repetir el mismo cuerpo daría
        // el mismo rechazo (esas ya salen con la hora buena: la toman del `claim`).
        if (mode == "tpv" || mode == "handy") && reloj::es_rechazo_por_reloj(status, &text) {
            (status, text) = self.enviar_post(mode, path, &body_str).await?;
        }

        // REV-02. Un 401 en una Handy con el token caducado es la credencial, no la petición: se
        // renueva y se repite UNA vez. Quien decide es la fecha del propio token
        // (`renovar_si_el_token_ha_caducado`) y no el texto del error, que cambia según por dónde
        // lo rechace el worker (`jwt_expired`, `token_expired`, `invalid_token`).
        //
        // Si renovar no arregla nada —el dispositivo está revocado, o su fila ya no está en este
        // negocio— el segundo intento vuelve con el mismo 401 y su código del catálogo, que es lo
        // que permite a quien llamó dejar de reintentar en vez de tomarlo por falta de red.
        if status == 401 && mode == "handy" && self.renovar_si_el_token_ha_caducado().await {
            let (s2, t2) = self.enviar_post(mode, path, &body_str).await?;
            status = s2;
            text = t2;
        }

        let parsed: JsonValue =
            serde_json::from_str(&text).unwrap_or(JsonValue::Object(Default::default()));

        // ARCH-05: un único criterio para resolver el código, compartido con el resto de
        // adaptadores (`from_api_body`): manda el `code` del worker; si no viene, se traduce
        // el string de negocio. El texto original sigue viajando como `message`.
        if !(200..300).contains(&status) {
            return Err(AppError::from_api_body(status, &text));
        }

        // 200 con `ok:false`: el worker responde 200 y marca el fallo en el cuerpo.
        if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            return Err(AppError::from_api_body(status, &text));
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
        // escritura directa a R2 (no pasa por el hub), y subir dos veces el mismo fichero al mismo
        // path deja exactamente lo mismo — por eso repetirlo tras renovar el token es inocuo.
        let (status, cuerpo) = self
            .enviar_firmado(mode, Method::PUT, path, &bytes, Some(content_type))
            .await?;

        if (200..300).contains(&status) {
            return Ok(());
        }
        Err(AppError::from_api_body(status, &String::from_utf8_lossy(&cuerpo)))
    }

    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()> {
        let (status, cuerpo) = self
            .enviar_firmado(mode, Method::DELETE, path, b"", None)
            .await?;

        if (200..300).contains(&status) {
            return Ok(());
        }
        Err(AppError::external(format!(
            "image_delete_http_{}: {}",
            status,
            String::from_utf8_lossy(&cuerpo)
        )))
    }

    async fn download_image(&self, mode: &str, rel_path: &str) -> AppResult<Option<Vec<u8>>> {
        // POST firmado a `/v1/images/download`. El tenant lo deriva el worker del token, así que
        // la Main no necesita conocerlo; `rel_path` viaja en el cuerpo, que **ahora sí entra en la
        // firma** (FABLE-E). 404 → None (el binario aún no está en R2).
        let path = "/v1/images/download";
        let body_str = serde_json::to_string(&serde_json::json!({ "rel_path": rel_path }))
            .map_err(|e| ext(format!("bad_json_body:{e}")))?;

        let (status, bytes) = self
            .enviar_firmado(
                mode,
                Method::POST,
                path,
                body_str.as_bytes(),
                Some("application/json"),
            )
            .await?;

        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(AppError::external(format!(
                "image_download_http_{}: {}",
                status,
                String::from_utf8_lossy(&bytes)
            )));
        }

        Ok(Some(bytes))
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

/// La respuesta de las rutas que mandan un código (`{ ok, emailHint, minutos, reenvioSegundos, sinCambios? }`).
fn codigo_enviado(resp: &JsonValue) -> CodigoEnviado {
    CodigoEnviado {
        email_hint: resp
            .get("emailHint")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        minutos: resp.get("minutos").and_then(|v| v.as_i64()).unwrap_or(10),
        reenvio_segundos: resp.get("reenvioSegundos").and_then(|v| v.as_i64()).unwrap_or(300),
        sin_cambios: resp.get("sinCambios").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}

/// La respuesta de las rutas del correo de recuperación (`{ ok, emailHint, esElDeLaCompra }`).
fn estado_correo(resp: &JsonValue) -> EstadoCorreoRecuperacion {
    EstadoCorreoRecuperacion {
        email_hint: resp
            .get("emailHint")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        es_el_de_la_compra: resp
            .get("esElDeLaCompra")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    }
}

#[async_trait]
impl CorreoRecuperacionService for PairingAdapter {
    async fn estado(&self) -> AppResult<EstadoCorreoRecuperacion> {
        let resp = self
            .tpv_server_post_json(
                "tpv",
                "/v1/login/correo-recuperacion/estado",
                serde_json::json!({}),
            )
            .await?;
        Ok(estado_correo(&resp))
    }

    async fn solicitar_cambio(&self, correo: &str) -> AppResult<CodigoEnviado> {
        let resp = self
            .tpv_server_post_json(
                "tpv",
                "/v1/login/correo-recuperacion/solicitar",
                serde_json::json!({ "correo": correo }),
            )
            .await?;
        Ok(codigo_enviado(&resp))
    }

    async fn confirmar_cambio(&self, codigo: &str) -> AppResult<EstadoCorreoRecuperacion> {
        let resp = self
            .tpv_server_post_json(
                "tpv",
                "/v1/login/correo-recuperacion/confirmar",
                serde_json::json!({ "codigo": codigo }),
            )
            .await?;
        Ok(estado_correo(&resp))
    }

    async fn usar_el_de_la_compra(&self) -> AppResult<EstadoCorreoRecuperacion> {
        let resp = self
            .tpv_server_post_json(
                "tpv",
                "/v1/login/correo-recuperacion/usar-el-de-la-compra",
                serde_json::json!({}),
            )
            .await?;
        Ok(estado_correo(&resp))
    }
}

#[async_trait]
impl RecuperacionPinService for PairingAdapter {
    async fn solicitar_codigo(&self, id_usuario: &str) -> AppResult<CodigoEnviado> {
        // Firmado como `tpv`: el tenant lo saca el worker del token y comprueba que es la Main.
        let resp = self
            .tpv_server_post_json(
                "tpv",
                "/v1/login/recuperar-pin/solicitar",
                serde_json::json!({ "id_usuario": id_usuario }),
            )
            .await?;

        Ok(codigo_enviado(&resp))
    }

    async fn verificar_codigo(&self, id_usuario: &str, codigo: &str) -> AppResult<()> {
        self.tpv_server_post_json(
            "tpv",
            "/v1/login/recuperar-pin/verificar",
            serde_json::json!({ "id_usuario": id_usuario, "codigo": codigo }),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests_respuesta_de_activar {
    use super::*;

    const RESPUESTA: &str = r#"{"ok":true,"tenantId":"t1","token":"jwt","status":"active","expiresAt":null,"deviceId":"d1","fieldDek":"x""#;

    #[test]
    fn lee_si_la_activacion_ha_sido_un_traslado() {
        let ok: ActivateOk = serde_json::from_str(&format!("{RESPUESTA},\"cambioDeEquipo\":true}}")).unwrap();
        assert!(ok.cambio_de_equipo);
    }

    /// Un worker anterior no lo manda: sin él no se sabe, y no se toca la base del equipo.
    #[test]
    fn sin_el_campo_no_es_un_traslado() {
        let ok: ActivateOk = serde_json::from_str(&format!("{RESPUESTA}}}")).unwrap();
        assert!(!ok.cambio_de_equipo);
    }
}

#[cfg(test)]
mod tests_error_del_worker {
    use super::*;

    fn texto(cuerpo: &str) -> String {
        ApiErr::parse(cuerpo).expect("cuerpo de error").texto()
    }

    /// Activar o cambiar de equipo enseñaba `invalid_code` aunque el worker mandara la frase.
    #[test]
    fn la_frase_del_worker_gana_al_identificador() {
        assert_eq!(
            texto(r#"{"ok":false,"error":"invalid_code","message":"El código no es correcto."}"#),
            "El código no es correcto."
        );
    }

    #[test]
    fn sin_frase_queda_el_identificador_para_que_la_frontera_lo_traduzca() {
        assert_eq!(texto(r#"{"ok":false,"error":"license_not_found"}"#), "license_not_found");
        assert_eq!(texto(r#"{"ok":false,"error":"x","message":"   "}"#), "x");
    }

    #[test]
    fn el_detalle_se_conserva_detras() {
        assert_eq!(
            texto(r#"{"ok":false,"error":"tenant_db_provision_failed","message":"No se ha podido preparar la base.","details":"turso 503"}"#),
            "No se ha podido preparar la base. (turso 503)"
        );
    }
}

#[cfg(test)]
mod tests_clasificar_error {
    //! REV-10: de qué clase es cada fallo del worker, que es lo que decide qué se le cuenta al
    //! usuario. El reloj desfasado se contaba como «no llego»: 72 h de cuenta atrás y después un
    //! bloqueo hablando de internet, mientras ni el WebSocket ni la Handy conectaban por lo mismo.

    use super::*;

    fn codigo(http: u16, code: &str) -> String {
        clasificar_error(http, code).to_string()
    }

    #[test]
    fn un_reloj_desfasado_se_distingue_de_no_tener_red() {
        assert_eq!(codigo(401, "device_ts_out_of_range"), "device_ts_out_of_range");
        // El worker usa los dos nombres según por dónde entre la petición.
        assert_eq!(codigo(401, "timestamp_out_of_range"), "device_ts_out_of_range");
    }

    #[test]
    fn lo_demas_sigue_siendo_inalcanzable() {
        // La otra mitad: sin esto, cualquier 5xx pasaría a echarle la culpa al reloj.
        for code in ["jwt_expired", "bad_device_signature", "internal_error", ""] {
            assert_eq!(codigo(500, code), "license_status_unreachable", "code={code}");
        }
    }

    #[test]
    fn un_rechazo_de_la_licencia_no_se_toca() {
        // Estos SÍ borran el estado local, así que confundirlos con el reloj sería mucho peor.
        for code in ["license_not_found", "license_revoked", "device_replaced"] {
            assert_eq!(codigo(403, code), code, "code={code}");
        }
    }
}

#[cfg(test)]
mod tests_firma_de_licencia {
    //! RI-09: las aserciones se verifican contra una LISTA de claves pineadas, para poder pasar a la
    //! de reserva sin dejar bloqueado a ningún equipo.

    use super::*;
    use ed25519_dalek::Signer;

    const AHORA: i64 = 1_790_000_000_000;

    fn clave(semilla: u8) -> SigningKey {
        SigningKey::from_bytes(&[semilla; 32])
    }

    fn publica(sk: &SigningKey) -> String {
        B64.encode(sk.verifying_key().to_bytes())
    }

    /// Una aserción `active` de esta petición, firmada con `sk`.
    fn firmada_por(sk: &SigningKey) -> SignedAssertionDto {
        let a = AssertionVerificada {
            version: 1,
            tenant_id: "t1".into(),
            device_id: "d1".into(),
            license_id: "l1".into(),
            estado: EstadoLicencia::Active,
            plan: "standard".into(),
            expires_at_ms: None,
            issued_at_ms: AHORA,
            assertion_expires_at_ms: AHORA + 60_000,
            client_ts: AHORA,
        };
        let sig = sk.sign(dom::mensaje_canonico(&a).as_bytes());
        SignedAssertionDto {
            v: a.version,
            tenant_id: a.tenant_id,
            device_id: a.device_id,
            license_id: a.license_id,
            state: "active".into(),
            plan: a.plan,
            expires_at_ms: a.expires_at_ms,
            issued_at_ms: a.issued_at_ms,
            assertion_expires_at_ms: a.assertion_expires_at_ms,
            client_ts: a.client_ts,
            sig: B64.encode(sig.to_bytes()),
        }
    }

    #[test]
    fn vale_la_firma_de_cualquiera_de_las_claves_pineadas() {
        let (en_uso, reserva) = (clave(1), clave(2));
        let claves = [publica(&en_uso), publica(&reserva)];
        let claves: Vec<&str> = claves.iter().map(String::as_str).collect();

        assert!(verificar_assertion_con(&claves, firmada_por(&en_uso), AHORA, AHORA).is_ok());
        assert!(
            verificar_assertion_con(&claves, firmada_por(&reserva), AHORA, AHORA).is_ok(),
            "el día que el worker pase a la de reserva, los equipos ya la aceptan"
        );
    }

    #[test]
    fn la_firma_de_una_clave_que_no_esta_pineada_no_vale() {
        let claves = [publica(&clave(1))];
        let claves: Vec<&str> = claves.iter().map(String::as_str).collect();
        assert!(matches!(
            verificar_assertion_con(&claves, firmada_por(&clave(9)), AHORA, AHORA),
            Err(FalloConsulta::FirmaInvalida)
        ));
    }

    /// Una clave mal copiada al pinearla no se notaría hasta el día que hiciera falta.
    #[test]
    fn las_claves_pineadas_son_validas_y_distintas() {
        assert!(LICENSE_SIGNING_PUBLIC_KEYS_B64.len() >= 2, "en uso + reserva");
        for c in LICENSE_SIGNING_PUBLIC_KEYS_B64 {
            assert!(verifying_key(c).is_some(), "clave pineada ilegible: {c}");
        }
        let mut unicas = LICENSE_SIGNING_PUBLIC_KEYS_B64.to_vec();
        unicas.sort();
        unicas.dedup();
        assert_eq!(unicas.len(), LICENSE_SIGNING_PUBLIC_KEYS_B64.len());
    }
}
