// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Toda la app vive en la crate de librería `tpv_lib` (src/lib.rs), que es el punto de entrada
// compartido: en escritorio este binario la arranca; en móvil el cdylib `libtpv_lib.so` usa su
// `#[tauri::mobile_entry_point] run()`. Mantener este shim mínimo. Ver lib.rs.
fn main() {
    // RI-87: reutiliza el binario con el manifiesto nativo de Tauri (también en Windows).
    // La generación no arranca la webview ni los servicios del negocio.
    let mut argumentos = std::env::args_os().skip(1);
    if argumentos.next().as_deref() == Some(std::ffi::OsStr::new("--export-bindings")) {
        let destino = argumentos.next().expect("Falta la ruta de los bindings");
        tpv_lib::exportar_contratos(std::path::Path::new(&destino)).expect("No se pudieron generar los contratos");
        return;
    }
    tpv_lib::run();
}
