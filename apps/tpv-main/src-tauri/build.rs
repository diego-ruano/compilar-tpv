fn main() {
    // `option_env!("TPV_SENTRY_DSN")` se resuelve al COMPILAR. Sin esta línea, cargo no considera
    // que el build dependa de esa variable: pones el DSN, recompila "sin cambios" y la app se queda
    // sin Sentry hasta que alguien toca un .rs o hace `cargo clean`. Un fallo que se diagnostica
    // muy tarde y siempre en el peor momento.
    println!("cargo:rerun-if-env-changed=TPV_SENTRY_DSN");

    // El icono de la ventana y el de la barra de tareas se incrustan en el binario desde `icons/`,
    // pero tauri-build no le dice a cargo que dependa de esa carpeta: se regeneran los iconos,
    // `pnpm tauri dev` recompila "sin cambios" y el .exe sigue saliendo con el logo anterior.
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
