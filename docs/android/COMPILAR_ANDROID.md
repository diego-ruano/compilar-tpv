# Compilar el TPV para Android — cuaderno de bitácora

> **Estado:** EN INVESTIGACIÓN / EN CURSO.
> Documento vivo. Aquí se apunta **todo lo que vamos descubriendo** sobre cómo cross-compilar la app
> (Tauri 2 + Rust + React) a Android, para no re-investigar. Cada hallazgo nuevo → a la §8 (Bitácora).
> **Objetivo actual:** habilitar el modo **Handy** (camarero handheld) en Android. El modo **Main**
> (TPV completo con BD local) queda documentado como fase posterior.
> **Fecha inicio:** 2026-07-25 · **Rama:** `main` · **Ámbito:** build/toolchain Android.
>
> Contexto del monorepo y arquitectura: ver [CLAUDE.md](../../CLAUDE.md). Este doc solo cubre Android.

---

## 0. Estrategia (por qué Handy primero)

- La app es **un solo binario** que contiene todos los modos. Compartir el código **no** obliga a que
  Android habilite todos los modos: qué modos se encienden es decisión de build (`#[cfg]`), no un
  desperdicio de la arquitectura.
- **Handy en Android = poco trabajo** (lee por REST, sin BD local en runtime, sin impresión, sin
  licencia Main, sin updater desktop). El único bloqueo *real* es la persistencia de secretos.
- **Main en Android = bastante más** (impresión térmica por Bluetooth/USB-OTG, UI responsive para
  tablet, y el propio uso de la BD local). Fase posterior — ver §7.
- **Matiz clave de compilación:** aunque Handy no *use* la BD local, el `AppState` con el macro
  `repo_accessor!` ([main.rs](../../apps/tpv-main/src-tauri/src/main.rs)) **nombra** los tipos
  `Sqlite*Repository`, así que `tpv-infra-sqlite` (y por tanto `libsql`) **se compila igualmente** en
  el binario. → No se puede esquivar `libsql`; hay que cross-compilarlo (ya validado, §3).

---

## 1. Entorno verificado (2026-07-25, Windows 11)

| Pieza | Valor | Notas |
|---|---|---|
| Android SDK | `C:\Users\diego\AppData\Local\Android\Sdk` | Instalado (vía Android Studio) |
| **NDK** | `29.0.13846066` | En `…\Sdk\ndk\29.0.13846066` |
| `cargo-ndk` | **v4.1.2** | `cargo install cargo-ndk`. Funciona con NDK 29. |
| Targets Rust | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` | Los 4 ya instalados |
| Proyecto Android | `apps/tpv-main/src-tauri/gen/android/` | Regenerado con `tauri android init` |

**Config del `gen/android/app/build.gradle.kts`** (lo que dejó `tauri android init`):
- `namespace` / `applicationId` = `com.altarialights.tpv`
- `minSdk = 24`, `compileSdk = 36`, `targetSdk = 36`
- ABIs empaquetadas: `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`
- `usesCleartextTraffic`: `false` en release, `true` en debug (la API va por HTTPS → ok)
- Plugin gradle `id("rust")` con `rootDirRel = "../../../"` → gradle dispara el cargo build por ABI.

> ⚠️ **Env del NDK:** en shells nuevas `ANDROID_NDK_HOME` / `ANDROID_NDK_ROOT` suelen estar **sin
> definir** aunque el NDK exista. Para `cargo-ndk` (y `tauri android build`) hay que apuntarlo:
> ```bash
> export ANDROID_NDK_HOME="C:/Users/diego/AppData/Local/Android/Sdk/ndk/29.0.13846066"
> ```
> Conviene fijarlo como **variable de usuario de Windows** para no repetirlo en cada sesión.

---

## 2. Técnica: aislar bloqueos compilando crate por crate

En vez de lanzar `tauri android build` completo (que choca a la vez con varios bloqueos y no aísla
nada), se compila **una crate concreta** contra el target Android. Así se sabe exactamente qué
compila y qué no, sin ruido:

```bash
export ANDROID_NDK_HOME="C:/Users/diego/AppData/Local/Android/Sdk/ndk/29.0.13846066"
cargo ndk -t arm64-v8a build -p <crate>      # arm64 basta para validar
```

Las crates `tpv-domain`, `tpv-application`, `tpv-contracts`, `tpv-infra-http` no arrastran nada
desktop-only → cruzan sin problema. Los sospechosos se aíslan uno a uno (§3).

---

## 3. Hallazgos verificados

| Prueba | Comando | Resultado |
|---|---|---|
| `libsql` / persistencia | `cargo ndk -t arm64-v8a build -p tpv-infra-sqlite` | ✅ **Compila** (2m02s). Incluye `libsql-sys v0.5.0` (SQLite en C, compilado con el clang del NDK) **y** el stack de replicación (`tonic`, `hyper`, `libsql_replication`). **No hace falta recortar features.** |
| `keyring` / identidad | `cargo ndk -t arm64-v8a build -p tpv-infra-licensing` | ✅ **Compila** (37s, 1 warning dead-code). **Bloqueo solo en runtime**, no en build (ver §4.3). |

**Versiones resueltas de libsql** (Cargo.lock): `libsql v0.3.5`, `libsql-sys v0.5.0`,
`libsql-rusqlite v0.30.0`, `libsql_replication v0.3.1`.

**Nota sobre features de libsql:** `connection.rs` solo usa `Builder::new_local`
([connection.rs:139](../../crates/tpv-infra-sqlite/src/connection.rs)), es decir, **BD de fichero
local, sin remote/replicación**. Con el build completo pasando, no es necesario, pero si en el futuro
molesta el stack gRPC se puede recortar en [Cargo.toml raíz](../../Cargo.toml) a:
```toml
libsql = { version = "0.3", default-features = false, features = ["core"] }
```

---

## 4. Bloqueos conocidos y su solución

### 4.1 Updater (`tauri-plugin-updater`) — bloqueo de compilación
- **Qué:** el plugin es **solo escritorio**. `main.rs` llama a `app.updater()` en `updater_check`,
  `updater_install` y en el chequeo de arranque → no compila en Android.
- **Solución:** gatear con `#[cfg(desktop)]` la dep ([Cargo.toml](../../apps/tpv-main/src-tauri/Cargo.toml)),
  el registro del plugin, los comandos y el bloque de arranque.
- **Actualizaciones en Android:** vía **Google Play** (auto-update gratis con `versionCode` mayor).
  Para forzar/avisar desde la app: **Play In-App Updates** (`com.google.android.play:app-update`,
  modo *immediate* recomendado para un TPV). Alternativa sin Play: sideload de APK con
  `PackageInstaller` + permiso `REQUEST_INSTALL_PACKAGES`.

### 4.2 Sentry (`tauri-plugin-sentry`) — bloqueo parcial
- **Qué rompe:** solo el **minidump**. `tauri_plugin_sentry::minidump::init`
  ([main.rs:1157](../../apps/tpv-main/src-tauri/src/main.rs)) lanza un **proceso helper** de crashes
  nativos → mecanismo de escritorio, no existe en Android.
- **Qué SÍ funciona en Android:** el crate `sentry` de Rust (panics + eventos por HTTP) y el Sentry
  de la webview (JS).
- **Solución:** gatear el minidump con `#[cfg(desktop)]`. **Pendiente de verificar** si el propio
  `tauri-plugin-sentry` compila en Android; si no, gatear también el plugin y en Android quedarse con
  el crate `sentry`.
- **Crashes nativos de Android (NDK/JVM/ANR):** añadir el **Sentry Android SDK**
  (`io.sentry:sentry-android` por Gradle) en `gen/android`. Es el equivalente al minidump de Windows.
- **Mapa mental de las 3 capas de crashes:**
  | Capa | Captura | Plataforma |
  |---|---|---|
  | Webview/JS | Sentry JS | ambas |
  | `panic!` de Rust | crate `sentry` (HTTP) | ambas |
  | Crash nativo duro (segfault/abort) | minidump (desktop) / Sentry Android SDK (Android) | específico |

### 4.3 Keyring / almacén de secretos — bloqueo de runtime (persistencia)
- **Qué:** `keyring` v2 **compila** en Android (§3) pero **no tiene backend real**: cae a un almacén
  *mock* en memoria → los secretos **no persisten entre reinicios**. El dispositivo "olvidaría" su
  identidad ed25519 y su handy-token al cerrar. *(Comportamiento documentado de keyring; pendiente de
  confirmar empíricamente en dispositivo.)*
- **Superficie de uso** (toda en [device.rs](../../crates/tpv-infra-licensing/src/device.rs)), 5
  secretos string por `service`+`key` con get/set/delete:
  | Secreto | Servicio/clave |
  |---|---|
  | `device-id` (UUID) | `tpv-licensing / device-id` |
  | clave privada ed25519 (32 B b64) | `tpv-licensing-devicekey / {device_id}` |
  | license-token (JWT Main) | `tpv-auth / license-token` |
  | handy-token (JWT) | `tpv-auth / handy-token` |
  | handy-tenant-id | `tpv-auth / handy-tenant-id` |
- **Solución elegida (opción A): Android Keystore + EncryptedSharedPreferences.** Clave maestra AES
  **hardware-backed** (TEE/StrongBox, no exportable) que cifra los secretos en
  `EncryptedSharedPreferences` (Jetpack `androidx.security:security-crypto`; `minSdk 24` lo soporta).
  Es el equivalente real al keychain del SO en escritorio y **preserva el anti-copia** (un fichero
  copiado no descifra en otro dispositivo). Requiere un pequeño **plugin Kotlin/JNI** que el
  adaptador Rust invoca.
  - **La cripto ed25519 NO cambia**: se sigue generando/firmando en Rust (`ed25519-dalek`); solo se
    guardan sus 32 bytes en el almacén cifrado.
  - **Por qué NO Stronghold (opción B):** se desbloquea por contraseña; para una clave de dispositivo
    headless no aporta device-binding real → sería un *downgrade* de seguridad. Descartada.
- **Implementación (✅ HECHA, 2026-07-25):** módulo
  [secret_store.rs](../../crates/tpv-infra-licensing/src/secret_store.rs) con dos impls cfg-gateadas y
  **misma API** (`get`/`set`/`delete` por `(service, key)`); `device.rs` **no cambia de firma** (sigue
  con funciones libres, con constantes para los identificadores). Backends:
  - `#[cfg(not(target_os="android"))]` → `keyring` (idéntico al comportamiento anterior).
  - `#[cfg(target_os="android")]` → **JNI puro a clases del framework**: clave maestra AES-256-GCM **no
    exportable** en el **Android Keystore** + valores cifrados en **SharedPreferences privadas** de la
    app. **No usa AndroidX ni Kotlin ni toca `gen/android`** (solo clases del sistema, findables por
    JNI) → sobrevive a `tauri android init`. Dep target-android: `jni`.
  - **Obtención de `JavaVM` y `Context`** (⚠️ el punto que más costó, ver §4.7): la VM se captura en
    `JNI_OnLoad` del **cdylib** de la app ([lib.rs](../../apps/tpv-main/src-tauri/src/lib.rs)) y se
    pasa a `secret_store::init_java_vm`; el `Context` se obtiene con `ActivityThread.currentApplication()`.
    **`ndk_context` NO sirve** (Tauri usa WryActivity, no inicializa ese global) y **`JNI_GetCreatedJavaVMs`
    vía `dlsym` tampoco** (el aislamiento de namespaces del linker de Android no expone ese símbolo a la app).
  - `keyring` pasa a dependencia `[target.'cfg(not(target_os = "android"))'.dependencies]` (no se
    compila en Android; su backend allí sería mock).
  - **✅ Verificado en runtime (emulador Pixel_7 x86_64, 2026-07-26):** el primer arranque genera y
    **cifra** la identidad (`tpv_secret_store.xml` con la clave ed25519 + device-id en AES-GCM); tras
    matar y relanzar la app, el `device_id` es **el mismo** → lee/descifra correctamente y **persiste**.
    Sin crashes.
  - **Nota de diseño:** se descartó el plugin Kotlin + `EncryptedSharedPreferences` (opción A2) porque
    obligaba a tocar `gen/android` + Gradle y a resolver el classloader de la app desde hilos nativos
    (tokio). El JNI a clases del framework (A1) es autocontenido en la crate y más robusto ante re-init.

### 4.4 Impresión (`printing.rs`) — sin bloqueo
- Ya tiene stub `#[cfg(not(windows))]`
  ([printing.rs:578](../../apps/tpv-main/src-tauri/src/printing.rs)) que compila en Android y devuelve
  error "solo disponible en Windows". El Handy no imprime → no bloquea.
- Opcional: gatear los comandos `printer_*` a `#[cfg(desktop)]` para no exponerlos en Android.
- Para **Main en Android** habría que implementar transporte Bluetooth/USB-OTG (el armado ESC/POS
  `build_ticket` ya es agnóstico y se reutiliza; solo cambia `print_raw`).

### 4.5 OpenSSL / native-tls (stack de Sentry) — bloqueo de compilación ✅ resuelto
- **Síntoma:** `openssl-sys` no cross-compila a Android (`Could not find openssl via pkg-config`).
  En Windows no dolía porque `native-tls` = SChannel (sin openssl); en Android `native-tls` = openssl.
- **Causa (árbol inverso):** el único que activaba `native-tls` era el crate **`sentry`** (feature
  `default` → `transport` → `native-tls`), tirado por `tpv-telemetry` y por `tauri-plugin-sentry`.
- **Fix:** en [Cargo.toml raíz](../../Cargo.toml), `sentry` con `default-features = false` +
  `["backtrace","contexts","debug-images","panic","reqwest","rustls"]` → transporte **rustls** en
  **todas** las plataformas (coherente con reqwest, que ya iba rustls). Verificado con
  `cargo tree --target aarch64-linux-android -i openssl-sys` → "did not match any packages".
- **Diagnóstico útil:** `cargo tree -p tpv --target aarch64-linux-android -i <crate-nativo> -e features`
  da la cadena exacta de quién activa una feature/dep problemática.

### 4.6 Capabilities: permisos de plugins desktop-only — bloqueo de build ✅ resuelto
- **Síntoma:** `Permission updater:default not found` (e igual pasaría con `sentry:default`) en el
  build script (`tauri-build`) al compilar Android: el permiso no existe porque su plugin ya no está
  en el build de Android.
- **Fix:** sacar `updater:default` y `sentry:default` de
  [capabilities/default.json](../../apps/tpv-main/src-tauri/capabilities/default.json) y meterlos en un
  capability nuevo [capabilities/desktop.json](../../apps/tpv-main/src-tauri/capabilities/desktop.json)
  con `"platforms": ["linux","macOS","windows"]`. En Android ese capability se ignora → no exige esos
  permisos. **Regla general:** todo permiso de un plugin gateado a escritorio debe vivir en un
  capability con `platforms` de escritorio.

### 4.7 Bugs de RUNTIME en Android (compilaban, fallaban al ejecutar) ✅ resueltos
Estos NO se ven compilando; solo aparecen ejecutando en dispositivo/emulador. Fueron los que más costaron.

**A) La app estaba en `main.rs` y `lib.rs` era el stub por defecto de Tauri.** En escritorio el binario
usa `main.rs`; en **móvil Tauri arranca por el cdylib `libtpv_lib.so`**, cuyo `mobile_entry_point` es el
`run()` de **`lib.rs`**. Como ahí solo estaba el stub (`greet` + `tauri_plugin_opener`), en Android
cargaba una app vacía: el frontend renderizaba (mismo `dist`) pero **ningún comando funcionaba** y los
taps no navegaban. **Síntoma:** UI visible pero muerta; ningún log ni fichero de la app.
- **Fix (estructura correcta de Tauri 2):** mover **toda** la app a
  [lib.rs](../../apps/tpv-main/src-tauri/src/lib.rs) (AppState, comandos, `run()` con
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`), y dejar `main.rs` como shim: `fn main() { tpv_lib::run() }`.

**B) `secret_store` abortaba el proceso: `ndk_context` no está inicializado.** `ndk_context::android_context()`
hace `.expect(...)` y Tauri (WryActivity) **nunca puebla** ese global → panic **no-unwinding → SIGABRT**.
**Síntoma:** la app llega a `setup()` y muere sin firma clara (el crash se rota si hay spam de logs).
- **Fix:** capturar la `JavaVM` en **`JNI_OnLoad`** del cdylib y el `Context` con
  `ActivityThread.currentApplication()` (ver §4.3). `JNI_GetCreatedJavaVMs` vía `dlsym` **no** funciona
  (namespaces del linker). `JNI_OnLoad` debe estar en el **cdylib** (no en un rlib) para que se exporte;
  no choca con wry (wry no define `JNI_OnLoad`).

**Herramienta de diagnóstico (queda en el repo):** en Android no hay salida de `tracing`/`eprintln` a
logcat de forma fiable. Se añadió **`android_logger`** (dep target-android) inicializado al principio de
`run()` con tag **`TPVRust`** y las macros `log::` (p. ej. `log::warn!("[secret_store] …")`). Claves:
- Nivel **Info** (no Trace): la crate `jni` loguea CADA llamada a Trace → a Trace inunda logcat (miles de
  líneas/seg), rota el buffer y **ralentiza tanto que el sistema mata la app**.
- El puente `log`→`tracing` de `tpv_telemetry` no roba estos logs: su `try_init()` falla al ver que
  `android_logger` ya fijó el logger `log` (se ignora), así que `log::` sigue yendo a logcat.
- Leerlos: `adb logcat -d -s TPVRust`.

---

## 5. Comandos de referencia

### Setup (una vez)
```bash
# Targets Rust de Android
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

# Herramienta que configura el clang del NDK como linker/CC del cargo
cargo install cargo-ndk

# Proyecto Android (regenera gen/android)
pnpm tauri android init
```

### Validar una crate aislada (cross-compile)
```bash
export ANDROID_NDK_HOME="C:/Users/diego/AppData/Local/Android/Sdk/ndk/29.0.13846066"
cargo ndk -t arm64-v8a build -p <crate>
```

### Build/run de la app completa (VERIFICADO 2026-07-25 — genera APK)
```bash
# El NDK/SDK/JDK deben estar en el entorno (en shells nuevas suelen estar sin definir):
export ANDROID_HOME="C:/Users/diego/AppData/Local/Android/Sdk"
export ANDROID_NDK_HOME="C:/Users/diego/AppData/Local/Android/Sdk/ndk/29.0.13846066"
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"   # JBR de Android Studio (JDK 21)
export PATH="$JAVA_HOME/bin:$PATH"

pnpm tauri android build --debug --apk --target aarch64   # APK debug arm64 (rápido; auto-firmado)
pnpm tauri android dev                                     # dev sobre emulador/dispositivo
# APK resultante: apps/tpv-main/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```
> El build debug se auto-firma con el keystore de debug (no necesita config de firma). Para
> release/AAB (Play) hará falta un keystore propio en `gen/android`.

> Recordatorio del repo: **siempre `pnpm`, nunca `npm`/`npx`** (ver [CLAUDE.md](../../CLAUDE.md) §8).

---

## 6. Checklist para dejar Handy compilando+arrancando en Android

- [x] Validar que `libsql` cross-compila (§3) ✅
- [x] Validar que `keyring` compila (bloqueo solo runtime) (§3) ✅
- [x] Gatear `#[cfg(desktop)]`: updater (dep + plugin + comandos + arranque) (§4.1) ✅
- [x] Gatear `#[cfg(desktop)]`: `tauri-plugin-sentry` (plugin + minidump) + sentry→rustls (§4.2, §4.5) ✅
- [x] Capabilities: mover `updater:default`/`sentry:default` a `desktop.json` (§4.6) ✅
- [x] **`tauri android build --debug --apk --target aarch64` → APK generado** ✅ (§8, 2026-07-25)
- [x] SecretStore Android real: JNI Android Keystore (AES-256-GCM) + SharedPreferences (§4.3) ✅
- [x] Instalar/arrancar el APK en emulador (Pixel_7 x86_64) → app real corre sin crash ✅
- [x] Validar en runtime el SecretStore: identidad cifrada y **persiste** tras reinicio (§4.3, §4.7) ✅
- [ ] Probar flujo Handy en dispositivo (pairing, lectura REST, WS) — requiere backend
- [ ] Revisar usabilidad de las pantallas Handy en móvil/tablet (diseño, no build)
- [ ] (Opcional) build release/AAB firmado para Google Play

---

## 7. Pendiente para "Main en Android" (fase posterior)

- **Impresión** por Bluetooth/USB-OTG (nuevo transporte `print_raw`; ESC/POS reutilizable).
- **UI responsive** del POS completo para tablet (posible coste grande de frontend).
- `libsql` local ya validado que compila (§3) → el outbox/sync vendría "gratis".
- Actualización por Play (igual que Handy).

---

## 8. Bitácora (append de hallazgos)

### 2026-07-25 — Arranque de la investigación
- Estado de partida: `gen/android` había sido **borrado** (aparecía como `D` en git); se regeneró con
  `tauri android init` (config en §1).
- Instalado `cargo-ndk v4.1.2`. Los 4 targets Rust ya estaban.
- NDK detectado: `29.0.13846066`. Env `ANDROID_NDK_HOME` estaba sin definir en shell → hay que
  exportarlo.
- ✅ **`tpv-infra-sqlite` (libsql) compila para arm64-android** en 2m02s, features completas.
  → El mayor "sí/no" del proyecto Android resuelto a favor. `libsql-sys` (C) compila con el NDK.
- ✅ **`tpv-infra-licensing` (keyring) compila para arm64-android** en 37s. keyring **no** es bloqueo
  de compilación; el problema es persistencia en runtime → SecretStore (§4.3).
- Bloqueos de compilación reales identificados y acotados a la crate de la app: `app.updater()` y
  `tauri_plugin_sentry::minidump::init` (§4.1, §4.2). Solución: `#[cfg(desktop)]`.
- **Siguiente:** gatear updater + minidump y lanzar `tauri android build` completo.

### 2026-07-25 (tarde) — Primer APK de Android ✅ (rama `compilacion-android`)
Cadena de bloqueos resuelta hasta generar el APK debug (arm64):
1. Gates `#[cfg(desktop)]` de **updater** + **minidump** (§4.1, §4.2) → superados a la primera.
2. **`openssl-sys`** (native-tls del stack de Sentry) → `sentry` a **rustls** + `tauri-plugin-sentry`
   a solo-escritorio (§4.5).
3. **`updater:default`/`sentry:default`** no existen en Android → movidos a
   `capabilities/desktop.json` con `platforms` de escritorio (§4.6).
- **Resultado:** `pnpm tauri android build --debug --apk --target aarch64` → **APK OK** (~4 min):
  `gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (~129 MB, debug/universal).
- Desktop (`cargo check -p tpv` host) verde en **cada** paso → no se rompió el escritorio.
- **keyring** sigue en modo *mock* en Android (identidad no persistente) → siguiente trabajo real:
  SecretStore (§4.3). El APK arranca pero aún no persiste pairing entre reinicios.
- **Pendiente inmediato:** instalar el APK en emulador/dispositivo y probar el flujo Handy.

### 2026-07-25 (tarde) — SecretStore Android (Android Keystore) ✅ compila
- Nuevo módulo `secret_store.rs` (§4.3): `keyring` en escritorio; en Android, **Android Keystore
  AES-256-GCM + SharedPreferences privadas** por JNI a clases del framework (sin AndroidX/Kotlin, sin
  tocar `gen/android`). `device.rs` migrado a `secret_store::{get,set,delete}` **sin cambiar firmas**.
- `keyring` pasa a dep solo-escritorio; añadidas `jni = "0.21"` + `ndk-context = "0.1"` target-android.
- Verificado: `cargo ndk -t arm64-v8a build -p tpv-infra-licensing` ✅ y `cargo check` host ✅.
- ⚠️ Runtime **sin validar** aún (requiere dispositivo/emulador): confirmar que persiste la identidad
  ed25519 y el handy-token entre reinicios y que el descifrado AES-GCM funciona.

### 2026-07-26 — App real corriendo en Android + SecretStore validado ✅ (emulador)
Dos bugs de **runtime** resueltos (§4.7), que compilaban pero fallaban al ejecutar:
1. La app vivía en `main.rs` y el cdylib usaba el **stub** de `lib.rs` → en móvil arrancaba una app
   vacía (UI sí, comandos no). Movida toda a `lib.rs`; `main.rs` = shim `tpv_lib::run()`.
2. `secret_store` abortaba (SIGABRT) porque **`ndk_context` no está inicializado** en Tauri. Ahora la
   `JavaVM` se captura en **`JNI_OnLoad`** (cdylib) y el `Context` con `ActivityThread.currentApplication()`.
- Añadido **`android_logger`** (tag `TPVRust`, nivel Info) como herramienta de diagnóstico permanente.
- **Validado en emulador Pixel_7 (x86_64):** la app corre estable; el SecretStore **escribe cifrado**
  (`tpv_secret_store.xml`, AES-GCM) y el `device_id` **persiste idéntico tras reinicio** (lee+descifra OK).
- Herramientas: emulador por CLI (`emulator -avd Pixel_7 -wipe-data -no-snapshot`), `adb install/logcat/run-as`,
  `adb exec-out screencap` para ver la UI. El APK debug pesa ~250MB → si el emulador se queda sin espacio
  (`INSTALL_FAILED_INSUFFICIENT_STORAGE`), relanzar con `-wipe-data`.
- **Pendiente:** flujo Handy completo (pairing + REST + WS) contra backend.

### 2026-07-26 (tarde) — Flujo Handy validado en Android + fix de CSP (WebSocket)
- **Bug (Android-only):** el WebSocket del Handy (`wss://tpv-api…/ws`) lo **bloqueaba el CSP**. El
  `tauri.conf.json` tenía `default-src 'self' ipc: https:` sin `connect-src`, y el Chromium de Android
  es estricto: `wss:` no cae bajo `https:`. → el Handy **nunca conectaba** y se quedaba en "Conectando
  con la Main" para siempre. (En escritorio/WebView2 colaba por ser más laxo.) **Fix:** añadir
  `connect-src 'self' ipc: https: wss: ws:` al CSP. Diagnóstico: `adb logcat` → `Tauri/Console: Refused
  to connect … Content Security Policy`.
- **Validado en emulador (Pixel_7 x86_64) con una Main online:** el Handy conecta, autentica, recibe
  `main_status`/`main_online`, se desbloquea y opera; la app carga en modo Handy sin problemas.
- **Gotcha de uso (no es bug):** la **Main solo abre su WS a la nube en modo "Con conexión (online)"**
  (`useMainSocket` corta si `connMode !== "online"`; por defecto arranca `offline`). Con la Main en
  solo-local, el worker no ve ninguna Main → el Handy muestra "La Main no está activa" aunque la Main
  esté arrancada. Se añadió un **overlay gris que bloquea la UI de "Vincular Handy"** en la Main
  cuando está en solo-local (no tiene sentido emparejar si el Handy no podrá conectar).
- **Mejora del banner (frontend, aplica a escritorio y Android):** el freeze del Handy ya no se queda
  pegado — gracia de 5 s antes de bloquear, reconexión al volver a primer plano/red (`visibilitychange`/
  `online`/`focus`), y botón "Reintentar conexión".

### 2026-08-15 — La CSP bloqueaba TODAS las imágenes de la Handy (bucket R2) ✅ arreglado
- **Bug (Android-only, mismo patrón que el del WebSocket de julio):** la `img-src` de
  `tauri.conf.json` no incluía el bucket R2, y al estar **declarada explícitamente no hereda** el
  comodín `https:` de `default-src`. Resultado: en la Handy **ninguna foto de producto/categoría
  cargaba** (la Main no se entera: usa `asset:` con el fichero local). **Fix:** añadir
  `https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev` a `img-src`.
- **Cómo se confirmó, sin necesidad de emparejar ni tener datos** (método nuevo, mejor que mirar
  pantallas): APK **empaquetado** en el emulador → `adb forward` del socket
  `webview_devtools_remote_<pid>` → CDP `Runtime.evaluate` cargando una `Image()` y escuchando
  `securitypolicyviolation`. Devuelve la directiva culpable y la URI bloqueada. Detalle y tabla de
  resultados en [BACKLOG §Cómo probar la CSP de verdad](../analisis/BACKLOG.md).
- ⚠️ **Gotcha que costó un rato:** el APK de `outputs/apk/x86_64/debug/` era de un `tauri android
  dev` — apunta a `http://<IP-LAN>:1420` y **no aplica CSP ninguna**. Para cualquier prueba de CSP
  hay que usar un APK de `tauri android build` (el `universal/debug/` lo es).

### 2026-08-15 (tarde) — CSP estricta verificada en Android ✅
Con la CSP nueva (`script-src 'self'`, `connect-src` acotado) se reconstruyó el APK y se repitió la
sonda por CDP sobre el emulador. Resultado, idéntico al de escritorio:

| Prueba | Resultado |
|---|---|
| `<script>` inline del anti-FOUC (`index.html`) | ✅ se ejecuta (Tauri le mete el `sha256` al empaquetar) |
| inyectar un `<script>` inline nuevo | ❌ bloqueado (`script-src-elem`) |
| `<script src>` de un host externo | ❌ bloqueado (`script-src-elem`) |
| `fetch()` a un host externo | ❌ bloqueado (`connect-src`) |
| imagen del bucket R2 | ✅ permitida (el bug de la mañana, ya arreglado) |

La app arranca sin ninguna violación en `logcat` y pinta bien la pantalla de elección de modo (o
sea: CSS cargado y el IPC hacia Rust funcionando bajo la CSP nueva).

**Receta de la sonda** (sirve para cualquier duda futura de CSP):
```bash
adb shell cat /proc/net/unix | grep webview_devtools     # saca el <pid>
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl -s http://localhost:9222/json/list                  # webSocketDebuggerUrl
# y por CDP: Runtime.evaluate cargando el recurso + listener de "securitypolicyviolation"
```
En escritorio es lo mismo arrancando el `.exe` con
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.

<!-- Plantilla para nuevas entradas:
### AAAA-MM-DD — <título>
- <hallazgo> (comando: `…`) → resultado.
-->
