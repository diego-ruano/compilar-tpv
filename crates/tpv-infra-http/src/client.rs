//! Cliente HTTP firmado hacia el worker `tpv-api`.
//!
//! Transporte compartido por todos los `Http…Repository`. Cada petición se firma con la
//! identidad del dispositivo (modo `handy`) reutilizando `PairingAdapter` de
//! `tpv-infra-licensing`, que ya gestiona el token Handy (keyring) y la firma ed25519.
//!
//! Contrato del worker (ver `apps/cloud-worker-licensing`):
//! - Auth: JWT Bearer + device-proof `{ts}\n{METHOD}\n{pathname}\n{sha256(token)}\n{sha256(body)}`
//!   (la firma va sobre el path SIN query string, y sobre los bytes exactos del cuerpo).
//! - Escrituras (POST/PUT/PATCH/DELETE): requieren la cabecera `X-Idempotency-Key`; se aplican
//!   vía el Durable Object contra la Main conectada (si no hay Main, responde `main_offline`).

use std::path::PathBuf;
use std::time::Duration;

use reqwest::{Client, Method, RequestBuilder};
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::PairingService;
use tpv_contracts::licensing::ApiSignedHeaders;
use tpv_infra_licensing::PairingAdapter;

/// Host del worker unificado `tpv-api`. La constante vive en `tpv-infra-licensing` (la crate
/// que también firma las peticiones); aquí solo se reexporta para no duplicar el literal.
pub use tpv_infra_licensing::CLOUD_API_BASE;

const HTTP_TIMEOUT_SECS: u64 = 20;

/// Transporte HTTP firmado contra `tpv-api`.
pub struct CloudClient {
    http: Client,
    base_url: String,
    pairing: PairingAdapter,
    /// Modo con el que se firman las peticiones ("handy" en dispositivos secundarios).
    mode: String,
}

impl CloudClient {
    /// Construye el cliente. `app_data_dir` es la carpeta de datos del dispositivo (necesaria
    /// para que `PairingAdapter` localice la clave/identidad). No hace red.
    pub fn new(base_url: impl Into<String>, app_data_dir: PathBuf) -> AppResult<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| AppError::external(format!("http_build_failed: {e}")))?;

        Ok(Self {
            http,
            base_url: base_url.into(),
            pairing: PairingAdapter::new(app_data_dir),
            mode: "handy".to_string(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    /// Firma device-proof sobre el path **canónico** (sin query string) y el cuerpo exacto.
    fn signed(&self, method: &str, path: &str, body: &[u8]) -> AppResult<ApiSignedHeaders> {
        let path_only = path.split('?').next().unwrap_or(path);
        self.pairing
            .tpv_server_signed_headers(&self.mode, method, path_only, body)
    }

    /// Crea un `RequestBuilder` con las cabeceras device-proof firmadas para `method`/`path`.
    ///
    /// SYNC-04 — `x-client-now`: el reloj lo pone el dispositivo EMISOR, no el servidor. El worker
    /// usa esta hora local para resolver a literal fijo los `datetime('now',…)` de las escrituras,
    /// de modo que la fila salga idéntica en nube, Main y Handy (replicación determinista). Si falta,
    /// el guard del DO **rechaza** el comando con `missing_client_now` en vez de escribir en UTC en
    /// silencio; sin esta cabecera, toda escritura del Handy cuyo SQL lleve `datetime('now')` fallaba
    /// (crear ticket, añadir línea, lotes, mesas, tareas, reservas…).
    ///
    /// Se fija aquí, en el ÚNICO punto por el que pasan todas las peticiones (GET incluidos, donde
    /// es inocua), y no en `write_body`: así ninguna ruta futura puede olvidarla — de hecho
    /// `delete_json` ya se saltaba `write_body`. Espejo de `tpv_server_post_json`
    /// (`tpv-infra-licensing`), que es el otro transporte y siempre la ha puesto.
    /// `body` son los bytes que se van a enviar (vacío en GET/DELETE): entran en la firma, así que
    /// el llamante tiene que adjuntar **exactamente** esos bytes con `.body(...)`, nunca volver a
    /// serializar con `.json(...)` (FABLE-E).
    fn signed_req(&self, method: Method, path: &str, body: &[u8]) -> AppResult<RequestBuilder> {
        let method_str = method.as_str().to_string();
        let h = self.signed(&method_str, path, body)?;
        let client_now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        Ok(self
            .http
            .request(method, self.url(path))
            .header("authorization", h.authorization)
            .header("x-device-ts", h.x_device_ts)
            .header("x-device-sig", h.x_device_sig)
            .header("x-client-now", client_now))
    }

    /// GET firmado que deserializa la respuesta JSON en `T`.
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let rb = self.signed_req(Method::GET, path, b"")?;
        Self::send(rb).await
    }

    /// GET firmado con parámetros de query (reqwest los codifica; la firma va sobre el path).
    pub async fn get_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> AppResult<T> {
        let rb = self.signed_req(Method::GET, path, b"")?.query(query);
        Self::send(rb).await
    }

    /// POST firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn post_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::POST, path, body).await
    }

    /// PUT firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn put_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::PUT, path, body).await
    }

    /// PATCH firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn patch_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::PATCH, path, body).await
    }

    /// DELETE firmado (escritura sin cuerpo): añade `X-Idempotency-Key`.
    pub async fn delete_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        let rb = self
            .signed_req(Method::DELETE, path, b"")?
            .header("x-idempotency-key", Uuid::new_v4().to_string());
        Self::send(rb).await
    }

    async fn write_body<B, T>(&self, method: Method, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        // Se serializa UNA vez: esos bytes son los que se firman y los que se envian. Con
        // `.json(body)` reqwest volveria a serializar y cualquier diferencia de bytes tiraria la
        // firma abajo en el worker.
        let bytes = serde_json::to_vec(body)
            .map_err(|e| AppError::external(format!("bad_json_body: {e}")))?;

        let rb = self
            .signed_req(method, path, &bytes)?
            .header("x-idempotency-key", Uuid::new_v4().to_string())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
        Self::send(rb).await
    }

    async fn send<T: DeserializeOwned>(rb: RequestBuilder) -> AppResult<T> {
        let resp = rb
            .send()
            .await
            .map_err(|e| AppError::external(format!("http_send_failed: {e}")))?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            // ARCH-05: el código lo resuelve `from_api_body`, que prefiere el `code` que
            // manda el worker (él tiene el status y el contexto de la ruta) y sólo traduce el
            // string de negocio si no viene.
            return Err(AppError::from_api_body(status.as_u16(), &text));
        }

        serde_json::from_str::<T>(&text)
            .map_err(|e| AppError::external(format!("bad_json: {e} | body={text}")))
    }
}
