//! Comandos de la **ventana de escritorio**: el tamaño de la interfaz (capa fina sobre `zoom.rs`).
//!
//! Sin sesión a propósito: el tamaño de la pantalla se ajusta también en el login. Es una
//! preferencia de este equipo, como la impresora, y no escribe nada de negocio.

use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::ventana::{CambioZoomArgs, ZoomVentana};

use crate::zoom;

#[tauri::command]
#[specta::specta]
pub async fn ventana_zoom_estado() -> Result<ZoomVentana, AppErrorDto> {
    Ok(zoom::actual())
}

/// Acercar o alejar lo fija a mano en este equipo; `automatico` lo devuelve al monitor.
#[tauri::command]
#[specta::specta]
pub async fn ventana_zoom_cambiar(app: AppHandle, args: CambioZoomArgs) -> Result<ZoomVentana, AppErrorDto> {
    let manual = zoom::tras_el_cambio(args.cambio);

    let dir = crate::app_data_dir_of(&app)?;
    let mut cfg = crate::load_config(&dir);
    cfg.zoom = manual;
    crate::save_config(&dir, &cfg)?;

    zoom::fijar_manual(manual);
    #[cfg(desktop)]
    if let Some(ventana) = app.get_webview_window("main") {
        zoom::aplicar(&ventana);
    }
    Ok(zoom::actual())
}
