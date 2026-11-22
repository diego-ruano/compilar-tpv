//! PROD-04 — la hora con la que este equipo FIRMA lo que manda a la nube.
//!
//! El worker rechaza cualquier firma cuya hora se aparte más de 2 minutos de la suya
//! (`device_ts_out_of_range`, y `ts_out_of_range` en el saludo del WebSocket). Un PC de bar que deja
//! de sincronizar la hora —Windows sin dominio lo hace una vez por semana, y un router que corta el
//! NTP deja pasar el HTTPS igual— se desvía unos segundos al día y llega a ese margen en semanas: a
//! partir de ahí se caen a la vez la licencia, el WebSocket, la replicación y las Handy, que se
//! quedan congeladas por falta de Main. REV-10 ya lo DIAGNOSTICABA; esto hace que no pase.
//!
//! La hora de firmar no sale del reloj del sistema sino del de la nube: cada respuesta del worker
//! trae su cabecera `Date` —también los rechazos, que es lo que permite arreglarlo sin tocar el
//! servidor—, y con ella se estima cuánto se desvía este equipo. Las firmas usan el reloj del sistema
//! MÁS ese desfase. La seguridad no cambia: lo que protege la firma es que lleve una hora pegada a la
//! del servidor, y la corrección la acerca, no la aleja.
//!
//! ⚠️ **Sólo para firmar y para leer fechas que pone la nube** (la caducidad de un token, la de una
//! aserción). La hora del NEGOCIO —ventas, fichajes, caja, registros de facturación, y la
//! `x-client-now` con la que el worker resuelve los `datetime('now')`— sigue siendo la del equipo, a
//! propósito: corregirla de golpe podría fechar una factura antes que la anterior, y eso una cadena
//! de facturación no lo admite. Es otra decisión, y no se toma aquí.
//!
//! RELOJ-01 — lo que sí se hace con la hora del negocio es AVISAR: la medida sale a la pantalla
//! ([`desfase_medido_ms`], comando `reloj_desfase`) y una franja le dice a quien está delante que
//! ajuste la hora del equipo cuando se aparta varios minutos de la nube. Nada se corrige solo.
//!
//! El desfase vive en memoria y no se guarda: al arrancar vale 0, la primera petición que la nube
//! rechace por la hora trae ya la suya, y se repite una vez (ver [`es_rechazo_por_reloj`]). Ese 0 de
//! arranque no es una medida, y por eso [`MEDIDA`] dice aparte si ya ha llegado alguna.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, DATE};
use reqwest::{RequestBuilder, Response};
use tpv_application::error::AppError;

/// Cuánto hay que sumarle al reloj del sistema para tener la hora de la nube. Es del PROCESO y no de
/// un adaptador: los adaptadores se construyen en cada comando y lo que aprende uno lo tiene que
/// saber el siguiente.
static DESFASE_MS: AtomicI64 = AtomicI64::new(0);

/// RELOJ-01 — la última medida, para el aviso: el desfase, y la hora del sistema y el reloj
/// monótono de cuando se tomó. Sin ella, el 0 de [`DESFASE_MS`] sólo es el valor de arranque: un
/// equipo sin red que lleva un día adelantado no puede enseñar «la hora está bien».
static MEDIDA: Mutex<Option<Medida>> = Mutex::new(None);

#[derive(Debug, Clone, Copy)]
struct Medida {
    desfase_ms: i64,
    sistema_ms: i64,
    monotono: Instant,
}

/// RELOJ-01 — si desde la medida la hora del sistema ha avanzado más o menos que el reloj monótono
/// en más que esto, alguien la ha cambiado (o el equipo ha estado suspendido): la medida ya no dice
/// nada de la hora de ahora.
const SALTO_DEL_RELOJ_MS: i64 = 60_000;

/// Una respuesta que tarda más que esto no sirve para medir: el error de la estimación es la mitad
/// de la ida y vuelta, y con 10 s ya son 5 contra un margen de 120.
const MAX_IDA_Y_VUELTA_MS: i64 = 10_000;

/// La cabecera `Date` va en segundos enteros (trunca), así que la hora de verdad cae en algún punto
/// de ese segundo: se toma el centro.
const MEDIO_SEGUNDO_MS: i64 = 500;

/// El reloj del sistema, tal cual. Es con el que se mide el desfase, y por eso no se corrige.
pub fn reloj_del_sistema_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

/// La hora con la que se firma: la del sistema, corregida con lo último que dijo la nube.
pub fn ahora_ms() -> i64 {
    reloj_del_sistema_ms().saturating_add(DESFASE_MS.load(Ordering::Relaxed))
}

/// Manda la petición y anota lo que su respuesta diga de la hora. Es el sustituto de `.send()` en
/// todo lo que habla con el worker: una respuesta que no se anota es una medida que se tira.
///
/// AUD-28 — el error que devuelve no lleva la URL. reqwest la añade a su texto («error sending
/// request for url (…)») con la query entera, y quien llama mete ese texto en un mensaje que sale
/// del equipo (Axiom, Sentry). Desde AUD-27 en la query sólo viajan identificadores, fechas y
/// filtros, pero antes llevaba el teléfono y el correo de la búsqueda de un cliente, codificados de
/// forma que el filtro de datos personales no los reconoce: lo que viaje en una URL no tiene por qué
/// salir del equipo con su error. Se quita aquí y no en cada llamada, para que nadie tenga que
/// acordarse. Tampoco se deja la ruta sin la query: quien registra el fallo ya sabe qué estaba
/// pidiendo, y nada impide que una ruta lleve un texto.
pub async fn enviar(peticion: RequestBuilder) -> reqwest::Result<Response> {
    let enviada = reloj_del_sistema_ms();
    let resp = peticion.send().await.map_err(reqwest::Error::without_url)?;
    anotar_respuesta(resp.headers(), enviada, reloj_del_sistema_ms());
    Ok(resp)
}

/// AUD-28 · CFG-INC-04 — la petición no ha llegado a tener respuesta: sin red, DNS, TLS, tiempo
/// agotado.
///
/// El mensaje dice qué pasa y qué hacer, en español (`AppError::sin_conexion`), y entre paréntesis
/// la CLASE del fallo, de una lista cerrada ([`clase_del_fallo`]), no el texto de reqwest. Ese texto
/// está en inglés («error sending request»), no le dice nada a quien está delante —vincular una Handy
/// sin red lo enseñaba tal cual— y lleva la URL entera; el mensaje es `external` y sube a Axiom. Lo
/// usan los dos transportes: el de la licencia, el emparejamiento y las imágenes (este crate) y el
/// `CloudClient` de la Handy (`tpv-infra-http`).
pub fn fallo_de_transporte(e: reqwest::Error) -> AppError {
    AppError::sin_conexion(clase_del_fallo(&e))
}

/// La clase de un fallo de transporte, para el paréntesis del mensaje (ver [`fallo_de_transporte`]).
pub fn clase_del_fallo(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "tiempo de espera agotado"
    } else if e.is_connect() {
        "no se pudo abrir la conexión"
    } else {
        "la petición no llegó a completarse"
    }
}

/// Actualiza el desfase con la cabecera `Date` de una respuesta. Sin cabecera, o con una que no se
/// puede leer, o con una respuesta demasiado lenta para fiarse, no cambia nada.
pub fn anotar_respuesta(cabeceras: &HeaderMap, enviada_ms: i64, recibida_ms: i64) {
    let Some(fecha) = cabeceras.get(DATE).and_then(|v| v.to_str().ok()) else {
        return;
    };
    if let Some(desfase) = estimar_desfase(fecha, enviada_ms, recibida_ms) {
        DESFASE_MS.store(desfase, Ordering::Relaxed);
        // Los dos relojes de ahora, juntos: con ellos se sabe después si la hora del sistema ha
        // saltado (`desfase_vigente`).
        let medida = Medida { desfase_ms: desfase, sistema_ms: reloj_del_sistema_ms(), monotono: Instant::now() };
        *MEDIDA.lock().unwrap_or_else(|e| e.into_inner()) = Some(medida);
    }
}

/// RELOJ-01 — el último desfase medido (positivo: el reloj del sistema va atrasado respecto a la
/// nube; negativo: adelantado), o `None` si este proceso aún no ha tenido ninguna respuesta del
/// worker con la que medirlo, o si la hora del sistema ha saltado desde entonces. Es lo que enseña el
/// aviso del reloj; firmar sigue con [`ahora_ms`].
///
/// La medida se renueva sola con cada respuesta: en la Main, al menos con la consulta de
/// interruptores (cada 5 min, job `interruptores`); en la Handy, con cada lectura o escritura. Quien
/// pone el equipo en hora siguiendo el aviso no espera a la siguiente: la hora del sistema salta
/// respecto al reloj monótono, la medida deja de valer y el aviso se va en su lectura siguiente. Si
/// la hora sigue mal, la medida nueva lo vuelve a decir.
pub fn desfase_medido_ms() -> Option<i64> {
    let medida = *MEDIDA.lock().unwrap_or_else(|e| e.into_inner());
    desfase_vigente(medida.as_ref(), reloj_del_sistema_ms(), Instant::now())
}

/// El desfase de una medida, si sigue valiendo: si la hora del sistema ha avanzado desde ella lo
/// mismo que el reloj monótono (con [`SALTO_DEL_RELOJ_MS`] de holgura). Un equipo que vuelve de
/// suspenderse puede dar también por saltada la medida: entonces el aviso calla hasta la siguiente,
/// que es lo seguro.
fn desfase_vigente(medida: Option<&Medida>, sistema_ms: i64, ahora: Instant) -> Option<i64> {
    let m = medida?;
    let monotono_ms = i64::try_from(ahora.saturating_duration_since(m.monotono).as_millis()).unwrap_or(i64::MAX);
    let sistema = sistema_ms.saturating_sub(m.sistema_ms);
    (sistema.saturating_sub(monotono_ms).abs() <= SALTO_DEL_RELOJ_MS).then_some(m.desfase_ms)
}

/// Cuánto va por detrás (positivo) o por delante (negativo) el reloj del sistema respecto a la
/// nube, según una respuesta.
///
/// La nube puso su hora en algún momento entre que salió la petición y que llegó la respuesta; sin
/// saber cuándo, lo que menos se equivoca es el punto medio. Error máximo: medio segundo por la
/// resolución de `Date` más media ida y vuelta.
fn estimar_desfase(fecha_http: &str, enviada_ms: i64, recibida_ms: i64) -> Option<i64> {
    let ida_y_vuelta = recibida_ms - enviada_ms;
    // Negativa sólo si el reloj del sistema ha saltado a mitad de petición: la medida no vale.
    if !(0..=MAX_IDA_Y_VUELTA_MS).contains(&ida_y_vuelta) {
        return None;
    }
    let servidor_ms = chrono::DateTime::parse_from_rfc2822(fecha_http.trim())
        .ok()?
        .timestamp_millis()
        + MEDIO_SEGUNDO_MS;
    Some(servidor_ms - (enviada_ms + ida_y_vuelta / 2))
}

/// ¿La nube ha rechazado la petición por la hora de la firma?
///
/// Es la condición para repetirla UNA vez, ya con la hora que acaba de traer ese mismo rechazo. Es
/// seguro también en una escritura: la hora se comprueba en la autenticación, antes de que ningún
/// handler toque nada, así que no hay nada aplicado que duplicar. El worker usa dos nombres según
/// por dónde entre la petición (el device-proof y el emparejamiento).
pub fn es_rechazo_por_reloj(status: u16, cuerpo: &str) -> bool {
    if status != 401 {
        return false;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(cuerpo) else {
        return false;
    };
    matches!(
        json.get("error").and_then(|v| v.as_str()),
        Some("device_ts_out_of_range" | "timestamp_out_of_range")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Fri, 25 Sep 2026 19:19:26 GMT`, que es como la manda Cloudflare (copiada de una respuesta
    /// real de `/health`), en milisegundos.
    const FECHA: &str = "Fri, 25 Sep 2026 19:19:26 GMT";
    const FECHA_MS: i64 = 1_790_363_966_000;

    #[test]
    fn lee_la_cabecera_date_tal_como_la_manda_cloudflare() {
        // Sin ida y vuelta, el desfase es la hora del servidor (centro del segundo) menos la nuestra.
        assert_eq!(estimar_desfase(FECHA, FECHA_MS + 500, FECHA_MS + 500), Some(0));
    }

    #[test]
    fn un_equipo_que_va_atrasado_da_desfase_positivo() {
        // Tres minutos por detrás: más de lo que el worker acepta. Sumando el desfase, la hora de
        // firmar vuelve a caer sobre la del servidor.
        let atrasado = FECHA_MS + 500 - 180_000;
        let desfase = estimar_desfase(FECHA, atrasado, atrasado).unwrap();
        assert_eq!(desfase, 180_000);
        assert_eq!(atrasado + desfase, FECHA_MS + 500);
    }

    #[test]
    fn y_uno_adelantado_negativo() {
        let adelantado = FECHA_MS + 500 + 3_600_000;
        assert_eq!(estimar_desfase(FECHA, adelantado, adelantado), Some(-3_600_000));
    }

    #[test]
    fn se_mide_contra_el_punto_medio_de_la_ida_y_vuelta() {
        // Sale a las X−1 s y vuelve a las X+1 s (reloj propio en hora): la nube estampó en el medio.
        let enviada = FECHA_MS + 500 - 1_000;
        let recibida = FECHA_MS + 500 + 1_000;
        assert_eq!(estimar_desfase(FECHA, enviada, recibida), Some(0));
    }

    #[test]
    fn una_respuesta_demasiado_lenta_no_cuenta() {
        assert_eq!(estimar_desfase(FECHA, 0, MAX_IDA_Y_VUELTA_MS + 1), None);
    }

    #[test]
    fn un_salto_del_reloj_a_mitad_de_peticion_no_cuenta() {
        assert_eq!(estimar_desfase(FECHA, 10_000, 5_000), None);
    }

    #[test]
    fn una_fecha_ilegible_no_cuenta() {
        assert_eq!(estimar_desfase("ayer por la tarde", 0, 0), None);
        assert_eq!(estimar_desfase("", 0, 0), None);
    }

    #[test]
    fn anotar_mueve_la_hora_de_firmar_y_sin_cabecera_no_la_toca() {
        let mut cabeceras = HeaderMap::new();
        cabeceras.insert(DATE, FECHA.parse().unwrap());
        let atrasado = FECHA_MS + 500 - 600_000;
        anotar_respuesta(&cabeceras, atrasado, atrasado);
        assert_eq!(DESFASE_MS.load(Ordering::Relaxed), 600_000);

        anotar_respuesta(&HeaderMap::new(), 0, 0);
        assert_eq!(DESFASE_MS.load(Ordering::Relaxed), 600_000, "sin Date se queda lo que había");

        let dif = ahora_ms() - reloj_del_sistema_ms();
        assert!((599_000..=601_000).contains(&dif), "la hora de firmar lleva el desfase: {dif}");
    }

    /// RELOJ-01: el 0 de arranque no es una medida. Hasta que llega una respuesta que se pueda leer,
    /// el aviso no sabe nada; un medido 0 (reloj en hora) sí es una medida.
    #[test]
    fn sin_medir_no_es_lo_mismo_que_medido_cero() {
        assert_eq!(desfase_medido_ms(), None, "al arrancar no hay medida");

        // Ni una respuesta sin `Date`, ni una demasiado lenta, ni una ilegible cuentan como medida.
        anotar_respuesta(&HeaderMap::new(), 0, 0);
        let mut cabeceras = HeaderMap::new();
        cabeceras.insert(DATE, FECHA.parse().unwrap());
        anotar_respuesta(&cabeceras, 0, MAX_IDA_Y_VUELTA_MS + 1);
        let mut ilegible = HeaderMap::new();
        ilegible.insert(DATE, "ayer".parse().unwrap());
        anotar_respuesta(&ilegible, 0, 0);
        assert_eq!(desfase_medido_ms(), None);

        // En hora: medido, y 0.
        anotar_respuesta(&cabeceras, FECHA_MS + 500, FECHA_MS + 500);
        assert_eq!(desfase_medido_ms(), Some(0));

        // Adelantado una hora; y lo que no se puede leer después no borra la medida.
        let adelantado = FECHA_MS + 500 + 3_600_000;
        anotar_respuesta(&cabeceras, adelantado, adelantado);
        assert_eq!(desfase_medido_ms(), Some(-3_600_000));
        anotar_respuesta(&HeaderMap::new(), 0, 0);
        assert_eq!(desfase_medido_ms(), Some(-3_600_000));
    }

    /// RELOJ-01: quien pone el equipo en hora siguiendo el aviso no tiene que esperar a la medida
    /// siguiente para que se vaya. La hora del sistema salta respecto al reloj monótono, y la medida
    /// deja de valer.
    #[test]
    fn tras_poner_el_equipo_en_hora_la_medida_vieja_deja_de_valer() {
        use std::time::Duration;
        let t0 = Instant::now();
        // Medido con el equipo dos horas adelantado.
        let m = Medida { desfase_ms: -7_200_000, sistema_ms: 1_000_000_000, monotono: t0 };
        let dentro = |s: u64| t0 + Duration::from_secs(s);

        // Pasa el tiempo sin tocar la hora: la medida vale.
        assert_eq!(desfase_vigente(Some(&m), 1_000_000_000 + 120_000, dentro(120)), Some(-7_200_000));
        // Un desajuste pequeño entre los dos relojes no la invalida.
        assert_eq!(desfase_vigente(Some(&m), 1_000_000_000 + 150_000, dentro(120)), Some(-7_200_000));
        // Se atrasa la hora del sistema dos horas: la medida ya no dice nada de la hora de ahora.
        assert_eq!(desfase_vigente(Some(&m), 1_000_000_000 + 120_000 - 7_200_000, dentro(120)), None);
        // Y si se adelanta, tampoco.
        assert_eq!(desfase_vigente(Some(&m), 1_000_000_000 + 120_000 + 7_200_000, dentro(120)), None);
        // Sin medida, nada.
        assert_eq!(desfase_vigente(None, 0, t0), None);
    }

    #[test]
    fn reconoce_los_dos_rechazos_por_la_hora() {
        assert!(es_rechazo_por_reloj(401, r#"{"ok":false,"error":"device_ts_out_of_range"}"#));
        assert!(es_rechazo_por_reloj(401, r#"{"ok":false,"error":"timestamp_out_of_range"}"#));
    }

    /// Sondea una vez un futuro que se resuelve sin esperar a nadie: sin runtime y sin red.
    fn resolver<F: std::future::Future>(futuro: F) -> F::Output {
        let mut futuro = std::pin::pin!(futuro);
        let mut contexto = std::task::Context::from_waker(std::task::Waker::noop());
        match futuro.as_mut().poll(&mut contexto) {
            std::task::Poll::Ready(salida) => salida,
            std::task::Poll::Pending => panic!("el envío tenía que fallar sin salir a la red"),
        }
    }

    /// AUD-28: el error de `enviar` no dice adónde iba la petición. Una dirección sin host no sale a
    /// la red: reqwest la rechaza al enviarla y pone en ese error la URL entera, con su query, igual
    /// que en un corte o en un tiempo agotado.
    #[test]
    fn un_envio_que_falla_no_dice_adonde_iba() {
        const URL: &str =
            "tpv:/v1/reservas/buscar-cliente?telefono=%2B34+612+345+678&email=ana.prueba%40example.com";
        let cliente = reqwest::Client::new();

        // El control: sin pasar por `enviar`, la query está en el texto del error.
        let directo = resolver(cliente.get(URL).send()).expect_err("sin host no se envía");
        assert!(directo.to_string().contains("telefono=%2B34+612+345+678"), "{directo}");

        let e = resolver(enviar(cliente.get(URL))).expect_err("sin host no se envía");
        assert!(e.url().is_none(), "{e:?}");
        let texto = e.to_string();
        for dato in ["telefono", "612", "%2B34", "email", "%40", "example.com", "buscar-cliente"] {
            assert!(!texto.contains(dato), "{dato}: {texto}");
        }
    }

    /// Repetir tiene que reservarse a la hora: por el mismo transporte viaja el login de la Handy,
    /// que contesta 401 con un PIN incorrecto y anota el intento (LOGIN-01).
    #[test]
    fn nada_mas_es_un_rechazo_por_la_hora() {
        assert!(!es_rechazo_por_reloj(401, r#"{"ok":false,"error":"bad_pin"}"#));
        assert!(!es_rechazo_por_reloj(401, r#"{"ok":false,"error":"token_expired"}"#));
        assert!(!es_rechazo_por_reloj(403, r#"{"ok":false,"error":"device_ts_out_of_range"}"#));
        assert!(!es_rechazo_por_reloj(401, "no es json"));
    }
}
