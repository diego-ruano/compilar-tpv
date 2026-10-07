//! RI-31/RI-57: un único transporte nativo, independiente del ciclo de vida de React.
use std::{collections::BTreeSet, sync::{Arc, Mutex, OnceLock}, time::Duration};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{sync::{mpsc, Notify}, time::{timeout, Instant}};
use tokio_tungstenite::{connect_async_with_config, tungstenite::{Message, protocol::WebSocketConfig}};
use tpv_application::{error::{AppError, AppResult}, ports::{licensing::PairingService, replicacion::{CanalReplicacion, ContextoReplicacion}, sync::SyncRepository}, use_cases::replicacion as uc};
use tpv_contracts::{errors::ErrorCode, recovery::RecoveryState, sync::{CambioReplicado, ComandaReplicada, EstadoReplicacion, OutboxFallo, SqlStatement}};
use tpv_infra_licensing::{PairingAdapter, CLOUD_API_BASE};
use crate::{AppState, DeviceMode, ConnectivityMode};

pub(crate) struct SyncNativo {
    pub despertar: Arc<Notify>,
    reintentar: Arc<Notify>,
    foto: Mutex<EstadoReplicacion>,
}
impl Default for SyncNativo {
    fn default() -> Self {
        Self { despertar: Arc::new(Notify::new()), reintentar: Arc::new(Notify::new()), foto: Mutex::new(EstadoReplicacion { revision:0, estado:"conectando".into(), detalle:None, fase_recuperacion:"inactiva".into(), fallos_recuperacion:0 }) }
    }
}
impl SyncNativo {
    pub fn estado(&self) -> EstadoReplicacion { self.foto.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    fn publicar(&self, app: &AppHandle, estado: &str, detalle: Option<String>) {
        let mut foto = self.foto.lock().unwrap_or_else(|e| e.into_inner());
        foto.revision += 1; foto.estado = estado.into(); foto.detalle = detalle;
        let _ = app.emit("sync:estado", foto.clone());
    }
    pub fn reintentar(&self) { self.reintentar.notify_one(); self.despertar.notify_one(); }
}

struct Contexto { app: AppHandle }
#[async_trait]
impl ContextoReplicacion for Contexto {
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>> {
        self.app.state::<AppState>().sync_repo().await.map_err(AppError::repository)
    }
    fn cambios(&self, sentencias: &[SqlStatement]) { let _ = self.app.emit("sync:cambio", aviso(sentencias)); }
    fn fase_recuperacion(&self, fase: &str) {
        let estado = self.app.state::<SyncNativo>();
        let mut foto = estado.foto.lock().unwrap_or_else(|e| e.into_inner());
        foto.revision += 1; foto.fase_recuperacion = fase.into();
        if fase == "completada" { foto.fallos_recuperacion = 0; }
        let _ = self.app.emit("sync:estado", foto.clone());
    }
    fn solicitud_emparejamiento(&self) { let _ = self.app.emit("sync:pair-request", ()); }
    fn fallo_subida(&self, op_id: &str, fallo: &OutboxFallo) {
        if fallo.apartada { tracing::error!(target:"tpv::sync", op_id, comando = %fallo.command_name, reparadas = fallo.reparadas, "operación apartada de la subida"); }
    }
    async fn completar_recuperacion(&self, high_water: i64) -> AppResult<()> {
        // La misma guardia nativa; ahora la cifra procede exclusivamente del HTTP autenticado.
        crate::commands::recovery::completar(&self.app.state::<AppState>(), high_water).await
    }
    async fn sigue_disponible(&self, recuperando: bool) -> AppResult<bool> {
        let state = self.app.state::<AppState>();
        if *state.mode.lock().await != Some(DeviceMode::Tpv) { return Ok(false); }
        let dir = self.app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
        if crate::load_config(&dir).connectivity == Some(ConnectivityMode::Off) { return Ok(false); }
        let db = state.db.lock().await.as_ref().cloned();
        let Some(db) = db else { return Ok(false); };
        let estado = tpv_infra_sqlite::recovery::status(&db).await?.state;
        Ok(estado == if recuperando {RecoveryState::ReconciliationPending} else {RecoveryState::Ready})
    }
    fn volcado_permitido(&self) -> bool {
        crate::interruptores::apagado(&self.app, tpv_contracts::interruptores::Interruptor::VolcadoAtraso).is_none()
    }
}

struct Canal {
    salida: mpsc::Sender<Value>,
    entrada: mpsc::Receiver<AppResult<Value>>,
    despertar: Arc<Notify>,
    tarea: tokio::task::JoinHandle<()>,
}
impl Drop for Canal { fn drop(&mut self) { self.tarea.abort(); } }
#[async_trait]
impl CanalReplicacion for Canal {
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

async fn conectar(ticket: &str, despertar: Arc<Notify>) -> AppResult<Canal> {
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
    Ok(Canal { salida, entrada, despertar, tarea })
}

async fn sesion(app: &AppHandle, recuperando: bool) -> AppResult<()> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let nube = PairingAdapter::new(dir);
    let ticket = nube.tpv_server_post_json("tpv", "/v1/ws/ticket", json!({})).await?;
    let ticket = ticket.get("ticket").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Respuesta sin ticket"))?;
    let mut canal = conectar(ticket, app.state::<SyncNativo>().despertar.clone()).await?;
    let fin = Instant::now() + Duration::from_secs(20);
    loop {
        if Instant::now() >= fin { return Err(AppError::external("El socket no confirmó la identidad")); }
        let Some(m) = canal.recibir(fin.saturating_duration_since(Instant::now())).await? else { continue; };
        match m.get("type").and_then(Value::as_str) {
            Some("challenge") => {
                let nonce = m.get("nonceB64").and_then(Value::as_str).unwrap_or("");
                let firma = nube.firmar_hello("tpv", nonce)?;
                canal.enviar(json!({"type":"helloSigned","ts":firma.ts,"sigB64":firma.sig_b64,"nonceB64":nonce,"recovering":recuperando})).await?;
            }
            Some("hello_ok") => break,
            Some("hello_error") => return Err(AppError::external("La nube rechazó el saludo del dispositivo")),
            _ => {}
        }
    }
    app.state::<SyncNativo>().publicar(app, "conectado", None);
    if !recuperando {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::images_drain_pending(h.clone(), h.state::<AppState>()).await {
                tracing::warn!(target:"tpv::sync", codigo = ?e.code, "falló la subida de imágenes al reconectar");
            }
        });
    }
    let ctx = Contexto { app: app.clone() };
    uc::ejecutar(&ctx, &nube, &mut canal, recuperando).await
}

pub(crate) fn arrancar(app: AppHandle) {
    app.manage(SyncNativo::default());
    tauri::async_runtime::spawn(async move {
        let ctx = Contexto { app: app.clone() };
        let mut retardo = 3u64;
        let mut fallos = 0u32;
        loop {
            let runtime = app.state::<SyncNativo>();
            let dir = app.path().app_data_dir().ok();
            let con_licencia = dir.as_ref().is_some_and(|d| crate::dispositivo_aprovisionado(d));
            let disponible = ctx.sigue_disponible(false).await.unwrap_or(false);
            let recuperando = ctx.sigue_disponible(true).await.unwrap_or(false);
            let mut espera = 60;
            if (disponible || recuperando) && con_licencia {
                runtime.publicar(&app, "conectando", None);
                match sesion(&app, recuperando).await {
                    Ok(()) => { retardo = 3; fallos = 0; espera = 1; }
                    Err(e) => {
                        let estuvo_conectada = runtime.estado().estado == "conectado";
                        if estuvo_conectada { retardo = 3; }
                        let rechazo = matches!(e.code(), ErrorCode::LicenseExpired | ErrorCode::LicenseNotFound | ErrorCode::DeviceRevoked);
                        runtime.publicar(&app, if rechazo {"rechazado"} else {"reintentando"}, Some(e.to_string()));
                        if rechazo {
                            espera = 300;
                            let h = app.clone();
                            tauri::async_runtime::spawn(async move { let _ = crate::commands::licensing::license_check_now(h).await; });
                        } else { espera = retardo; retardo = (retardo * 2).min(30); }
                        if recuperando && estuvo_conectada {
                            fallos += 1;
                            let mut foto = runtime.foto.lock().unwrap_or_else(|e| e.into_inner());
                            foto.revision += 1; foto.fallos_recuperacion = fallos;
                            foto.fase_recuperacion = if fallos >= 5 {"bloqueada"} else {"error"}.into();
                            let _ = app.emit("sync:estado", foto.clone());
                        }
                    }
                }
            } else if !con_licencia && (disponible || recuperando) { runtime.publicar(&app, "sin_identidad", Some("Aún no hay una licencia activada".into())); }
            else { runtime.publicar(&app, "pausada", Some("Sincronización pendiente del modo, los datos o la palanca de este equipo".into())); }
            if fallos >= 5 {
                runtime.reintentar.notified().await;
                fallos = 0;
            } else {
                let jitter = rand::random::<u16>() as u64 % 1000;
                tokio::select! {
                    _ = runtime.reintentar.notified() => { fallos = 0; },
                    _ = tokio::time::sleep(Duration::from_millis(espera * 1000 + jitter)) => {},
                }
            }
        }
    });
}

fn aviso(sentencias: &[SqlStatement]) -> CambioReplicado {
    static TABLA: OnceLock<Regex> = OnceLock::new();
    static COMANDA: OnceLock<Regex> = OnceLock::new();
    static INSERT: OnceLock<Regex> = OnceLock::new();
    let tabla = TABLA.get_or_init(|| Regex::new(r#"(?i)^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+[\"`\[]?(\w+)"#).unwrap());
    let comanda = COMANDA.get_or_init(|| Regex::new(r"(?i)ID_Comanda\s*=\s*\?(\d+)").unwrap());
    let insert = INSERT.get_or_init(|| Regex::new(r"(?i)INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]*)\)").unwrap());
    let mut tablas = BTreeSet::new(); let mut ids = BTreeSet::new();
    let mut conocida = true; let mut tocada = false; let mut catalogo = false; let mut incierta = false;
    for s in sentencias {
        let Some(t) = tabla.captures(&s.sql).map(|c| c[1].to_ascii_lowercase()) else { conocida = false; tocada = true; catalogo = true; incierta = true; continue; };
        catalogo |= ["categorias_producto","productos","lotes_producto","lote_consumos","alergenos","producto_alergenos"].contains(&t.as_str());
        if ["comandas","detalle_comanda","pagos","pago_detalles"].contains(&t.as_str()) {
            tocada = true; let mut encontrado = false;
            for c in comanda.captures_iter(&s.sql) {
                if let Ok(i) = c[1].parse::<usize>() {
                    if let Some(v) = i.checked_sub(1).and_then(|i| s.args.get(i)).and_then(Value::as_str).filter(|s| !s.is_empty()) { ids.insert(v.to_string()); encontrado = true; }
                }
            }
            if let Some(c) = insert.captures(&s.sql) {
                let posicion = c[1].split(',').position(|s| s.trim().eq_ignore_ascii_case("ID_Comanda"));
                if let Some(v) = posicion.and_then(|i| s.args.get(i)).and_then(Value::as_str).filter(|s| !s.is_empty()) { ids.insert(v.to_string()); encontrado = true; }
            }
            incierta |= !encontrado;
        }
        tablas.insert(t);
    }
    CambioReplicado { tablas: conocida.then(|| tablas.into_iter().collect()), comanda: ComandaReplicada { ids:ids.into_iter().collect(), touched_comanda:tocada, uncertain:incierta, touched_catalog:catalogo } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn el_aviso_no_expone_sql_y_conserva_la_seleccion_del_ticket() {
        let v = aviso(&[SqlStatement { sql:"UPDATE Detalle_Comanda SET Cantidad=?1 WHERE ID_Comanda=?2".into(), args:vec![json!(2),json!("comanda-1")] }]);
        assert_eq!(v.comanda.ids, vec!["comanda-1"]);
        assert!(!v.comanda.uncertain);
        let texto = serde_json::to_string(&v).unwrap();
        assert!(!texto.contains("UPDATE")); assert!(!texto.contains("Cantidad"));
    }
    #[test]
    fn una_forma_desconocida_refresca_por_seguridad() {
        let v = aviso(&[SqlStatement { sql:"WITH x AS (SELECT 1) UPDATE Productos SET Nombre='x'".into(), args:vec![] }]);
        assert!(v.tablas.is_none()); assert!(v.comanda.uncertain);
    }
}
