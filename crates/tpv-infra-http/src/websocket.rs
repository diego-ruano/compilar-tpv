//! Transporte WebSocket interno compartido por Main y Handy. Sin Tauri, SQL ni sesi?n personal.
use std::{sync::Arc, time::Duration};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{sync::{mpsc, Notify}, time::{timeout, Instant}};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};
use tpv_application::{error::{AppError, AppResult}, ports::canal_nube::CanalNube};
use tpv_infra_licensing::CLOUD_API_BASE;

pub struct CanalWebSocket {
    salida: mpsc::Sender<Value>,
    entrada: mpsc::Receiver<AppResult<Value>>,
    despertar: Arc<Notify>,
    tarea: tokio::task::JoinHandle<()>,
}
impl Drop for CanalWebSocket { fn drop(&mut self) { self.tarea.abort(); } }
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
    let (mut escritor, mut lector) = socket.split();
    // Buffer acotado: mientras se descarga catch-up, TCP aplica contrapresión a lo vivo.
    let (salida, mut pendientes) = mpsc::channel::<Value>(8);
    let (recibidos, entrada) = mpsc::channel::<AppResult<Value>>(8);
    let tarea = tokio::spawn(async move {
        let mut latido = tokio::time::interval(Duration::from_secs(30));
        latido.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut ultimo_pong = Instant::now();
        loop {
            tokio::select! {
                _ = latido.tick() => {
                    if ultimo_pong.elapsed() > Duration::from_secs(65) { break; }
                    if !timeout(Duration::from_secs(10), escritor.send(Message::Text(r#"{"type":"ping"}"#.into()))).await.is_ok_and(|r| r.is_ok()) { break; }
                }
                msg = pendientes.recv() => {
                    let Some(msg) = msg else { break; };
                    if !timeout(Duration::from_secs(10), escritor.send(Message::Text(msg.to_string().into()))).await.is_ok_and(|r| r.is_ok()) { break; }
                }
                msg = lector.next() => {
                    match msg {
                        Some(Ok(Message::Text(texto))) => {
                            let Ok(m) = serde_json::from_str::<Value>(&texto) else { break; };
                            if m.get("type").and_then(Value::as_str) == Some("pong") { ultimo_pong = Instant::now(); continue; }
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
    Ok(CanalWebSocket { salida, entrada, despertar, tarea })
}

