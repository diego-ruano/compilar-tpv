//! Comandos Tauri de **pairing / identidad de dispositivo** (capa fina hexagonal).
//! No SQLite: keyring (clave ed25519 + handy token) + HTTP a tpv-server.
//! El `AppHandle` lo inyecta Tauri (no viaja desde JS): se usa sólo para resolver AppData,
//! necesario cuando el modo `tpv` firma con el token de `license_state.json`.

use std::path::PathBuf;

use tpv_contracts::json::JsonDinamico;
use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::pairing as uc;
use tpv_contracts::licensing::{
    DeviceIdentity, DeviceFirmarEmparejamientoArgs, HandySetTokenArgs,
    PairCreateResult, FirmaDispositivo, TpvServerPostJsonArgs,
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


fn ruta_permitida(modo: Option<crate::DeviceMode>, mode: &str, path: &str) -> bool {
    match mode {
        "anon" => PAIRING_SIN_SESION.contains(&path),

        "tpv" => modo == Some(crate::DeviceMode::Tpv) && ["/v1/pair/pending", "/v1/pair/approve", "/v1/pair/reject", "/v1/device/list", "/v1/device/revoke"].contains(&path),
        _ => false,
    }
}

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
#[specta::specta]
pub async fn handy_set_token(app: AppHandle, state: State<'_, AppState>, args: HandySetTokenArgs) -> Result<String, AppErrorDto> {
    let service = svc(&app)?;
    state.cerrar_sesion().await;
    uc::handy_set_token(&service, args)?;
    crate::socket_handy::contexto_cambiado(&app);

    // La etiqueta de Sentry sale del token, y `setup()` sólo la lee al arrancar: una Handy recién
    // vinculada mandaba sus errores sin negocio hasta el siguiente reinicio.
    if let Ok(Some(tenant)) = uc::handy_get_tenant(&service) {
        if !tenant.is_empty() {
            tpv_telemetry::set_tenant(tenant);
        }
    }
    Ok("OK".into())
}

#[tauri::command(async)]
#[specta::specta]
pub fn handy_get_tenant(app: AppHandle) -> Result<Option<String>, AppErrorDto> {
    Ok(uc::handy_get_tenant(&svc(&app)?)?)
}

/// INFRA-03 · De dónde pinta la Handy las imágenes de su negocio: `{CLOUD_API_BASE}/v1/images/{negocio}`
/// (`tpv_infra_licensing::url_imagenes_del_negocio`), sin la `Ruta_Imagen`, que pone `imageUrl.ts`.
/// `None` si no está vinculada. La dirección del worker sale del backend, la misma de la API, y no
/// se escribe otra vez en el frontend.
#[tauri::command(async)]
#[specta::specta]
pub fn handy_url_imagenes(app: AppHandle) -> Result<Option<String>, AppErrorDto> {
    Ok(uc::handy_get_tenant(&svc(&app)?)?.and_then(|negocio| tpv_infra_licensing::url_imagenes_del_negocio(&negocio)))
}


#[tauri::command(async)]
#[specta::specta]
pub fn device_get_identity(app: AppHandle) -> Result<DeviceIdentity, AppErrorDto> {
    Ok(uc::device_identity(&svc(&app)?)?)
}

#[tauri::command(async)]
#[specta::specta]
pub fn device_firmar_emparejamiento(app: AppHandle, args: DeviceFirmarEmparejamientoArgs) -> Result<FirmaDispositivo, AppErrorDto> {
    Ok(uc::firmar_emparejamiento(&svc(&app)?, args)?)
}

/// PROD-04: la hora con la que el frontend firma el saludo del WebSocket y el emparejamiento. Es
/// la de la nube, no la del equipo: con un reloj desfasado más de 2 min la nube rechaza la firma.
/// Sin sesión, como los comandos de firma acotada: se usa en el emparejamiento de la Handy, antes de que nadie
/// entre.
#[tauri::command(async)]
#[specta::specta]
pub fn device_hora_para_firmar(app: AppHandle) -> Result<i64, AppErrorDto> {
    Ok(uc::hora_para_firmar(&svc(&app)?))
}

#[tauri::command]
#[specta::specta]
pub async fn tpv_server_post_json(
    app: AppHandle,
    state: State<'_, AppState>,
    args: TpvServerPostJsonArgs,
) -> Result<JsonDinamico, AppErrorDto> {
    // RI-57: lista exacta de capacidades UI. El modo y las rutas de réplica no los elige JS.
    let modo = *state.mode.lock().await;
    let permitido = ruta_permitida(modo, &args.mode, &args.path);
    if !permitido { return Err(crate::permiso_denegado("Esta ruta no está disponible desde la interfaz")); }
    if ruta_de_administracion(&args.path) {
        state.exigir_rol(&[ADMIN]).await?;
    }
    Ok(JsonDinamico(uc::tpv_server_post_json(&svc(&app)?, args).await?))
}

/// Genera un nuevo código de emparejamiento (lo pide al worker) y lo devuelve tipado a la UI.
///
/// SEC-01: es la otra mitad de la administración de dispositivos —lo llama únicamente
/// Configuración → Vincular Handy—, así que va con el mismo candado que las rutas de
/// `/v1/pair/…` del proxy. Repartir un código de emparejamiento es dar acceso al negocio.
#[tauri::command]
#[specta::specta]
pub async fn pair_create(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PairCreateResult, AppErrorDto> {
    state.exigir_rol(&[ADMIN]).await?;
    Ok(uc::pair_create(&svc(&app)?).await?)
}

// AUD-24: aquí estaba `config_upload_initial_setup`, que subía a la nube el PIN que le dijeran para
// el usuario que le dijeran, sin sesión ni `Requiere_Setup`. Sobraba: el `UPDATE` del setup local
// ya sube por el outbox (`complete_initial_setup`). Lo vigila
// `lib.rs::los_comandos_retirados_no_vuelven_por_la_puerta_de_atras`.

#[cfg(test)]
mod tests_gate_del_proxy {
    //! Qué rutas del proxy genérico piden ser administrador (SEC-01).
    //!
    //! La función es pura, así que se prueba sin Tauri ni red. Lo que se comprueba no es la
    //! tabla —eso sería el código diciendo que es igual a sí mismo— sino las dos propiedades
    //! que sostienen la decisión: que el emparejamiento sin sesión siga pasando, y que no se
    //! pueda esquivar el candado escribiendo la ruta de otra manera.

    use super::{ruta_de_administracion, ruta_permitida};

    #[test]
    fn el_proxy_no_da_acceso_a_replica_ni_a_rutas_reescritas() {
        use crate::DeviceMode;
        assert!(!ruta_permitida(Some(DeviceMode::Handy), "handy", "/v1/ws/ticket"));
        assert!(!ruta_permitida(Some(DeviceMode::Tpv), "handy", "/v1/ws/ticket"));
        for p in ["/v1/sync/changes", "/v1/ws/ticket", "/v1/pair/pending?x=1", "/v1/pair/../sync/changes", "/v1/pair/%2e%2e/sync/changes"] {
            assert!(!ruta_permitida(Some(DeviceMode::Tpv), "tpv", p));
        }
    }

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
