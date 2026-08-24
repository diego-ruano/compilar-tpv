fn main() {
    // `option_env!("TPV_SENTRY_DSN")` se resuelve al COMPILAR. Sin esta línea, cargo no considera
    // que el build dependa de esa variable: pones el DSN, recompila "sin cambios" y la app se queda
    // sin Sentry hasta que alguien toca un .rs o hace `cargo clean`. Un fallo que se diagnostica
    // muy tarde y siempre en el peor momento.
    println!("cargo:rerun-if-env-changed=TPV_SENTRY_DSN");

    tauri_build::build()
}
