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

pub mod cola_imagenes;
pub mod device;
pub mod field_crypto;
pub mod reloj;
mod secret_store;

/// Reexport para que el cdylib de la app entregue la `JavaVM` del proceso (`JNI_OnLoad`) y el `Context`
/// (`MainActivity`), que el almacén de secretos de Android (Keystore) necesita. En otras plataformas no
/// existe.
#[cfg(target_os = "android")]
pub use secret_store::{init_contexto, init_java_vm};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::{EstadoConsultado, LicensingService, PairingService, ResultadoSubidaImagen};
use tpv_application::ports::correo_recuperacion::CorreoRecuperacionService;
use tpv_application::ports::recuperacion_pin::RecuperacionPinService;
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::licensing::{
    ApiSignedHeaders, DeviceIdentity,  LicenseLocalState, PairCreateResult, FirmaDispositivo, DeviceFirmarEmparejamientoArgs, AccionEmparejamiento,
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
///
/// INFRA-04: `workers.dev` y no un nombre propio de `altarialights.com`. Los nombres de esa zona
/// salen por 188.114.96.5 y 188.114.97.5, que los operadores españoles bloquean cuando hay partido
/// de LaLiga: la Handy y la sincronización caerían justo en las horas fuertes del bar. Se probó y se
/// volvió atrás el 2026-10-25: según el registro público de hayahora.futbol, Movistar, Vodafone,
/// Orange, MásMóvil y DIGI las habían bloqueado unas veinte veces cada uno desde agosto, y las de
/// `workers.dev` (104.21.11.118, 172.67.166.1) nunca. Lo que se acepta a cambio: esta dirección queda
/// pegada en cada web que pega el widget o usa el SDK.
pub const CLOUD_API_BASE: &str = "https://tpv-api.altarialights.workers.dev";

/// INFRA-03 · De dónde pinta la Handy las imágenes de su negocio: el GET público del worker,
/// `{CLOUD_API_BASE}/v1/images/{negocio}` (`domains/images/images.routes.ts`), al que `imageUrl.ts`
/// le pega la `Ruta_Imagen` (`images/{carpeta}/{uuid}.{ext}`). Antes las leía del `r2.dev` del bucket,
/// que Cloudflare reserva para desarrollo. Sale de aquí para que la dirección del worker siga siendo
/// una sola; la CSP de `tauri.conf.json` la repite en `img-src`, y lo vigila un test de `lib.rs`.
///
/// El negocio es la carpeta del bucket y va como un segmento del camino, escapado: es un UUID, y si
/// no lo fuera no podría salirse de su segmento. Sin negocio (vacío) no hay dirección.
pub fn url_imagenes_del_negocio(negocio: &str) -> Option<String> {
    let negocio = negocio.trim();
    if negocio.is_empty() {
        return None;
    }
    let mut url = reqwest::Url::parse(CLOUD_API_BASE).ok()?;
    url.path_segments_mut().ok()?.pop_if_empty().extend(["v1", "images", negocio]);
    Some(url.to_string())
}

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

/// Plazo de una petición entera, de conectar a leer el cuerpo: lo que se espera a una respuesta
/// corta (la licencia, un ticket del WebSocket, una página del catch-up).
const HTTP_TIMEOUT_SECS: u64 = 20;

/// Lo que se espera a que el worker acepte la conexión, en cualquier petición. Sin él, el único
/// plazo era el de la petición entera, y una que tiene 150 s para bajar un volcado los gastaba
/// también esperando a un servidor que no contesta.
const HTTP_CONNECT_TIMEOUT_SECS: u64 = 10;

/// Plazo de las rutas que bajan un volcado de la base del negocio. Con 20 s, la recuperación de un
/// negocio con mucho desde el último cierre, o una página grande del histórico por una conexión
/// lenta, se cortaba a mitad del cuerpo y volvía a empezar de cero en cada intento.
const HTTP_TIMEOUT_VOLCADO_SECS: u64 = 150;

/// Las rutas que contestan con un volcado o que pueden tardar en hacerlo: la fase 1 de la
/// recuperación, las páginas de la fase 2 y las del contraste con la nube (el resumen, que recorre
/// la ventana entera en el TenantHub, y las páginas de filas y de claves, de varios MB).
const RUTAS_DE_VOLCADO: [&str; 6] = [
    "/v1/sync/bootstrap",
    "/v1/sync/historico",
    "/v1/sync/verificar/resumen",
    "/v1/sync/verificar/filas",
    "/v1/sync/verificar/por-clave",
    "/v1/sync/verificar/claves",
];

/// El plazo de una petición según lo que pide. Es por petición (`RequestBuilder::timeout`, que
/// manda sobre el del cliente): el resto sigue con [`HTTP_TIMEOUT_SECS`].
fn plazo_de(path: &str) -> Duration {
    let ruta = path.split('?').next().unwrap_or(path);
    if RUTAS_DE_VOLCADO.contains(&ruta) {
        Duration::from_secs(HTTP_TIMEOUT_VOLCADO_SECS)
    } else {
        Duration::from_secs(HTTP_TIMEOUT_SECS)
    }
}

fn ext(e: impl std::fmt::Display) -> AppError {
    AppError::external(e.to_string())
}

/// AUD-28 — no se pudo `que` (escribir, borrar) un fichero de AppData: su nombre, nunca la ruta
/// entera, que lleva el usuario de Windows. El mensaje sale del equipo con el fallo del comando
/// (Axiom, y Sentry si es de programa), y la ruta de AppData no dice nada que no diga el nombre. El
/// `io::Error` no cita la ruta.
fn fallo_de_fichero(que: &str, ruta: &Path, e: std::io::Error) -> AppError {
    let nombre = ruta.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    ext(format!("No se pudo {que} {nombre}: {e}"))
}

/// AUD-28 — una respuesta de la nube que no encaja en el tipo esperado: el tipo, la clase del error
/// de serde, la línea y la columna. Ni el cuerpo ni el texto de serde, que cita el valor que no
/// encaja: el de la activación y el de `/status` llevan el token de sesión y la DEK de los datos
/// del personal. Es el criterio de `no_encaja` en `tpv-infra-http`.
fn no_encaja<T>(que: &str, e: &serde_json::Error) -> String {
    format!(
        "{que}: la respuesta de la nube no encaja en {} ({:?}, línea {}, columna {})",
        std::any::type_name::<T>(),
        e.classify(),
        e.line(),
        e.column()
    )
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
    fs::write(&p, txt).map_err(|e| fallo_de_fichero("escribir", &p, e))?;
    Ok(())
}

fn delete_state(dir: &Path) -> AppResult<()> {
    let p = license_state_path(dir);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| fallo_de_fichero("borrar", &p, e))?;
    }
    Ok(())
}

/* ===== AUD-06 · Licencia pendiente =====
   La licencia de otro negocio que la base del equipo no vale en el proceso que la activa: se guarda
   aparte, sin tocar lo vigente, y la aplica el arranque siguiente, cuando ya ha apartado la base
   (`tpv_application::use_cases::licensing::aplicar_cambio_de_negocio_pendiente`). Los secretos van al
   almacén de secretos, en entradas aparte; el estado, a `license_state.pending.json`, que es lo que
   dice que hay algo pendiente y se escribe el último. */

fn estado_pendiente_path(dir: &Path) -> PathBuf {
    dir.join("license_state.pending.json")
}

/// El almacén de secretos, por lo que guarda una licencia. El del sistema y, en los tests, uno en
/// memoria: así lo pendiente se prueba sin tocar el almacén de verdad.
trait Secretos {
    fn leer(&self, clave: &str) -> Result<Option<String>, String>;
    fn guardar(&self, clave: &str, valor: &str) -> Result<(), String>;
    fn borrar(&self, clave: &str) -> Result<(), String>;
}

struct SecretosDelSistema;

impl Secretos for SecretosDelSistema {
    fn leer(&self, clave: &str) -> Result<Option<String>, String> {
        device::secreto_leer(clave)
    }
    fn guardar(&self, clave: &str, valor: &str) -> Result<(), String> {
        device::secreto_guardar(clave, valor)
    }
    fn borrar(&self, clave: &str) -> Result<(), String> {
        device::secreto_borrar(clave)
    }
}

fn load_estado_pendiente(dir: &Path) -> Option<LicenseLocalState> {
    let txt = fs::read_to_string(estado_pendiente_path(dir)).ok()?;
    serde_json::from_str::<LicenseLocalState>(&txt).ok()
}

/// En la entrada de la DEK pendiente, «el negocio nuevo no trae DEK»: al aplicarse se retira la
/// vigente, como hace `guardar_credenciales`. Sin entrada, en cambio, es que ya se aplicó.
const SIN_DEK: &str = "sin-dek";

/// AUD-28 — la DEK de la licencia no se pudo guardar. Sin el error del almacén de secretos ni el
/// nombre de la entrada: el aviso sale del equipo, y para saber qué pasó basta con esto.
const AVISO_SIN_CLAVE_DEL_PERSONAL: &str =
    "no se pudo guardar la clave de cifrado de los datos del personal: el equipo sigue sin ella";

/// Guarda como pendiente lo concedido: el token y la DEK (ligada a su negocio) en sus entradas
/// pendientes, y después el estado, entero o nada (temporal y `rename`). Lo vigente no se toca.
/// Como en `guardar_credenciales`, si la DEK no se puede guardar la activación sigue sin ella.
fn guardar_pendiente_en(
    secretos: &dyn Secretos,
    dir: &Path,
    concedido: &CredencialesConcedidas,
    estado: &LicenseLocalState,
) -> AppResult<()> {
    use std::io::Write as _;
    secretos.guardar(device::KEY_LICENSE_TOKEN_PENDIENTE, &concedido.token).map_err(ext)?;
    let dek = concedido.field_dek.as_deref().map(|dek| device::envolver_dek(&concedido.negocio, dek));
    let guardada = match dek {
        Some(Ok(guardada)) => secretos.guardar(device::KEY_FIELD_DEK_PENDIENTE, &guardada),
        Some(Err(e)) => Err(e),
        None => secretos.guardar(device::KEY_FIELD_DEK_PENDIENTE, SIN_DEK),
    };
    if guardada.is_err() {
        // AUD-28: sin el error del almacén de secretos ni el nombre de la entrada.
        tracing::warn!("no se pudo guardar la clave de cifrado del personal de la licencia nueva: se aplicará sin ella");
        // Lo que quedara de otra activación va ligado a su negocio: no se usaría con éste.
        let _ = secretos.guardar(device::KEY_FIELD_DEK_PENDIENTE, SIN_DEK);
    }
    let txt = serde_json::to_string_pretty(estado).map_err(ext)?;
    let tmp = dir.join("license_state.pending.json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(ext)?;
        f.write_all(txt.as_bytes()).and_then(|_| f.sync_all()).map_err(ext)?;
    }
    fs::rename(&tmp, estado_pendiente_path(dir)).map_err(ext)
}

/// Lo pendiente pasa a vigente: token, DEK y estado (que quita la nota del rechazo, como guardar
/// una licencia). Después se borra lo pendiente, el estado el último. Repetible: cortado en
/// cualquier punto, repetirlo lo termina; sin estado pendiente no hace nada.
fn aplicar_pendiente_en(secretos: &dyn Secretos, dir: &Path) -> AppResult<()> {
    let Some(estado) = load_estado_pendiente(dir) else {
        return Ok(());
    };
    if let Some(token) = secretos.leer(device::KEY_LICENSE_TOKEN_PENDIENTE).map_err(ext)? {
        secretos.guardar(device::KEY_LICENSE_TOKEN_VIGENTE, token.trim()).map_err(ext)?;
    }
    match secretos.leer(device::KEY_FIELD_DEK_PENDIENTE).map_err(ext)? {
        Some(dek) if dek != SIN_DEK => {
            if secretos.guardar(device::KEY_FIELD_DEK_VIGENTE, &dek).is_err() {
                tracing::warn!("{AVISO_SIN_CLAVE_DEL_PERSONAL}");
                let _ = secretos.borrar(device::KEY_FIELD_DEK_VIGENTE);
            }
        }
        Some(_) => secretos.borrar(device::KEY_FIELD_DEK_VIGENTE).map_err(ext)?,
        None => {}
    }
    delete_rejection(dir)?;
    save_state(dir, &estado)?;
    secretos.borrar(device::KEY_LICENSE_TOKEN_PENDIENTE).map_err(ext)?;
    secretos.borrar(device::KEY_FIELD_DEK_PENDIENTE).map_err(ext)?;
    fs::remove_file(estado_pendiente_path(dir)).map_err(ext)
}

/// Olvida lo pendiente: primero el estado, que es lo que dice que lo hay.
fn descartar_pendiente_en(secretos: &dyn Secretos, dir: &Path) -> AppResult<()> {
    match fs::remove_file(estado_pendiente_path(dir)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(ext(e)),
        _ => {}
    }
    secretos.borrar(device::KEY_LICENSE_TOKEN_PENDIENTE).map_err(ext)?;
    secretos.borrar(device::KEY_FIELD_DEK_PENDIENTE).map_err(ext)
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
    fs::write(&p, code).map_err(|e| fallo_de_fichero("escribir", &p, e))
}

fn delete_rejection(dir: &Path) -> AppResult<()> {
    let p = license_rejection_path(dir);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| fallo_de_fichero("borrar", &p, e))?;
    }
    Ok(())
}

/* ===== HTTP ===== */

pub use secret_store::apartar_secretos;

// El shell conoce la versión de la aplicación; la versión de esta crate puede ser distinta.
static METADATOS_CLIENTE: std::sync::OnceLock<(&'static str, &'static str)> = std::sync::OnceLock::new();
pub fn configurar_metadatos_cliente(version: &'static str, variante: &'static str) {
    let _ = METADATOS_CLIENTE.set((version, variante));
}
pub fn cabeceras_version() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some((version, variante)) = METADATOS_CLIENTE.get() {
        if let (Ok(v), Ok(p)) = (version.parse(), variante.parse()) {
            headers.insert("x-tpv-version", v);
            headers.insert("x-tpv-variant", p);
        }
    }
    headers
}

fn http_client() -> AppResult<Client> {
    // RI-15: las copias comparten el pool; las credenciales y firmas siguen siendo por petición.
    static CLIENTE: LazyLock<Result<Client, String>> = LazyLock::new(|| {
        construir_cliente(
            Duration::from_secs(HTTP_TIMEOUT_SECS),
            Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS),
        )
    });
    CLIENTE.as_ref().cloned().map_err(|e| ext(e.clone()))
}

/// El cliente HTTP de todo lo que habla con el worker. `plazo` es el de una petición que no pide
/// otro (ver [`plazo_de`]); `conexion`, lo que se espera a conectar.
///
/// Pide las respuestas comprimidas (`Accept-Encoding: gzip`, la feature `gzip` de reqwest) y las
/// descomprime al leerlas: un volcado es JSON con los nombres de columna y los mismos valores
/// repetidos fila a fila, y comprimido viaja en una fracción. Quien no comprime (un worker
/// anterior, una imagen) contesta como siempre.
fn construir_cliente(plazo: Duration, conexion: Duration) -> Result<Client, String> {
    Client::builder()
        .default_headers(cabeceras_version())
        .timeout(plazo)
        .connect_timeout(conexion)
        .gzip(true)
        .build()
        .map_err(|e| format!("Error creando HTTP client: {e}"))
}

fn api_url(path: &str) -> String {
    format!("{}{}", CLOUD_API_BASE.trim_end_matches('/'), path)
}

/// Lo que contesta un POST al worker: el estado y el cuerpo tal cual, ya descomprimido.
struct RespuestaPost {
    status: u16,
    /// `Err` si la respuesta se cortó antes de terminar el cuerpo: un plazo que vence a mitad de un
    /// volcado, la conexión que se cae. Lleva el motivo, sin la URL (AUD-28).
    cuerpo: Result<Vec<u8>, String>,
}

impl RespuestaPost {
    /// El cuerpo como texto, para leer en él un error de la API. Vacío si no llegó entero.
    fn texto(&self) -> String {
        match &self.cuerpo {
            Ok(bytes) => String::from_utf8_lossy(bytes).into_owned(),
            Err(_) => String::new(),
        }
    }

    fn aceptada(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// PROD-04: rechazada por la hora de la firma. Sólo se lee el cuerpo de un 401.
    fn rechazada_por_reloj(&self) -> bool {
        self.status == 401 && reloj::es_rechazo_por_reloj(self.status, &self.texto())
    }
}

/// Manda un POST ya montado y devuelve su estado y su cuerpo en bytes, sin interpretarlos.
///
/// `plazo` es el de ESTA petición, de conectar a terminar de leer el cuerpo ([`plazo_de`]). El
/// cuerpo se devuelve en bytes y no como texto para que una respuesta grande se lea una sola vez,
/// directamente en su tipo (`tpv_server_post_bytes`).
async fn post_crudo(
    client: &Client,
    url: &str,
    headers: HeaderMap,
    cuerpo: String,
    plazo: Duration,
) -> AppResult<RespuestaPost> {
    let resp = reloj::enviar(client.post(url).headers(headers).timeout(plazo).body(cuerpo))
        .await
        .map_err(reloj::fallo_de_transporte)?;

    let status = resp.status().as_u16();
    let cuerpo = resp
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| reloj::clase_del_fallo(&e).to_string());
    Ok(RespuestaPost { status, cuerpo })
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
        .map_err(|e| reloj::clase_del_fallo(&e).to_string())?;

        let http = resp.status().as_u16();
        let texto = resp.text().await.unwrap_or_default();

        if !repetida && reloj::es_rechazo_por_reloj(http, &texto) {
            repetida = true;
            continue;
        }
        return Ok(Respondida { http, texto, ts });
    }
}

/// AUD-01 · Lo que sale hacia la nube en un intento de activar: el cuerpo tal cual, la hora con la
/// que se ha firmado (`X-Device-Ts`) y la firma (`X-Device-Sig`).
struct ActivacionFirmada<'a> {
    ts: i64,
    firma: String,
    cuerpo: &'a [u8],
}

/// Firma `cuerpo` con la clave del equipo y la hora de la nube de AHORA
/// (`device::mensaje_de_activacion`). Cada intento se firma de nuevo: la hora va dentro de la firma.
fn firmar_intento<'a>(sk: &SigningKey, cuerpo: &'a [u8]) -> AppResult<ActivacionFirmada<'a>> {
    let ts = reloj::ahora_ms();
    let firma = device::firmar_activacion(sk, ts, cuerpo).map_err(ext)?;
    Ok(ActivacionFirmada { ts, firma, cuerpo })
}

/// AUD-01 · Activa con la petición firmada, y repite UNA vez si la nube la rechaza por la hora de la
/// firma (PROD-04, ver [`reloj`]). El rechazo ya ha traído la hora buena —`enviar` la anota—, así
/// que el segundo intento se firma con ella: misma petición, otra hora y otra firma. Lo que
/// conteste el segundo es lo que hay: no se insiste.
///
/// `enviar` es el transporte ([`enviar_activacion`]); va aparte para poder probar esto sin red.
async fn activar_firmando<'a, E, Fut>(
    sk: &SigningKey,
    cuerpo: &'a [u8],
    mut enviar: E,
) -> AppResult<(u16, String)>
where
    E: FnMut(ActivacionFirmada<'a>) -> Fut,
    Fut: std::future::Future<Output = AppResult<(u16, String)>>,
{
    let (http, texto) = enviar(firmar_intento(sk, cuerpo)?).await?;
    if reloj::es_rechazo_por_reloj(http, &texto) {
        return enviar(firmar_intento(sk, cuerpo)?).await;
    }
    Ok((http, texto))
}

/// AUD-01 · Manda un intento de activar tal cual, con la firma en `X-Device-Sig` y su hora en
/// `X-Device-Ts`, y anota la hora de la nube que traiga la respuesta. Devuelve el par crudo
/// `(status, cuerpo)`.
async fn enviar_activacion(intento: ActivacionFirmada<'_>) -> AppResult<(u16, String)> {
    let resp = reloj::enviar(
        http_client()?
            .post(api_url(device::RUTA_ACTIVAR))
            .header(CONTENT_TYPE, "application/json")
            .header("X-Device-Ts", intento.ts.to_string())
            .header("X-Device-Sig", intento.firma)
            .body(intento.cuerpo.to_vec()),
    )
    .await
    .map_err(reloj::fallo_de_transporte)?;

    let http = resp.status().as_u16();
    let texto = resp.text().await.unwrap_or_default();
    Ok((http, texto))
}

/* ===== Tipos de la API de licencias (internos del adaptador) ===== */

/// Respuesta de error del worker: `{ ok:false, error, code?, message?, details? }`.
#[derive(Debug, Deserialize)]
struct ApiErr {
    error: String,
    /// ARCH-05: código ya resuelto por el worker. Si no viene, se traduce el `error` con
    /// `ErrorCode::from_wire`.
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
    /// `AppErrorDto` convierte en la frase genérica de su código). El `details`, si lo trae, va
    /// detrás, entre paréntesis, para diagnosticar. Sólo lo llevan los errores de negocio: un 5xx
    /// del worker no cuenta su detalle interno (FABLE-B).
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
    /// TRAB-03: DEK del tenant para cifrar la PII del personal. Viene en cada activación.
    field_dek: String,
    /// Si la activación ha trasladado la licencia desde otro equipo.
    cambio_de_equipo: bool,
    /// REV-13: la clave ha sumado su tiempo a la licencia que ya había en este equipo. El worker
    /// sólo lo manda cuando suma (el canje); si no viene, no ha sumado.
    #[serde(default)]
    tiempo_sumado: bool,
}

/// El 2xx de `/v1/license/activate`, ya leído: tiene que traer la licencia concedida.
///
/// AUD-28: ese cuerpo lleva el token de sesión y la DEK de los datos del personal, así que ningún
/// mensaje de aquí lo cita, ni entero ni a trozos: si no encaja, el tipo y la posición
/// ([`no_encaja`]); si encaja pero le falta algo, qué le falta.
fn leer_activacion(texto: &str) -> AppResult<ActivateOk> {
    let ok: ActivateOk =
        serde_json::from_str(texto).map_err(|e| ext(no_encaja::<ActivateOk>("activate_bad_json", &e)))?;
    let falta = if !ok.ok {
        Some("ok=false")
    } else if ok.token.trim().is_empty() {
        Some("sin token")
    } else if ok.tenant_id.trim().is_empty() {
        Some("sin negocio")
    } else {
        None
    };
    match falta {
        Some(falta) => Err(AppError::external(format!(
            "La respuesta del servidor de licencias no trae la licencia concedida ({falta})."
        ))),
        None => Ok(ok),
    }
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
    /// AUD-01: el negocio que este equipo tiene ahora, si tiene alguno. La nube lo contrasta con el
    /// que tiene registrado para el equipo, y no canjea si no es el mismo.
    #[serde(skip_serializing_if = "Option::is_none")]
    tenant_actual: Option<&'a str>,
}

/// Los bytes del cuerpo de `/v1/license/activate`: lo que se firma y lo que se manda (AUD-01).
/// `negocio_actual` es el tenant de la licencia que este equipo tiene guardada, si tiene alguna.
fn cuerpo_de_activar(
    solicitud: &SolicitudActivacion,
    device_id: &str,
    device_pub_key: &str,
    device_change_code: Option<&str>,
    negocio_actual: Option<&str>,
) -> AppResult<Vec<u8>> {
    serde_json::to_vec(&ActivateReq {
        activation_key: &solicitud.clave,
        device_id,
        device_pub_key,
        device_change_code,
        tenant_info: TenantInfo {
            display_name: &solicitud.business_name,
            legal_name: solicitud.legal_name.as_deref(),
            phone: solicitud.phone.as_deref(),
            country: solicitud.country.as_deref(),
        },
        solo_sumar: solicitud.solo_sumar,
        tenant_actual: negocio_actual,
    })
    .map_err(ext)
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

/// El 2xx de `/v1/license/status`, ya leído. Si no encaja es una respuesta ilegible para el gate;
/// el detalle, sin el cuerpo, que lleva el token renovado (AUD-28, [`no_encaja`]).
fn leer_status(texto: &str) -> Result<StatusOk, FalloConsulta> {
    serde_json::from_str(texto).map_err(|e| FalloConsulta::Ilegible {
        detalle: no_encaja::<StatusOk>("invalid_json", &e),
    })
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

/// AUD-28 — un estado de licencia que este equipo no conoce. Es un trozo de la respuesta, todavía
/// sin verificar: va al mensaje sólo si es un identificador (`suspended`), y si no, nada de él.
fn estado_desconocido(estado: &str) -> String {
    let es_identificador = (1..=32).contains(&estado.len())
        && estado.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if es_identificador {
        format!("estado_desconocido: {estado}")
    } else {
        "estado_desconocido".to_string()
    }
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
        detalle: estado_desconocido(&dto.state),
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

/// Clasifica el error del worker según lo que implica para el gate. Ninguno borra la licencia
/// (RI-09): un rechazo sin firmar no se puede comprobar, y una incidencia de auth o de reloj tampoco
/// dice nada de la licencia.
fn clasificar_error(http: u16, code: &str) -> FalloConsulta {
    match code {
        // El servidor dice que la licencia ya no vale, pero sin firma. Una anulación o un traslado de
        // verdad llegan firmados (`leer_rechazo`); esto es sobre todo `license_not_found`, que con un
        // token válido sólo puede ser un fallo nuestro.
        "license_not_found" | "license_revoked" | "device_replaced" => {
            tracing::warn!("[licencia] rechazo sin firmar del servidor: {code} (http {http})");
            FalloConsulta::RechazoSinFirmar { code: code.to_string() }
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

/// Un rechazo del worker en `/status` o `/refresh`, ya leído.
enum Rechazo {
    /// RI-09: vino con la aserción firmada de esta petición (una licencia que existe pero está
    /// anulada o trasladada). Es el estado de la licencia, tan de fiar como el de un `/status` bueno.
    Firmado(EstadoVerificado),
    Fallo(FalloConsulta),
}

impl From<FalloConsulta> for Rechazo {
    fn from(f: FalloConsulta) -> Self {
        Rechazo::Fallo(f)
    }
}

/// Cuerpo de un rechazo: el `error` y, cuando la licencia existe, la aserción firmada.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RechazoBody {
    #[serde(default)]
    error: String,
    assertion: Option<SignedAssertionDto>,
    server_time: Option<i64>,
}

/// Lee un rechazo. Si trae aserción, manda ella —verificada como cualquier otra, contra las claves
/// pineadas y el `client_ts` de esta petición—; si no, el código de error, que va sin firmar.
fn leer_rechazo(r: &Respondida) -> Rechazo {
    leer_rechazo_con(LICENSE_SIGNING_PUBLIC_KEYS_B64, r)
}

fn leer_rechazo_con(claves: &[&str], r: &Respondida) -> Rechazo {
    let Ok(body) = serde_json::from_str::<RechazoBody>(&r.texto) else {
        return Rechazo::Fallo(clasificar_error(r.http, ""));
    };
    match body.assertion {
        Some(dto) => match verificar_assertion_con(claves, dto, r.ts, reloj::ahora_ms()) {
            Ok(assertion) => Rechazo::Firmado(EstadoVerificado {
                assertion,
                server_time_ms: body.server_time.unwrap_or_else(reloj::ahora_ms),
            }),
            Err(fallo) => Rechazo::Fallo(fallo),
        },
        None => Rechazo::Fallo(clasificar_error(r.http, &body.error)),
    }
}

/* =========================================================
   Reloj monótono de la gracia offline (RI-36)
========================================================= */

/// La última vez que se contó el tiempo sin conexión, según el reloj monótono. Es del PROCESO y no
/// del adaptador, como el desfase de `reloj`: los adaptadores se construyen en cada comando y el
/// pulso de la licencia tiene que medir desde lo que contó el anterior.
static ULTIMA_MARCA_MONOTONA: Mutex<Option<Instant>> = Mutex::new(None);

/// Lo transcurrido desde la marca anterior, dejando ésta como la nueva. `None` la primera vez.
fn transcurrido_desde_la_ultima_marca() -> Option<i64> {
    let ahora = Instant::now();
    let mut marca = ULTIMA_MARCA_MONOTONA.lock().unwrap_or_else(|e| e.into_inner());
    marca
        .replace(ahora)
        .map(|antes| ahora.saturating_duration_since(antes).as_millis() as i64)
}

/* =========================================================
   De qué negocio es un token (AUD-06)
========================================================= */

/// El negocio para el que el worker emitió un token de sesión (su claim `tenantId`, ver
/// `lib/sesion.ts`). NO verifica la firma: eso lo hace el worker al recibirlo. Aquí sólo se mira a
/// quién dice ser, para no mandarlo en nombre de otro negocio.
pub fn negocio_del_token(token: &str) -> Option<String> {
    use base64::Engine as _;
    let payload = token.trim().split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .get("tenantId")?
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// AUD-06 · `Ok` si `token` es de `negocio`. Uno que no dice de quién es tampoco vale.
pub fn comprobar_negocio_del_token(token: &str, negocio: &str) -> AppResult<()> {
    match negocio_del_token(token) {
        Some(del_token) if del_token == negocio.trim() => Ok(()),
        _ => Err(AppError::conflict(
            "Las credenciales guardadas en este equipo no son de su licencia: vuelve a activarla.",
        )),
    }
}

/* =========================================================
   LicensingAdapter
========================================================= */

pub struct LicensingAdapter {
    app_data_dir: PathBuf,
    /// AUD-06 · Lo que concedió la última activación y aún no se ha guardado: se guarda en
    /// `guardar_credenciales`, cuando el caso de uso ya ha decidido qué hace con la base del equipo.
    concedido: std::sync::Mutex<Option<CredencialesConcedidas>>,
}

/// AUD-06 · Las credenciales de una activación, de camino al almacén de secretos.
struct CredencialesConcedidas {
    negocio: String,
    token: String,
    field_dek: Option<String>,
}

impl LicensingAdapter {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir, concedido: std::sync::Mutex::new(None) }
    }

    /// GET `/v1/license/status` firmado con device-proof. Devuelve el cuerpo parseado, o el error
    /// ya clasificado. NO verifica la firma todavía (eso es del llamante, que conoce el `ts`).
    async fn get_status(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<(StatusOk, i64), Rechazo> {
        const PATH: &str = "/v1/license/status";

        // Un fallo local (keyring, firma, cliente HTTP) es indistinguible de no tener red para el
        // gate: en ambos casos no sabemos qué dice el servidor → `Inalcanzable` (gracia offline).
        // RI-72: la clave se LEE. Si el almacén no contesta, se vuelve a intentar en el siguiente
        // pulso; crear otra aquí era perder la identidad del equipo para siempre.
        let sk = leer_device_keypair(device_id).map_err(|e| {
            tracing::warn!("[licencia] sin la clave del dispositivo: {e}");
            FalloConsulta::Inalcanzable
        })?;
        let r = peticion_con_prueba(Method::GET, PATH, token, &sk)
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        if !(200..300).contains(&r.http) {
            return Err(leer_rechazo(&r));
        }

        Ok((leer_status(&r.texto)?, r.ts))
    }

    /// POST `/v1/license/refresh` (device-proof). Reemite el token de sesión cuando el viejo ha
    /// caducado. `Ok(None)` si el refresco falló por red (se cae a la gracia offline).
    async fn refrescar_token(
        &self,
        token: &str,
        device_id: &str,
    ) -> Result<String, Rechazo> {
        const PATH: &str = "/v1/license/refresh";

        let sk = leer_device_keypair(device_id).map_err(|e| {
            tracing::warn!("[licencia] sin la clave del dispositivo: {e}");
            FalloConsulta::Inalcanzable
        })?;
        let r = peticion_con_prueba(Method::POST, PATH, token, &sk)
            .await
            .map_err(|_| FalloConsulta::Inalcanzable)?;

        if !(200..300).contains(&r.http) {
            return Err(leer_rechazo(&r));
        }

        serde_json::from_str::<RefreshOk>(&r.texto)
            .map(|r| r.token)
            .map_err(|_| Rechazo::Fallo(FalloConsulta::Inalcanzable))
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

    fn transcurrido_monotono(&self) -> Option<i64> {
        transcurrido_desde_la_ultima_marca()
    }

    async fn activar_remoto(
        &self,
        solicitud: &SolicitudActivacion,
        device_change_code: Option<&str>,
    ) -> AppResult<ResultadoActivacion> {
        let device_id = get_or_create_device_id().map_err(ext)?;
        let (sk, pub_b64) = get_or_create_device_keypair(&device_id).map_err(ext)?;

        // AUD-01: el negocio que este equipo tiene ahora, si tiene licencia guardada. Va en el cuerpo
        // firmado —la nube rechaza el canje si no es el que tiene registrado para este equipo— y se
        // compara abajo con el que conteste.
        let negocio_actual = load_state(&self.app_data_dir)
            .map(|st| st.tenant_id.trim().to_string())
            .filter(|t| !t.is_empty());

        // Lo que se pide tiene que poder pedirse, antes de que la clave salga del equipo.
        dom::comprobar_solicitud(solicitud.solo_sumar, negocio_actual.as_deref())
            .map_err(AppError::conflict)?;

        // AUD-01: el cuerpo se serializa UNA vez. Es lo que se firma y lo que se manda; si reqwest
        // lo volviera a serializar, cualquier diferencia de bytes invalidaría la firma.
        let cuerpo = cuerpo_de_activar(
            solicitud,
            &device_id,
            &pub_b64,
            device_change_code,
            negocio_actual.as_deref(),
        )?;

        // Firmado con la clave del equipo: la nube no activa nada sin esa prueba. Un equipo recién
        // estrenado no ha visto todavía la hora de la nube, así que si su reloj va mal el primer
        // intento se rechaza por la hora; ese rechazo ya la trae, y el segundo se firma con ella.
        let (http, text) = activar_firmando(&sk, &cuerpo, enviar_activacion).await?;

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
            // AUD-28: sin el cuerpo, que no es de la API (la página de un intermediario).
            return Err(AppError::rechazo("activate_failed", http, &text));
        }

        let ok = leer_activacion(&text)?;

        // Anti-copia: el token concedido va ligado a la clave de ESTE dispositivo. Si el servidor
        // devuelve otro `deviceId`, la firma de las siguientes peticiones no cuadraría.
        if let Some(server_device) = ok.device_id.as_deref().map(str::trim) {
            if !server_device.is_empty() && server_device != device_id {
                return Err(AppError::external(
                    "deviceId mismatch (server devolvió otro deviceId)",
                ));
            }
        }

        // AUD-06: lo concedido no se guarda todavía. Se queda aquí hasta `guardar_credenciales`,
        // que llama el caso de uso cuando ya ha contrastado lo concedido con lo pedido (AUD-01,
        // `dom::comprobar_concesion`) y ha decidido qué hace con la base del equipo: con el token en
        // el almacén, todo lo que habla con la nube lo hace ya en nombre del negocio concedido.
        *self.concedido.lock().unwrap_or_else(|e| e.into_inner()) = Some(CredencialesConcedidas {
            negocio: ok.tenant_id.trim().to_string(),
            token: ok.token.trim().to_string(),
            field_dek: Some(ok.field_dek.trim()).filter(|d| !d.is_empty()).map(str::to_string),
        });

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

    fn guardar_credenciales(&self) -> AppResult<()> {
        let concedido = self.concedido.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(concedido) = concedido else {
            return Err(AppError::internal("No hay ninguna activación concedida que guardar."));
        };

        // El token es una credencial: va directo al keyring, nunca a `license_state.json`.
        set_license_token(&concedido.token).map_err(ext)?;

        // TRAB-03: la clave de cifrado de campo, al almacén de secretos del sistema. Va aquí y
        // no en `license_state.json` porque guardarla junto a la base de datos que protege no
        // serviría de nada. Si falla, se registra y se sigue: la activación NO se aborta —
        // quedarse sin poder activar por esto sería peor que operar sin cifrado.
        //
        // AUD-06: va ligada a su negocio (`device::set_field_dek_de`), y sólo se usa con la
        // licencia de ese negocio. Si no se puede guardar, la que hubiera de otro no se usa
        // (y se intenta retirar); nunca se cifra ni se descifra con la clave de otro negocio.
        match concedido.field_dek.as_deref() {
            Some(dek) => {
                if device::set_field_dek_de(&concedido.negocio, dek).is_err() {
                    tracing::warn!("{AVISO_SIN_CLAVE_DEL_PERSONAL}");
                    let _ = device::clear_field_dek();
                }
            }
            None => {
                let _ = device::clear_field_dek();
            }
        }
        Ok(())
    }

    fn guardar_pendiente(&self, estado: &LicenseLocalState) -> AppResult<()> {
        let concedido = self.concedido.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(concedido) = concedido else {
            return Err(AppError::internal("No hay ninguna activación concedida que guardar."));
        };
        guardar_pendiente_en(&SecretosDelSistema, &self.app_data_dir, &concedido, estado)
    }

    fn negocio_pendiente(&self) -> AppResult<Option<String>> {
        Ok(load_estado_pendiente(&self.app_data_dir)
            .map(|st| st.tenant_id.trim().to_string())
            .filter(|t| !t.is_empty()))
    }

    fn aplicar_pendiente(&self) -> AppResult<()> {
        aplicar_pendiente_en(&SecretosDelSistema, &self.app_data_dir)
    }

    fn descartar_pendiente(&self) -> AppResult<()> {
        descartar_pendiente_en(&SecretosDelSistema, &self.app_data_dir)
    }

    async fn solicitar_cambio_dispositivo(&self, clave: &str) -> AppResult<()> {
        let device_id = get_or_create_device_id().map_err(ext)?;

        // La respuesta es constante (siempre 200) por diseño del worker: no filtra si la clave
        // existe. Basta con no fallar en el transporte.
        let body = serde_json::json!({ "activationKey": clave, "deviceId": device_id });

        reloj::enviar(
            http_client()?
                .post(api_url("/v1/license/device-change/request"))
                .header(CONTENT_TYPE, "application/json")
                .json(&body),
        )
        .await
        .map_err(reloj::fallo_de_transporte)?;

        Ok(())
    }

    async fn consultar_estado(
        &self,
        state: &LicenseLocalState,
    ) -> Result<EstadoConsultado, FalloConsulta> {
        // El token vive en el keyring. Si no está, no podemos consultar: se trata como offline
        // (gracia) en vez de tirar la licencia por un problema puntual de acceso al keyring.
        let token = get_license_token().map_err(|_| FalloConsulta::Inalcanzable)?;
        // AUD-06: y si es de otro negocio que la licencia guardada (una activación cortada entre
        // guardar el token y guardar la licencia), tampoco: lo que contestara sería de otra licencia.
        if let Err(e) = comprobar_negocio_del_token(&token, &state.tenant_id) {
            tracing::warn!("[licencia] {e}");
            return Err(FalloConsulta::Inalcanzable);
        }

        // 1er intento con el token actual.
        // RI-09: un rechazo que trae la aserción firmada (licencia anulada o trasladada) ES el estado
        // de la licencia: se devuelve como tal, y el dominio lo evalúa igual que un `/status` bueno.
        let (ok, ts) = match self.get_status(&token, &state.device_id).await {
            Ok(v) => v,
            Err(Rechazo::Firmado(estado)) => return Ok(sin_token(estado)),
            Err(Rechazo::Fallo(fallo)) => {
                // Un token de sesión caducado NO debe borrar la licencia: se renueva por
                // device-proof (`/refresh`) y se reintenta una vez. El worker devuelve
                // `token_expired`, que `clasificar_error` mete en `Inalcanzable`; distinguimos ese
                // caso reintentando el refresco, que sí sabe si el problema es el token.
                if !matches!(fallo, FalloConsulta::Inalcanzable) {
                    return Err(fallo);
                }
                let nuevo = match self.refrescar_token(&token, &state.device_id).await {
                    Ok(t) => t,
                    Err(Rechazo::Firmado(estado)) => return Ok(sin_token(estado)),
                    Err(Rechazo::Fallo(f)) => return Err(f),
                };
                let (ok, ts) = match self.get_status(&nuevo, &state.device_id).await {
                    Ok(v) => v,
                    Err(Rechazo::Firmado(estado)) => return Ok(sin_token(estado)),
                    Err(Rechazo::Fallo(f)) => return Err(f),
                };
                let assertion = verificar_assertion(ok.assertion, ts, reloj::ahora_ms())?;
                return Ok(EstadoConsultado {
                    verificado: EstadoVerificado { assertion, server_time_ms: ok.server_time },
                    // El que renovó /status, o el del refresh si no.
                    token: Some(token_efectivo(ok.token.as_deref(), &nuevo)),
                });
            }
        };

        // PROD-04: la caducidad de la aserción la pone la nube con SU reloj, así que se compara con
        // la hora de la nube. Con la del equipo, uno adelantado más de cinco minutos daría por
        // caducada una aserción recién firmada, justo cuando la petición ya había entrado.
        let assertion = verificar_assertion(ok.assertion, ts, reloj::ahora_ms())?;
        Ok(EstadoConsultado {
            verificado: EstadoVerificado { assertion, server_time_ms: ok.server_time },
            // El worker renueva el token en cada /status (fin del muro de 30d).
            token: Some(token_efectivo(ok.token.as_deref(), &token)),
        })
    }

    fn guardar_token(&self, token: &str) {
        let _ = set_license_token(token);
    }
}

/// El token con el que seguir tras un `/status`: el que renovó el servidor (`renovado`) o, si no
/// vino, el que ya se estaba usando (`actual`).
fn token_efectivo(renovado: Option<&str>, actual: &str) -> String {
    renovado.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(actual).to_string()
}

/// Un rechazo firmado no trae token: el del keyring se queda como está.
fn sin_token(verificado: EstadoVerificado) -> EstadoConsultado {
    EstadoConsultado { verificado, token: None }
}

/* =========================================================
   PairingAdapter
========================================================= */

/// Las credenciales Main/Handy y la clave del dispositivo viven en el almacén de secretos.
/// El directorio de datos permite leer el tenant de la licencia y el reloj de la nube al
/// construir mensajes de firma específicos; el contexto autorizado no lo aporta la webview.
pub struct PairingAdapter { app_data_dir: PathBuf }

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
        negocio: Option<&str>,
    ) -> AppResult<ApiSignedHeaders> {
        // RI-72: firmar sólo lee la identidad; nunca la crea.
        let (_, sk) = leer_identidad().map_err(ext)?;

        let token = if mode == "handy" {
            get_handy_token().map_err(AppError::external)?
        } else if mode == "tpv" {
            // AUD-06: la Main firma sólo con un token del negocio de su licencia. Entre guardar el
            // token de una licencia nueva y guardar la licencia (una activación cortada) no cuadran,
            // y nada sale firmado hasta que vuelvan a cuadrar.
            let token = self.license_token()?;
            let negocio = load_state(&self.app_data_dir)
                .map(|s| s.tenant_id)
                .ok_or_else(|| AppError::not_found("Este equipo no tiene ninguna licencia activada."))?;
            comprobar_negocio_del_token(&token, &negocio)?;
            token
        } else {
            return Err(AppError::validation("Modo de dispositivo inválido."));
        };
        // AUD-06: y lo que se firma para un negocio concreto (una imagen que empezó a subirse con
        // él), sólo con un token de ese negocio, en cada intento.
        if let Some(negocio) = negocio {
            comprobar_negocio_del_token(&token, negocio)?;
        }

        // PROD-04: la hora de la nube, no la del equipo (ver `reloj`).
        let ts = reloj::ahora_ms();
        // RI-50: firmar exactamente el destino que reqwest enviará, incluidos query y escapes.
        let url = reqwest::Url::parse(&api_url(path)).map_err(|e| AppError::validation(e.to_string()))?;
        let target = format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default());
        let sig = sign_device_proof(&sk, ts, &method.to_uppercase(), &target, token.trim(), body)
            .map_err(ext)?;

        Ok(ApiSignedHeaders {
            authorization: format!("Bearer {}", token.trim()),
            x_device_ts: ts.to_string(),
            x_device_sig: sig,
        })
    }

    /// Manda el POST ya firmado y devuelve la respuesta cruda (estado y cuerpo).
    ///
    /// Está aparte de `tpv_server_post_json` porque esa petición puede hacerse **dos veces**: si
    /// la nube contesta 401 a una Handy, se renueva su token y se repite. Y repetirla exige volver
    /// a firmar —la firma cubre el token, y el token es justo lo que ha cambiado—, así que no vale
    /// con reenviar las mismas cabeceras.
    async fn enviar_post(&self, mode: &str, path: &str, body_str: &str) -> AppResult<RespuestaPost> {
        let client = http_client()?;

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        // El reloj lo pone el dispositivo emisor (Main o Handy), NO el servidor: el worker usa
        // esta hora local para resolver los `datetime('now')` de las escrituras a un literal fijo,
        // de modo que la fila sea idéntica en nube/Main/Handy (replicación determinista).
        // MES-INC-03: la de la Handy, con su desfase, que el worker pasa a la zona del negocio. La de
        // la Main va sin él: su zona es la del negocio (`Zona_Horaria` sale de ella).
        let client_now = if mode == "handy" {
            tpv_domain::fechas::hora_con_desfase(chrono::Local::now())
        } else {
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
        };
        if let Ok(v) = HeaderValue::from_str(&client_now) {
            headers.insert("x-client-now", v);
        }

        if mode == "tpv" || mode == "handy" {
            let signed = self.signed_headers_inner(mode, "POST", path, body_str.as_bytes(), None)?;

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
        post_crudo(&client, &api_url(path), headers, body_str.to_string(), plazo_de(path)).await
    }

    /// El POST firmado con las dos repeticiones que admite, y lo que contestó el último intento.
    async fn post_con_repeticiones(
        &self,
        mode: &str,
        path: &str,
        body: &JsonValue,
    ) -> AppResult<RespuestaPost> {
        // El cuerpo se serializa UNA vez: es lo que se firma y lo que se envía. Si se dejase que
        // reqwest lo volviera a serializar con `.json(&body)`, cualquier diferencia de bytes
        // (orden, espacios) invalidaría la firma en el worker.
        let body_str =
            serde_json::to_string(body).map_err(|e| ext(format!("bad_json_body:{:?}", e.classify())))?;

        let mut respuesta = self.enviar_post(mode, path, &body_str).await?;

        // PROD-04. Rechazada por la hora de la firma: el rechazo ya ha traído la hora de la nube,
        // así que se firma otra vez y se repite UNA. Sólo si la firma la pone Rust: en las anónimas
        // del emparejamiento la hora va firmada dentro del cuerpo, y repetir el mismo cuerpo daría
        // el mismo rechazo (esas ya salen con la hora buena: la toman del `claim`).
        if (mode == "tpv" || mode == "handy") && respuesta.rechazada_por_reloj() {
            respuesta = self.enviar_post(mode, path, &body_str).await?;
        }

        // REV-02. Un 401 en una Handy con el token caducado es la credencial, no la petición: se
        // renueva y se repite UNA vez. Quien decide es la fecha del propio token
        // (`renovar_si_el_token_ha_caducado`) y no el texto del error, que cambia según por dónde
        // lo rechace el worker (`jwt_expired`, `token_expired`, `invalid_token`).
        //
        // Si renovar no arregla nada —el dispositivo está revocado, o su fila ya no está en este
        // negocio— el segundo intento vuelve con el mismo 401 y su código del catálogo, que es lo
        // que permite a quien llamó dejar de reintentar en vez de tomarlo por falta de red.
        if respuesta.status == 401 && mode == "handy" && self.renovar_si_el_token_ha_caducado().await {
            respuesta = self.enviar_post(mode, path, &body_str).await?;
        }

        Ok(respuesta)
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

        // AUD-28: sin el texto de serde, que citaría el token.
        let nuevo = serde_json::from_str::<RefreshOk>(&r.texto)
            .map_err(|e| ext(no_encaja::<RefreshOk>("bad_refresh_response", &e)))?;

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
    ///
    /// AUD-06 · `negocio`: si lo que se manda es de un negocio concreto, cada intento comprueba al
    /// firmar que el token es de ese negocio (ver `signed_headers_inner`).
    async fn enviar_firmado(
        &self,
        mode: &str,
        metodo: Method,
        path: &str,
        cuerpo: &[u8],
        content_type: Option<&str>,
        negocio: Option<&str>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let (mut status, mut bytes) = self
            .una_peticion_firmada(mode, metodo.clone(), path, cuerpo, content_type, negocio)
            .await?;

        // PROD-04: igual que en el POST de JSON.
        if reloj::es_rechazo_por_reloj(status, &String::from_utf8_lossy(&bytes)) {
            (status, bytes) = self
                .una_peticion_firmada(mode, metodo.clone(), path, cuerpo, content_type, negocio)
                .await?;
        }

        if status != 401 || mode != "handy" {
            return Ok((status, bytes));
        }
        if !self.renovar_si_el_token_ha_caducado().await {
            return Ok((status, bytes));
        }

        self.una_peticion_firmada(mode, metodo, path, cuerpo, content_type, negocio)
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
        negocio: Option<&str>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let signed = self.signed_headers_inner(mode, metodo.as_str(), path, cuerpo, negocio)?;

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

        let resp = reloj::enviar(rb).await.map_err(reloj::fallo_de_transporte)?;
        let status = resp.status().as_u16();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ext(format!("respuesta_ilegible:{}", e.without_url())))?;
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
    fn firmar_hello(&self, mode: &str, nonce_b64: &str) -> AppResult<FirmaDispositivo> {
        device::validar_reto(nonce_b64).map_err(AppError::validation)?;
        let (device_id, sk) = leer_identidad().map_err(ext)?;
        let tenant = match mode {
            "tpv" => load_state(&self.app_data_dir).map(|s| s.tenant_id),
            "handy" => device::handy_get_tenant().map_err(ext)?,
            _ => return Err(AppError::validation("Modo de dispositivo inválido")),
        }.ok_or_else(|| AppError::not_found("Falta el negocio del dispositivo"))?;
        if tenant.is_empty() || tenant.contains(['\n', '\r']) { return Err(AppError::validation("Negocio inválido")); }
        let ts = reloj::ahora_ms();
        let dominio = if mode == "handy" { "WS_HANDY_HELLO" } else { "WS_HELLO" };
        let payload = format!("{dominio}\n{ts}\n{tenant}\n{device_id}\n{nonce_b64}");
        Ok(FirmaDispositivo { ts, sig_b64: sign_payload_b64(&sk, &payload).map_err(ext)? })
    }

    fn firmar_emparejamiento(&self, args: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> {
        device::validar_reto(&args.nonce_b64).map_err(AppError::validation)?;
        let (device_id, sk) = leer_identidad().map_err(ext)?;
        let accion = match args.accion { AccionEmparejamiento::Consultar => "PAIR_FETCH", AccionEmparejamiento::Cancelar => "PAIR_CANCEL" };
        let ts = reloj::ahora_ms();
        let payload = format!("{accion}\n{ts}\n{}\n{}\n{device_id}", args.pair_code, args.nonce_b64);
        Ok(FirmaDispositivo { ts, sig_b64: sign_payload_b64(&sk, &payload).map_err(ext)? })
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

    fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
        Ok(load_state(&self.app_data_dir)
            .map(|s| s.tenant_id.trim().to_string())
            .filter(|t| !t.is_empty()))
    }


    fn tpv_server_signed_headers(
        &self,
        mode: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> AppResult<ApiSignedHeaders> {
        self.signed_headers_inner(mode, method, path, body, None)
    }

    async fn tpv_server_post_json(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<JsonValue> {
        let respuesta = self.post_con_repeticiones(mode, path, &body).await?;
        let status = respuesta.status;
        let text = respuesta.texto();

        let parsed: JsonValue =
            serde_json::from_str(&text).unwrap_or(JsonValue::Object(Default::default()));

        // ARCH-05: un único criterio para resolver el código, compartido con el resto de
        // adaptadores (`from_api_body`): manda el `code` del worker; si no viene, se traduce
        // el string de negocio. El texto original sigue viajando como `message`.
        if !respuesta.aceptada() {
            return Err(AppError::from_api_body(status, &text));
        }

        // 200 con `ok:false`: el worker responde 200 y marca el fallo en el cuerpo.
        if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            return Err(AppError::from_api_body(status, &text));
        }

        Ok(parsed)
    }

    /// El mismo POST, con el cuerpo de la respuesta tal cual: quien lo pide lo lee directamente en
    /// su tipo. Un volcado de la base del negocio son decenas de megas de JSON, y montar con él un
    /// `serde_json::Value` para deserializarlo después lo tenía dos veces en memoria.
    ///
    /// Los rechazos salen igual que en `tpv_server_post_json`. Lo que cambia es una respuesta que
    /// no llega entera: aquí es un fallo de conexión, no un cuerpo vacío.
    async fn tpv_server_post_bytes(
        &self,
        mode: &str,
        path: &str,
        body: JsonValue,
    ) -> AppResult<Vec<u8>> {
        let respuesta = self.post_con_repeticiones(mode, path, &body).await?;
        if !respuesta.aceptada() {
            return Err(AppError::from_api_body(respuesta.status, &respuesta.texto()));
        }
        respuesta
            .cuerpo
            .map_err(|e| AppError::sin_conexion(format!("la respuesta no ha llegado entera: {e}")))
    }

    async fn pair_create(&self) -> AppResult<PairCreateResult> {
        // Reutiliza el POST firmado en modo `tpv` (el worker exige rol TPV + licencia activa)
        // y tipa la respuesta `{ ok, pairCode, pairSecret, expiresAtMs }`.
        let parsed = self
            .tpv_server_post_json("tpv", "/v1/pair/create", JsonValue::Object(Default::default()))
            .await?;
        // AUD-28: sin el texto de serde, que citaría el código o el secreto del emparejamiento.
        serde_json::from_value(parsed)
            .map_err(|e| ext(no_encaja::<PairCreateResult>("bad_pair_create_response", &e)))
    }

    async fn upload_image(
        &self,
        mode: &str,
        path: &str,
        content_type: &str,
        bytes: Vec<u8>,
        negocio: &str,
    ) -> AppResult<ResultadoSubidaImagen> {
        // PUT firmado (device-proof sobre el path canónico, sin query). El tenant lo deriva el
        // worker del token: aislamiento por tenant garantizado. NO usa idempotency-key: es una
        // escritura directa a R2 (no pasa por el hub), y subir dos veces el mismo fichero al mismo
        // path deja exactamente lo mismo — por eso repetirlo tras renovar el token es inocuo.
        let (status, cuerpo) = self
            .enviar_firmado(mode, Method::PUT, path, &bytes, Some(content_type), Some(negocio))
            .await?;

        clasificar_subida_imagen(status, &cuerpo)
    }

    async fn delete_image(&self, mode: &str, path: &str) -> AppResult<()> {
        let (status, cuerpo) = self
            .enviar_firmado(mode, Method::DELETE, path, b"", None, None)
            .await?;

        if (200..300).contains(&status) {
            return Ok(());
        }
        // AUD-28: lo que falló y su status; nada del cuerpo.
        Err(AppError::rechazo("image_delete", status, &String::from_utf8_lossy(&cuerpo)))
    }

    async fn download_image(&self, mode: &str, rel_path: &str) -> AppResult<Option<Vec<u8>>> {
        // POST firmado a `/v1/images/download`. El tenant lo deriva el worker del token, así que
        // la Main no necesita conocerlo; `rel_path` viaja en el cuerpo, que **ahora sí entra en la
        // firma** (FABLE-E). 404 → None (el binario aún no está en R2).
        let path = "/v1/images/download";
        let body_str = serde_json::to_string(&serde_json::json!({ "rel_path": rel_path }))
            .map_err(|e| ext(format!("bad_json_body:{:?}", e.classify())))?;

        let (status, bytes) = self
            .enviar_firmado(
                mode,
                Method::POST,
                path,
                body_str.as_bytes(),
                Some("application/json"),
                None,
            )
            .await?;

        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            // AUD-28: lo que falló y su status; nada del cuerpo.
            return Err(AppError::rechazo("image_download", status, &String::from_utf8_lossy(&bytes)));
        }

        Ok(Some(bytes))
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

    #[test]
    fn sin_el_campo_la_respuesta_no_encaja() {
        // Lo manda siempre: una respuesta sin él no es la de la activación, y no se adivina.
        assert!(serde_json::from_str::<ActivateOk>(&format!("{RESPUESTA}}}")).is_err());
        let ok: ActivateOk = serde_json::from_str(&format!("{RESPUESTA},\"cambioDeEquipo\":false}}")).unwrap();
        assert!(!ok.cambio_de_equipo && !ok.tiempo_sumado);
    }
}

#[cfg(test)]
mod tests_peticion_de_activar {
    //! AUD-01: qué se manda al activar y cuándo se repite. Sin red y sin almacén de claves: la clave
    //! sale de una semilla fija, el cuerpo es una función pura y la nube es de mentira.

    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    /// La nube de estos tests contesta en el acto, así que basta con sondear el futuro una vez: no
    /// hace falta un runtime.
    fn esperar<F: Future>(futuro: F) -> F::Output {
        let mut futuro = std::pin::pin!(futuro);
        match futuro.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(valor) => valor,
            Poll::Pending => panic!("la nube de prueba no se queda esperando"),
        }
    }

    /// Un intento tal como llegó a la nube.
    #[derive(Debug, Clone, PartialEq)]
    struct Recibido {
        ts: i64,
        firma: String,
        cuerpo: Vec<u8>,
    }

    /// Una nube que guarda cada intento que recibe y contesta lo que se le diga, por orden. Si se
    /// le da una hora, sus rechazos por el reloj la traen en la cabecera `Date`, y la anota como lo
    /// hace `reloj::enviar` con una respuesta de verdad.
    struct Nube {
        respuestas: RefCell<VecDeque<AppResult<(u16, String)>>>,
        recibidos: RefCell<Vec<Recibido>>,
        hora: Option<&'static str>,
    }

    impl Nube {
        fn que_contesta(respuestas: Vec<AppResult<(u16, String)>>) -> Self {
            Nube {
                respuestas: RefCell::new(respuestas.into()),
                recibidos: RefCell::new(Vec::new()),
                hora: None,
            }
        }

        fn con_hora(mut self, fecha_http: &'static str) -> Self {
            self.hora = Some(fecha_http);
            self
        }

        fn recibir(
            &self,
            intento: ActivacionFirmada<'_>,
        ) -> std::future::Ready<AppResult<(u16, String)>> {
            self.recibidos.borrow_mut().push(Recibido {
                ts: intento.ts,
                firma: intento.firma,
                cuerpo: intento.cuerpo.to_vec(),
            });
            let respuesta = self
                .respuestas
                .borrow_mut()
                .pop_front()
                .expect("más intentos que respuestas");

            if let (Some(fecha), Ok((http, texto))) = (self.hora, &respuesta) {
                if reloj::es_rechazo_por_reloj(*http, texto) {
                    let mut cabeceras = HeaderMap::new();
                    cabeceras.insert(reqwest::header::DATE, HeaderValue::from_static(fecha));
                    let ahora = reloj::reloj_del_sistema_ms();
                    reloj::anotar_respuesta(&cabeceras, ahora, ahora);
                }
            }
            std::future::ready(respuesta)
        }

        fn activar(&self, cuerpo: &[u8]) -> AppResult<(u16, String)> {
            esperar(activar_firmando(&clave(), cuerpo, |intento| self.recibir(intento)))
        }

        fn intentos(&self) -> usize {
            self.recibidos.borrow().len()
        }
    }

    fn clave() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    const CUERPO: &[u8] = br#"{"activationKey":"TPV-1","deviceId":"d1","devicePubKey":"k"}"#;

    fn rechazo(http: u16, error: &str) -> AppResult<(u16, String)> {
        Ok((http, format!(r#"{{"ok":false,"error":"{error}"}}"#)))
    }

    fn activada() -> AppResult<(u16, String)> {
        Ok((200, r#"{"ok":true}"#.to_string()))
    }

    /// El equipo recién estrenado con el reloj mal. El primer intento va firmado con su hora; el
    /// rechazo trae la de la nube, y el segundo es la MISMA petición firmada de nuevo con ella. Si
    /// reutilizara la hora o la firma del primero, la nube lo volvería a rechazar.
    #[test]
    fn un_rechazo_por_la_hora_se_repite_firmando_con_la_hora_de_la_nube() {
        // La cabecera `Date` tal como la manda Cloudflare (la misma de los tests de `reloj`).
        const FECHA: &str = "Fri, 25 Sep 2026 19:19:26 GMT";
        const HORA_DE_LA_NUBE_MS: i64 = 1_790_363_966_000 + 500;
        const MARGEN_DE_LA_NUBE_MS: i64 = 2 * 60 * 1000;

        let nube = Nube::que_contesta(vec![rechazo(401, "device_ts_out_of_range"), activada()])
            .con_hora(FECHA);

        let antes = reloj::reloj_del_sistema_ms();
        assert_eq!(nube.activar(CUERPO).unwrap().0, 200);
        let tardado = reloj::reloj_del_sistema_ms() - antes;

        let recibidos = nube.recibidos.borrow();
        assert_eq!(recibidos.len(), 2);
        let (primero, segundo) = (&recibidos[0], &recibidos[1]);

        // El primero salió con una hora que la nube no acepta; el segundo, con la que trajo el
        // rechazo (el centro del segundo de `Date`, más lo que haya tardado este test).
        assert!((primero.ts - HORA_DE_LA_NUBE_MS).abs() > MARGEN_DE_LA_NUBE_MS);
        assert!(
            (HORA_DE_LA_NUBE_MS..=HORA_DE_LA_NUBE_MS + tardado + 1).contains(&segundo.ts),
            "el segundo intento lleva {} y la nube dijo {HORA_DE_LA_NUBE_MS}",
            segundo.ts
        );
        assert_ne!(primero.ts, segundo.ts);

        // Otra firma, no la de antes: cada una es la de su hora, sobre el mismo cuerpo.
        assert_ne!(primero.firma, segundo.firma);
        for intento in [primero, segundo] {
            assert_eq!(intento.cuerpo, CUERPO);
            assert_eq!(
                intento.firma,
                device::firmar_activacion(&clave(), intento.ts, CUERPO).unwrap()
            );
        }
    }

    #[test]
    fn si_la_hora_sigue_sin_valer_no_se_insiste() {
        let nube = Nube::que_contesta(vec![
            rechazo(401, "device_ts_out_of_range"),
            rechazo(401, "device_ts_out_of_range"),
            activada(),
        ]);
        let (http, texto) = nube.activar(CUERPO).unwrap();
        assert_eq!(http, 401);
        assert!(texto.contains("device_ts_out_of_range"));
        assert_eq!(nube.intentos(), 2, "una repetición, no un bucle");
    }

    /// Repetir se reserva a la hora: una firma que no vale, el código de traslado que falta o uno
    /// incorrecto (que cuenta un intento en la nube) no se mandan dos veces.
    #[test]
    fn lo_que_no_es_la_hora_no_se_repite() {
        for respuesta in [
            activada(),
            rechazo(401, "bad_device_signature"),
            rechazo(401, "missing_device_proof"),
            rechazo(401, "invalid_code"),
            rechazo(409, "device_change_required"),
            rechazo(403, "device_ts_out_of_range"),
        ] {
            let esperado = respuesta.as_ref().unwrap().clone();
            let nube = Nube::que_contesta(vec![respuesta, activada()]);
            assert_eq!(nube.activar(CUERPO).unwrap(), esperado);
            assert_eq!(nube.intentos(), 1, "{esperado:?}");
        }
    }

    #[test]
    fn un_fallo_de_red_no_se_repite() {
        let nube = Nube::que_contesta(vec![Err(AppError::external("sin red")), activada()]);
        assert!(nube.activar(CUERPO).is_err());
        assert_eq!(nube.intentos(), 1);
    }

    /// El cuerpo que sale de aquí es, byte a byte, el del vector que firma el test de `device.rs` y
    /// verifica el worker: el orden de los campos y lo que se omite son parte de lo firmado.
    #[test]
    fn el_cuerpo_de_activar_es_el_del_vector_compartido() {
        let vector: serde_json::Value =
            serde_json::from_str(include_str!("firma_activacion_casos.json")).unwrap();
        let clave_publica = vector["clavePublicaB64"].as_str().unwrap();
        let device_id = "3f2b8c1e-5d47-4a9b-8e6f-0c1d2e3f4a5b";
        let negocio = "0b6f3c52-7f0a-4b1e-9c3d-5a2e8f1d4c7b";

        let alta = SolicitudActivacion::validar(
            "TPV-AAAAA-BBBBB-CCCCC-DDDDD".into(),
            "Bar Ñandú".into(),
            None,
            None,
            None,
        )
        .unwrap();
        let canje = SolicitudActivacion::para_sumar("TPV-EEEEE-FFFFF-GGGGG-HHHHH".into()).unwrap();

        let cuerpos = [
            // Un equipo sin licencia guardada no tiene negocio que decir.
            cuerpo_de_activar(&alta, device_id, clave_publica, None, None).unwrap(),
            cuerpo_de_activar(&alta, device_id, clave_publica, Some("123456"), None).unwrap(),
            // El canje desde Configuración lleva el negocio del equipo.
            cuerpo_de_activar(&canje, device_id, clave_publica, None, Some(negocio)).unwrap(),
        ];
        let casos = vector["casos"].as_array().unwrap();
        assert_eq!(casos.len(), cuerpos.len());
        for (caso, cuerpo) in casos.iter().zip(cuerpos) {
            assert_eq!(
                String::from_utf8(cuerpo).unwrap(),
                caso["cuerpo"].as_str().unwrap(),
                "{}",
                caso["nombre"]
            );
        }
    }
}

fn clasificar_subida_imagen(status: u16, cuerpo: &[u8]) -> AppResult<ResultadoSubidaImagen> {
    if (200..300).contains(&status) { return Ok(ResultadoSubidaImagen::Subida); }
    let error = AppError::from_api_body(status, &String::from_utf8_lossy(cuerpo));
    if matches!(status, 400 | 413 | 415 | 422) {
        return Ok(ResultadoSubidaImagen::Rechazada { motivo: error.to_string() });
    }
    Err(error)
}

#[cfg(test)]
mod tests_subida_imagen {
    use super::*;
    #[test]
    fn credenciales_limites_y_servidor_no_apartan_una_imagen_valida() {
        for status in [401, 403, 408, 429, 500, 502, 503] {
            assert!(clasificar_subida_imagen(status, br#"{"error":"fallo"}"#).is_err());
        }
        for status in [400, 413, 415, 422] {
            assert!(matches!(clasificar_subida_imagen(status, br#"{"error":"bad_image_path"}"#),
                Ok(ResultadoSubidaImagen::Rechazada { .. })));
        }
        assert!(matches!(clasificar_subida_imagen(204, b""), Ok(ResultadoSubidaImagen::Subida)));
    }
}

#[cfg(test)]
mod tests_url_imagenes {
    use super::*;

    /// INFRA-03: la forma exacta que espera el GET del worker (`/v1/images/:tenant/*`), sobre la
    /// misma dirección que el resto de la nube, y nunca el `r2.dev` del bucket.
    #[test]
    fn la_handy_pide_las_imagenes_al_worker_con_su_negocio() {
        let negocio = "0190f3a1-7b2c-4d4e-8f00-123456789abc";
        assert_eq!(
            url_imagenes_del_negocio(negocio).as_deref(),
            Some("https://tpv-api.altarialights.workers.dev/v1/images/0190f3a1-7b2c-4d4e-8f00-123456789abc")
        );
        assert_eq!(
            url_imagenes_del_negocio(negocio).unwrap(),
            format!("{CLOUD_API_BASE}/v1/images/{negocio}")
        );
        assert_eq!(
            url_imagenes_del_negocio(&format!("  {negocio}\n")).unwrap(),
            format!("{CLOUD_API_BASE}/v1/images/{negocio}")
        );
        assert!(!url_imagenes_del_negocio(negocio).unwrap().contains("r2.dev"));
    }

    #[test]
    fn sin_negocio_no_hay_direccion_y_el_negocio_no_sale_de_su_segmento() {
        assert_eq!(url_imagenes_del_negocio(""), None);
        assert_eq!(url_imagenes_del_negocio("   "), None);
        let raro = url_imagenes_del_negocio("a/b?c#d").unwrap();
        assert_eq!(raro, format!("{CLOUD_API_BASE}/v1/images/a%2Fb%3Fc%23d"));
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
            texto(r#"{"ok":false,"error":"x","message":"No se ha podido completar.","details":"diagnóstico"}"#),
            "No se ha podido completar. (diagnóstico)"
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
        // RI-09: sin firma no borran nada, pero tienen su propio motivo; confundirlos con el reloj
        // o con la red mandaría a quien está delante a mirar lo que no es.
        for code in ["license_not_found", "license_revoked", "device_replaced"] {
            assert!(
                matches!(clasificar_error(403, code), FalloConsulta::RechazoSinFirmar { .. }),
                "code={code}"
            );
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
        firmada(sk, EstadoLicencia::Active, AHORA, AHORA + 60_000)
    }

    fn firmada(
        sk: &SigningKey,
        estado: EstadoLicencia,
        client_ts: i64,
        caduca: i64,
    ) -> SignedAssertionDto {
        let a = AssertionVerificada {
            version: 1,
            tenant_id: "t1".into(),
            device_id: "d1".into(),
            license_id: "l1".into(),
            estado,
            plan: "standard".into(),
            expires_at_ms: None,
            issued_at_ms: client_ts,
            assertion_expires_at_ms: caduca,
            client_ts,
        };
        let sig = sk.sign(dom::mensaje_canonico(&a).as_bytes());
        SignedAssertionDto {
            v: a.version,
            tenant_id: a.tenant_id,
            device_id: a.device_id,
            license_id: a.license_id,
            state: a.estado.codigo().into(),
            plan: a.plan,
            expires_at_ms: a.expires_at_ms,
            issued_at_ms: a.issued_at_ms,
            assertion_expires_at_ms: a.assertion_expires_at_ms,
            client_ts: a.client_ts,
            sig: B64.encode(sig.to_bytes()),
        }
    }

    /// El cuerpo de un rechazo de `/refresh` tal como lo manda el worker, con o sin aserción.
    fn rechazo(error: &str, a: Option<&SignedAssertionDto>, ts: i64) -> Respondida {
        let assertion = a.map(|a| {
            serde_json::json!({
                "v": a.v, "tenantId": a.tenant_id, "deviceId": a.device_id,
                "licenseId": a.license_id, "state": a.state, "plan": a.plan,
                "expiresAtMs": a.expires_at_ms, "issuedAtMs": a.issued_at_ms,
                "assertionExpiresAtMs": a.assertion_expires_at_ms, "clientTs": a.client_ts,
                "sig": a.sig,
            })
        });
        let texto = serde_json::json!({ "ok": false, "error": error, "assertion": assertion, "serverTime": ts })
            .to_string();
        Respondida { http: 403, texto, ts }
    }

    /// RI-09: una anulación de un equipo que llevaba más de 30 días apagado (token caducado) llega
    /// por `/refresh`. Con la aserción firmada se cree; con un código suelto, no.
    #[test]
    fn un_rechazo_con_asercion_firmada_es_el_estado_de_la_licencia() {
        let sk = clave(1);
        let claves = [publica(&sk)];
        let claves: Vec<&str> = claves.iter().map(String::as_str).collect();
        let ts = reloj::ahora_ms();
        let a = firmada(&sk, EstadoLicencia::Revoked, ts, ts + 300_000);

        match leer_rechazo_con(&claves, &rechazo("license_revoked", Some(&a), ts)) {
            Rechazo::Firmado(v) => assert_eq!(v.assertion.estado, EstadoLicencia::Revoked),
            Rechazo::Fallo(f) => panic!("debía creerse la aserción: {f}"),
        }
    }

    #[test]
    fn un_rechazo_con_asercion_de_otra_clave_o_de_otra_peticion_no_se_cree() {
        let sk = clave(1);
        let claves = [publica(&sk)];
        let claves: Vec<&str> = claves.iter().map(String::as_str).collect();
        let ts = reloj::ahora_ms();

        let ajena = firmada(&clave(9), EstadoLicencia::Revoked, ts, ts + 300_000);
        assert!(matches!(
            leer_rechazo_con(&claves, &rechazo("license_revoked", Some(&ajena), ts)),
            Rechazo::Fallo(FalloConsulta::FirmaInvalida)
        ));

        let vieja = firmada(&sk, EstadoLicencia::Revoked, ts - 1, ts + 300_000);
        assert!(matches!(
            leer_rechazo_con(&claves, &rechazo("license_revoked", Some(&vieja), ts)),
            Rechazo::Fallo(FalloConsulta::FirmaInvalida)
        ));
    }

    #[test]
    fn un_rechazo_sin_asercion_queda_sin_firmar() {
        let claves = [publica(&clave(1))];
        let claves: Vec<&str> = claves.iter().map(String::as_str).collect();
        assert!(matches!(
            leer_rechazo_con(&claves, &rechazo("license_not_found", None, reloj::ahora_ms())),
            Rechazo::Fallo(FalloConsulta::RechazoSinFirmar { .. })
        ));
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

#[cfg(test)]
mod tests_negocio_del_token {
    //! AUD-06 · Sólo ficheros en memoria: ni almacén de claves, ni AppData, ni red.
    use super::*;

    fn token_de(claims: serde_json::Value) -> String {
        let b64 = |v: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v);
        format!("{}.{}.firma", b64(br#"{"alg":"HS256","typ":"JWT"}"#), b64(claims.to_string().as_bytes()))
    }

    #[test]
    fn el_negocio_de_un_token_es_el_que_dice_su_claim() {
        let token = token_de(serde_json::json!({"tenantId": "negocio-a", "deviceId": "d", "licHash": "h"}));
        assert_eq!(negocio_del_token(&token).as_deref(), Some("negocio-a"));
        assert!(comprobar_negocio_del_token(&token, "negocio-a").is_ok());
        assert!(comprobar_negocio_del_token(&token, " negocio-a ").is_ok());

        let err = comprobar_negocio_del_token(&token, "negocio-x").unwrap_err();
        assert!(err.to_string().contains("vuelve a activarla"), "{err}");
    }

    #[test]
    fn un_token_que_no_dice_de_quien_es_no_vale_para_nadie() {
        for token in [
            "no-es-un-jwt".to_string(),
            "a.%%%.c".to_string(),
            token_de(serde_json::json!({"deviceId": "d"})),
            token_de(serde_json::json!({"tenantId": "  "})),
        ] {
            assert_eq!(negocio_del_token(&token), None, "{token}");
            assert!(comprobar_negocio_del_token(&token, "negocio-a").is_err(), "{token}");
        }
    }
}

#[cfg(test)]
mod tests_licencia_pendiente {
    //! AUD-06 · Con un almacén de secretos en memoria y una carpeta temporal: ni el almacén del
    //! sistema ni AppData.
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct EnMemoria {
        valores: RefCell<HashMap<String, String>>,
        /// La operación que falla, como si el proceso se cortara ahí: (operación, clave).
        corte: RefCell<Option<(&'static str, &'static str)>>,
    }

    impl EnMemoria {
        fn cortar(&self, op: &'static str, clave: &'static str) -> Result<(), String> {
            if *self.corte.borrow() == Some((op, clave)) {
                return Err(format!("corte en {op} {clave}"));
            }
            Ok(())
        }
        fn valor(&self, clave: &str) -> Option<String> {
            self.valores.borrow().get(clave).cloned()
        }
    }

    impl Secretos for EnMemoria {
        fn leer(&self, clave: &str) -> Result<Option<String>, String> {
            Ok(self.valor(clave))
        }
        fn guardar(&self, clave: &str, valor: &str) -> Result<(), String> {
            let clave_estatica = [device::KEY_LICENSE_TOKEN_PENDIENTE, device::KEY_FIELD_DEK_PENDIENTE,
                device::KEY_LICENSE_TOKEN_VIGENTE, device::KEY_FIELD_DEK_VIGENTE]
                .into_iter().find(|c| *c == clave).unwrap_or("otra");
            self.cortar("guardar", clave_estatica)?;
            self.valores.borrow_mut().insert(clave.into(), valor.into());
            Ok(())
        }
        fn borrar(&self, clave: &str) -> Result<(), String> {
            let clave_estatica = [device::KEY_LICENSE_TOKEN_PENDIENTE, device::KEY_FIELD_DEK_PENDIENTE,
                device::KEY_FIELD_DEK_VIGENTE]
                .into_iter().find(|c| *c == clave).unwrap_or("otra");
            self.cortar("borrar", clave_estatica)?;
            self.valores.borrow_mut().remove(clave);
            Ok(())
        }
    }

    fn dir_temporal(nombre: &str) -> PathBuf {
        let d = std::env::temp_dir().join("tpv_tests").join(format!(
            "licencia-pendiente-{nombre}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn estado_de(negocio: &str) -> LicenseLocalState {
        LicenseLocalState {
            tenant_id: negocio.into(),
            device_id: "equipo".into(),
            status: Some("active".into()),
            expires_at: None,
            expires_at_ms: None,
            plan: None,
            last_server_time_ms: None,
            last_check_ok_ms: None,
            last_check_attempt_ms: None,
            activated_at_ms: 1,
            offline_consumido_ms: None,
            marca_tiempo_ms: None,
        }
    }

    /// Un equipo con la licencia de A vigente, y lo concedido para X.
    fn equipo_de_a(nombre: &str) -> (EnMemoria, PathBuf, CredencialesConcedidas) {
        let secretos = EnMemoria::default();
        secretos.guardar(device::KEY_LICENSE_TOKEN_VIGENTE, "token-de-a").unwrap();
        secretos.guardar(device::KEY_FIELD_DEK_VIGENTE, &device::envolver_dek("negocio-a", "dek-de-a").unwrap()).unwrap();
        let dir = dir_temporal(nombre);
        save_state(&dir, &estado_de("negocio-a")).unwrap();
        let x = CredencialesConcedidas { negocio: "negocio-x".into(), token: "token-de-x".into(), field_dek: Some("dek-de-x".into()) };
        (secretos, dir, x)
    }

    fn vigente(secretos: &EnMemoria, dir: &Path) -> (Option<String>, Option<String>, Option<String>) {
        (
            secretos.valor(device::KEY_LICENSE_TOKEN_VIGENTE),
            secretos.valor(device::KEY_FIELD_DEK_VIGENTE).and_then(|d| device::dek_del_negocio(&d, "negocio-x").or(device::dek_del_negocio(&d, "negocio-a"))),
            load_state(dir).map(|s| s.tenant_id),
        )
    }

    #[test]
    fn la_licencia_de_otro_negocio_queda_pendiente_y_lo_vigente_no_cambia() {
        let (secretos, dir, x) = equipo_de_a("pendiente");
        guardar_pendiente_en(&secretos, &dir, &x, &estado_de("negocio-x")).unwrap();

        assert_eq!(vigente(&secretos, &dir), (Some("token-de-a".into()), Some("dek-de-a".into()), Some("negocio-a".into())));
        assert_eq!(load_estado_pendiente(&dir).map(|s| s.tenant_id).as_deref(), Some("negocio-x"));
        assert_eq!(secretos.valor(device::KEY_LICENSE_TOKEN_PENDIENTE).as_deref(), Some("token-de-x"));
        assert!(!dir.join("license_state.pending.json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn el_arranque_aplica_lo_pendiente_y_aguanta_un_corte_en_cualquier_punto() {
        for corte in [
            None,
            Some(("guardar", device::KEY_LICENSE_TOKEN_VIGENTE)),
            Some(("borrar", device::KEY_LICENSE_TOKEN_PENDIENTE)),
            Some(("borrar", device::KEY_FIELD_DEK_PENDIENTE)),
        ] {
            let (secretos, dir, x) = equipo_de_a("aplicar");
            guardar_pendiente_en(&secretos, &dir, &x, &estado_de("negocio-x")).unwrap();

            *secretos.corte.borrow_mut() = corte;
            assert_eq!(aplicar_pendiente_en(&secretos, &dir).is_err(), corte.is_some(), "corte en {corte:?}");
            *secretos.corte.borrow_mut() = None;
            aplicar_pendiente_en(&secretos, &dir).unwrap();

            assert_eq!(
                vigente(&secretos, &dir),
                (Some("token-de-x".into()), Some("dek-de-x".into()), Some("negocio-x".into())),
                "corte en {corte:?}"
            );
            assert!(load_estado_pendiente(&dir).is_none(), "corte en {corte:?}");
            assert!(secretos.valor(device::KEY_LICENSE_TOKEN_PENDIENTE).is_none(), "corte en {corte:?}");
            // Repetirlo ya no hace nada.
            aplicar_pendiente_en(&secretos, &dir).unwrap();
            assert_eq!(vigente(&secretos, &dir).2.as_deref(), Some("negocio-x"));
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn un_negocio_sin_dek_retira_la_del_anterior_aunque_el_arranque_se_corte() {
        let (secretos, dir, mut x) = equipo_de_a("sin-dek");
        x.field_dek = None;
        guardar_pendiente_en(&secretos, &dir, &x, &estado_de("negocio-x")).unwrap();
        assert_eq!(vigente(&secretos, &dir).1.as_deref(), Some("dek-de-a"), "lo vigente no cambia al activar");

        *secretos.corte.borrow_mut() = Some(("borrar", device::KEY_FIELD_DEK_VIGENTE));
        assert!(aplicar_pendiente_en(&secretos, &dir).is_err());
        *secretos.corte.borrow_mut() = None;
        aplicar_pendiente_en(&secretos, &dir).unwrap();

        assert_eq!(vigente(&secretos, &dir), (Some("token-de-x".into()), None, Some("negocio-x".into())));
        assert!(secretos.valor(device::KEY_FIELD_DEK_PENDIENTE).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn si_la_dek_no_se_puede_guardar_la_activacion_sigue_sin_ella() {
        let (secretos, dir, x) = equipo_de_a("dek-falla");
        guardar_pendiente_en(&secretos, &dir, &x, &estado_de("negocio-x")).unwrap();
        *secretos.corte.borrow_mut() = Some(("guardar", device::KEY_FIELD_DEK_VIGENTE));
        aplicar_pendiente_en(&secretos, &dir).unwrap();

        // Ni la de X (no se pudo) ni la de A: con la licencia de X no se cifra con la de otro negocio.
        assert_eq!(vigente(&secretos, &dir), (Some("token-de-x".into()), None, Some("negocio-x".into())));
        assert!(load_estado_pendiente(&dir).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn descartar_lo_pendiente_deja_lo_vigente_como_estaba() {
        let (secretos, dir, x) = equipo_de_a("descartar");
        guardar_pendiente_en(&secretos, &dir, &x, &estado_de("negocio-x")).unwrap();
        descartar_pendiente_en(&secretos, &dir).unwrap();

        assert!(load_estado_pendiente(&dir).is_none());
        assert!(secretos.valor(device::KEY_LICENSE_TOKEN_PENDIENTE).is_none());
        assert!(secretos.valor(device::KEY_FIELD_DEK_PENDIENTE).is_none());
        aplicar_pendiente_en(&secretos, &dir).unwrap();
        assert_eq!(vigente(&secretos, &dir), (Some("token-de-a".into()), Some("dek-de-a".into()), Some("negocio-a".into())));
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_mensajes_sin_datos {
    //! AUD-28: los mensajes de error de este adaptador salen del equipo (Axiom, y Sentry si son de
    //! programa). No llevan el cuerpo de una respuesta, que en la activación y en `/status` trae el
    //! token de sesión y la DEK de los datos del personal, ni la ruta de AppData, que lleva el
    //! usuario de Windows. Puros: sin red, sin almacén de secretos; sólo una carpeta temporal.

    use super::*;

    const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJ0ZW5hbnRJZCI6Im5lZ29jaW8ifQ.firma-de-prueba";
    const DEK: &str = "3q2+7wZmaWVsZC1kZWstZGUtcHJ1ZWJh";

    fn sin_secretos(mensaje: &str) {
        for dato in [TOKEN, "eyJ", DEK, "3q2+7w", "987654321", "body="] {
            assert!(!mensaje.contains(dato), "{dato}: {mensaje}");
        }
    }

    #[test]
    fn una_activacion_que_no_encaja_no_cita_el_token_ni_la_dek() {
        // El control: con todo en su sitio, se lee.
        let buena = format!(r#"{{"ok":true,"tenantId":"t1","token":"{TOKEN}","status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#);
        assert_eq!(leer_activacion(&buena).unwrap().token, TOKEN);

        for cuerpo in [
            // La DEK con otro tipo: el texto de serde la citaría.
            format!(r#"{{"ok":true,"tenantId":"t1","token":"{TOKEN}","status":"active","fieldDek":987654321,"cambioDeEquipo":false}}"#),
            // El token con otro tipo.
            format!(r#"{{"ok":true,"tenantId":"t1","token":987654321,"status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#),
            // Le falta un campo.
            format!(r#"{{"ok":true,"token":"{TOKEN}","status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#),
            // Sin la DEK, o nula: viene en cada activación, y sin ella no se activa a medias.
            format!(r#"{{"ok":true,"tenantId":"t1","token":"{TOKEN}","status":"active","cambioDeEquipo":false}}"#),
            format!(r#"{{"ok":true,"tenantId":"t1","token":"{TOKEN}","status":"active","fieldDek":null,"cambioDeEquipo":false}}"#),
        ] {
            let mensaje = leer_activacion(&cuerpo).expect_err("no encaja").to_string();
            sin_secretos(&mensaje);
            assert!(mensaje.starts_with("activate_bad_json: la respuesta de la nube no encaja en "), "{mensaje}");
            assert!(mensaje.contains("ActivateOk") && mensaje.contains("línea 1, columna "), "{mensaje}");
        }
    }

    #[test]
    fn una_activacion_sin_la_licencia_dice_que_le_falta() {
        for (cuerpo, falta) in [
            (format!(r#"{{"ok":false,"tenantId":"t1","token":"{TOKEN}","status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#), "ok=false"),
            (format!(r#"{{"ok":true,"tenantId":"t1","token":"  ","status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#), "sin token"),
            (format!(r#"{{"ok":true,"tenantId":" ","token":"{TOKEN}","status":"active","fieldDek":"{DEK}","cambioDeEquipo":false}}"#), "sin negocio"),
        ] {
            let mensaje = leer_activacion(&cuerpo).expect_err("le falta algo").to_string();
            sin_secretos(&mensaje);
            assert_eq!(
                mensaje,
                format!("La respuesta del servidor de licencias no trae la licencia concedida ({falta}).")
            );
        }
    }

    #[test]
    fn un_status_que_no_encaja_no_cita_el_token() {
        let cuerpo = format!(r#"{{"ok":true,"assertion":"{DEK}","token":"{TOKEN}","serverTime":1}}"#);
        let Err(fallo) = leer_status(&cuerpo) else { panic!("no encaja") };
        let mensaje = fallo.to_string();
        sin_secretos(&mensaje);
        assert!(mensaje.starts_with("status_unreadable: invalid_json: la respuesta de la nube no encaja en "), "{mensaje}");
    }

    #[test]
    fn un_estado_desconocido_solo_se_cita_si_es_un_identificador() {
        assert_eq!(estado_desconocido("suspended"), "estado_desconocido: suspended");
        let largo = "a".repeat(33);
        for estado in ["Ana Prueba", "612345678", TOKEN, "", largo.as_str()] {
            assert_eq!(estado_desconocido(estado), "estado_desconocido", "{estado:?}");
        }
    }

    /// Una carpeta temporal en la que el fichero de la licencia es una carpeta: escribirlo o
    /// borrarlo falla, que es lo que se quiere ver.
    fn equipo_con_ficheros_bloqueados(nombre: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("tpv_tests").join(format!(
            "aud28-{nombre}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(license_state_path(&dir)).unwrap();
        fs::create_dir_all(license_rejection_path(&dir)).unwrap();
        dir
    }

    #[test]
    fn un_fichero_de_la_licencia_que_falla_no_dice_la_ruta() {
        let dir = equipo_con_ficheros_bloqueados("ficheros");
        let estado = LicenseLocalState {
            tenant_id: "negocio".into(),
            device_id: "equipo".into(),
            status: Some("active".into()),
            expires_at: None,
            expires_at_ms: None,
            plan: None,
            last_server_time_ms: None,
            last_check_ok_ms: None,
            last_check_attempt_ms: None,
            activated_at_ms: 1,
            offline_consumido_ms: None,
            marca_tiempo_ms: None,
        };
        let carpeta = dir.to_string_lossy().to_string();
        // El control: la ruta de la carpeta temporal es la de AppData de un usuario de verdad.
        assert!(carpeta.len() > "license_state.json".len());

        for (fallo, fichero) in [
            (save_state(&dir, &estado).err(), "license_state.json"),
            (delete_state(&dir).err(), "license_state.json"),
            (save_rejection(&dir, "license_revoked").err(), "license_rejection.txt"),
            (delete_rejection(&dir).err(), "license_rejection.txt"),
        ] {
            let mensaje = fallo.expect("el fichero es una carpeta: tiene que fallar").to_string();
            assert!(mensaje.starts_with("No se pudo ") && mensaje.contains(fichero), "{mensaje}");
            assert!(!mensaje.contains(&carpeta) && !mensaje.contains("tpv_tests"), "{mensaje}");
        }
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_transporte_de_volcados {
    //! El POST que baja un volcado, contra un servidor local: pide la respuesta comprimida y la
    //! lee descomprimida, respeta el plazo de su ruta por encima del general, y una respuesta
    //! cortada no se confunde con una vacía.

    use super::*;
    use std::io::Write as _;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use tpv_contracts::sync::BootstrapSnapshot;

    /// Lo que el servidor hace con la petición que recibe.
    enum Contesta {
        /// El cuerpo tal cual.
        Plano(Vec<u8>),
        /// El cuerpo comprimido con gzip, diciéndolo en `content-encoding`.
        Gzip(Vec<u8>),
        /// El cuerpo tal cual, tras esperar.
        TrasEsperar(Duration, Vec<u8>),
        /// Anuncia `declarados` bytes, manda sólo el principio y corta.
        Cortado { declarados: usize, enviados: Vec<u8> },
    }

    /// Atiende UNA petición y devuelve sus cabeceras (en minúsculas) y su cuerpo.
    async fn atender(listener: TcpListener, contesta: Contesta) -> (String, Vec<u8>) {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut leido = Vec::new();
        let mut buf = [0u8; 4096];
        let fin_cabeceras = loop {
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0, "la conexión se cerró a mitad de las cabeceras");
            leido.extend_from_slice(&buf[..n]);
            if let Some(i) = leido.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let cabeceras = String::from_utf8(leido[..fin_cabeceras].to_vec()).unwrap().to_ascii_lowercase();
        let largo: usize = cabeceras
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .map(|v| v.trim().parse().unwrap())
            .unwrap_or(0);
        while leido.len() < fin_cabeceras + largo {
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0, "la conexión se cerró a mitad del cuerpo");
            leido.extend_from_slice(&buf[..n]);
        }
        let cuerpo = leido[fin_cabeceras..fin_cabeceras + largo].to_vec();

        let respuesta = |extra: &str, largo: usize| {
            format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n{extra}content-length: {largo}\r\nconnection: close\r\n\r\n")
        };
        match contesta {
            Contesta::Plano(bytes) => {
                socket.write_all(respuesta("", bytes.len()).as_bytes()).await.unwrap();
                socket.write_all(&bytes).await.unwrap();
            }
            Contesta::Gzip(bytes) => {
                let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                gz.write_all(&bytes).unwrap();
                let comprimido = gz.finish().unwrap();
                assert!(comprimido.len() < bytes.len(), "el ejemplo tiene que comprimir");
                socket
                    .write_all(respuesta("content-encoding: gzip\r\n", comprimido.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&comprimido).await.unwrap();
            }
            Contesta::TrasEsperar(espera, bytes) => {
                tokio::time::sleep(espera).await;
                // Quien pidió puede haberse ido ya (su plazo venció): escribir puede fallar.
                let _ = socket.write_all(respuesta("", bytes.len()).as_bytes()).await;
                let _ = socket.write_all(&bytes).await;
            }
            Contesta::Cortado { declarados, enviados } => {
                socket.write_all(respuesta("", declarados).as_bytes()).await.unwrap();
                socket.write_all(&enviados).await.unwrap();
            }
        }
        let _ = socket.shutdown().await;
        (cabeceras, cuerpo)
    }

    /// Manda un POST al servidor local con `plazo`, usando un cliente cuyo plazo general es
    /// `plazo_general`. Devuelve lo que contestó y lo que el servidor recibió.
    async fn pedir(
        contesta: Contesta,
        plazo_general: Duration,
        plazo: Duration,
    ) -> (AppResult<RespuestaPost>, tokio::task::JoinHandle<(String, Vec<u8>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/sync/bootstrap", listener.local_addr().unwrap());
        let servidor = tokio::spawn(atender(listener, contesta));
        let cliente = construir_cliente(plazo_general, Duration::from_secs(5)).unwrap();
        let mut cabeceras = HeaderMap::new();
        cabeceras.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let respuesta = post_crudo(&cliente, &url, cabeceras, "{}".to_string(), plazo).await;
        (respuesta, servidor)
    }

    /// Un volcado como el de `/v1/sync/bootstrap`, con filas repetidas para que comprima.
    fn volcado() -> Vec<u8> {
        let filas: Vec<serde_json::Value> =
            (0..500).map(|i| serde_json::json!([format!("zona-{i}"), "Salón de la planta baja"])).collect();
        serde_json::to_vec(&serde_json::json!({
            "ok": true, "seq": 77, "total_filas": 500,
            "tablas": [{ "nombre": "Zonas", "columnas": ["ID_Zona", "Nombre_Zona"], "filas": filas, "parcial": false }],
            "backfill": [],
        }))
        .unwrap()
    }

    const LARGO: Duration = Duration::from_secs(20);

    #[tokio::test]
    async fn pide_la_respuesta_comprimida_y_la_lee_descomprimida() {
        let original = volcado();
        let (respuesta, servidor) = pedir(Contesta::Gzip(original.clone()), LARGO, LARGO).await;
        let respuesta = respuesta.unwrap();
        let (cabeceras, cuerpo_pedido) = servidor.await.unwrap();

        assert!(
            cabeceras.lines().any(|l| l.starts_with("accept-encoding:") && l.contains("gzip")),
            "la petición tiene que pedir gzip: {cabeceras}"
        );
        assert_eq!(cuerpo_pedido, b"{}");
        assert_eq!(respuesta.status, 200);
        let bytes = respuesta.cuerpo.expect("el cuerpo llega entero");
        assert_eq!(bytes, original, "lo que se lee es el JSON, no el gzip");

        // Y de los bytes al tipo, sin pasar por un `Value`.
        let foto: BootstrapSnapshot = serde_json::from_slice(&bytes).unwrap();
        assert_eq!((foto.seq, foto.total_filas, foto.tablas[0].filas.len()), (77, 500, 500));
    }

    #[tokio::test]
    async fn una_respuesta_sin_comprimir_se_lee_igual() {
        // Una respuesta que llega sin comprimir (una pequeña).
        let original = volcado();
        let (respuesta, servidor) = pedir(Contesta::Plano(original.clone()), LARGO, LARGO).await;
        servidor.await.unwrap();
        assert_eq!(respuesta.unwrap().cuerpo.unwrap(), original);
    }

    #[tokio::test]
    async fn el_plazo_de_la_peticion_manda_sobre_el_general() {
        // El cliente corta a los 200 ms; el volcado tarda 700 ms en salir. Con el plazo de su
        // ruta, llega.
        let general = Duration::from_millis(200);
        let tarda = Duration::from_millis(700);
        let (respuesta, servidor) =
            pedir(Contesta::TrasEsperar(tarda, b"{\"ok\":true}".to_vec()), general, Duration::from_secs(20)).await;
        servidor.await.unwrap();
        assert_eq!(respuesta.unwrap().cuerpo.unwrap(), b"{\"ok\":true}");

        // Y sin él (el plazo general), la misma respuesta no llega: es un fallo de conexión.
        let (respuesta, servidor) =
            pedir(Contesta::TrasEsperar(tarda, b"{\"ok\":true}".to_vec()), general, general).await;
        let fallo = respuesta.err().expect("vence el plazo");
        assert!(fallo.to_string().contains("No se ha podido conectar"), "{fallo}");
        assert!(!fallo.to_string().contains("127.0.0.1"), "el error no lleva la URL: {fallo}");
        servidor.await.unwrap();
    }

    #[tokio::test]
    async fn una_respuesta_cortada_no_es_una_respuesta_vacia() {
        let (respuesta, servidor) = pedir(
            Contesta::Cortado { declarados: 5_000, enviados: b"{\"ok\":true,\"seq\":7,".to_vec() },
            LARGO,
            LARGO,
        )
        .await;
        servidor.await.unwrap();
        let respuesta = respuesta.unwrap();
        assert_eq!(respuesta.status, 200);
        assert!(respuesta.cuerpo.is_err(), "el cuerpo no llegó entero");
        assert_eq!(respuesta.texto(), "", "y como texto no se inventa nada");
    }

    #[test]
    fn las_rutas_que_bajan_un_volcado_tienen_su_plazo() {
        let volcado = Duration::from_secs(HTTP_TIMEOUT_VOLCADO_SECS);
        let normal = Duration::from_secs(HTTP_TIMEOUT_SECS);
        assert!((120..=180).contains(&HTTP_TIMEOUT_VOLCADO_SECS));
        for ruta in [
            "/v1/sync/bootstrap",
            "/v1/sync/historico",
            "/v1/sync/verificar/resumen",
            "/v1/sync/verificar/filas",
            "/v1/sync/verificar/por-clave",
            "/v1/sync/verificar/claves",
        ] {
            assert_eq!(plazo_de(ruta), volcado, "{ruta}");
        }
        assert_eq!(plazo_de("/v1/sync/bootstrap?x=1"), volcado);
        for ruta in ["/v1/sync/changes", "/v1/sync/salud", "/v1/ws/ticket", "/v1/license/status", "/v1/sync/bootstrap-otra", "/v1/sync/verificar"] {
            assert_eq!(plazo_de(ruta), normal, "{ruta}");
        }
    }
}

#[cfg(test)]
mod tests_sin_red {
    //! CFG-INC-04: sin red, lo que se enseña dice qué pasa y qué hacer, en español, y entre
    //! paréntesis sólo la clase del fallo. Antes iba el texto de reqwest («error sending request»):
    //! vincular una Handy sin red lo enseñaba tal cual en la Main.

    use super::*;
    use tokio::net::TcpSocket;

    const FRASE: &str = "No se ha podido conectar con el servidor. Comprueba la conexión a internet.";

    fn en_espanol(mensaje: &str, clase: &str) {
        assert_eq!(mensaje, format!("{FRASE} ({clase})"));
        for ingles in ["error sending", "request", "connect", "tcp", "os error"] {
            assert!(!mensaje.to_lowercase().contains(ingles), "{ingles}: {mensaje}");
        }
    }

    /// Un puerto en el que no escucha nadie: enlazado por el test y sin `listen`, el sistema
    /// rechaza la conexión y nadie más lo ocupa mientras tanto.
    fn sin_nadie() -> (TcpSocket, String) {
        let reservado = TcpSocket::new_v4().unwrap();
        reservado.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let base = format!("http://{}", reservado.local_addr().unwrap());
        (reservado, base)
    }

    /// El POST firmado de la Main y la Handy: emparejamiento, licencia, ticket del WebSocket.
    #[tokio::test]
    async fn el_post_firmado() {
        let (_reservado, base) = sin_nadie();
        let e = post_crudo(&Client::new(), &format!("{base}/v1/pair/create"), HeaderMap::new(), "{}".into(), Duration::from_secs(5))
            .await
            .err()
            .expect("sin nadie escuchando no hay respuesta");
        en_espanol(&e.to_string(), "no se pudo abrir la conexión");
    }

    /// Lo que usa cada sitio que habla con la nube por su cuenta (activar, pedir el cambio de
    /// equipo, las imágenes): la misma frase.
    #[tokio::test]
    async fn cualquier_envio() {
        let (_reservado, base) = sin_nadie();
        let e = reloj::enviar(Client::new().get(format!("{base}/v1/images/x")))
            .await
            .expect_err("sin nadie escuchando no hay respuesta");
        en_espanol(&reloj::fallo_de_transporte(e).to_string(), "no se pudo abrir la conexión");
    }
}
