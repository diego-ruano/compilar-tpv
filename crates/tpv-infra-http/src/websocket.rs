//! Transporte WebSocket interno compartido por Main y Handy. Sin Tauri, SQL ni sesi?n personal.
use std::{sync::Arc, time::{Duration, SystemTime}};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{sync::{mpsc, watch, Notify}, time::{timeout, Instant}};
use tokio_tungstenite::{WebSocketStream, connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};
use tpv_application::{error::{AppError, AppResult}, ports::canal_nube::CanalNube};
use tpv_infra_licensing::CLOUD_API_BASE;

/// El texto exacto del latido. El `TenantHub` lo contesta en el borde sin despertarse
/// (`setWebSocketAutoResponse`), y sólo si la cadena es ésta.
const PING: &str = r#"{"type":"ping"}"#;

pub struct CanalWebSocket {
    salida: mpsc::Sender<Value>,
    entrada: mpsc::Receiver<AppResult<Value>>,
    despertar: Arc<Notify>,
    latido: Latido,
    tarea: tokio::task::JoinHandle<()>,
}
impl Drop for CanalWebSocket { fn drop(&mut self) { self.tarea.abort(); } }
impl CanalWebSocket {
    /// El latido de este canal, para comprobarlo desde fuera sin quitarle los mensajes a quien lo lee.
    pub fn latido(&self) -> Latido { self.latido.clone() }
}

/// Cuándo llegó un `pong`, por los dos relojes. El monótono se para con el equipo suspendido
/// (Android en reposo) y el de pared no, así que la edad es la mayor de las dos.
#[derive(Clone, Copy)]
struct Pong { en: Instant, reloj: SystemTime }
impl Pong {
    fn ahora() -> Self { Self { en: Instant::now(), reloj: SystemTime::now() } }
    fn edad(self) -> Duration { self.en.elapsed().max(self.reloj.elapsed().unwrap_or_default()) }
}

/// El latido de un canal abierto: cuánto hace del último `pong` y un ping a demanda. Sirve para
/// saber si una conexión sigue viva sin cortarla (INC-20261030-019).
#[derive(Clone)]
pub struct Latido {
    pedir: Arc<Notify>,
    pongs: watch::Receiver<Pong>,
}
impl Latido {
    /// Lo que hace del último `pong` (o de abrir el canal, si aún no ha llegado ninguno).
    pub fn edad_ultimo_pong(&self) -> Duration { self.pongs.borrow().edad() }

    /// Manda un ping ya y espera su `pong`. `false` si no llega en el plazo o si el canal se ha
    /// cerrado. Vale cualquier `pong` que llegue después de pedirlo: es la conexión la que se prueba.
    pub async fn comprobar(&mut self, plazo: Duration) -> bool {
        self.pongs.borrow_and_update();
        self.pedir.notify_one();
        matches!(timeout(plazo, self.pongs.changed()).await, Ok(Ok(())))
    }
}
#[async_trait]
impl CanalNube for CanalWebSocket {
    async fn enviar(&mut self, mensaje: Value) -> AppResult<()> {
        timeout(Duration::from_secs(10), self.salida.send(mensaje)).await.map_err(|_| AppError::external("Tiempo de envío agotado"))?.map_err(|_| AppError::external("Socket cerrado"))
    }
    async fn recibir(&mut self, espera: Duration) -> AppResult<Option<Value>> {
        tokio::select! {
            m = self.entrada.recv() => m.unwrap_or_else(|| Err(AppError::external("Socket cerrado"))).map(Some),
            _ = self.despertar.notified() => Ok(Some(json!({"type":"despertar"}))),
            _ = tokio::time::sleep(espera) => Ok(None),
        }
    }
}

pub async fn conectar(ticket: &str, despertar: Arc<Notify>) -> AppResult<CanalWebSocket> {
    let mut url = reqwest::Url::parse(CLOUD_API_BASE).map_err(|_| AppError::internal("Host inválido"))?;
    url.set_scheme("wss").map_err(|_| AppError::internal("Esquema WS inválido"))?;
    url.set_path("/ws"); url.query_pairs_mut().append_pair("ticket", ticket);
    let config = WebSocketConfig::default().max_message_size(Some(32 * 1024 * 1024)).max_frame_size(Some(32 * 1024 * 1024));
    // El ticket no entra nunca en logs ni errores de transporte.
    let (socket, _) = timeout(Duration::from_secs(20), connect_async_with_config(url.as_str(), Some(config), false)).await.map_err(|_| AppError::sin_conexion("Tiempo de conexión agotado"))?.map_err(|_| AppError::sin_conexion("No se pudo abrir el WebSocket"))?;
    Ok(desde_socket(socket, despertar))
}

fn desde_socket<S>(socket: WebSocketStream<S>, despertar: Arc<Notify>) -> CanalWebSocket
where S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {
    let (mut escritor, mut lector) = socket.split();
    // Buffer acotado: mientras se descarga catch-up, TCP aplica contrapresión a lo vivo.
    let (salida, mut pendientes) = mpsc::channel::<Value>(8);
    let (recibidos, entrada) = mpsc::channel::<AppResult<Value>>(8);
    let pedir = Arc::new(Notify::new());
    // Al acabar la tarea se suelta el emisor, y quien espere un `pong` se entera de que ya no hay canal.
    let (pongs, visto) = watch::channel(Pong::ahora());
    let pulso = Latido { pedir: pedir.clone(), pongs: visto };
    let tarea = tokio::spawn(async move {
        let mut latido = tokio::time::interval(Duration::from_secs(30));
        latido.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut ultimo_pong = Instant::now();
        loop {
            tokio::select! {
                _ = latido.tick() => {
                    if ultimo_pong.elapsed() > Duration::from_secs(65) { break; }
                    if !timeout(Duration::from_secs(10), escritor.send(Message::Text(PING.into()))).await.is_ok_and(|r| r.is_ok()) { break; }
                }
                // Un ping a demanda (`Latido::comprobar`), fuera del ritmo del latido.
                _ = pedir.notified() => {
                    if !timeout(Duration::from_secs(10), escritor.send(Message::Text(PING.into()))).await.is_ok_and(|r| r.is_ok()) { break; }
                }
                msg = pendientes.recv() => {
                    let Some(msg) = msg else { break; };
                    if !timeout(Duration::from_secs(10), escritor.send(Message::Text(msg.to_string().into()))).await.is_ok_and(|r| r.is_ok()) { break; }
                }
                msg = lector.next() => {
                    match msg {
                        Some(Ok(Message::Text(texto))) => {
                            let Ok(m) = serde_json::from_str::<Value>(&texto) else { break; };
                            if m.get("type").and_then(Value::as_str) == Some("pong") { ultimo_pong = Instant::now(); pongs.send_replace(Pong::ahora()); continue; }
                            if recibidos.send(Ok(m)).await.is_err() { break; }
                        }
                        Some(Ok(Message::Ping(bytes))) => { if !timeout(Duration::from_secs(10), escritor.send(Message::Pong(bytes))).await.is_ok_and(|r| r.is_ok()) { break; } }
                        Some(Ok(Message::Pong(_))) => {},
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {},
                    }
                }
            }
        }
        let _ = timeout(Duration::from_secs(5), escritor.close()).await;
        let _ = recibidos.send(Err(AppError::external("Se perdió la conexión con la nube"))).await;
    });
    CanalWebSocket { salida, entrada, despertar, latido: pulso, tarea }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::protocol::Role;

    async fn pareja() -> (CanalWebSocket, WebSocketStream<DuplexStream>) {
        let (cliente, servidor) = tokio::io::duplex(64 * 1024);
        let cliente = WebSocketStream::from_raw_socket(cliente, Role::Client, None).await;
        let servidor = WebSocketStream::from_raw_socket(servidor, Role::Server, None).await;
        (desde_socket(cliente, Arc::new(Notify::new())), servidor)
    }

    #[tokio::test]
    async fn conserva_el_orden_de_los_mensajes_del_protocolo() {
        let (mut cliente, mut servidor) = pareja().await;
        for tipo in ["challenge", "main_status", "change"] {
            servidor.send(Message::Text(json!({"type":tipo}).to_string().into())).await.unwrap();
        }
        for tipo in ["challenge", "main_status", "change"] {
            assert_eq!(cliente.recibir(Duration::from_secs(1)).await.unwrap().unwrap()["type"], tipo);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn sin_pong_cierra_una_conexion_medio_muerta() {
        let (mut cliente, mut servidor) = pareja().await;
        let mensaje = servidor.next().await.unwrap().unwrap();
        assert_eq!(mensaje.into_text().unwrap(), r#"{"type":"ping"}"#);
        tokio::time::advance(Duration::from_secs(90)).await;
        assert!(cliente.recibir(Duration::from_secs(10)).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn el_pong_json_sostiene_el_transporte_sin_llegar_a_la_aplicacion() {
        let (mut cliente, mut servidor) = pareja().await;
        for _ in 0..4 {
            let ping = servidor.next().await.unwrap().unwrap();
            assert_eq!(ping.into_text().unwrap(), r#"{"type":"ping"}"#);
            servidor.send(Message::Text(r#"{"type":"pong"}"#.into())).await.unwrap();
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(30)).await;
        }
        servidor.send(Message::Text(r#"{"type":"main_online"}"#.into())).await.unwrap();
        assert_eq!(cliente.recibir(Duration::from_secs(1)).await.unwrap().unwrap()["type"], "main_online");
    }

    /// Lee del lado del servidor el siguiente mensaje, que tiene que ser un ping.
    async fn siguiente_ping(servidor: &mut WebSocketStream<DuplexStream>) {
        let ping = servidor.next().await.unwrap().unwrap();
        assert_eq!(ping.into_text().unwrap(), PING);
    }

    #[tokio::test(start_paused = true)]
    async fn un_ping_a_demanda_dice_que_la_conexion_sigue_viva_sin_esperar_al_latido() {
        let (cliente, mut servidor) = pareja().await;
        let mut latido = cliente.latido();
        // El primero es el del latido, al abrir. El segundo, el que se pide.
        siguiente_ping(&mut servidor).await;
        let comprobacion = tokio::spawn(async move { latido.comprobar(Duration::from_secs(3)).await });
        siguiente_ping(&mut servidor).await;
        servidor.send(Message::Text(r#"{"type":"pong"}"#.into())).await.unwrap();
        assert!(comprobacion.await.unwrap(), "con su pong, la conexión está viva");
        // Y no ha hecho falta que pasen los 30 s del latido.
        assert!(cliente.latido().edad_ultimo_pong() < Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn un_ping_sin_pong_vence_a_su_plazo_y_no_cierra_el_canal() {
        let (mut cliente, mut servidor) = pareja().await;
        let mut latido = cliente.latido();
        siguiente_ping(&mut servidor).await;
        let comprobacion = tokio::spawn(async move { latido.comprobar(Duration::from_secs(3)).await });
        siguiente_ping(&mut servidor).await;
        assert!(!comprobacion.await.unwrap(), "sin pong en 3 s no se da por viva");
        // Decidir qué hacer es de quien pregunta: el transporte sigue leyendo.
        servidor.send(Message::Text(r#"{"type":"main_online"}"#.into())).await.unwrap();
        assert_eq!(cliente.recibir(Duration::from_secs(1)).await.unwrap().unwrap()["type"], "main_online");
    }

    #[tokio::test(start_paused = true)]
    async fn la_edad_del_ultimo_pong_crece_hasta_el_siguiente() {
        let (cliente, mut servidor) = pareja().await;
        let latido = cliente.latido();
        siguiente_ping(&mut servidor).await;
        servidor.send(Message::Text(r#"{"type":"pong"}"#.into())).await.unwrap();
        // Con el reloj parado, esta espera sólo vence cuando el transporte ya ha leído el pong.
        tokio::time::sleep(Duration::from_millis(10)).await;
        tokio::time::advance(Duration::from_secs(36)).await;
        assert!(latido.edad_ultimo_pong() >= Duration::from_secs(36));
        siguiente_ping(&mut servidor).await;
        servidor.send(Message::Text(r#"{"type":"pong"}"#.into())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(latido.edad_ultimo_pong() < Duration::from_secs(1));
    }

    #[tokio::test(start_paused = true)]
    async fn con_el_canal_cerrado_la_comprobacion_falla_sin_esperar() {
        let (cliente, _servidor) = pareja().await;
        let mut latido = cliente.latido();
        drop(cliente);
        let antes = Instant::now();
        assert!(!latido.comprobar(Duration::from_secs(3)).await);
        assert!(antes.elapsed() < Duration::from_secs(3), "no agota el plazo: el canal ya no existe");
    }

    #[tokio::test]
    async fn una_trama_invalida_cierra_sin_exponer_su_contenido() {
        let (mut cliente, mut servidor) = pareja().await;
        servidor.send(Message::Text("dato-secreto".into())).await.unwrap();
        let error = cliente.recibir(Duration::from_secs(6)).await.unwrap_err();
        assert!(!error.to_string().contains("dato-secreto"));
    }

    #[tokio::test]
    async fn soltar_el_canal_cancela_el_lector_y_cierra_el_transporte_anterior() {
        let (cliente, mut servidor) = pareja().await;
        drop(cliente);
        timeout(Duration::from_secs(1), async {
            while let Some(Ok(_)) = servidor.next().await {}
        }).await.unwrap();
    }
}

