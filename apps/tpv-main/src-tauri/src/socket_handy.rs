//! RI-31: servicio de avisos Handy. Su vida pertenece a la aplicación, no a React.
use std::{future::Future, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{sync::{watch, Notify}, time::Instant};
use tpv_application::{error::{AppError, AppResult}, ports::{canal_nube::CanalNube, licensing::PairingService}, use_cases::{presencia_handy::{self, AlVolver, PresenciaHandy, PLAZO_PONG_MS}, saludo_socket}};
use tpv_contracts::socket_handy::{AvisoSocketHandy, ConexionHandy, EstadoSocketHandy};
use tpv_infra_http::websocket::{conectar, Latido};
use tpv_infra_licensing::PairingAdapter;
use crate::{AppState, DeviceMode};

pub(crate) struct HandyNativo {
    presencia: Mutex<PresenciaHandy>,
    orden: watch::Sender<u64>,
    /// El latido de la conexión confirmada. Se guarda con el cerrojo de `presencia` cogido, en el
    /// mismo paso que la confirma: quien ve `Conectada` ve el latido de esa conexión.
    latido: Mutex<Option<Latido>>,
    /// Hay un ping de comprobación esperando su `pong`: los focos que lleguen entretanto no mandan otro.
    comprobando: AtomicBool,
}

/// Un ping de comprobación por mandar: el latido y la conexión a la que pertenece.
struct Comprobacion { latido: Latido, generacion: u64, conexion: u64 }

impl HandyNativo {
    fn nuevo(orden: watch::Sender<u64>) -> Self {
        Self { presencia: Mutex::new(PresenciaHandy::default()), orden, latido: Mutex::new(None), comprobando: AtomicBool::new(false) }
    }

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

    /// La aplicación vuelve a primer plano, vuelve la red o alguien pulsa «Reintentar».
    ///
    /// INC-20261030-019: una conexión abierta no se corta para comprobarla. Se le manda un ping, y
    /// sólo si no contesta se reconecta. Cada reconexión es un ticket nuevo (la base central), un
    /// saludo con el `TenantHub` y, en la interfaz, releerlo todo.
    pub fn reintentar(&self, app: &AppHandle, forzar: bool) {
        let Some(Comprobacion { mut latido, generacion, conexion }) = self.decidir_al_volver(forzar) else { return; };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let viva = latido.comprobar(Duration::from_millis(PLAZO_PONG_MS)).await;
            let runtime = app.state::<HandyNativo>();
            if !viva && runtime.cortar_si_es(generacion, conexion) {
                tracing::warn!(target: "tpv::handy", "el socket de avisos no contestó al volver a primer plano");
            }
            runtime.comprobando.store(false, Ordering::Release);
        });
    }

    /// Decide qué hacer al volver y, si toca reconectar, lo ordena. Devuelve el ping de
    /// comprobación que queda por mandar, si lo hay.
    ///
    /// La decisión y la orden van con el cerrojo de `presencia` cogido. Una conexión sólo se
    /// confirma con ese cerrojo, así que entre mirar el estado y ordenar no puede abrirse otra:
    /// la orden no dice a qué conexión va, y cortaría la nueva.
    fn decidir_al_volver(&self, forzar: bool) -> Option<Comprobacion> {
        let p = self.presencia.lock().unwrap_or_else(|e| e.into_inner());
        let latido = self.latido.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let edad = latido.as_ref().map(|l| l.edad_ultimo_pong().as_millis() as u64);
        match (p.al_volver(forzar, edad), latido) {
            (AlVolver::Nada, _) => None,
            (AlVolver::Comprobar, Some(latido)) => {
                if self.comprobando.swap(true, Ordering::AcqRel) { return None; }
                Some(Comprobacion { latido, generacion: p.foto.generacion, conexion: p.foto.conexion })
            }
            (AlVolver::Comprobar, None) | (AlVolver::Reconectar, _) => {
                self.orden.send_modify(|revision| *revision += 1);
                None
            }
        }
    }

    /// El ping de una comprobación no ha vuelto: corta esa conexión, y sólo ésa. Si entretanto se
    /// cayó o se sustituyó ya hay otra en marcha, y cortarla sería empezar de nuevo. Con el
    /// cerrojo cogido, por lo mismo que en `decidir_al_volver`.
    fn cortar_si_es(&self, generacion: u64, conexion: u64) -> bool {
        let p = self.presencia.lock().unwrap_or_else(|e| e.into_inner());
        if !p.es_la_conexion(generacion, conexion) { return false; }
        self.orden.send_modify(|revision| *revision += 1);
        true
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
            let runtime = app.state::<HandyNativo>();
            runtime.publicar(app, generacion, |p| {
                p.confirmar(online, volcando);
                *runtime.latido.lock().unwrap_or_else(|e| e.into_inner()) = Some(canal.latido());
            });
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
    app.manage(HandyNativo::nuevo(orden));
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

#[cfg(test)]
mod tests {
    //! Quién ordena reconectar y a qué conexión. La orden es un contador sin destinatario: lo que
    //! se vigila es que sólo se dé con la conexión que se miraba todavía abierta.
    use super::*;
    use tpv_contracts::errors::ErrorCode;

    fn servicio() -> (HandyNativo, watch::Receiver<u64>) {
        let (orden, ordenes) = watch::channel(0);
        (HandyNativo::nuevo(orden), ordenes)
    }

    /// Deja el servicio con una conexión confirmada y dice cuál es.
    fn conectar(servicio: &HandyNativo) -> (u64, u64) {
        let mut p = servicio.presencia.lock().unwrap();
        p.activar(Some("negocio-a".into()), true);
        p.confirmar(true, false);
        (p.foto.generacion, p.foto.conexion)
    }

    /// ¿Se ha dado una orden desde la última vez que se miró?
    fn ordenado(ordenes: &mut watch::Receiver<u64>) -> bool {
        let hay = ordenes.has_changed().unwrap();
        ordenes.borrow_and_update();
        hay
    }

    #[test]
    fn un_ping_sin_respuesta_corta_la_conexion_que_se_comprobaba() {
        let (servicio, mut ordenes) = servicio();
        let (generacion, conexion) = conectar(&servicio);
        assert!(servicio.cortar_si_es(generacion, conexion));
        assert!(ordenado(&mut ordenes));
    }

    #[test]
    fn un_ping_sin_respuesta_no_corta_la_conexion_que_sustituyo_a_la_suya() {
        let (servicio, mut ordenes) = servicio();
        let (generacion, conexion) = conectar(&servicio);
        // Alguien pulsó «Reintentar» mientras se esperaba el pong: ya hay otra conexión abierta.
        servicio.presencia.lock().unwrap().confirmar(true, false);
        assert!(!servicio.cortar_si_es(generacion, conexion));
        assert!(!ordenado(&mut ordenes), "la conexión nueva no se toca");
        // Tampoco si la suya se cayó sola y ya se está reconectando.
        servicio.presencia.lock().unwrap().desconectar(0);
        assert!(!servicio.cortar_si_es(generacion, conexion + 1));
        assert!(!ordenado(&mut ordenes));
    }

    #[test]
    fn volver_sin_conexion_ordena_reconectar_y_con_un_rechazo_solo_el_boton() {
        let (servicio, mut ordenes) = servicio();
        // Sin conexión abierta no hay nada que comprobar: se intenta ya.
        assert!(servicio.decidir_al_volver(false).is_none());
        assert!(ordenado(&mut ordenes));
        // Conectada pero sin latido que mirar: tampoco se puede comprobar.
        conectar(&servicio);
        assert!(servicio.decidir_al_volver(false).is_none());
        assert!(ordenado(&mut ordenes));
        // Un rechazo no se reintenta por volver a primer plano…
        assert!(servicio.presencia.lock().unwrap().rechazar(ErrorCode::DeviceRevoked));
        assert!(servicio.decidir_al_volver(false).is_none());
        assert!(!ordenado(&mut ordenes));
        // …pero sí con el botón.
        assert!(servicio.decidir_al_volver(true).is_none());
        assert!(ordenado(&mut ordenes));
    }
}
