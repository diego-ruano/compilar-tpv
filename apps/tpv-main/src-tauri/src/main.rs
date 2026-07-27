// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Toda la app vive en la crate de librería `tpv_lib` (src/lib.rs), que es el punto de entrada
// compartido: en escritorio este binario la arranca; en móvil el cdylib `libtpv_lib.so` usa su
// `#[tauri::mobile_entry_point] run()`. Mantener este shim mínimo. Ver lib.rs.
fn main() {
    tpv_lib::run();
}
