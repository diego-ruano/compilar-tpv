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
        let http = Client::builder()
            .default_headers(tpv_infra_licensing::cabeceras_version())
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .map_err(|e| AppError::external(format!("http_build_failed: {e}")))?;

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
        let mut url = reqwest::Url::parse(&self.url(path))
            .map_err(|e| AppError::validation(e.to_string()))?;
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
            .map_err(|e| AppError::external(format!("bad_json_body: {e}")))?;
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
            .map_err(|e| AppError::external(format!("bad_json_body: {e}")))?;

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

        let resp = reloj::enviar(rb).await.map_err(AppError::sin_conexion)?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();

        Ok((status, text))
    }
}

/// La respuesta de la nube, ya con su desenlace: el cuerpo deserializado o el error que trae.
fn interpretar<T: DeserializeOwned>(status: u16, text: &str) -> AppResult<T> {
    if !(200..300).contains(&status) {
        // ARCH-05: el código lo resuelve `from_api_body`, que prefiere el `code` que
        // manda el worker (él tiene el status y el contexto de la ruta) y sólo traduce el
        // string de negocio si no viene.
        return Err(AppError::from_api_body(status, text));
    }

    serde_json::from_str::<T>(text)
        .map_err(|e| AppError::external(format!("bad_json: {e} | body={text}")))
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

        let client = CloudClient::new(base, std::env::temp_dir()).unwrap();
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
        // Una búsqueda de productos: tilde, espacios y un `&` que no separa parámetros.
        let query = [("query", "café & tostá".to_string()), ("limit", "20".to_string())];
        let (firmado, recibido) =
            firmado_y_recibido(Method::GET, "/v1/venta-rapida/productos/search", &query, b"").await;
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
