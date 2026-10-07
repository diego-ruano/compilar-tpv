//! RI-31/RI-57: un único transporte nativo, independiente del ciclo de vida de React.
use std::{sync::{Arc, Mutex}, time::Duration};
use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tpv_application::{error::{AppError, AppResult}, ports::{licensing::PairingService, replicacion::{ContextoReplicacion}, sync::SyncRepository}, use_cases::replicacion as uc};
use tpv_contracts::{errors::ErrorCode, recovery::RecoveryState, sync::{EstadoReplicacion, OutboxFallo, SqlStatement}};
use tpv_infra_licensing::PairingAdapter;
use tpv_infra_http::websocket::conectar;
use tpv_application::{use_cases::avisos_nube::aviso};
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

async fn sesion(app: &AppHandle, recuperando: bool) -> AppResult<()> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let nube = PairingAdapter::new(dir);
    let ticket = nube.tpv_server_post_json("tpv", "/v1/ws/ticket", json!({})).await?;
    let ticket = ticket.get("ticket").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Respuesta sin ticket"))?;
    let mut canal = conectar(ticket, app.state::<SyncNativo>().despertar.clone()).await?;
    tpv_application::use_cases::saludo_socket::saludar(&mut canal, |nonce| nube.firmar_hello("tpv", nonce), "tpv", recuperando).await?;
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
