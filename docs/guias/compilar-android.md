# Compilar para Android (modo Handy)

La aplicación es un solo binario con todos los modos. En Android se usa como **Handy**: lee y escribe
por la nube, sin base local en uso, sin imprimir, sin licencia de Main y sin updater. Está validado en
emulador (identidad que persiste tras reiniciar, emparejamiento, REST y WebSocket).

## Cómo está montado

- **Toda la app vive en la crate de librería `tpv_lib`** (`apps/tpv-main/src-tauri/src/lib.rs`), con
  `run()` marcado `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. En móvil Tauri arranca por el cdylib
  `libtpv_lib.so`; `main.rs` es sólo el shim del escritorio (`fn main() { tpv_lib::run() }`).
- **Lo que sólo existe en escritorio va como dependencia por plataforma** en
  `apps/tpv-main/src-tauri/Cargo.toml`
  (`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`):
  `tauri-plugin-updater`, `tauri-plugin-sentry` (con el minidump) y `tauri-plugin-single-instance`. En el
  código, sus usos van con `#[cfg(desktop)]` (el job `updater`, los comandos `updater_*`, el minidump).
- **Sus permisos van en `capabilities/desktop.json`**, con `"platforms": ["linux", "macOS", "windows"]`:
  en Android un permiso de un plugin que no está compilado rompe el build (`Permission updater:default
  not found`). Todo permiso de un plugin de escritorio va ahí.
- **`libsql` se compila igual** (el `AppState` nombra los repositorios SQLite): `libsql = { version =
  "0.9.30", default-features = false, features = ["core"] }` en el `Cargo.toml` raíz, sólo base de
  fichero local.
- **Sin OpenSSL**: `sentry` va con `default-features = false` y `rustls`. Para encontrar quién activa una
  dependencia nativa: `cargo tree -p tpv --target aarch64-linux-android -i <crate> -e features`.
- **El almacén de secretos** (`crates/tpv-infra-licensing/src/secret_store.rs`) tiene la misma API en las
  dos plataformas: `keyring` en escritorio; en Android, una clave AES-256-GCM no exportable en el
  **Android Keystore** y los valores cifrados en SharedPreferences privadas, por JNI a clases del framework
  (sin AndroidX, sin Kotlin, sin tocar `gen/android`). La `JavaVM` la entrega `JNI_OnLoad`, que tiene que
  estar en el cdylib (`lib.rs`), y el `Context` sale de `ActivityThread.currentApplication()`.
  `ndk_context` no sirve (Tauri no lo inicializa) ni `JNI_GetCreatedJavaVMs` (el linker de Android no lo
  expone). Una excepción de Java que deja una llamada fallida se trata y se limpia en `with_env` antes de
  soltar el hilo (RI-75): con una pendiente, la siguiente llamada JNI es ilegal.
- **Comprobar que compila** sin el proyecto Android entero:
  `cargo clippy -p tpv-infra-licensing --target aarch64-linux-android`, con `CC_aarch64_linux_android` y
  `AR_aarch64_linux_android` apuntando al `clang` y al `llvm-ar` del NDK.
- **Imprimir** no está disponible fuera de Windows (`printing.rs` tiene un stub `#[cfg(not(windows))]`
  que devuelve error).
- **Logs**: `android_logger` con la etiqueta `TPVRust`, nivel Info (a Trace, la crate `jni` inunda logcat
  y el sistema mata la app). `adb logcat -d -s TPVRust`.
- **Actualizaciones**: por Google Play, no por el updater.

Proyecto Android: `apps/tpv-main/src-tauri/gen/android/` (`applicationId` `com.altarialights.tpv`,
`minSdk` 24, `compileSdk`/`targetSdk` 36, ABIs `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`). No hay job de
Android en CI.

## Conectividad al probar Main y Handy

La Main intenta conectar automáticamente cuando está en modo `tpv`, tiene licencia aprovisionada
y una base lista o en reconciliación. No hay que elegir «online» en la interfaz. La palanca técnica
`connectivity: "off"` de `device_config.json` puede pausar esa conexión; si el campo falta, vale
`auto`. Los valores antiguos `online` y `offline` también se interpretan como `auto`.

La Handy emparejada accede al negocio por REST y recibe avisos por su servicio nativo de WebSocket.
El transporte de ambos dispositivos vive en Rust; la UI observa los estados y refresca sus datos.
Las condiciones de conexión y el papel de cada servicio están en
[sincronizacion.md](../arquitectura/sincronizacion.md#conectividad).

## Preparar la máquina (una vez)

- Android SDK y NDK (probado con NDK `29.0.13846066`) y el JDK de Android Studio (JBR).
- Targets de Rust y `cargo-ndk`:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo install cargo-ndk
pnpm tauri android init        # sólo si falta gen/android
```

Las variables suelen faltar en una shell nueva; conviene fijarlas como variables de usuario:

```bash
export ANDROID_HOME="C:/Users/<usuario>/AppData/Local/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"
export PATH="$JAVA_HOME/bin:$PATH"
```

## Compilar

```bash
pnpm tauri android build --debug --apk --target aarch64     # APK debug arm64, autofirmado
pnpm tauri android dev                                       # sobre emulador o dispositivo
```

El APK queda en `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`. Un
release o un AAB para Play necesita un keystore propio.

Para aislar un fallo de compilación, compilar una crate suelta:

```bash
cargo ndk -t arm64-v8a build -p tpv-infra-licensing
```

## Probar en el emulador

```bash
emulator -avd Pixel_7 -wipe-data -no-snapshot
adb install -r <apk>
adb logcat -d -s TPVRust
adb exec-out screencap -p > pantalla.png
```

El APK debug pesa bastante: con `INSTALL_FAILED_INSUFFICIENT_STORAGE`, relanzar con `-wipe-data`.

## La CSP en Android

En Android la CSP **sí** se aplica, y el Chromium de su webview es más estricto que WebView2: es el mejor
sitio para cazar un origen que falta ([frontend.md](../arquitectura/frontend.md#csp)). ⚠️ Un APK de
`tauri android dev` apunta al servidor de Vite y **no aplica ninguna CSP**: para probarla hay que usar uno
de `tauri android build`.

La sonda, sin tener que emparejar ni tener datos:

```bash
adb shell cat /proc/net/unix | grep webview_devtools      # el <pid>
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl -s http://localhost:9222/json/list                   # webSocketDebuggerUrl
# por CDP: Runtime.evaluate cargando el recurso y escuchando "securitypolicyviolation"
```

Devuelve la directiva culpable y la URI bloqueada. En escritorio es lo mismo arrancando el `.exe` con
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.

Las imágenes de la Handy salen del bucket R2 (`pub-6814….r2.dev`), que está en `img-src` de `csp` y
`devCsp`; cambiarlo de host es [INFRA-03](../pendientes.md#infra-03--imágenes-por-r2dev).

## Lo que falta para usar Android como Main

Imprimir por Bluetooth o USB-OTG (el ESC/POS ya es independiente del transporte; cambiaría `print_raw`),
una interfaz del POS para tablet y las actualizaciones por Play.
