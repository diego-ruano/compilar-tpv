//! Observación y reintento del servicio. Disponibles antes del login; no aceptan identidad ni SQL.
use tauri::{AppHandle, Manager};
use tpv_contracts::socket_handy::EstadoSocketHandy;

#[tauri::command(async)]
#[specta::specta]
pub fn handy_socket_estado(app: AppHandle) -> EstadoSocketHandy {
    app.state::<crate::socket_handy::HandyNativo>().estado()
}

#[tauri::command(async)]
#[specta::specta]
pub fn handy_socket_reintentar(app: AppHandle, forzar: bool) {
    app.state::<crate::socket_handy::HandyNativo>().reintentar(&app, forzar);
}
