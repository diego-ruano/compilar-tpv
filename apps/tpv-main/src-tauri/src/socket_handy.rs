//! RI-31: servicio de avisos Handy. Su vida pertenece a la aplicación, no a React.
use std::{future::Future, sync::{Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{sync::{watch, Notify}, time::Instant};
use tpv_application::{error::{AppError, AppResult}, ports::{canal_nube::CanalNube, licensing::PairingService}, use_cases::{presencia_handy::{self, PresenciaHandy}, saludo_socket}};
use tpv_contracts::socket_handy::{AvisoSocketHandy, ConexionHandy, EstadoSocketHandy};
use tpv_infra_http::websocket::conectar;
use tpv_infra_licensing::PairingAdapter;
use crate::{AppState, DeviceMode};

pub(crate) struct HandyNativo {
    presencia: Mutex<PresenciaHandy>,
    orden: watch::Sender<u64>,
}

impl HandyNativo {
    pub fn estado(&self) -> EstadoSocketHandy {
        self.presencia.lock().unwrap_or_else(|e| e.into_inner()).foto.clone()
    }

    fn publicar(&self, app: &AppHandle, generacion: u64, cambio: impl FnOnce(&mut PresenciaHandy)) {
        let mut p = self.presencia.lock().unwrap_or_else(|e| e.into_inner());
        if p.foto.generacion != generacion { return; }
        cambio(&mut p);
        p.foto.revision += 1;
        let _ = app.emit("handy:estado", p.foto.clone());
    }

    pub fn contexto_cambiado(&self, app: &AppHandle) {
        // Invalida ANTES de despertar: una respuesta anterior ya no puede publicar presencia.
        let mut p = self.presencia.lock().unwrap_or_else(|e| e.into_inner());
        p.activar(None, false);
        p.foto.revision += 1;
        let _ = app.emit("handy:estado", p.foto.clone());
        self.orden.send_modify(|revision| *revision += 1);
    }

    pub fn reintentar(&self, forzar: bool) {
        // Volver a primer plano no convierte una revocación en un bucle de peticiones.
        if !forzar && self.estado().rechazo.is_some() { return; }
        self.orden.send_modify(|revision| *revision += 1);
    }
}

/// La gracia vence también mientras se espera el ticket, TLS o el backoff; ningún fetch la alarga.
async fn vigilada<F: Future>(app: &AppHandle, generacion: u64, orden: &mut watch::Receiver<u64>, inicio: Instant, operacion: F) -> Option<F::Output> {
    tokio::pin!(operacion);
    loop {
        let runtime = app.state::<HandyNativo>();
        let gracia = runtime.presencia.lock().unwrap_or_else(|e| e.into_inner()).espera_gracia(inicio.elapsed().as_millis() as u64);
        tokio::select! {
            biased;
            _ = orden.changed() => return None,
            resultado = &mut operacion => return Some(resultado),
            _ = tokio::time::sleep(Duration::from_millis(gracia.unwrap_or(60_000))), if gracia.is_some() => {
                runtime.publicar(app, generacion, |p| { p.vencer_gracia(inicio.elapsed().as_millis() as u64); });
            }
        }
    }
}

async fn sesion(app: &AppHandle, nube: &PairingAdapter, generacion: u64) -> AppResult<()> {
    let ticket = nube.tpv_server_post_json("handy", "/v1/ws/ticket", json!({})).await?;
    let ticket = ticket.get("ticket").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Respuesta sin ticket"))?;
    let mut canal = conectar(ticket, Arc::new(Notify::new())).await?;
    saludo_socket::saludar(&mut canal, |nonce| nube.firmar_hello("handy", nonce), "handy", false).await?;
    let fin = Instant::now() + Duration::from_secs(20);
    loop {
        let espera = fin.saturating_duration_since(Instant::now());
        if espera.is_zero() { return Err(AppError::external("La nube no confirmó la presencia de la Main")); }
        let m = canal.recibir(espera).await?.ok_or_else(|| AppError::external("La nube no confirmó la presencia de la Main"))?;
        if m.get("type").and_then(Value::as_str) == Some("main_status") {
            let (online, volcando) = presencia_handy::estado_main(&m)?;
            app.state::<HandyNativo>().publicar(app, generacion, |p| p.confirmar(online, volcando));
            break;
        }
        if m.get("type").and_then(Value::as_str) == Some("error") { return Err(AppError::external("La nube rechazó la conexión")); }
    }
    loop {
        let Some(m) = canal.recibir(Duration::from_secs(60)).await? else { continue; };
        let runtime = app.state::<HandyNativo>();
        let mut p = runtime.presencia.lock().unwrap_or_else(|e| e.into_inner());
        if p.foto.generacion != generacion { return Ok(()); }
        let anterior = (p.foto.main_online, p.foto.volcando);
        if let Some(cambio) = p.atender(m)? {
            let _ = app.emit("handy:cambio", AvisoSocketHandy { generacion, cambio });
        } else if anterior != (p.foto.main_online, p.foto.volcando) {
            p.foto.revision += 1;
            let _ = app.emit("handy:estado", p.foto.clone());
        }
    }
}

pub(crate) fn arrancar(app: AppHandle) {
    let (orden, mut cambios) = watch::channel(0);
    app.manage(HandyNativo { presencia: Mutex::new(PresenciaHandy::default()), orden });
    tauri::async_runtime::spawn(async move {
        let inicio = Instant::now();
        let mut retardo = 3u64;
        loop {
            cambios.borrow_and_update();
            let runtime = app.state::<HandyNativo>();
            let generacion = runtime.estado().generacion;
            let handy = *app.state::<AppState>().mode.lock().await == Some(DeviceMode::Handy);
            let nube = app.path().app_data_dir().ok().map(PairingAdapter::new);
            let tenant = if handy { nube.as_ref().and_then(|n| n.handy_get_tenant().ok().flatten()).filter(|t| !t.is_empty()) } else { None };
            if runtime.estado().generacion != generacion { continue; }
            runtime.publicar(&app, generacion, |p| {
                p.foto.tenant_id = tenant.clone();
                p.foto.estado = if !handy { ConexionHandy::Pausada } else if tenant.is_none() { ConexionHandy::SinIdentidad } else { ConexionHandy::Conectando };
            });
            if !handy || tenant.is_none() {
                let _ = vigilada(&app, generacion, &mut cambios, inicio, tokio::time::sleep(Duration::from_secs(60))).await;
                retardo = 3;
                continue;
            }
            let Some(nube) = nube else { continue; };
            let resultado = vigilada(&app, generacion, &mut cambios, inicio, sesion(&app, &nube, generacion)).await;
            let mut espera = retardo;
            match resultado {
                None => {
                    runtime.publicar(&app, generacion, |p| p.desconectar(inicio.elapsed().as_millis() as u64));
                    retardo = 3;
                    continue;
                }
                Some(Ok(())) => { retardo = 3; }
                Some(Err(e)) => {
                    let estuvo_conectada = runtime.estado().estado == ConexionHandy::Conectada;
                    let mut rechazo = false;
                    runtime.publicar(&app, generacion, |p| {
                        rechazo = p.rechazar(e.code());
                        if !rechazo { p.desconectar(inicio.elapsed().as_millis() as u64); }
                    });
                    tracing::warn!(target: "tpv::handy", codigo = ?e.code(), "se interrumpió el socket de avisos");
                    if rechazo { espera = 300; }
                    else {
                        if estuvo_conectada { retardo = 3; }
                        espera = retardo;
                        retardo = (retardo * 2).min(30);
                    }
                }
            }
            let jitter = u64::from(rand::random::<u16>()) % 1000;
            if vigilada(&app, generacion, &mut cambios, inicio, tokio::time::sleep(Duration::from_millis(espera * 1000 + jitter))).await.is_none() { retardo = 3; }
        }
    });
}

pub(crate) fn contexto_cambiado(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<HandyNativo>() { runtime.contexto_cambiado(app); }
    // La Main comprueba el modo al despertar y sale de su sesión sin interrumpir transacciones.
    if let Some(runtime) = app.try_state::<crate::replicacion::SyncNativo>() { runtime.reintentar(); }
}
