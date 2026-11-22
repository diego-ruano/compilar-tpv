//! Comandos del **reloj del equipo** (RELOJ-01, capa fina sobre `use_cases::pairing`).
//!
//! Sin sesión a propósito: la franja que avisa de un reloj desfasado cuelga por encima de todo,
//! también del login y de la espera de la Handy, que es justo cuando una hora mal puesta se nota
//! (la nube rechaza lo que se firma con ella). Sólo lee una medida en memoria: no escribe nada ni
//! sale a la red.

use tauri::{AppHandle, Manager};

use tpv_application::use_cases::pairing as uc;
use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::licensing::DesfaseReloj;
use tpv_infra_licensing::PairingAdapter;

/// RELOJ-01: cuánto se aparta la hora de este equipo de la de la nube, según la última respuesta
/// del worker. Lo enseña `AvisoReloj`; no corrige nada.
#[tauri::command(async)]
#[specta::specta]
pub fn reloj_desfase(app: AppHandle) -> Result<DesfaseReloj, AppErrorDto> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    Ok(uc::desfase_del_reloj(&PairingAdapter::new(dir)))
}
