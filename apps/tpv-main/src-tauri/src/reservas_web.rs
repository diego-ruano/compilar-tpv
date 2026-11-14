//! La recogida de las reservas web en la Main (docs/estudios/reservas-web.md §5.4).
//!
//! El motor de réplica la pide (al conectar, al terminar una recuperación y cuando la agenda avisa)
//! y aquí se lanza en segundo plano: va por REST y escribe en la base, y no puede retener el bucle
//! del socket ni sus confirmaciones. Una sola a la vez; si se pide mientras corre, se repite al
//! acabar, para no perder lo que llegó entretanto.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager};
use tpv_application::error::{AppError, AppResult};
use tpv_application::use_cases::reservas_web_recogida as uc;
use tpv_contracts::recovery::RecoveryState;
use tpv_contracts::sync::{CambioReplicado, ComandaReplicada};
use tpv_infra_licensing::PairingAdapter;

use crate::{AppState, ConnectivityMode, DeviceMode};

#[derive(Default)]
pub(crate) struct RecogidaWeb {
    corriendo: tokio::sync::Mutex<()>,
    pedida: AtomicBool,
}

/// Pide una recogida. No espera: vuelve en el acto.
pub(crate) fn pedir_recogida(app: &AppHandle) {
    let Some(estado) = app.try_state::<RecogidaWeb>() else { return };
    estado.pedida.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let estado = app.state::<RecogidaWeb>();
        loop {
            // Si ya hay una en marcha, ésa verá la petición al terminar su vuelta.
            let Ok(guarda) = estado.corriendo.try_lock() else { return };
            while estado.pedida.swap(false, Ordering::SeqCst) {
                if let Err(e) = recoger(&app).await {
                    // Sin datos de nadie: sólo el código. Lo pendiente se lo vuelve a ofrecer la agenda.
                    tracing::warn!(target: "tpv::reservas_web", codigo = ?e.code(), "no se han podido recoger las reservas web");
                }
            }
            drop(guarda);
            // Una petición que llegó justo al soltar el cerrojo no se queda sin atender.
            if !estado.pedida.load(Ordering::SeqCst) {
                return;
            }
        }
    });
}

async fn recoger(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    // Sólo una Main operativa: con sus datos, sin recuperación en curso (el cerrojo de la base lo
    // impediría igual) y con la conectividad encendida.
    if *state.mode.lock().await != Some(DeviceMode::Tpv) {
        return Ok(());
    }
    let db = state.db.lock().await.as_ref().cloned();
    let Some(db) = db else { return Ok(()) };
    if tpv_infra_sqlite::recovery::status(&db).await?.state != RecoveryState::Ready {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    if crate::load_config(&dir).connectivity == Some(ConnectivityMode::Off) {
        return Ok(());
    }
    let repo = state.reservas_web_repo().await.map_err(|e| AppError::repository(e.message))?;
    let notifier = state.notifier().await.ok();
    let nube = PairingAdapter::new(dir);

    let mut resumen = uc::ResumenRecogida::default();
    let resultado = uc::recoger(&nube, repo.as_ref(), notifier.as_deref(), &mut resumen).await;
    // Aunque haya fallado a mitad: lo apuntado ya está en la base.
    if resumen.hay_cambios() {
        avisar_de_lo_recogido(app, &resumen);
    }
    resultado
}

fn avisar_de_lo_recogido(app: &AppHandle, resumen: &uc::ResumenRecogida) {
    tracing::info!(
        target: "tpv::reservas_web",
        registradas = resumen.registradas,
        solapadas = resumen.solapadas,
        canceladas = resumen.canceladas,
        fallidas = resumen.fallidas,
        "reservas web recogidas"
    );
    // Que la pantalla recargue el calendario, los clientes y los avisos…
    let _ = app.emit(
        "sync:cambio",
        CambioReplicado {
            tablas: Some(vec!["reservas".into(), "clientes".into(), "notificaciones".into()]),
            comanda: ComandaReplicada { ids: vec![], touched_comanda: false, uncertain: false, touched_catalog: false },
        },
    );
    // …y que el motor suba ya lo registrado: hasta que llega a la nube, la agenda no lo da por visto.
    app.state::<crate::replicacion::SyncNativo>().despertar.notify_one();
}
