# Compatibilidad de la aplicación de escritorio con Windows 7

**Estado:** estudio; no hay nada de Windows 7 en el código ni en CI.

Este documento estudia únicamente la posibilidad de distribuir una versión estable de la
aplicación de escritorio para Windows 7. No plantea que Windows 7 vuelva a ser una plataforma de
desarrollo ni que esta variante siga las actualizaciones ordinarias de la aplicación.

## Conclusión

La aplicación **no es compatible con Windows 7 tal como se compila y empaqueta ahora**, pero no hay
ningún bloqueo arquitectónico que impida preparar una variante dedicada.

No bastaría con cambiar una sola versión de Rust. Haría falta congelar un conjunto coherente de
dependencias Rust, empaquetar una versión compatible de WebView2 y aislar el canal de
actualizaciones de esta variante. El frontend y las funciones principales de la aplicación no
presentan, por sí mismos, una incompatibilidad evidente con Windows 7.

Hay una limitación que no puede resolverse dentro del proyecto: WebView2 109 es la última versión
compatible con Windows 7 y ya no recibe correcciones de seguridad. Por tanto:

- Es viable mantener una versión **funcional y congelada** para Windows 7.
- No es viable garantizar que esa versión reciba todas las futuras correcciones críticas del motor
  web sin abandonar Windows 7.

## Por qué el artefacto actual no funciona

El workflow de publicación (`.github/workflows/release.yml`) utiliza Rust 1.91.1 y ejecuta el build
normal de Tauri sobre `windows-latest`, sin seleccionar un target legado:

```yaml
- uses: dtolnay/rust-toolchain@1.91.1

- name: Compilar + firmar instalador (Tauri / Windows)
  run: pnpm --filter @tpv/main tauri build
```

Esto produce un binario para `x86_64-pc-windows-msvc`. Desde Rust 1.78, los targets estándar de
Windows requieren Windows 10 tanto como plataforma de compilación como de ejecución del binario.
Rust 1.77.2 fue la última versión de la línea estándar que generaba binarios oficialmente
compatibles con Windows 7.

Referencia: [anuncio oficial de Rust 1.78](https://blog.rust-lang.org/2024/05/02/Rust-1.78.0/).

Además, el grafo resuelto en el `Cargo.lock` raíz ya contiene dependencias con una versión mínima de
Rust superior a 1.77.2. Entre las relevantes se encuentran:

| Dependencia resuelta | MSRV declarado | Motivo por el que aparece |
| --- | ---: | --- |
| `image 0.25.10` | 1.88 | Procesamiento de imágenes |
| `time 0.3.47` | 1.88 | Tauri, cookies, Sentry y telemetría |
| `serde_with 3.20.0` / `darling 0.23.0` | 1.88 | Utilidades y macros de Tauri |
| `reqwest 0.13.4` | 1.85 | Plugin updater de Tauri |
| `sentry 0.42.0` | 1.81 | Observabilidad y minidumps |
| `tauri 2.11.2` | 1.77.2 | Shell de escritorio |
| `tauri-plugin-single-instance 2.4.4` | 1.77.2 | Una sola instancia en escritorio |
| `rusqlite 0.40.2` (`bundled`) | — | Base local |

Aunque Tauri declara un MSRV compatible, el conjunto completo actual no compila con Rust 1.77.2.
El lockfile también usa el formato 4, por lo que debería regenerarse con la versión de Cargo elegida
para la variante Windows 7.

## Estrategias posibles para Rust

### Opción recomendada: Rust 1.77.2 y dependencias congeladas

Consiste en crear una variante con Rust 1.77.2 y fijar versiones compatibles de Tauri, sus plugins
y las dependencias transitivas. Como mínimo habría que resolver versiones compatibles de:

- Tauri y sus utilidades transitivas.
- `tauri-plugin-updater` y su cliente HTTP.
- `tauri-plugin-sentry` (0.5.0), `sentry` y el helper de minidumps.
- `tauri-plugin-single-instance` y `rusqlite`.
- `image`, `time`, `serde_with` y sus macros.

El resultado debería quedar fijado mediante un lockfile propio y no recibir actualizaciones
automáticas de dependencias. Esta ruta utiliza el target MSVC normal, conocido por Tauri y por las
dependencias nativas, y es la opción más predecible para un producto que se pretende congelar.

### Alternativa: target moderno específico para Windows 7

Rust dispone actualmente de `x86_64-win7-windows-msvc`, un target Tier 3 que conserva soporte para
Windows 7. Permitiría estudiar el uso de un compilador moderno, pero Rust no distribuye su biblioteca
estándar precompilada para este target: hay que construirla y mantener un toolchain especial.

También habría que verificar expresamente el empaquetado de Tauri y todas las dependencias con ese
triple. Por su mayor complejidad y menor nivel de soporte, no es la primera opción para una variante
estable salvo que una prueba de concepto demuestre una ventaja clara.

Referencia: [target `*-win7-windows-msvc` en el libro de rustc](https://doc.rust-lang.org/rustc/platform-support/win7-windows-msvc.html).

## Tauri y WebView2

Tauri no incluye un navegador completo dentro del ejecutable. En Windows utiliza Microsoft
WebView2. La configuración actual no define `bundle.windows.webviewInstallMode`, por lo que el
instalador NSIS usa el modo predeterminado `downloadBootstrapper`: el WebView no está embebido en el
instalador.

Para una instalación estable y reproducible en Windows 7 debería incluirse un **Fixed Version
Runtime de WebView2 109 para x64** y configurar Tauri para usarlo. El instalador crecería
aproximadamente 180 MB, pero dejaría de depender de que el bootstrapper de Microsoft continúe
ofreciendo una versión antigua compatible con Windows 7.

Tauri documenta tanto el soporte del instalador para Windows 7 como el empaquetado de un runtime
fijo: [Windows Installer — Tauri](https://v2.tauri.app/distribute/windows-installer/).

WebView2/Edge 109 fue la última versión compatible con Windows 7. Microsoft terminó su soporte en
febrero de 2023 y Edge 110 ya requiere Windows 10:
[ciclo de vida de Microsoft Edge](https://learn.microsoft.com/en-us/lifecycle/products/microsoft-edge).

### Compatibilidad del frontend

El proyecto resuelve Vite 7.3.5. Vite 7 genera por defecto JavaScript para Chrome/Edge 107, mientras
que WebView2 109 está basado en Chromium 109. En la revisión del código no se encontraron usos
directos de APIs JavaScript posteriores que constituyan un bloqueo conocido.

Esto permite considerar compatible el frontend actual, pero el build de la variante debe conservar
un target de navegador explícito compatible con Chromium 109 para impedir que una futura versión de
las herramientas eleve silenciosamente el mínimo.

Referencia: [cambios de compatibilidad de Vite 7](https://v7.vite.dev/guide/migration.html#default-browser-target-change).

## Componentes de la aplicación

No se han encontrado incompatibilidades estructurales en los siguientes componentes:

- SQLite (rusqlite, con su SQLite empaquetado) y el almacenamiento local en AppData.
- Windows Credential Manager utilizado mediante `keyring`.
- Las APIs de impresión `winspool` empleadas para enumerar impresoras y enviar datos ESC/POS.
- Las comunicaciones HTTPS y WebSocket con el backend remoto (reqwest con rustls).
- React y el resto del frontend una vez compilados.

Node.js, pnpm y Vite son herramientas de compilación; no se distribuyen ni se ejecutan en el equipo
Windows 7. La variante puede seguir construyéndose en CI sobre un Windows moderno. El Worker de
Cloudflare también se ejecuta remotamente y no depende del sistema operativo del TPV.

Los elementos que requieren una prueba real, porque incluyen integración nativa o dependen del
estado concreto del sistema, son:

- El helper de minidumps de Sentry. Si no fuese compatible, habría que usar una versión anterior o
  deshabilitar solamente los minidumps en Windows 7.
- La descarga, verificación e instalación mediante el updater.
- TLS, certificados raíz y WebSockets contra los dominios de producción.
- **La remisión a la AEAT** (`crates/tpv-infra-aeat`): va por **WinHTTP** (schannel) con el certificado
  del almacén por CryptoAPI, y el código no fija `WINHTTP_OPTION_SECURE_PROTOCOLS`. En Windows 7, WinHTTP
  sólo negocia TLS 1.2 con la actualización KB3140245 y la clave de registro `DefaultSecureProtocols`;
  sin eso no se puede remitir. Hay que añadirlo a los requisitos del sistema o fijar la opción en el
  código.
- Los drivers de la impresora concreta y la impresión RAW.

## Sistema operativo mínimo

La variante debería limitarse a **Windows 7 SP1 x64 completamente actualizado**, incluyendo las
actualizaciones de SHA-2, TLS 1.2 y certificados raíz. El build actual es de 64 bits; si existieran
equipos con Windows 7 de 32 bits sería necesario producir y validar una variante `i686` separada.

No debe asumirse compatibilidad con instalaciones base de Windows 7 sin Service Pack ni parches del
sistema.

## Actualizaciones y distribución

La aplicación consulta periódicamente el feed de actualizaciones y permite que el usuario instale
la versión encontrada. Una variante Windows 7 no puede compartir sin control el mismo canal que las
versiones normales: una actualización compilada para el target estándar actual dejaría de arrancar
en Windows 7.

Debe aplicarse una de estas políticas:

- Publicar la variante en un canal separado. `app_releases` ya tiene `channel` y `arch` en la clave,
  pero el feed sólo sirve `channel = 'stable'` (`domains/updates/updates.routes.ts`): un canal Windows 7
  exige cambiar esa ruta o el endpoint del updater de la variante.
- Deshabilitar su updater y actualizarla manualmente cuando sea imprescindible.
- Segmentar en el servidor por plataforma, además de la arquitectura (hoy el feed distingue `target` y
  `arch`, no la versión del sistema operativo).

Las correcciones posteriores de la variante deben compilarse siempre con el mismo toolchain, el
mismo lockfile y el mismo WebView2 fijo. Cualquier cambio de dependencia requiere repetir la
validación completa.

## Validación necesaria antes de distribuir

La compatibilidad no debería darse por cerrada únicamente porque el proyecto compile. Hace falta
probar el instalador final en una máquina o VM limpia con Windows 7 SP1 x64:

1. Instalación y primer arranque sin WebView2 previamente instalado.
2. Renderizado completo del frontend y comunicación IPC con Tauri.
3. Activación de licencia y acceso al Credential Manager.
4. Apertura, migración y uso continuado de la base de datos local.
5. Conexiones HTTPS y WebSocket con producción, y el *handshake* con la AEAT
   (`pnpm verifactu:probar-aeat`).
6. Guardado y carga de imágenes.
7. Enumeración de impresoras, ticket de prueba y apertura del cajón.
8. Registro de errores y comportamiento de Sentry/minidumps.
9. Detección, descarga, firma e instalación de una actualización del canal Windows 7.
10. Reinicio del equipo y funcionamiento prolongado sin herramientas de desarrollo instaladas.

## Decisión técnica

Preparar esta variante es viable, pero debe tratarse como un producto separado y congelado, no como
un simple flag del build habitual. La ruta más conservadora es:

1. Congelar un grafo compatible con Rust 1.77.2.
2. Compilar un artefacto NSIS x64 dedicado.
3. Empaquetar WebView2 109 Fixed Version Runtime.
4. Separar o deshabilitar el canal de actualizaciones.
5. Certificar el instalador completo sobre Windows 7 SP1 x64.

Esta solución puede mantener la funcionalidad de la aplicación, pero no elimina el riesgo de operar
con un sistema operativo y un motor Chromium que ya no reciben mantenimiento del fabricante.
