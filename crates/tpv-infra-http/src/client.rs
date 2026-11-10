//! Cliente HTTP firmado hacia el worker `tpv-api`.
//!
//! Transporte compartido por todos los `Http…Repository`. Cada petición se firma con la
//! identidad del dispositivo (modo `handy`) reutilizando `PairingAdapter` de
//! `tpv-infra-licensing`, que ya gestiona el token Handy (keyring) y la firma ed25519.
//!
//! Contrato del worker (ver `apps/cloud-worker-licensing`):
//! - Auth: JWT Bearer + device-proof `{ts}\n{METHOD}\n{pathname}{search}\n{sha256(token)}\n{sha256(body)}`
//!   (la firma va sobre la ruta CON su query, tal como la verá el worker, y sobre los bytes exactos
//!   del cuerpo).
//! - Escrituras (POST/PUT/PATCH/DELETE): requieren la cabecera `X-Idempotency-Key`; las aplica el
//!   Durable Object en la base de la nube, y sólo si hay una Main conectada (si no, `main_offline`).
//!   La clave se repite en el reintento de una escritura incierta (RI-64, `EscriturasInciertas`).
//!
//! REV-02 — el token caduca y aquí se renueva. El de la Handy dura 30 días y por este transporte
//! pasa TODO lo que hace (no tiene BD local): si caduca, dejan de funcionar a la vez sus lecturas y
//! sus escrituras. Renovarlo sólo en el ticket del WebSocket no bastaba, porque ese ticket se pide
//! al reconectar: un equipo que cruza la caducidad con el socket abierto se quedaba con la pantalla
//! conectada y todo lo demás fallando en silencio.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{Client, Method, RequestBuilder};
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::licensing::PairingService;
use tpv_contracts::licensing::ApiSignedHeaders;
use tpv_infra_licensing::{reloj, PairingAdapter};

/// Host del worker unificado `tpv-api`. La constante vive en `tpv-infra-licensing` (la crate
/// que también firma las peticiones); aquí solo se reexporta para no duplicar el literal.
pub use tpv_infra_licensing::CLOUD_API_BASE;

const HTTP_TIMEOUT_SECS: u64 = 20;

/// RI-64 — cuánto se recuerda una escritura cuyo resultado no se llegó a saber.
const VENTANA_INCIERTA: Duration = Duration::from_secs(5 * 60);

/// Una escritura que salió sin respuesta clara: un fallo de transporte (incluido el timeout) o un
/// 5xx. Puede haberse aplicado o no.
#[derive(Clone)]
struct Incierta {
    clave: String,
    cuerpo: Vec<u8>,
    desde: Instant,
}

/// RI-64 — la clave de idempotencia cubre también el reintento de la PERSONA.
///
/// Si una escritura tarda más que el timeout pero sí se aplicó, la pantalla da error y el camarero
/// vuelve a pulsar. Con una clave nueva en cada llamada, eso era una segunda línea en la comanda o
/// una reserva repetida. Ahora, mientras el resultado de una escritura es incierto, la misma
/// petición (método, ruta y cuerpo) vuelve a salir con **su** clave y **sus** bytes, y el Durable
/// Object hace el resto: si la primera se aplicó, devuelve aquel resultado; si no, la aplica.
///
/// Sólo se reutiliza tras un resultado incierto. Con una respuesta clara (2xx o 4xx) se olvida, así
/// que pedir dos veces lo mismo a propósito (dos cafés) sigue siendo dos operaciones.
///
/// Un cuerpo puede llevar un id que el repositorio genera en cada llamada (el de la fila que
/// crea). Ese campo no cuenta para reconocer la petición (`volatiles`), y al reconocerla se envían
/// los bytes de la primera: el mismo id, el mismo hash del cuerpo para el DO.
#[derive(Default)]
struct EscriturasInciertas {
    por_huella: Mutex<HashMap<String, Incierta>>,
}

impl EscriturasInciertas {
    /// La clave y el cuerpo con los que salió esta misma petición, si su resultado sigue incierto.
    fn retomar(&self, huella: &str, ahora: Instant) -> Option<Incierta> {
        let mut m = self.por_huella.lock().unwrap_or_else(|e| e.into_inner());
        m.retain(|_, i| ahora.duration_since(i.desde) < VENTANA_INCIERTA);
        m.get(huella).cloned()
    }

    /// Anota el resultado de un envío: incierto se recuerda, claro se olvida.
    fn anotar(&self, huella: String, incierta: Option<Incierta>) {
        let mut m = self.por_huella.lock().unwrap_or_else(|e| e.into_inner());
        match incierta {
            Some(i) => {
                m.insert(huella, i);
            }
            None => {
                m.remove(&huella);
            }
        }
    }
}

/// Lo que identifica una escritura para `EscriturasInciertas`: método, ruta y cuerpo, sin los
/// campos `volatiles` del primer nivel.
fn huella(method: &Method, path: &str, cuerpo: &[u8], volatiles: &[&str]) -> String {
    let cuerpo = match serde_json::from_slice::<serde_json::Value>(cuerpo) {
        Ok(serde_json::Value::Object(mut o)) if !volatiles.is_empty() => {
            for campo in volatiles {
                o.remove(*campo);
            }
            serde_json::Value::Object(o).to_string()
        }
        _ => String::from_utf8_lossy(cuerpo).into_owned(),
    };
    format!("{} {path} {cuerpo}", method.as_str())
}

/// Transporte HTTP firmado contra `tpv-api`.
pub struct CloudClient {
    http: Client,
    base_url: String,
    pairing: PairingAdapter,
    /// Modo con el que se firman las peticiones ("handy" en dispositivos secundarios).
    mode: String,
    inciertas: EscriturasInciertas,
}

impl CloudClient {
    /// Construye el cliente. `app_data_dir` es la carpeta de datos del dispositivo (necesaria
    /// para que `PairingAdapter` localice la clave/identidad). No hace red.
    pub fn new(base_url: impl Into<String>, app_data_dir: PathBuf) -> AppResult<Self> {
        Self::con_http(base_url, app_data_dir, Self::http())
    }

    /// El cliente de reqwest de producción, todavía sin construir: sus cabeceras y su tiempo
    /// máximo. Lo comparte `de_pruebas`, que sólo le quita el proxy del sistema.
    fn http() -> reqwest::ClientBuilder {
        Client::builder()
            .default_headers(tpv_infra_licensing::cabeceras_version())
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
    }

    fn con_http(
        base_url: impl Into<String>,
        app_data_dir: PathBuf,
        http: reqwest::ClientBuilder,
    ) -> AppResult<Self> {
        let http = http
            .build()
            .map_err(|_| AppError::external("http_build_failed"))?;

        Ok(Self {
            http,
            base_url: base_url.into(),
            pairing: PairingAdapter::new(app_data_dir),
            mode: "handy".to_string(),
            inciertas: EscriturasInciertas::default(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    /// La petición lista para salir, con las cabeceras device-proof firmadas sobre su destino
    /// **exacto**: la ruta con la query ya puesta, que es lo que el worker verifica
    /// (`pathname + search`, RI-50).
    ///
    /// INC-20261030-003 — la query entra en la URL ANTES de firmar. Se firmaba la ruta y la query
    /// se añadía después con `RequestBuilder::query`, así que salía `/v1/cuentas/cierres?limite=20`
    /// con la firma de `/v1/cuentas/cierres`, y el worker rechazaba con `bad_device_signature`
    /// toda consulta de la Handy con parámetros: barra, Cuentas, Inventario, tareas, horarios,
    /// notificaciones, búsquedas y estadísticas.
    ///
    /// `firmar` recibe el método, el destino y el cuerpo, que son las piezas del mensaje que el
    /// worker vuelve a montar. Es un parámetro para que el test compruebe que lo firmado es lo
    /// que sale, sin tocar la identidad del equipo.
    ///
    /// SYNC-04 — `x-client-now`: el reloj lo pone el dispositivo EMISOR, no el servidor. El worker
    /// usa esta hora local para resolver a literal fijo los `datetime('now',…)` de las escrituras,
    /// de modo que la fila salga idéntica en nube, Main y Handy (replicación determinista). Si falta,
    /// el guard del DO **rechaza** el comando con `missing_client_now` en vez de escribir en UTC en
    /// silencio; sin esta cabecera, toda escritura del Handy cuyo SQL lleve `datetime('now')` fallaba
    /// (crear ticket, añadir línea, lotes, mesas, tareas, reservas…).
    ///
    /// Se fija aquí, en el ÚNICO punto por el que pasan todas las peticiones, y no en `write_body`:
    /// así ninguna ruta futura puede olvidarla — de hecho `delete_json` ya se saltaba `write_body`.
    /// Espejo de `tpv_server_post_json` (`tpv-infra-licensing`), que es el otro transporte y
    /// siempre la ha puesto.
    ///
    /// REV-03 — en un GET ya NO es inocua, que es lo que decía esta nota. Con ella, el worker
    /// resuelve el `'now','localtime'` de una LECTURA a la hora local de este equipo; sin ella lo
    /// resuelve Turso, que corre en UTC, y «hoy» pasa a ser el día del servidor: de madrugada, el
    /// de ayer. Quitarla de los GET no daría ningún error, sólo respuestas de otro día.
    ///
    /// `cuerpo` son los bytes que se envían (vacío en GET/DELETE): entran en la firma y se adjuntan
    /// **esos mismos** con `.body(...)`, nunca volviendo a serializar con `.json(...)` (FABLE-E).
    fn preparar(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        cuerpo: &[u8],
        idempotencia: Option<&str>,
        firmar: impl FnOnce(&str, &str, &[u8]) -> AppResult<ApiSignedHeaders>,
    ) -> AppResult<RequestBuilder> {
        // AUD-28: un texto fijo, como el resto de los mensajes de esta crate, y no el del error.
        let mut url = reqwest::Url::parse(&self.url(path))
            .map_err(|_| AppError::validation("La dirección del servidor no es válida."))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let destino = format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        );

        let h = firmar(method.as_str(), &destino, cuerpo)?;
        let client_now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let mut rb = self
            .http
            .request(method, url)
            .header("authorization", h.authorization)
            .header("x-device-ts", h.x_device_ts)
            .header("x-device-sig", h.x_device_sig)
            .header("x-client-now", client_now);

        if let Some(clave) = idempotencia {
            rb = rb.header("x-idempotency-key", clave);
        }
        if !cuerpo.is_empty() {
            rb = rb
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(cuerpo.to_vec());
        }
        Ok(rb)
    }

    /// GET firmado que deserializa la respuesta JSON en `T`.
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        self.enviar(Method::GET, path, b"", None, &[]).await
    }

    /// GET firmado con parámetros de query (se codifican en la URL y la firma los incluye).
    pub async fn get_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> AppResult<T> {
        self.enviar(Method::GET, path, b"", None, query).await
    }

    /// POST firmado de una **lectura** (AUD-27): lo que se busca viaja en el cuerpo y no en la
    /// query, porque la URL de cada petición se queda en los registros de Cloudflare y el cuerpo
    /// no. Ahí va todo lo que sea de una persona (nombre, teléfono, correo) o texto que escribe
    /// alguien; en la query sólo identificadores, fechas, filtros cerrados y paginación.
    ///
    /// Sale como un GET: por `enviar`, sin `X-Idempotency-Key` y sin pasar por
    /// `EscriturasInciertas` (no aplica nada: repetirla no duplica nada), y con `x-client-now`,
    /// que `preparar` pone en todas y que el worker usa también al leer.
    pub async fn post_lectura<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        let bytes = serde_json::to_vec(body).map_err(|e| cuerpo_no_serializable(&e))?;
        self.enviar(Method::POST, path, &bytes, None, &[]).await
    }

    /// POST firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn post_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::POST, path, body, &[]).await
    }

    /// POST que crea una fila. `id_generado` es el campo del id **si lo ha generado el repositorio
    /// en esta llamada**: ese campo no cuenta para reconocer el reintento de una escritura incierta
    /// (RI-64). Si el id venía dado, `None`: entonces sí distingue una fila de otra.
    ///
    /// Devuelve, con la respuesta, el id que salió de verdad: si esto era el reintento de una
    /// escritura incierta, es el del primer envío y no el recién generado.
    pub async fn post_json_creando<B, T>(
        &self,
        path: &str,
        body: &B,
        id_generado: Option<&str>,
    ) -> AppResult<(T, Option<String>)>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        let bytes = serde_json::to_vec(body)
            .map_err(|e| cuerpo_no_serializable(&e))?;
        let volatiles: Vec<&str> = id_generado.into_iter().collect();
        let (resp, enviado) = self.escribir(Method::POST, path, bytes, &volatiles).await?;
        let id = id_generado.and_then(|campo| {
            serde_json::from_slice::<serde_json::Value>(&enviado)
                .ok()?
                .get(campo)?
                .as_str()
                .map(str::to_string)
        });
        Ok((resp, id))
    }

    /// PUT firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn put_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::PUT, path, body, &[]).await
    }

    /// PATCH firmado (escritura): añade `X-Idempotency-Key`.
    pub async fn patch_json<B, T>(&self, path: &str, body: &B) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        self.write_body(Method::PATCH, path, body, &[]).await
    }

    /// DELETE firmado (escritura sin cuerpo): añade `X-Idempotency-Key`.
    pub async fn delete_json<T: DeserializeOwned>(&self, path: &str) -> AppResult<T> {
        Ok(self.escribir(Method::DELETE, path, Vec::new(), &[]).await?.0)
    }

    async fn write_body<B, T>(
        &self,
        method: Method,
        path: &str,
        body: &B,
        volatiles: &[&str],
    ) -> AppResult<T>
    where
        B: Serialize + ?Sized,
        T: DeserializeOwned,
    {
        // Se serializa UNA vez: esos bytes son los que se firman y los que se envian. Con
        // `.json(body)` reqwest volveria a serializar y cualquier diferencia de bytes tiraria la
        // firma abajo en el worker.
        let bytes = serde_json::to_vec(body)
            .map_err(|e| cuerpo_no_serializable(&e))?;

        Ok(self.escribir(method, path, bytes, volatiles).await?.0)
    }

    /// Una escritura con su clave de idempotencia: la de la misma petición si su resultado quedó
    /// incierto, o una nueva (RI-64, ver `EscriturasInciertas`). Devuelve también los bytes que
    /// salieron, que en un reintento reconocido son los del primer envío.
    async fn escribir<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        cuerpo: Vec<u8>,
        volatiles: &[&str],
    ) -> AppResult<(T, Vec<u8>)> {
        let huella = huella(&method, path, &cuerpo, volatiles);
        let (clave, cuerpo) = match self.inciertas.retomar(&huella, Instant::now()) {
            Some(previa) => (previa.clave, previa.cuerpo),
            None => (Uuid::now_v7().to_string(), cuerpo),
        };

        let res = self
            .con_reintentos(method, path, &cuerpo, Some(&clave), &[])
            .await;

        let incierto = match &res {
            Err(_) => true,
            Ok((status, _)) => *status >= 500,
        };
        self.inciertas.anotar(
            huella,
            incierto.then(|| Incierta {
                clave,
                cuerpo: cuerpo.clone(),
                desde: Instant::now(),
            }),
        );

        let (status, text) = res?;
        Ok((interpretar(status, &text)?, cuerpo))
    }

    async fn enviar<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        cuerpo: &[u8],
        idempotencia: Option<&str>,
        query: &[(&str, String)],
    ) -> AppResult<T> {
        let (status, text) = self
            .con_reintentos(method, path, cuerpo, idempotencia, query)
            .await?;
        interpretar(status, &text)
    }

    /// Manda la petición y, si la nube contesta 401 porque nuestro token ha caducado, la repite
    /// UNA vez con el token renovado (REV-02).
    ///
    /// Dos cosas hacen que repetir sea seguro incluso en una escritura:
    ///
    /// - **La clave de idempotencia es la misma** en los dos intentos. Generar otra convertiría un
    ///   reintento en una operación nueva para el Durable Object, que es justo lo que esa clave
    ///   existe para evitar.
    /// - **Un 401 por token caducado lo pone la autenticación del worker**, antes de que ningún
    ///   handler toque nada: no hay nada aplicado que repetir. Por eso la condición es la fecha del
    ///   token y no «ha dado 401» — ver `device::token_caducado`.
    async fn con_reintentos(
        &self,
        method: Method,
        path: &str,
        cuerpo: &[u8],
        idempotencia: Option<&str>,
        query: &[(&str, String)],
    ) -> AppResult<(u16, String)> {
        let (status, text) = self
            .una_vez(method.clone(), path, cuerpo, idempotencia, query)
            .await?;

        // PROD-04: rechazada por la hora de la firma. El rechazo ya ha traído la hora de la nube
        // (`tpv_infra_licensing::reloj`), así que se firma otra vez y se repite UNA. Es seguro en
        // una escritura por lo mismo que el reintento de abajo: la hora se comprueba en la
        // autenticación, antes de tocar nada, y la clave de idempotencia es la misma.
        let (status, text) = if reloj::es_rechazo_por_reloj(status, &text) {
            self.una_vez(method.clone(), path, cuerpo, idempotencia, query)
                .await?
        } else {
            (status, text)
        };

        let (status, text) = if status == 401
            && self.pairing.renovar_si_el_token_ha_caducado().await
        {
            self.una_vez(method, path, cuerpo, idempotencia, query)
                .await?
        } else {
            (status, text)
        };

        Ok((status, text))
    }

    /// Un intento: firma con el token que haya AHORA en el almacén de secretos y devuelve el par
    /// crudo `(status, cuerpo)`. Se firma dentro y no fuera porque la firma cubre el token, así que
    /// el segundo intento tiene que firmarse otra vez —con el nuevo— para valer de algo.
    async fn una_vez(
        &self,
        method: Method,
        path: &str,
        cuerpo: &[u8],
        idempotencia: Option<&str>,
        query: &[(&str, String)],
    ) -> AppResult<(u16, String)> {
        let rb = self.preparar(method, path, query, cuerpo, idempotencia, |metodo, destino, cuerpo| {
            self.pairing
                .tpv_server_signed_headers(&self.mode, metodo, destino, cuerpo)
        })?;

        mandar(rb).await
    }
}

#[cfg(test)]
impl CloudClient {
    /// El cliente de producción, con su tiempo máximo, pero sin el proxy del sistema: con
    /// `HTTP_PROXY` o `ALL_PROXY` puestos en la máquina, lo que va a 127.0.0.1 saldría hacia el
    /// proxy y los tests de red fallarían, o pasarían, por otro motivo.
    fn de_pruebas(base_url: impl Into<String>) -> Self {
        Self::con_http(base_url, std::env::temp_dir(), Self::http().no_proxy()).unwrap()
    }
}

/// Manda una petición ya firmada y devuelve el par crudo `(status, cuerpo)`. Está fuera de
/// `una_vez` para que el test del fallo de transporte pase por lo mismo que producción sin firmar
/// con la identidad del equipo.
async fn mandar(rb: RequestBuilder) -> AppResult<(u16, String)> {
    let resp = reloj::enviar(rb).await.map_err(fallo_de_transporte)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    Ok((status, text))
}

/// AUD-28 — la petición no ha llegado a tener respuesta: sin red, DNS, TLS, tiempo agotado.
///
/// El detalle que va entre paréntesis es la CLASE del fallo, de una lista cerrada, y no el texto de
/// reqwest. Ese texto lleva la URL entera, y el mensaje es `external` y sube a Axiom: lo que viaje en
/// la URL (desde AUD-27 sólo identificadores, fechas y filtros; antes, el teléfono y el correo de una
/// búsqueda) no tiene por qué salir del equipo con él. `reloj::enviar` ya le quita la URL al error,
/// y aquí además no se escribe: la clase (con el comando, la pantalla y lo que tardó, que van en el
/// evento) es lo que hace falta para diagnosticar un corte, y no puede llevar un dato.
fn fallo_de_transporte(e: reqwest::Error) -> AppError {
    let clase = if e.is_timeout() {
        "tiempo de espera agotado"
    } else if e.is_connect() {
        "no se pudo abrir la conexión"
    } else {
        "la petición no llegó a completarse"
    };
    AppError::sin_conexion(clase)
}

/// AUD-28 — una respuesta de la nube que no encaja en el tipo que se esperaba.
///
/// El mensaje dice qué se esperaba y dónde se torció (el tipo, la clase del error de serde, la línea
/// y la columna), nunca qué había: ni el cuerpo, que son datos del negocio (nombres, notas,
/// teléfonos), ni el texto de serde, que cita el valor que no encaja (`invalid type: integer
/// 612345678`). Es `external` y sube a Axiom, donde el filtro de datos personales no reconoce un
/// nombre ni una nota; con el tipo y la posición basta para dar con el campo.
fn no_encaja<T>(que: &str, e: &serde_json::Error) -> AppError {
    AppError::external(format!(
        "{que}: la respuesta de la nube no encaja en {} ({:?}, línea {}, columna {})",
        std::any::type_name::<T>(),
        e.classify(),
        e.line(),
        e.column()
    ))
}

/// Un trozo de una respuesta ya leída (`resp["lineas"]`), en su tipo. Si no encaja, el error es el
/// de `no_encaja`, con `que` por delante para saber qué trozo era.
pub(crate) fn leer_campo<T: DeserializeOwned>(que: &str, valor: &serde_json::Value) -> AppResult<T> {
    T::deserialize(valor).map_err(|e| no_encaja::<T>(que, &e))
}

/// AUD-28 — el cuerpo de una escritura que no se ha podido serializar. Sólo la clase del error: su
/// texto lo escribe el `Serialize` de cada tipo, y lo que se serializa son datos del negocio.
fn cuerpo_no_serializable(e: &serde_json::Error) -> AppError {
    AppError::external(format!("bad_json_body: {:?}", e.classify()))
}

/// La respuesta de la nube, ya con su desenlace: el cuerpo deserializado o el error que trae.
fn interpretar<T: DeserializeOwned>(status: u16, text: &str) -> AppResult<T> {
    if !(200..300).contains(&status) {
        // ARCH-05: el código lo resuelve `from_api_body`, que prefiere el `code` que
        // manda el worker (él tiene el status y el contexto de la ruta) y sólo traduce el
        // string de negocio si no viene.
        return Err(AppError::from_api_body(status, text));
    }

    // AUD-28: sin el cuerpo y sin el texto de serde (ver `no_encaja`).
    serde_json::from_str::<T>(text).map_err(|e| no_encaja::<T>("bad_json", &e))
}

#[cfg(test)]
mod tests_firma_del_destino {
    //! INC-20261030-003: lo que se firma es lo que sale. Un servidor local recibe la petición de
    //! verdad, saca de ella lo mismo que el worker al verificar la firma (método, `pathname +
    //! search` y los bytes del cuerpo) y se compara con lo que `preparar` le pasó a `firmar`.

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Las piezas del mensaje device-proof que dependen de la petición (la hora y el token van en
    /// cabeceras y no se tocan por el camino).
    #[derive(Debug, PartialEq)]
    struct Piezas {
        metodo: String,
        destino: String,
        cuerpo: Vec<u8>,
    }

    /// Atiende UNA petición: devuelve sus piezas, vistas como las ve el worker, y la cabecera de
    /// firma con la que llegó.
    async fn recibir(listener: TcpListener) -> (Piezas, Option<String>) {
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

        let cabeceras = String::from_utf8(leido[..fin_cabeceras].to_vec()).unwrap();
        let mut lineas = cabeceras.split("\r\n");
        let mut primera = lineas.next().unwrap().split(' ');
        let metodo = primera.next().unwrap().to_string();
        let objetivo = primera.next().unwrap().to_string();
        let mut largo = 0;
        let mut firma = None;
        for linea in lineas {
            if let Some((nombre, valor)) = linea.split_once(':') {
                match nombre.to_ascii_lowercase().as_str() {
                    "content-length" => largo = valor.trim().parse().unwrap(),
                    "x-device-sig" => firma = Some(valor.trim().to_string()),
                    _ => {}
                }
            }
        }
        while leido.len() < fin_cabeceras + largo {
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0, "la conexión se cerró a mitad del cuerpo");
            leido.extend_from_slice(&buf[..n]);
        }
        let cuerpo = leido[fin_cabeceras..fin_cabeceras + largo].to_vec();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
            .await
            .unwrap();

        // Como el worker: `new URL(req.url)` y `pathname + search`. `Url` sigue el mismo estándar
        // (WHATWG), así que normaliza igual.
        let url = reqwest::Url::parse(&format!("http://worker{objetivo}")).unwrap();
        let destino = format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        );
        (Piezas { metodo, destino, cuerpo }, firma)
    }

    /// Prepara y manda la petición; devuelve lo que se firmó y lo que recibió el servidor.
    async fn firmado_y_recibido(
        method: Method,
        path: &str,
        query: &[(&str, String)],
        cuerpo: &[u8],
    ) -> (Piezas, Piezas) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let servidor = tokio::spawn(recibir(listener));

        let client = CloudClient::de_pruebas(base);
        let mut firmado = None;
        let rb = client
            .preparar(method, path, query, cuerpo, None, |metodo, destino, cuerpo| {
                firmado = Some(Piezas {
                    metodo: metodo.to_string(),
                    destino: destino.to_string(),
                    cuerpo: cuerpo.to_vec(),
                });
                Ok(ApiSignedHeaders {
                    authorization: "Bearer token".into(),
                    x_device_ts: "1".into(),
                    x_device_sig: "la-firma".into(),
                })
            })
            .unwrap();
        rb.send().await.unwrap();

        let (recibido, firma) = servidor.await.unwrap();
        assert_eq!(firma.as_deref(), Some("la-firma"), "la firma va en la petición que sale");
        (firmado.expect("se firmó"), recibido)
    }

    #[tokio::test]
    async fn la_query_de_una_consulta_entra_en_la_firma() {
        let query = [("limite", "20".to_string())];
        let (firmado, recibido) =
            firmado_y_recibido(Method::GET, "/v1/cuentas/cierres", &query, b"").await;
        assert_eq!(recibido.destino, "/v1/cuentas/cierres?limite=20");
        assert_eq!(firmado, recibido);
    }

    #[tokio::test]
    async fn lo_que_se_escapa_se_firma_escapado() {
        // Un valor con tilde, espacios y un `&` que no separa parámetros. Ninguna consulta de la
        // app lleva ya texto así en la query (AUD-27), pero lo que llegue se firma como sale.
        let query = [("valor", "café & tostá".to_string()), ("limit", "20".to_string())];
        let (firmado, recibido) =
            firmado_y_recibido(Method::GET, "/v1/venta-rapida/comandas", &query, b"").await;
        assert_eq!(firmado, recibido);
    }

    #[tokio::test]
    async fn la_query_escrita_en_la_ruta_tambien_se_firma() {
        let (firmado, recibido) =
            firmado_y_recibido(Method::GET, "/v1/clientes/overview?ranking=gasto", &[], b"").await;
        assert_eq!(recibido.destino, "/v1/clientes/overview?ranking=gasto");
        assert_eq!(firmado, recibido);
    }

    #[tokio::test]
    async fn una_escritura_firma_sus_bytes_sin_query() {
        let cuerpo = br#"{"id_producto":"p","cantidad":1}"#;
        let (firmado, recibido) =
            firmado_y_recibido(Method::POST, "/v1/venta-rapida/lineas", &[], cuerpo).await;
        assert_eq!(recibido.destino, "/v1/venta-rapida/lineas");
        assert_eq!(firmado, recibido);
    }
}

#[cfg(test)]
mod tests_lectura_por_post {
    //! AUD-27: una lectura que lleva datos de una persona o texto libre sale por POST, con ellos
    //! en el cuerpo. Un servidor local recibe la petición de verdad (`preparar` + reqwest, con
    //! una firma ficticia: no toca la identidad del equipo) y se mira lo que llega.

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// La petición tal como llega: la línea de petición, las cabeceras (en minúsculas) y el cuerpo.
    struct Recibida {
        linea: String,
        cabeceras: HashMap<String, String>,
        cuerpo: Vec<u8>,
    }

    async fn recibir(listener: TcpListener) -> Recibida {
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
        let cabecera = String::from_utf8(leido[..fin_cabeceras].to_vec()).unwrap();
        let mut lineas = cabecera.split("\r\n");
        let linea = lineas.next().unwrap().to_string();
        let cabeceras: HashMap<String, String> = lineas
            .filter_map(|l| l.split_once(':'))
            .map(|(nombre, valor)| (nombre.to_ascii_lowercase(), valor.trim().to_string()))
            .collect();
        let largo: usize = cabeceras
            .get("content-length")
            .map(|v| v.parse().unwrap())
            .unwrap_or(0);
        while leido.len() < fin_cabeceras + largo {
            let n = socket.read(&mut buf).await.unwrap();
            assert!(n > 0, "la conexión se cerró a mitad del cuerpo");
            leido.extend_from_slice(&buf[..n]);
        }
        let cuerpo = leido[fin_cabeceras..fin_cabeceras + largo].to_vec();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnull")
            .await
            .unwrap();
        Recibida { linea, cabeceras, cuerpo }
    }

    /// Lo que sale con los argumentos que `post_lectura` le da a `enviar`: POST, sin query y sin
    /// clave de idempotencia.
    async fn lectura_por_post(path: &str, cuerpo: &serde_json::Value) -> Recibida {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let servidor = tokio::spawn(recibir(listener));

        let client = CloudClient::de_pruebas(base);
        let bytes = serde_json::to_vec(cuerpo).unwrap();
        let rb = client
            .preparar(Method::POST, path, &[], &bytes, None, |_, _, _| {
                Ok(ApiSignedHeaders {
                    authorization: "Bearer ficticio".into(),
                    x_device_ts: "1".into(),
                    x_device_sig: "ficticia".into(),
                })
            })
            .unwrap();
        rb.send().await.unwrap();
        servidor.await.unwrap()
    }

    #[tokio::test]
    async fn el_telefono_y_el_correo_van_en_el_cuerpo_y_no_en_la_url() {
        let cuerpo = serde_json::json!({ "telefono": "+34 600 000 000", "email": "prueba@ejemplo.invalid" });
        let r = lectura_por_post("/v1/reservas/buscar-cliente", &cuerpo).await;

        assert_eq!(r.linea, "POST /v1/reservas/buscar-cliente HTTP/1.1");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&r.cuerpo).unwrap(), cuerpo);
        assert_eq!(r.cabeceras.get("content-type").map(String::as_str), Some("application/json"));
    }

    #[tokio::test]
    async fn lo_que_se_busca_en_cuentas_va_en_el_cuerpo_y_no_en_la_url() {
        let cuerpo = serde_json::json!({ "del": "2026-11-08", "al": "2026-11-08", "q": "María José Fernández López" });
        let r = lectura_por_post("/v1/cuentas/resumen", &cuerpo).await;

        assert_eq!(r.linea, "POST /v1/cuentas/resumen HTTP/1.1");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&r.cuerpo).unwrap(), cuerpo);
    }

    #[tokio::test]
    async fn sale_como_una_lectura_con_la_hora_y_sin_clave_de_idempotencia() {
        let r = lectura_por_post("/v1/cuentas/entradas", &serde_json::json!({ "q": "Cliente Ficticio" })).await;

        // La hora local de quien pregunta, como en un GET (REV-03): «hoy» es el de la Handy.
        assert!(r.cabeceras.contains_key("x-client-now"), "falta x-client-now");
        assert!(
            !r.cabeceras.contains_key("x-idempotency-key"),
            "una lectura no lleva clave de idempotencia"
        );
    }

    /// `post_lectura` no es una escritura: va por `enviar`, como `get_query`, y no por `escribir`,
    /// que es quien pone la clave y recuerda las inciertas (RI-64). No se puede llamar aquí de
    /// verdad —firmaría con la identidad del equipo—, así que se lee su cuerpo.
    #[test]
    fn post_lectura_no_pasa_por_el_camino_de_las_escrituras() {
        // Con `core.autocrlf` el fuente llega con CRLF: se mira siempre con LF.
        let fuente = include_str!("client.rs").replace("\r\n", "\n");
        let desde = fuente
            .find("pub async fn post_lectura")
            .expect("no encuentro post_lectura");
        let resto = &fuente[desde..];
        let cuerpo = &resto[..resto.find("\n    }\n").expect("no encuentro el final de post_lectura")];

        assert!(
            cuerpo.contains("self.enviar(Method::POST, path, &bytes, None, &[])"),
            "post_lectura tiene que salir por `enviar`, sin clave y sin query:\n{cuerpo}"
        );
        for camino in ["escribir", "write_body", "inciertas"] {
            assert!(!cuerpo.contains(camino), "post_lectura no puede tocar `{camino}`:\n{cuerpo}");
        }
    }
}

#[cfg(test)]
mod tests_inciertas {
    //! RI-64: qué petición se reconoce como el reintento de una escritura incierta.

    use super::*;

    fn incierta(clave: &str, cuerpo: &str, desde: Instant) -> Incierta {
        Incierta {
            clave: clave.into(),
            cuerpo: cuerpo.as_bytes().to_vec(),
            desde,
        }
    }

    #[test]
    fn el_id_que_genera_el_repositorio_no_cuenta_para_reconocerla() {
        let a = huella(&Method::POST, "/v1/venta-rapida/lineas", br#"{"id_detalle":"a","id_producto":"p"}"#, &["id_detalle"]);
        let b = huella(&Method::POST, "/v1/venta-rapida/lineas", br#"{"id_detalle":"b","id_producto":"p"}"#, &["id_detalle"]);
        assert_eq!(a, b);
    }

    #[test]
    fn otro_cuerpo_otra_ruta_u_otro_metodo_son_otra_peticion() {
        let base = huella(&Method::POST, "/v1/mesas/lineas", br#"{"id_producto":"p"}"#, &[]);
        assert_ne!(base, huella(&Method::POST, "/v1/mesas/lineas", br#"{"id_producto":"q"}"#, &[]));
        assert_ne!(base, huella(&Method::POST, "/v1/reservas", br#"{"id_producto":"p"}"#, &[]));
        assert_ne!(base, huella(&Method::PUT, "/v1/mesas/lineas", br#"{"id_producto":"p"}"#, &[]));
    }

    #[test]
    fn una_incierta_se_retoma_con_su_clave_y_sus_bytes() {
        let r = EscriturasInciertas::default();
        let ahora = Instant::now();
        r.anotar("h".into(), Some(incierta("k1", r#"{"id_detalle":"a"}"#, ahora)));

        let previa = r.retomar("h", ahora).expect("sigue incierta");
        assert_eq!(previa.clave, "k1");
        assert_eq!(previa.cuerpo, br#"{"id_detalle":"a"}"#);
    }

    #[test]
    fn una_respuesta_clara_la_olvida() {
        let r = EscriturasInciertas::default();
        let ahora = Instant::now();
        r.anotar("h".into(), Some(incierta("k1", "{}", ahora)));
        r.anotar("h".into(), None);
        assert!(r.retomar("h", ahora).is_none(), "pedir lo mismo otra vez es otra operación");
    }

    #[test]
    fn pasada_la_ventana_ya_no_se_retoma() {
        let r = EscriturasInciertas::default();
        let antes = Instant::now();
        r.anotar("h".into(), Some(incierta("k1", "{}", antes)));
        assert!(r.retomar("h", antes + VENTANA_INCIERTA).is_none());
    }
}

#[cfg(test)]
mod tests_mensaje_sin_datos {
    //! AUD-28: el mensaje de un error de la nube no se compone con datos. Lo que falla aquí es
    //! `external` y sube a Axiom, y el filtro de datos personales no reconoce un teléfono ni un
    //! correo codificados en una URL, ni un nombre, ni una nota. Datos ficticios.

    use super::*;
    use tokio::net::{TcpListener, TcpSocket};
    use tpv_contracts::errors::{AppErrorDto, ErrorCode};
    use tpv_contracts::mesas::MesaLineaComandaRow;
    use tpv_contracts::reservas::ReservaDto;
    use tpv_domain::dinero::Dinero;

    const TELEFONO: &str = "+34 612 345 678";
    const EMAIL: &str = "ana.prueba@example.com";
    /// Como salen en la URL: el espacio pasa a `+`, el `+` a `%2B` y la arroba a `%40`.
    const QUERY: &str = "telefono=%2B34+612+345+678&email=ana.prueba%40example.com";
    /// La query, sus piezas y el resto de la URL: nada de eso va en el mensaje.
    const DE_LA_URL: &[&str] = &[
        "telefono", "email", "612", "345", "678", "%2B34", "+34", "%40", "ana.prueba", "example.com",
        "buscar-cliente", "127.0.0.1", "http",
    ];
    /// Lo que se le dice a quien está delante: qué pasa y qué puede hacer.
    const FRASE: &str = "No se ha podido conectar con el servidor. Comprueba la conexión a internet.";

    const NOMBRE: &str = "Ana Prueba";
    const NOTA: &str = "alergia al marisco";

    fn firma_simulada(_: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
        Ok(ApiSignedHeaders {
            authorization: "Bearer token".into(),
            x_device_ts: "1".into(),
            x_device_sig: "la-firma".into(),
        })
    }

    /// Una petición con datos de un cliente en la query, como la que hacía la búsqueda del cliente de
    /// una reserva antes de AUD-27: el peor caso de lo que puede llevar una URL. Firmada sin tocar la
    /// identidad del equipo, contra `base`, con el cliente de producción (su tiempo máximo) y sin
    /// proxy.
    fn con_datos_en_la_url(base: String) -> RequestBuilder {
        let client = CloudClient::de_pruebas(base);
        let query = [("telefono", TELEFONO.to_string()), ("email", EMAIL.to_string())];
        let rb = client
            .preparar(Method::GET, "/v1/reservas/buscar-cliente", &query, b"", None, firma_simulada)
            .unwrap();

        // El control: la URL que sale sí lleva los datos, codificados.
        let peticion = rb.try_clone().unwrap().build().unwrap();
        assert_eq!(peticion.url().query(), Some(QUERY));
        rb
    }

    /// Lo que cruza a la pantalla, y de ahí a la telemetría, cuando la petición no tiene respuesta.
    /// Pasa por `mandar`, lo mismo que `una_vez`.
    async fn fallo(rb: RequestBuilder) -> AppErrorDto {
        let err = mandar(rb).await.expect_err("la petición tenía que fallar");
        AppErrorDto::from(err)
    }

    /// Dice qué pasa y qué hacer, en español, y entre paréntesis sólo la clase del fallo.
    fn es_la_frase_con_su_clase(dto: &AppErrorDto, clase: &str) {
        assert_eq!(dto.code, ErrorCode::External);
        assert_eq!(dto.message, format!("{FRASE} ({clase})"));
        for dato in DE_LA_URL {
            assert!(!dto.message.contains(dato), "{dato}: {}", dto.message);
        }
    }

    /// Sin red: un puerto en el que no escucha nadie. Está enlazado por el test y sin `listen`, así
    /// que el sistema rechaza la conexión y nadie más puede ocuparlo mientras tanto.
    #[tokio::test]
    async fn sin_conexion_no_lleva_la_url() {
        let reservado = TcpSocket::new_v4().unwrap();
        reservado.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let base = format!("http://{}", reservado.local_addr().unwrap());

        let dto = fallo(con_datos_en_la_url(base)).await;
        es_la_frase_con_su_clase(&dto, "no se pudo abrir la conexión");
        drop(reservado);
    }

    /// La red se queda colgada: el servidor acepta y no contesta. Con el reloj de tokio en pausa, el
    /// tiempo máximo del propio `CloudClient` vence sin esperarlo: el test ni tarda ni depende de lo
    /// rápida que vaya la máquina.
    #[tokio::test(start_paused = true)]
    async fn el_tiempo_agotado_tampoco() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let servidor = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
            drop(socket);
        });

        let inicio = tokio::time::Instant::now();
        let dto = fallo(con_datos_en_la_url(base)).await;
        es_la_frase_con_su_clase(&dto, "tiempo de espera agotado");
        assert!(inicio.elapsed() >= Duration::from_secs(HTTP_TIMEOUT_SECS), "venció el tiempo del cliente");
        servidor.abort();
    }

    /// Una reserva como la lee la Handy, con `id_mesa` y `telefono_cliente` a elegir.
    fn reservas(id_mesa: &str, telefono_cliente: &str) -> String {
        format!(
            r#"[{{"id_reserva":"r1","id_mesa":{id_mesa},"dia_ymd":"2026-11-08","hora":"21:00","turno":"CENA","comensales":2,"duracion_min":null,"nota":"{NOTA}","estado":"PROXIMA","origen":"TPV","id_cliente":"c1","nombre_cliente":"{NOMBRE}","telefono_cliente":{telefono_cliente},"email_cliente":"{EMAIL}","id_zona":"","numero_mesa":"","capacidad":0,"nombre_zona":""}}]"#
        )
    }

    fn sin_datos_del_cliente(mensaje: &str) {
        for dato in [NOMBRE, "Ana", "Prueba", NOTA, "marisco", "612", EMAIL, "example.com", "body"] {
            assert!(!mensaje.contains(dato), "{dato}: {mensaje}");
        }
    }

    /// Un 2xx que no encaja en el DTO: un `id_mesa` nulo, como el que ya tumbó el calendario de la
    /// Handy. El mensaje dice qué se esperaba y dónde se torció, no qué había.
    #[test]
    fn un_2xx_que_no_encaja_no_lleva_el_cuerpo() {
        let cuerpo = reservas("null", r#""612 345 678""#);
        // El control: con un `id_mesa` de verdad, ese cuerpo se lee.
        let buenas = interpretar::<Vec<ReservaDto>>(200, &reservas(r#""m1""#, r#""612 345 678""#)).unwrap();
        assert_eq!(buenas[0].nombre_cliente, NOMBRE);

        let err = interpretar::<Vec<ReservaDto>>(200, &cuerpo).expect_err("no encaja en el DTO");
        let dto = AppErrorDto::from(err);
        assert_eq!(dto.code, ErrorCode::External);
        sin_datos_del_cliente(&dto.message);
        assert!(dto.message.starts_with("bad_json: la respuesta de la nube no encaja en "), "{}", dto.message);
        assert!(dto.message.contains("ReservaDto"), "{}", dto.message);
        assert!(dto.message.ends_with("(Data, línea 1, columna 34)"), "{}", dto.message);
    }

    /// Quitar el cuerpo no basta: el texto de serde cita el valor que no encaja cuando es un texto o
    /// un número donde se esperaba otra cosa.
    #[test]
    fn ni_el_valor_que_cita_serde() {
        let cuerpo = reservas(r#""m1""#, "612345678");
        // El control: el texto de serde sí lleva el teléfono.
        let de_serde = serde_json::from_str::<Vec<ReservaDto>>(&cuerpo).unwrap_err().to_string();
        assert!(de_serde.contains("612345678"), "{de_serde}");

        let err = interpretar::<Vec<ReservaDto>>(200, &cuerpo).expect_err("no encaja en el DTO");
        let dto = AppErrorDto::from(err);
        assert_eq!(dto.code, ErrorCode::External);
        sin_datos_del_cliente(&dto.message);
        assert!(dto.message.contains("ReservaDto") && dto.message.contains("(Data, línea 1, columna "), "{}", dto.message);
    }

    /// Lo mismo en los trozos de una respuesta que se leen aparte: las líneas de una mesa y el
    /// precio de una línea de barra.
    #[test]
    fn un_trozo_que_no_encaja_tampoco_cita_su_valor() {
        let resp = serde_json::json!({
            "lineas": [{ "ID_Detalle": "d1", "ID_Comanda": "c1", "ID_Producto": "p1", "Cantidad": NOTA }],
            "precio_unitario": NOMBRE,
        });
        // El control: el texto de serde sí lleva lo que había.
        let de_serde = serde_json::from_value::<Dinero>(resp["precio_unitario"].clone()).unwrap_err().to_string();
        assert!(de_serde.contains(NOMBRE), "{de_serde}");

        let lineas = leer_campo::<Vec<MesaLineaComandaRow>>("bad_lineas", &resp["lineas"]).expect_err("no encaja");
        let precio = leer_campo::<Dinero>("bad_precio_unitario", &resp["precio_unitario"]).expect_err("no encaja");
        for (err, que, tipo) in [(lineas, "bad_lineas: ", "MesaLineaComandaRow"), (precio, "bad_precio_unitario: ", "Dinero")] {
            let dto = AppErrorDto::from(err);
            assert_eq!(dto.code, ErrorCode::External);
            sin_datos_del_cliente(&dto.message);
            assert!(dto.message.starts_with(que) && dto.message.contains(tipo), "{}", dto.message);
        }

        // Y lo que sí encaja se lee.
        assert_eq!(leer_campo::<Dinero>("bad_precio_unitario", &serde_json::json!(250)).unwrap(), Dinero::de_centimos(250));
    }

    /// Un `Serialize` que cuenta lo que no pudo serializar, como puede hacerlo el de cualquier tipo.
    struct Indiscreto;
    impl Serialize for Indiscreto {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom(format!("no vale: {NOMBRE}, {NOTA}")))
        }
    }

    #[test]
    fn un_cuerpo_que_no_se_serializa_no_cita_lo_que_llevaba() {
        let e = serde_json::to_vec(&Indiscreto).unwrap_err();
        assert!(e.to_string().contains(NOMBRE), "{e}");

        let dto = AppErrorDto::from(cuerpo_no_serializable(&e));
        assert_eq!(dto.code, ErrorCode::External);
        assert_eq!(dto.message, "bad_json_body: Data");
    }
}

#[cfg(test)]
mod tests_ningun_mensaje_lleva_el_error_ni_el_cuerpo {
    //! AUD-28, el guardián. Lee el fuente de esta crate y avisa si un mensaje se compone con el
    //! error de reqwest o de serde, o con el cuerpo de una petición o de una respuesta, y si una
    //! petición sale sin pasar por `reloj::enviar`, que es quien le quita la URL al error. Esos
    //! mensajes salen del equipo (Axiom).
    //!
    //! **La protección son los tests de comportamiento** (`tests_mensaje_sin_datos`), que miran el
    //! mensaje que sale de verdad. Esto es un aviso barato para quien escribe, no un analizador: mira
    //! lo que se escribe a la vista en un mensaje —los huecos de un texto y los argumentos de
    //! `format!`, de los avisos de `tracing` y de los constructores de `AppError`— y no sigue un
    //! valor. No ve un error guardado antes en una variable con otro nombre, ni el que formatea una
    //! función aparte, ni otra forma de componer un texto. Si salta, lo que hay que revisar es el
    //! mensaje: la clase del fallo (`fallo_de_transporte`) o el tipo y la posición (`no_encaja`,
    //! `leer_campo`).
    //!
    //! Lo de los tests no sale del equipo y no se mira: los módulos `#[cfg(test)] mod … { … }` y los
    //! ficheros que se declaran enteros como tests (`#[cfg(test)] mod x;` → `x.rs`).

    use std::path::{Path, PathBuf};

    /// Con qué nombres se escribe aquí un error. De un error sólo se pregunta lo de `PREGUNTAS`.
    const ERRORES: &[&str] = &["e", "err", "error"];
    const PREGUNTAS: &[&str] = &["classify", "line", "column"];
    /// Y con cuáles el cuerpo de una petición o de una respuesta, y la URL.
    const CUERPOS: &[&str] = &["text", "texto", "body", "cuerpo", "resp", "respuesta", "url"];

    /// Con qué se compone aquí un mensaje: lo que se mira son sus argumentos.
    const COMPONEN: &[&str] = &[
        "format!(", "write!(", "writeln!(", "panic!(", "trace!(", "debug!(", "info!(", "warn!(", "error!(",
        "AppError::validation(", "AppError::not_found(", "AppError::conflict(", "AppError::repository(",
        "AppError::external(", "AppError::internal(", "AppError::sin_conexion(", "AppError::coded(",
    ];

    /// Lo que salta y no es un mensaje.
    const NO_SON_MENSAJES: &[(&str, &str)] = &[
        // La huella de una escritura incierta (RI-64): no sale de `EscriturasInciertas`.
        ("client.rs", "«{} {path} {cuerpo}»"),
    ];

    /// La marca que deja en el código cada texto entre comillas.
    const TEXTO: char = '§';

    /// Un fuente de Rust troceado: su código, sin comentarios y con `§` donde iba cada texto entre
    /// comillas, y esos textos, en orden.
    #[derive(Default)]
    struct Fuente {
        codigo: String,
        textos: Vec<String>,
    }

    fn trocear(fuente: &str) -> Fuente {
        let c: Vec<char> = fuente.chars().collect();
        let mut f = Fuente::default();
        let mut i = 0;
        while i < c.len() {
            match c[i] {
                '/' if c.get(i + 1) == Some(&'/') => {
                    while i < c.len() && c[i] != '\n' {
                        i += 1;
                    }
                }
                '/' if c.get(i + 1) == Some(&'*') => {
                    i += 2;
                    while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                        i += 1;
                    }
                    i += 2;
                }
                // Un carácter (`'"'`, `'\''`) no abre un texto; una vida (`'a`) tampoco.
                '\'' if c.get(i + 1) == Some(&'\\') => {
                    i += 3;
                    while i < c.len() && c[i] != '\'' {
                        i += 1;
                    }
                    i += 1;
                }
                '\'' if c.get(i + 2) == Some(&'\'') => i += 3,
                // Un texto crudo: `r"…"`, `r#"…"#`.
                'r' if matches!(c.get(i + 1), Some('"' | '#')) => {
                    let mut j = i + 1;
                    while c.get(j) == Some(&'#') {
                        j += 1;
                    }
                    let almohadillas = j - i - 1;
                    if c.get(j) != Some(&'"') {
                        f.codigo.push(c[i]);
                        i += 1;
                        continue;
                    }
                    let inicio = j + 1;
                    let mut fin = inicio;
                    while fin < c.len()
                        && !(c[fin] == '"' && (1..=almohadillas).all(|k| c.get(fin + k) == Some(&'#')))
                    {
                        fin += 1;
                    }
                    f.textos.push(c[inicio..fin].iter().collect());
                    f.codigo.push(TEXTO);
                    i = fin + 1 + almohadillas;
                }
                '"' => {
                    let inicio = i + 1;
                    let mut fin = inicio;
                    while fin < c.len() && c[fin] != '"' {
                        fin += if c[fin] == '\\' { 2 } else { 1 };
                    }
                    let fin = fin.min(c.len());
                    f.textos.push(c[inicio..fin].iter().collect());
                    f.codigo.push(TEXTO);
                    i = fin + 1;
                }
                otro => {
                    f.codigo.push(otro);
                    i += 1;
                }
            }
        }
        f
    }

    /// Lo que no es de tests: sin los módulos `#[cfg(test)] mod … { … }`, estén donde estén.
    fn produccion(f: Fuente) -> Fuente {
        const MARCA: &str = "#[cfg(test)]";
        let mut textos = f.textos.into_iter();
        let mut fuera = Fuente::default();
        // Un tramo de código se conserva o se tira con los textos que lleva dentro.
        let mut pasar = |tramo: &str, conservar: bool| {
            let suyos: Vec<String> = textos.by_ref().take(tramo.matches(TEXTO).count()).collect();
            if conservar {
                fuera.codigo.push_str(tramo);
                fuera.textos.extend(suyos);
            }
        };

        let mut resto = f.codigo.as_str();
        while let Some(i) = resto.find(MARCA) {
            let tras = &resto[i + MARCA.len()..];
            let es_modulo = ["mod ", "pub mod ", "pub(crate) mod "].iter().any(|m| tras.trim_start().starts_with(m));
            if es_modulo {
                pasar(&resto[..i], true);
                let fin = fin_del_modulo(tras);
                pasar(&tras[..fin], false);
                resto = &tras[fin..];
            } else {
                // Sólo condiciona un `use` o una función: lo que sigue es producción.
                pasar(&resto[..i + MARCA.len()], true);
                resto = tras;
            }
        }
        pasar(resto, true);
        fuera
    }

    /// Cuánto ocupa el módulo que empieza aquí: hasta su `;` o hasta la llave que cierra la suya.
    fn fin_del_modulo(codigo: &str) -> usize {
        let mut hondo = 0usize;
        for (i, c) in codigo.char_indices() {
            match c {
                ';' if hondo == 0 => return i + 1,
                '{' => hondo += 1,
                '}' => {
                    hondo = hondo.saturating_sub(1);
                    if hondo == 0 {
                        return i + 1;
                    }
                }
                _ => {}
            }
        }
        codigo.len()
    }

    /// Los nombres de los huecos de un texto de formato: `{e}`, `{e:?}`. `{{` no abre ninguno.
    fn huecos(texto: &str) -> Vec<&str> {
        let mut nombres = Vec::new();
        let mut resto = texto;
        while let Some(i) = resto.find('{') {
            resto = &resto[i + 1..];
            if let Some(tras) = resto.strip_prefix('{') {
                resto = tras;
                continue;
            }
            let fin = resto.find('}').unwrap_or(resto.len());
            nombres.push(resto[..fin].split(':').next().unwrap_or_default().trim());
            resto = &resto[fin..];
        }
        nombres
    }

    /// Los argumentos de una llamada, desde detrás de su paréntesis hasta el que la cierra.
    fn argumentos(codigo: &str) -> &str {
        let mut hondo = 1usize;
        for (i, c) in codigo.char_indices() {
            match c {
                '(' => hondo += 1,
                ')' => {
                    hondo -= 1;
                    if hondo == 0 {
                        return &codigo[..i];
                    }
                }
                _ => {}
            }
        }
        codigo
    }

    fn es_de_nombre(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    /// El error o el cuerpo entre los argumentos de un mensaje: `e`, `&text`, `%err`,
    /// `e.to_string()`. De un error valen sus `PREGUNTAS` (`e.classify()`); del cuerpo o de la URL,
    /// lo que se saque de ellos (`url.path()`), pero no enteros.
    fn vetado_en(argumentos: &str) -> Option<String> {
        let c: Vec<char> = argumentos.chars().collect();
        let mut i = 0;
        while i < c.len() {
            if !es_de_nombre(c[i]) {
                i += 1;
                continue;
            }
            let inicio = i;
            while i < c.len() && es_de_nombre(c[i]) {
                i += 1;
            }
            let nombre: String = c[inicio..i].iter().collect();
            let antes = c[..inicio].iter().rev().find(|x| !x.is_whitespace()).copied();
            let mut j = i;
            while j < c.len() && c[j].is_whitespace() {
                j += 1;
            }
            let (despues, siguiente) = (c.get(j).copied(), c.get(j + 1).copied());

            // Un campo o un método (`x.error`), una ruta (`a::e`), el parámetro de un cierre (`|e|`),
            // una llamada (`text(…)`) o el nombre de un argumento (`error = …`): no es el valor.
            let no_es_el_valor = matches!(antes, Some('.' | ':' | '|'))
                || matches!(despues, Some('(' | '!' | ':' | '|'))
                || (despues == Some('=') && siguiente != Some('='));
            if no_es_el_valor {
                continue;
            }
            if ERRORES.contains(&nombre.as_str()) {
                let metodo: String = c[(j + 1).min(c.len())..].iter().take_while(|x| es_de_nombre(**x)).collect();
                if !(despues == Some('.') && PREGUNTAS.contains(&metodo.as_str())) {
                    return Some(nombre);
                }
            } else if CUERPOS.contains(&nombre.as_str()) && !matches!(despues, Some('.' | '[')) {
                return Some(nombre);
            }
        }
        None
    }

    /// Lo que este fuente compone con el error o con el cuerpo, y lo que manda por su cuenta.
    fn hallazgos(fuente: &str) -> Vec<String> {
        let Fuente { codigo, textos } = produccion(trocear(fuente));
        let mut out = Vec::new();

        // Un hueco con nombre: `{e}`, `{text:?}`.
        for texto in &textos {
            if huecos(texto).iter().any(|h| ERRORES.contains(h) || CUERPOS.contains(h)) {
                out.push(format!("«{texto}»"));
            }
        }
        for llamada in COMPONEN {
            // Entre los argumentos: `"{}", e`, `e.to_string()`, `error = %e`, `"…".to_string() + &text`.
            for (i, _) in codigo.match_indices(llamada) {
                if let Some(nombre) = vetado_en(argumentos(&codigo[i + llamada.len()..])) {
                    out.push(format!("`{llamada}…)` lleva `{nombre}`"));
                }
            }
            // Y el constructor entregado como función: `.map_err(AppError::sin_conexion)`.
            if let Some(constructor) = llamada.strip_suffix('(').filter(|c| c.starts_with("AppError::")) {
                for (i, _) in codigo.match_indices(constructor) {
                    let tras = codigo[i + constructor.len()..].chars().next();
                    if !tras.is_some_and(|c| c == '(' || es_de_nombre(c)) {
                        out.push(format!("`{constructor}` se pasa como función: recibe el error entero"));
                    }
                }
            }
        }
        // El `.send()` y el `execute` de reqwest: sin argumentos el primero, que no es el de un canal.
        for envio in [".send()", ".execute("] {
            if codigo.contains(envio) {
                out.push(format!("manda con `{envio}` y no con `reloj::enviar`"));
            }
        }
        out
    }

    /// Los módulos de tests que un fuente declara en su propio fichero (`#[cfg(test)] mod x;`):
    /// `x.rs` es entero de tests, y no se mira.
    fn modulos_de_tests(fuente: &str) -> Vec<String> {
        const MARCA: &str = "#[cfg(test)]";
        let codigo = trocear(fuente).codigo;
        codigo
            .match_indices(MARCA)
            .filter_map(|(i, _)| {
                let tras = codigo[i + MARCA.len()..].trim_start();
                let tras = tras.strip_prefix("pub(crate) ").or(tras.strip_prefix("pub ")).unwrap_or(tras);
                let (nombre, _) = tras.strip_prefix("mod ")?.split_once(';')?;
                let nombre = nombre.trim();
                (!nombre.is_empty() && nombre.chars().all(es_de_nombre)).then(|| format!("{nombre}.rs"))
            })
            .collect()
    }

    fn ficheros(dir: &Path, out: &mut Vec<PathBuf>) {
        for entrada in std::fs::read_dir(dir).expect("no se puede leer el directorio") {
            let ruta = entrada.expect("entrada ilegible").path();
            if ruta.is_dir() {
                ficheros(&ruta, out);
            } else if ruta.extension().is_some_and(|x| x == "rs") {
                out.push(ruta);
            }
        }
    }

    #[test]
    fn caza_el_error_y_el_cuerpo_en_un_mensaje() {
        for fuente in [
            // Con su nombre en el hueco.
            r##"serde_json::from_str::<T>(text).map_err(|e| AppError::external(format!("bad_json: {e} | body={text}")))"##,
            r##".map_err(|e| AppError::external(format!("bad_lineas: {e}")))?"##,
            r##"tracing::warn!("no se pudo leer la respuesta: {err:?}");"##,
            r##"let c = '"'; return Err(AppError::external(format!("http_{status}: {body}")));"##,
            r##"AppError::external(format!(r#"respuesta "rara": {texto}"#))"##,
            // Entre los argumentos.
            r##".map_err(|e| AppError::external(format!("bad_lineas: {}", e)))?"##,
            r##"AppError::external(format!("bad_json: {0:?} | {1}", x, &text))"##,
            r##".map_err(|e| AppError::external(e.to_string()))?"##,
            r##"tracing::warn!(error = %e, "no se pudo leer la respuesta");"##,
            r##"AppError::external("respuesta rara: ".to_string() + &text)"##,
            // El constructor como función, que es como estaba el fallo.
            r##"let resp = reloj::enviar(rb).await.map_err(AppError::sin_conexion)?;"##,
            // Por su cuenta.
            r##"let resp = self.http.get(url).send().await?;"##,
            r##"let resp = self.http.execute(peticion).await?;"##,
            // Después de un módulo de tests, y tras un `#[cfg(test)]` que sólo condiciona un `use`.
            "#[cfg(test)]\nmod tests {\n    fn g() {}\n}\nfn f(e: E) -> String { format!(\"{e}\") }\n",
            "#[cfg(test)]\nuse x::y;\nfn f(e: E) -> String { format!(\"{e}\") }\n",
        ] {
            assert!(!hallazgos(fuente).is_empty(), "{fuente}");
        }
    }

    #[test]
    fn deja_pasar_lo_que_no_es_un_dato() {
        for fuente in [
            r##"return Err(AppError::external(format!("respuesta sin {field}")));"##,
            r##"use tpv_application::{error::AppResult, ports::permisos::PermisosRepository};"##,
            r##"// antes era format!("bad_json: {e} | body={text}"), con sus "comillas""##,
            r##"/* y esto: "{e}" */ let x = 'a'; fn f<'a>(e: &'a str) -> &'a str { e }"##,
            r##"escritor.send(Message::Text(r#"{"type":"ping"}"#.into()))"##,
            r##"AppError::external(format!("{que}: no encaja en {} ({:?}, línea {})", tipo, e.classify(), e.line()))"##,
            r##"let ejemplo = format!("las llaves dobles no abren un hueco: {{e}} {{text}}");"##,
            r##"let destino = format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default());"##,
            r##".map_err(|e| cuerpo_no_serializable(&e))?; query.push(("email", e.to_string()));"##,
            r##"return Err(AppError::from_api_body(status, text));"##,
            r##".map_err(|_| AppError::sin_conexion("Tiempo de conexión agotado"))?"##,
            r##"tracing::warn!(veces = intentos, error_code = codigo, "la nube ha rechazado la petición");"##,
            // Lo de los tests no sale del equipo, esté donde esté el módulo.
            "fn f() {}\n#[cfg(test)]\nmod tests {\n    fn g(e: E) { let _ = format!(\"{e} {}\", e); rb.send(); }\n}\nfn h() {}\n",
            "#[cfg(test)]\nmod tests;\nfn h() {}\n",
        ] {
            assert_eq!(hallazgos(fuente), Vec::<String>::new(), "{fuente}");
        }
        // Un módulo de tests en su propio fichero se reconoce; uno con cuerpo o comentado, no.
        assert_eq!(
            modulos_de_tests("#[cfg(test)]\nmod tests_a;\n#[cfg(test)]\npub(crate) mod tests_b;\n#[cfg(test)]\nmod tests_c {\n    fn f() {}\n}\n// #[cfg(test)] mod tests_d;\n"),
            vec!["tests_a.rs".to_string(), "tests_b.rs".to_string()]
        );
    }

    #[test]
    fn ningun_mensaje_de_la_handy_lleva_el_error_ni_el_cuerpo() {
        let raiz = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut rutas = Vec::new();
        ficheros(&raiz, &mut rutas);
        assert!(rutas.len() >= 18, "sólo se han leído {} ficheros", rutas.len());

        let fuentes: Vec<(String, String)> = rutas
            .iter()
            .map(|ruta| {
                let nombre = ruta.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
                (nombre, std::fs::read_to_string(ruta).expect("fichero ilegible"))
            })
            .collect();
        let de_tests: Vec<String> = fuentes.iter().flat_map(|(_, texto)| modulos_de_tests(texto)).collect();
        assert!(
            de_tests.iter().any(|f| f == "tests_sin_datos_en_la_url.rs"),
            "no se reconocen los módulos de tests en su fichero: {de_tests:?}"
        );

        let mut encontrados = Vec::new();
        for (nombre, texto) in &fuentes {
            if de_tests.contains(nombre) {
                continue;
            }
            let nombre = nombre.as_str();
            for hallazgo in hallazgos(texto) {
                if !NO_SON_MENSAJES.contains(&(nombre, hallazgo.as_str())) {
                    encontrados.push(format!("{nombre}  {hallazgo}"));
                }
            }
        }
        assert!(
            encontrados.is_empty(),
            "mensajes que llevan el error o el cuerpo, o peticiones que no pasan por `reloj::enviar`:\n{}",
            encontrados.join("\n")
        );
    }
}
