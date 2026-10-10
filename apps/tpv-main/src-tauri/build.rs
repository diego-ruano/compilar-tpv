fn main() {
    // `option_env!("TPV_SENTRY_DSN")` se resuelve al COMPILAR. Sin esta línea, cargo no considera
    // que el build dependa de esa variable: pones el DSN, recompila "sin cambios" y la app se queda
    // sin Sentry hasta que alguien toca un .rs o hace `cargo clean`. Un fallo que se diagnostica
    // muy tarde y siempre en el peor momento.
    println!("cargo:rerun-if-env-changed=TPV_SENTRY_DSN");
    println!("cargo:rerun-if-env-changed=SENTRY_RELEASE");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    let target = std::env::var("TARGET").expect("Cargo define TARGET");
    let variant = if target.contains("win7") { "win7" } else if target.contains("android") { "android" } else { "windows-modern" };
    let name = if variant == "win7" { "tpv-desktop-win7" } else { "tpv-desktop" };
    let release = format!("{name}@{}", std::env::var("CARGO_PKG_VERSION").unwrap());
    if let Ok(configured) = std::env::var("SENTRY_RELEASE") {
        assert_eq!(configured, release, "SENTRY_RELEASE no coincide con la versión y el target");
    }
    println!("cargo:rustc-env=TPV_SENTRY_RELEASE={release}");
    println!("cargo:rustc-env=TPV_BUILD_VARIANT={variant}");
    if let Ok(commit) = std::env::var("GITHUB_SHA") {
        if commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            println!("cargo:rustc-env=TPV_BUILD_COMMIT={commit}");
        }
    }

    // El icono de la ventana y el de la barra de tareas se incrustan en el binario desde `icons/`,
    // pero tauri-build no le dice a cargo que dependa de esa carpeta: se regeneran los iconos,
    // `pnpm tauri dev` recompila "sin cambios" y el .exe sigue saliendo con el logo anterior.
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
