//! RI-31/RI-57: un único transporte nativo, independiente del ciclo de vida de React.
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, time::{Duration, Instant}};
use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tpv_application::{error::{AppError, AppResult}, ports::{licensing::PairingService, replicacion::{ContextoReplicacion, RitmoDeSubida}, sync::SyncRepository}, use_cases::replicacion as uc};
use tpv_contracts::{errors::ErrorCode, recovery::RecoveryState, sync::{EstadoReplicacion, OutboxFallo, SqlStatement}};
use tpv_infra_licensing::PairingAdapter;
use tpv_infra_http::websocket::conectar;
use tpv_application::{use_cases::avisos_nube::aviso};
use crate::{AppState, DeviceMode, ConnectivityMode};

pub(crate) struct SyncNativo {
    pub despertar: Arc<Notify>,
    reintentar: Arc<Notify>,
    foto: Mutex<EstadoReplicacion>,
    /// De cuántas operaciones es el siguiente lote de la subida. Sobrevive a las sesiones: un lote
    /// sin respuesta acaba con la suya, y la siguiente tiene que saberlo.
    ritmo: Arc<RitmoDeSubida>,
    /// Mientras se trae el estado de la nube, el motor no abre ninguna sesión (`pausar`).
    pausa: AtomicBool,
    /// Hay una sesión en marcha, normal o de recuperación (que al terminar sigue en vivo).
    en_sesion: AtomicBool,
    /// Traer la nube, de uno en uno: el que termina quita la pausa (`turno_para_traer_la_nube`).
    traer: tokio::sync::Mutex<()>,
}
impl Default for SyncNativo {
    fn default() -> Self {
        Self { despertar: Arc::new(Notify::new()), reintentar: Arc::new(Notify::new()), foto: Mutex::new(EstadoReplicacion { revision:0, estado:"conectando".into(), detalle:None, fase_recuperacion:"inactiva".into(), fallos_recuperacion:0, handy_retenidas:false }), ritmo: Arc::default(), pausa: AtomicBool::new(false), en_sesion: AtomicBool::new(false), traer: tokio::sync::Mutex::new(()) }
    }
}
impl SyncNativo {
    pub fn estado(&self) -> EstadoReplicacion { self.foto.lock().unwrap_or_else(|e| e.into_inner()).clone() }
    fn publicar(&self, app: &AppHandle, estado: &str, detalle: Option<String>) {
        let mut foto = self.foto.lock().unwrap_or_else(|e| e.into_inner());
        foto.revision += 1; foto.estado = estado.into(); foto.detalle = detalle;
        // `conectado` se publica justo después del saludo, que congela a las Handy; las suelta el
        // `recovery_ready` de la sesión (`handy_retenidas`). Fuera de `conectado` no se aplica.
        foto.handy_retenidas = estado == "conectado";
        let _ = app.emit("sync:estado", foto.clone());
    }
    pub fn reintentar(&self) { self.reintentar.notify_one(); self.despertar.notify_one(); }

    /// Codex (SYNC-36): traer la nube va de uno en uno. Dos a la vez se quitarían la pausa la una a
    /// la otra: la que termina antes reanudaría el motor con la otra todavía restaurando. La segunda
    /// no espera: se le dice que ya hay una en marcha.
    pub(crate) fn turno_para_traer_la_nube(&self) -> AppResult<tokio::sync::MutexGuard<'_, ()>> {
        self.traer
            .try_lock()
            .map_err(|_| AppError::conflict("Ya se están trayendo los datos de la nube: espera a que termine."))
    }

    /// Para el motor mientras se trae el estado de la nube, y espera a que termine la sesión que
    /// estuviera en marcha, normal o de recuperación (Codex, SYNC-36). Traer la nube con una sesión viva no es seguro: la
    /// restauración devuelve el checkpoint al `Seq` de su foto, y un cambio que esa sesión aplicara
    /// después en vivo lo llevaría más allá, saltándose los que la foto no traía y la sesión ya
    /// había aplicado sobre la base de antes. Despierta a la sesión para que mire en el momento si
    /// sigue disponible (`sigue_disponible`, que con la pausa dice que no), y si en `plazo` no ha
    /// terminado (un lote esperando su acuse), reanuda y falla sin haber tocado nada.
    pub(crate) async fn pausar_hasta_sin_sesion(&self, plazo: Duration) -> AppResult<()> {
        self.pausa.store(true, Ordering::SeqCst);
        let hasta = Instant::now() + plazo;
        while self.en_sesion.load(Ordering::SeqCst) {
            if Instant::now() >= hasta {
                self.reanudar();
                return Err(AppError::conflict(
                    "La conexión con la nube está terminando lo que tenía en marcha. Vuelve a intentarlo en un momento.",
                ));
            }
            self.despertar.notify_one();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }

    /// Quita la pausa y pide al motor que vuelva a mirar ya: tras traer la nube, para reconciliar.
    pub(crate) fn reanudar(&self) {
        self.pausa.store(false, Ordering::SeqCst);
        self.reintentar();
    }
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
    fn reservas_web(&self) { crate::reservas_web::pedir_recogida(&self.app); }
    fn fallo_subida(&self, op_id: &str, fallo: &OutboxFallo) {
        if fallo.apartada { tracing::error!(target:"tpv::sync", op_id, comando = %fallo.command_name, reparadas = fallo.reparadas, "operación apartada de la subida"); }
    }
    async fn completar_recuperacion(&self, high_water: i64) -> AppResult<()> {
        // La misma guardia nativa; ahora la cifra procede exclusivamente del HTTP autenticado.
        crate::commands::recovery::completar(&self.app.state::<AppState>(), high_water).await
    }
    async fn sigue_disponible(&self, recuperando: bool) -> AppResult<bool> {
        // Se está trayendo el estado de la nube (`SyncNativo::pausar_hasta_sin_sesion`).
        if self.app.state::<SyncNativo>().pausa.load(Ordering::SeqCst) { return Ok(false); }
        let state = self.app.state::<AppState>();
        if *state.mode.lock().await != Some(DeviceMode::Tpv) { return Ok(false); }
        let dir = self.app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
        if crate::load_config(&dir).connectivity == Some(ConnectivityMode::Off) { return Ok(false); }
        let db = state.db.lock().await.as_ref().cloned();
        let Some(db) = db else { return Ok(false); };
        let estado = tpv_infra_sqlite::recovery::status(&db).await?.state;
        Ok(estado == if recuperando {RecoveryState::ReconciliationPending} else {RecoveryState::Ready})
    }
    fn ritmo_de_subida(&self) -> Arc<RitmoDeSubida> { self.app.state::<SyncNativo>().ritmo.clone() }
    async fn subida(&self) -> AppResult<Option<Arc<dyn tpv_application::ports::subida_completa::SubidaCompleta>>> {
        // DO-SUBIDA: sobre la base de este equipo, creada para cada uso (no retiene la base).
        let db = self.app.state::<AppState>().db.lock().await.as_ref().cloned();
        Ok(db.map(|db| Arc::new(tpv_infra_sqlite::subida_completa::SqliteSubidaCompleta::new(db)) as Arc<dyn tpv_application::ports::subida_completa::SubidaCompleta>))
    }
    fn subida_pausada(&self) -> bool {
        crate::interruptores::apagado(&self.app, tpv_contracts::interruptores::Interruptor::SubidaNube).is_some()
    }
    fn handy_retenidas(&self, retenidas: bool) {
        let estado = self.app.state::<SyncNativo>();
        let mut foto = estado.foto.lock().unwrap_or_else(|e| e.into_inner());
        if foto.handy_retenidas == retenidas { return; }
        foto.revision += 1; foto.handy_retenidas = retenidas;
        let _ = self.app.emit("sync:estado", foto.clone());
    }
}

async fn sesion(app: &AppHandle, recuperando: bool) -> AppResult<uc::FinDeSesion> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let nube = PairingAdapter::new(dir);
    let ticket = nube.tpv_server_post_json("tpv", "/v1/ws/ticket", json!({})).await?;
    let ticket = ticket.get("ticket").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Respuesta sin ticket"))?;
    let mut canal = conectar(ticket, app.state::<SyncNativo>().despertar.clone()).await?;
    // AUD-15: el saludo congela a las Handy hasta que esta Main se ponga al día (`uc::saludar`).
    // DO-SUBIDA: el saludo trae, si la nube la pide, la petición de subida completa.
    let peticion = uc::saludar(&mut canal, |nonce| nube.firmar_hello("tpv", nonce)).await?;
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
    uc::ejecutar_con_saludo(&ctx, &nube, &mut canal, recuperando, peticion).await
}

pub(crate) fn arrancar(app: AppHandle) {
    app.manage(SyncNativo::default());
    app.manage(crate::reservas_web::RecogidaWeb::default());
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
            let mut detenida = false;
            if (disponible || recuperando) && con_licencia {
                runtime.publicar(&app, "conectando", None);
                // Lo mira `pausar_hasta_sin_sesion` antes de traer la nube, también para la de
                // recuperación, que al terminar sigue replicando en vivo. Se anota la sesión y
                // DESPUÉS se mira la pausa (quien pausa hace lo contrario): una de las dos partes ve
                // a la otra, y no hay hueco entre mirar `disponible` arriba y empezar.
                runtime.en_sesion.store(true, Ordering::SeqCst);
                let fin = if runtime.pausa.load(Ordering::SeqCst) {
                    Ok(uc::FinDeSesion::NoDisponible)
                } else {
                    sesion(&app, recuperando).await
                };
                runtime.en_sesion.store(false, Ordering::SeqCst);
                match fin {
                    Ok(uc::FinDeSesion::NoDisponible) => { retardo = 3; fallos = 0; espera = 1; }
                    // AUD-19: a esta base le falta lo que la nube ya purgó. Reconectar no lo
                    // arregla. SYNC-32: el caso de uso ya la ha pasado a recuperarse de la nube
                    // (escrituras cerradas, lo pendiente se guarda aparte al traerla); la pantalla
                    // se entera por este `detenida` y relee el estado de la recuperación. Se espera
                    // a que se pida reintentar, que es lo que hace la recuperación al terminar.
                    Ok(uc::FinDeSesion::AnteriorAlLog) => {
                        runtime.publicar(&app, "detenida", Some(uc::MOTIVO_ANTERIOR_AL_LOG.into()));
                        detenida = true;
                    }
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
            if fallos >= 5 || detenida {
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

#[cfg(test)]
mod tests_pausa {
    //! Codex (SYNC-36): traer la nube con el motor parado. La pausa espera a que acabe la sesión
    //! en marcha, y si no acaba a tiempo se deshace sin haber tocado nada; y va de una en una.
    use super::*;

    #[tokio::test]
    async fn la_pausa_espera_a_que_acabe_la_sesion_normal() {
        let motor = Arc::new(SyncNativo::default());
        motor.en_sesion.store(true, Ordering::SeqCst);
        let sesion = motor.clone();
        let fin = tokio::spawn(async move {
            // La sesión, despertada, mira si sigue disponible: con la pausa, no.
            sesion.despertar.notified().await;
            assert!(sesion.pausa.load(Ordering::SeqCst));
            sesion.en_sesion.store(false, Ordering::SeqCst);
        });
        motor.pausar_hasta_sin_sesion(Duration::from_secs(5)).await.unwrap();
        fin.await.unwrap();
        assert!(motor.pausa.load(Ordering::SeqCst), "sigue parado mientras se trae la nube");
        motor.reanudar();
        assert!(!motor.pausa.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn si_la_sesion_no_acaba_a_tiempo_se_deshace_la_pausa_y_falla() {
        let motor = SyncNativo::default();
        motor.en_sesion.store(true, Ordering::SeqCst);
        let e = motor.pausar_hasta_sin_sesion(Duration::from_millis(250)).await.unwrap_err();
        assert!(e.to_string().contains("Vuelve a intentarlo"), "{e}");
        assert!(!motor.pausa.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn traer_la_nube_va_de_uno_en_uno() {
        let motor = SyncNativo::default();
        let turno = motor.turno_para_traer_la_nube().unwrap();
        let e = motor.turno_para_traer_la_nube().unwrap_err();
        assert!(e.to_string().contains("Ya se están trayendo"), "{e}");
        drop(turno);
        assert!(motor.turno_para_traer_la_nube().is_ok());
    }

    #[tokio::test]
    async fn sin_sesion_en_marcha_no_espera() {
        let motor = SyncNativo::default();
        motor.pausar_hasta_sin_sesion(Duration::from_millis(1)).await.unwrap();
        assert!(motor.pausa.load(Ordering::SeqCst));
    }
}
