//! Comandos Tauri de **licensing** (capa fina hexagonal). No SQLite: el adaptador usa
//! keyring + `license_state.json` (en AppData) + HTTP al worker de licencias.
//! Mismos nombres de invoke que el monolito previo.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use tpv_application::use_cases::licensing as uc;
use tpv_contracts::licensing::{
    LicenseActivateInput, LicenseActivateOutcome, LicenseDeviceChangeInput, LicenseGateResult,
    LicenseLocalState, LicenseSumarClaveInput,
};
use tpv_infra_licensing::LicensingAdapter;
use tpv_contracts::errors::AppErrorDto;

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/// `pub(crate)` porque el job periódico de licencia (`jobs/registro.rs`) construye el mismo
/// servicio: el pulso de fondo y los comandos de la UI deben hablar con el MISMO adaptador.
pub(crate) fn svc(app: &AppHandle) -> Result<LicensingAdapter, String> {
    Ok(LicensingAdapter::new(app_data_dir(app)?))
}

#[tauri::command(async)]
#[specta::specta]
pub fn license_get_state(app: AppHandle) -> Result<Option<LicenseLocalState>, AppErrorDto> {
    Ok(uc::get_state(&svc(&app)?)?)
}

#[tauri::command(async)]
#[specta::specta]
pub fn license_clear_state(app: AppHandle) -> Result<String, AppErrorDto> {
    uc::clear_state(&svc(&app)?)?;
    Ok("OK".into())
}

#[tauri::command]
#[specta::specta]
pub async fn license_gate(app: AppHandle) -> Result<LicenseGateResult, AppErrorDto> {
    // Notifier (mode-switched) para avisar de licencia por caducar / caducada-en-gracia / gracia
    // offline. `None` si aún no hay modo/BD → no se avisa. La decisión del gate NO depende de esto.
    let notifier = app.state::<crate::AppState>().notifier().await.ok();
    let service = svc(&app)?;
    Ok(uc::gate(&service, notifier.as_deref()).await?)
}

/// RI-52: añade el tiempo de otra clave a la licencia de este equipo (Configuración → Licencia).
///
/// De administrador: es la pantalla de Configuración, y gastar una clave pagada no es algo que
/// haga cualquiera a mitad de servicio. Después se comprueba la licencia contra el servidor, como
/// `license_check_now`, para que la caducidad nueva llegue firmada y la vea toda la interfaz.
#[tauri::command]
#[specta::specta]
pub async fn license_sumar_clave(
    app: AppHandle,
    args: LicenseSumarClaveInput,
) -> Result<LicenseActivateOutcome, AppErrorDto> {
    app.state::<crate::AppState>().exigir_rol(&[crate::ADMIN]).await?;
    let service = svc(&app)?;
    // AUD-06: en el turno de las activaciones, y no con un cambio de negocio pendiente.
    let db = app.state::<crate::AppState>().db.lock().await.as_ref().cloned();
    let base = tpv_infra_sqlite::recovery::BaseLocal::new(&app_data_dir(&app)?, db);
    let outcome = uc::sumar_clave(&service, &base, args.activation_key).await?;

    // Best-effort: el tiempo ya está sumado; si la comprobación falla, el pulso lo traerá.
    if let Ok(res) = uc::check_now(&service).await {
        let _ = app.emit("license:changed", res);
    }
    Ok(outcome)
}

/// Comprueba la licencia contra el servidor AHORA, sin esperar al pulso del job.
///
/// Emite `license:changed` con el resultado, igual que hace el job: quien llame a esto puede no ser
/// la pantalla —lo llama también el WebSocket cuando la nube le rechaza el ticket por licencia—, y
/// sin el evento el veredicto se quedaba en el fichero de estado mientras la interfaz seguía
/// vendiendo tan tranquila hasta la siguiente vuelta del job, seis horas después.
#[tauri::command]
#[specta::specta]
pub async fn license_check_now(app: AppHandle) -> Result<LicenseGateResult, AppErrorDto> {
    let res = uc::check_now(&svc(&app)?).await?;

    // Best-effort: que no se pueda avisar a la ventana no invalida la comprobación.
    if let Err(e) = app.emit("license:changed", res.clone()) {
        tracing::warn!(target: "tpv::licensing", error = %e, "no se pudo emitir license:changed");
    }

    Ok(res)
}

/// Si la activación trasladó la licencia desde otro equipo, lo que hubiera en la base local es de
/// antes del traslado: se marca para reconstruirla desde la nube (`recovery::marcar_traslado`) y se
/// cierran ya las escrituras de negocio, antes de que la aplicación arranque nada encima.
#[tauri::command]
#[specta::specta]
pub async fn license_activate(
    app: AppHandle,
    args: LicenseActivateInput,
) -> Result<LicenseActivateOutcome, AppErrorDto> {
    let service = svc(&app)?;
    // AUD-06: el caso de uso decide con el sello de la base abierta (o del fichero, si no hay).
    let state = app.state::<crate::AppState>();
    let db = state.db.lock().await.as_ref().cloned();
    let base = tpv_infra_sqlite::recovery::BaseLocal::new(&app_data_dir(&app)?, db);
    let outcome = uc::activate(&service, &base, args).await?;

    // AUD-06: la licencia es de otro negocio que la base. Se ha guardado como pendiente, sin tocar
    // la vigente: hasta que el proceso acabe, todo sigue siendo del negocio anterior, con sus
    // credenciales. El TPV se reinicia, y el arranque aparta los datos del anterior y aplica la
    // licencia nueva antes de abrir nada. La pantalla avisa mientras tanto.
    if outcome.reinicia {
        reiniciar_en_unos_segundos(app.clone());
        return Ok(outcome);
    }

    // RI-56: el `tenant_id` es el número de instalación de cada registro de facturación, y en un
    // equipo recién instalado `setup()` corrió antes de que existiera. Sin esto, todo lo facturado
    // hasta el siguiente reinicio salía con `NumeroInstalacion` vacío.
    //
    // Y la etiqueta de Sentry, por lo mismo: `setup()` la lee del mismo fichero, así que en un
    // equipo recién estrenado los errores salían sin negocio hasta el siguiente reinicio.
    if let Ok(Some(st)) = uc::get_state(&service) {
        if !st.tenant_id.is_empty() {
            tpv_infra_sqlite::verifactu::set_numero_instalacion(&st.tenant_id);
            tpv_telemetry::set_tenant(st.tenant_id);
        }
    }

    Ok(outcome)
}

/// Pide al servidor que envíe el OTP de cambio de dispositivo al email de la licencia.
#[tauri::command]
#[specta::specta]
pub async fn license_request_device_change(
    app: AppHandle,
    args: LicenseDeviceChangeInput,
) -> Result<String, AppErrorDto> {
    uc::request_device_change(&svc(&app)?, args).await?;
    Ok("OK".into())
}

/// AUD-06 · Reinicia el TPV dentro de unos segundos, el tiempo de que la pantalla enseñe el aviso.
#[cfg(desktop)]
fn reiniciar_en_unos_segundos(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        tracing::info!(target: "tpv::licensing", "licencia de otro negocio: el TPV se reinicia");
        app.restart();
    });
}

/// En la Handy no se activa ninguna licencia de Main; si llegara aquí, el cambio pendiente lo
/// resuelve el siguiente arranque.
#[cfg(not(desktop))]
fn reiniciar_en_unos_segundos(_app: AppHandle) {}
