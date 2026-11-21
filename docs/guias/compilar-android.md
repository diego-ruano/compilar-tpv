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
- **Y al revés, lo que sólo existe en móvil**: el lector de QR con la cámara
  (`tauri-plugin-barcode-scanner`, para vincular una Handy escaneando el QR de la Main) va en
  `[target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]`, se registra con
  `#[cfg(mobile)]` y sus permisos van en `capabilities/mobile.json` (`"platforms": ["android", "iOS"]`).
  El permiso `CAMERA` de Android lo añade el manifiesto del propio plugin al fusionarse, y con él la
  cámara como requisito (`<uses-feature android:name="android.hardware.camera.any">`, obligatoria):
  Google Play no ofrecería la app a un equipo sin cámara, que puede vincularse escribiendo el código.
  `gen/android/app/src/main/AndroidManifest.xml` la sustituye por una no obligatoria
  (`android:required="false"` con `tools:node="replace"`; sin él, al fusionar ganaría el `true` del
  plugin) y declara también no obligatorias `android.hardware.camera` y `camera.autofocus`, que Play
  deduce del permiso si no están. Se comprueba en el manifiesto fusionado del APK
  (`app/build/intermediates/merged_manifests/…/AndroidManifest.xml`) o con
  `aapt dump badging <apk>`, que lista los `uses-feature`. En iOS, la
  frase del permiso de la cámara (`NSCameraUsageDescription`) está en `src-tauri/Info.ios.plist`, que
  Tauri funde en el `Info.plist` al generar el proyecto: no hay `gen/apple` en el repositorio.
- **`rusqlite` se compila igual** (el `AppState` nombra los repositorios SQLite): con `bundled`
  compila su propio SQLite con el `clang` del NDK, como el resto del código C. No depende del SQLite
  del teléfono.
- **Sin OpenSSL**: `sentry` va con `default-features = false` y `rustls`. Para encontrar quién activa una
  dependencia nativa: `cargo tree -p tpv --target aarch64-linux-android -i <crate> -e features`.
- **El almacén de secretos** (`crates/tpv-infra-licensing/src/secret_store.rs`) tiene la misma API en las
  dos plataformas: `keyring` en escritorio; en Android, una clave AES-256-GCM no exportable en el
  **Android Keystore** y los valores cifrados en SharedPreferences privadas, por JNI a clases del framework
  (sin AndroidX). La `JavaVM` la entrega `JNI_OnLoad` y el `Context`, `MainActivity` antes de arrancar
  Tauri (`TpvNativo.entregarContexto`, RI-75); las dos funciones nativas tienen que estar en el cdylib
  (`lib.rs`) para que se exporten. `ndk_context` no sirve (Tauri no lo inicializa), ni
  `JNI_GetCreatedJavaVMs` (el linker de Android no lo expone), ni `ActivityThread.currentApplication()`
  (API no pública). Una excepción de Java que deja una llamada fallida se trata y se limpia en `with_env` antes de
  soltar el hilo (RI-75): con una pendiente, la siguiente llamada JNI es ilegal.
- **Comprobar que compila** sin el proyecto Android entero:
  `cargo clippy -p tpv-infra-licensing --target aarch64-linux-android`, con `CC_aarch64_linux_android` y
  `AR_aarch64_linux_android` apuntando al `clang` y al `llvm-ar` del NDK.
- **Las barras del sistema** (RI-76): con `targetSdk` 36 la app se dibuja detrás de la barra de estado, la
  de navegación y la muesca. `MainActivity` le da a la vista esos márgenes y el del teclado
  (`adjustResize` en el manifiesto), y pinta lo que queda detrás con el fondo del tema de la app: se
  lo dice `useTheme` por el puente `window.TpvAndroid.tema(oscuro)`. En Android la barra de título
  no lleva minimizar/maximizar/cerrar (`ControlesVentana`, `import.meta.env.TAURI_ENV_PLATFORM`).
- **Imprimir** no está disponible fuera de Windows (`printing.rs` tiene un stub `#[cfg(not(windows))]`
  que devuelve error).
- **Logs**: `android_logger` con la etiqueta `TPVRust`, nivel Info (a Trace, la crate `jni` inunda logcat
  y el sistema mata la app). `adb logcat -d -s TPVRust`. Todo lo de `tracing` llega ahí sólo en el APK
  de depuración (`--debug`, el de `tauri android dev` y el de E2E). En el de release sólo queda el
  arranque anterior a la telemetría, también si ésta no llega a arrancar (AUD-29): lo demás va al
  `tpv.log` de AppData, a Axiom y a Sentry ([observabilidad.md](../arquitectura/observabilidad.md)). Lo que Rust escribe por la salida estándar
  o de error, como un `panic`, sale en los dos con la etiqueta `RustStdoutStderr`.
- **Actualizaciones**: el updater de Tauri es sólo de escritorio. En Android se instala el APK nuevo
  encima del anterior (o lo hace Google Play), siempre firmado con la misma clave (abajo).

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

El APK queda en `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`. La
versión de release (`pnpm tauri android build --apk`, o `--aab` para Play) necesita la clave de firma.

## La clave de firma de la versión de release (RI-76)

Android sólo instala una actualización firmada con **la misma clave** que la versión instalada. Sin
ella, cada Handy tendría que desinstalarse —y volver a emparejarse— para recibir una versión nueva, y en
Google Play no se podría publicar otra versión de la app. Es lo mismo que la clave del updater de
escritorio ([publicar-version.md](publicar-version.md#la-clave-de-firma-del-updater)), pero es otra.

**Generarla, una sola vez** (el `keytool` viene con el JDK de Android Studio; pide una contraseña):

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v `
  -keystore tpv-android.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
```

**Guardarla.** El `.jks` es un fichero pequeño; se guarda como texto en base64:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("tpv-android.jks")) | Set-Clipboard
```

- En **Bitwarden**, una nota segura con ese texto, la contraseña y el alias (`upload`). Es la copia que
  se puede recuperar: un secreto de GitHub se usa, pero no se vuelve a leer.
- En **GitHub** (Settings → Secrets and variables → Actions), `TPV_ANDROID_KEYSTORE_BASE64` con ese texto
  y `TPV_ANDROID_KEYSTORE_PASSWORD`, para cuando haya un job de Android en CI.

Después se puede borrar el `.jks` del disco. Para recuperarlo desde el texto:
`[IO.File]::WriteAllBytes("tpv-android.jks", [Convert]::FromBase64String((Get-Clipboard -Raw)))`.

**Usarla.** `app/build.gradle.kts` la busca primero en `gen/android/keystore.properties` (fuera de git):

```properties
storeFile=C:/ruta/a/tpv-android.jks
password=…
keyAlias=upload
```

y si no está, en las variables de entorno `TPV_ANDROID_KEYSTORE` (ruta) o `TPV_ANDROID_KEYSTORE_BASE64`,
`TPV_ANDROID_KEYSTORE_PASSWORD`, `TPV_ANDROID_KEY_ALIAS` (por defecto `upload`) y
`TPV_ANDROID_KEY_PASSWORD` (por defecto, la del almacén). Sin ninguna de las dos, la versión de release
sale **sin firmar** (Gradle lo avisa) y Android no la instala. Para comprobar con qué clave salió:
`apksigner verify --print-certs <apk>` (en `build-tools` del SDK).

Si la app pasa a Google Play con *Play App Signing*, esta clave es la **de subida**: Google firma lo que
llega a los teléfonos con otra que guarda él, y una clave de subida perdida se puede reponer.

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

Las imágenes de la Handy salen del worker (`GET /v1/images/{tenant}/{ruta}`, INFRA-03), cuyo origen
está en `img-src` de `csp` y `devCsp`. Si se cambia `CLOUD_API_BASE`, cambia también ahí: lo vigila
`lib.rs::las_imagenes_de_la_handy_salen_del_worker_y_no_de_r2_dev` ([worker.md](../arquitectura/worker.md#imágenes)).

## Lo que falta para usar Android como Main

Imprimir por Bluetooth o USB-OTG (el ESC/POS ya es independiente del transporte; cambiaría `print_raw`),
una interfaz del POS para tablet y las actualizaciones por Play.
