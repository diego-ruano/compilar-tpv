//! Comandos Tauri de **pairing / identidad de dispositivo** (capa fina hexagonal).
//! No SQLite: keyring (clave ed25519 + handy token) + HTTP a tpv-server.
//! El `AppHandle` lo inyecta Tauri (no viaja desde JS): se usa sólo para resolver AppData,
//! necesario cuando el modo `tpv` firma con el token de `license_state.json`.

use std::path::PathBuf;

use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::cloud_sync as uc_sync;
use tpv_application::use_cases::pairing as uc;
use tpv_contracts::licensing::{
    DeviceIdentity, DeviceSignB64Args, HandySetTokenArgs, HandyWsAuth,
    PairCreateResult, SigB64, TpvServerPostJsonArgs, UploadInitialSetupArgs,
};
use tpv_infra_licensing::PairingAdapter;
use tpv_contracts::errors::AppErrorDto;

use crate::{AppState, ADMIN};

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

fn svc(app: &AppHandle) -> Result<PairingAdapter, String> {
    Ok(PairingAdapter::new(app_data_dir(app)?))
}

/* ── SEC-01: el gate del proxy genérico ──────────────────────────────────────────────────────

   `tpv_server_post_json` es un transporte, no un comando de negocio: firma lo que le den y lo
   manda. Por él viajan a la vez el emparejamiento de un Handy —que ocurre ANTES de que nadie
   inicie sesión— y la administración de dispositivos de Configuración: aprobar, listar y
   revocar. Sin gate, un camarero podía revocar un Handy escribiendo la ruta; con un gate a
   secas, un equipo nuevo no podría emparejarse jamás.

   Por eso la regla va **por ruta y fallando cerrado**: todo `/v1/pair/…` y `/v1/device/…`
   exige Administrador, salvo los pasos del emparejamiento que el Handy da sin sesión. Es
   un prefijo y no una lista de rutas exactas a propósito: una ruta de administración que se
   añada mañana queda cubierta sola, que es lo contrario de lo que hace una lista blanca. */

/// Los pasos que da el Handy que se está emparejando, cuando todavía no hay sesión que
/// exigirle: reclamar el código, recoger el token y cancelar la espera. Van firmados como `anon`,
/// así que el worker sólo les deja llegar hasta aquí (y los dos últimos, firmados además por la
/// clave del dispositivo que reclamó).
const PAIRING_SIN_SESION: [&str; 3] = ["/v1/pair/claim", "/v1/pair/fetch-token", "/v1/pair/cancel"];

/// ¿Esta ruta del proxy es administración de dispositivos?
///
/// Normaliza antes de decidir (query, mayúsculas, barra final): la ruta la escribe quien llama,
/// y un gate que se esquiva escribiendo `/v1/device/revoke/` no es un gate.
fn ruta_de_administracion(path: &str) -> bool {
    let p = path.split(['?', '#']).next().unwrap_or("").trim().to_ascii_lowercase();
    let p = p.trim_end_matches('/');

    if PAIRING_SIN_SESION.contains(&p) {
        return false;
    }
    // LOGIN-08: cambiar a dónde llegan los códigos de recuperación es de administrador, y el worker
    // no conoce las sesiones. Sin esto, llamarlo por el proxy esquivaba el gate de sus comandos.
    p.starts_with("/v1/pair/")
        || p.starts_with("/v1/device/")
        || p.starts_with("/v1/login/correo-recuperacion/")
}

#[tauri::command]
pub fn handy_set_token(app: AppHandle, args: HandySetTokenArgs) -> Result<String, AppErrorDto> {
    let service = svc(&app)?;
    uc::handy_set_token(&service, args)?;

    // La etiqueta de Sentry sale del token, y `setup()` sólo la lee al arrancar: una Handy recién
    // vinculada mandaba sus errores sin negocio hasta el siguiente reinicio.
    if let Ok(Some(tenant)) = uc::handy_get_tenant(&service) {
        if !tenant.is_empty() {
            tpv_telemetry::set_tenant(tenant);
        }
    }
    Ok("OK".into())
}

#[tauri::command]
pub fn handy_get_tenant(app: AppHandle) -> Result<Option<String>, AppErrorDto> {
    Ok(uc::handy_get_tenant(&svc(&app)?)?)
}

/// Credenciales (token + tenant) para abrir el WebSocket del Handy (`/ws?token=`).
#[tauri::command]
pub fn handy_get_ws_auth(app: AppHandle) -> Result<HandyWsAuth, AppErrorDto> {
    Ok(uc::handy_get_ws_auth(&svc(&app)?)?)
}

#[tauri::command]
pub fn device_get_identity(app: AppHandle) -> Result<DeviceIdentity, AppErrorDto> {
    Ok(uc::device_identity(&svc(&app)?)?)
}

#[tauri::command]
pub fn device_sign_b64(app: AppHandle, args: DeviceSignB64Args) -> Result<SigB64, AppErrorDto> {
    Ok(uc::device_sign_b64(&svc(&app)?, args)?)
}

/// PROD-04: la hora con la que el frontend firma el saludo del WebSocket y el emparejamiento. Es
/// la de la nube, no la del equipo: con un reloj desfasado más de 2 min la nube rechaza la firma.
/// Sin sesión, como `device_sign_b64`: se usa en el emparejamiento de la Handy, antes de que nadie
/// entre.
#[tauri::command]
pub fn device_hora_para_firmar(app: AppHandle) -> Result<i64, AppErrorDto> {
    Ok(uc::hora_para_firmar(&svc(&app)?))
}

#[tauri::command]
pub async fn tpv_server_post_json(
    app: AppHandle,
    state: State<'_, AppState>,
    args: TpvServerPostJsonArgs,
) -> Result<JsonValue, AppErrorDto> {
    if ruta_de_administracion(&args.path) {
        state.exigir_rol(&[ADMIN]).await?;
    }
    Ok(uc::tpv_server_post_json(&svc(&app)?, args).await?)
}

/// Genera un nuevo código de emparejamiento (lo pide al worker) y lo devuelve tipado a la UI.
///
/// SEC-01: es la otra mitad de la administración de dispositivos —lo llama únicamente
/// Configuración → Vincular Handy—, así que va con el mismo candado que las rutas de
/// `/v1/pair/…` del proxy. Repartir un código de emparejamiento es dar acceso al negocio.
#[tauri::command]
pub async fn pair_create(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PairCreateResult, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    Ok(uc::pair_create(&svc(&app)?).await?)
}

/// Sube a la nube el setup inicial del admin tras completarlo en local (panel de
/// configuración inicial). El `PairingAdapter` firma la petición como dispositivo TPV.
#[tauri::command]
pub async fn config_upload_initial_setup(
    app: AppHandle,
    args: UploadInitialSetupArgs,
) -> Result<String, AppErrorDto> {
    uc_sync::upload_initial_setup(&svc(&app)?, args).await?;
    Ok("OK".into())
}

#[cfg(test)]
mod tests_gate_del_proxy {
    //! Qué rutas del proxy genérico piden ser administrador (SEC-01).
    //!
    //! La función es pura, así que se prueba sin Tauri ni red. Lo que se comprueba no es la
    //! tabla —eso sería el código diciendo que es igual a sí mismo— sino las dos propiedades
    //! que sostienen la decisión: que el emparejamiento sin sesión siga pasando, y que no se
    //! pueda esquivar el candado escribiendo la ruta de otra manera.

    use super::ruta_de_administracion;

    #[test]
    fn administrar_dispositivos_pide_permiso() {
        for p in [
            "/v1/device/revoke",
            "/v1/device/list",
            "/v1/pair/approve",
            "/v1/pair/reject",
            "/v1/pair/pending",
            // Una ruta de administración que todavía no existe: el prefijo la cubre sola.
            "/v1/device/lo-que-venga",
        ] {
            assert!(ruta_de_administracion(p), "{p} debería exigir Administrador");
        }
    }

    /// LOGIN-08: el correo de recuperación tiene sus comandos con gate, pero el proxy firma lo que
    /// le den. Si no exigiera rol aquí, bastaría con llamar a la ruta por él.
    #[test]
    fn cambiar_el_correo_de_recuperacion_pide_permiso_tambien_por_el_proxy() {
        for p in [
            "/v1/login/correo-recuperacion/solicitar",
            "/v1/login/correo-recuperacion/confirmar",
            "/v1/login/correo-recuperacion/usar-el-de-la-compra",
            "/V1/Login/Correo-Recuperacion/Confirmar/",
        ] {
            assert!(ruta_de_administracion(p), "{p} debería exigir Administrador");
        }
        // Recuperar el PIN no: es justo para quien no puede iniciar sesión.
        assert!(!ruta_de_administracion("/v1/login/recuperar-pin/solicitar"));
    }

    /// El caso que impide el callejón sin salida: el Handy que se empareja no tiene sesión
    /// —ni puede tenerla— y estos pasos son todo su camino.
    #[test]
    fn los_pasos_del_emparejamiento_pasan_sin_sesion() {
        assert!(!ruta_de_administracion("/v1/pair/claim"));
        assert!(!ruta_de_administracion("/v1/pair/fetch-token"));
        assert!(!ruta_de_administracion("/v1/pair/cancel"));
    }

    /// El resto del worker no pasa por este gate: no es un candado a la nube entera.
    #[test]
    fn lo_que_no_es_administracion_de_dispositivos_no_se_toca() {
        for p in ["/v1/email/enviar-pedido", "/v1/sync/changes", "/v1/license/status", "", "/"] {
            assert!(!ruta_de_administracion(p), "{p} no debería exigir rol");
        }
    }

    /// La ruta la escribe quien llama. Si el gate se esquivara con una barra final, una query
    /// o unas mayúsculas, no sería un gate.
    #[test]
    fn no_se_esquiva_reescribiendo_la_ruta() {
        for p in [
            "/v1/device/revoke/",
            "/v1/device/revoke?x=1",
            "/V1/Device/Revoke",
            "  /v1/device/revoke  ",
            "/v1/device/revoke#frag",
        ] {
            assert!(ruta_de_administracion(p), "{p:?} debería seguir exigiendo rol");
        }
    }

    /// Y al revés: la exención tampoco puede depender de cómo se escriba, o el emparejamiento
    /// fallaría según de dónde salga la cadena.
    #[test]
    fn la_exencion_tambien_se_normaliza() {
        for p in ["/v1/pair/claim/", "/V1/PAIR/CLAIM", " /v1/pair/fetch-token "] {
            assert!(!ruta_de_administracion(p), "{p:?} debería seguir exento");
        }
    }
}
