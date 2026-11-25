# E2E sobre la aplicación compilada

Seis recorridos sobre la aplicación **compilada**, encadenados sobre un mismo equipo: la Main en Windows
y, en uno de ellos, una Handy de Android a la vez. Prueban la costura
que no prueba nada más: React → IPC de Tauri → comandos Rust → SQLite → y vuelta. No cubren el frontend
(la cobertura de componentes está descartada a propósito, ver `vitest.config.ts`). Van sobre
WebdriverIO + `@wdio/tauri-service` (la Handy, por Appium) y tardan menos de dos minutos.

```bash
cargo install tauri-driver --locked          # una vez por máquina (y Appium: abajo)
pnpm --filter @tpv/main build:e2e            # compila el binario aislado y lo verifica
pnpm --filter @tpv/main build:e2e:android    # compila el APK de la Handy
pnpm --filter @tpv/main test:e2e             # la tanda (con el emulador arrancado)
```

Hace falta `ADMIN_API_TOKEN` en el `.env` de la raíz: la tanda emite su propia licencia y la revoca al
terminar. **No va a CI**: la licencia se ata al `main_device_id` del equipo, que vive en el keyring de la
máquina, y un runner nuevo cada vez chocaría con el cambio de equipo, que pide un código por correo. Se
corre antes de cada versión ([publicar-version.md](../../../docs/guias/publicar-version.md)).

## Los recorridos, en orden

| Recorrido | Fichero | Qué hace |
|---|---|---|
| El camino del dinero | `specs/venta.e2e.ts` | Equipo nuevo → modo TPV → **activar una licencia real** → PIN → fichar y entrar → declarar los datos fiscales (la pantalla avisa de que faltan) → categoría y producto con precio, IVA y lote → zona y mesa → dos líneas → **cobro en efectivo exacto** → el registro de facturación existe, es `F2` y su número es el del ticket → el ticket lleva su QR y una reimpresión saca el mismo → una segunda venta avanza la cadena sin anomalías → las dos quedan en cola diciendo por qué no salen → **cierre de caja con descuadre 0** |
| La Main y la Handy | `specs/handy.e2e.ts` | La Main enseña el código → una Handy de Android recién instalada se configura como Handy y lo escribe → la Main acepta la solicitud → el administrador entra en la Handy → la Handy apunta una caña en la mesa → a la Main le llega por la nube y la cobra → la Handy ve la mesa libre → la Main da de alta una camarera **sin PIN** y entra en la Handy sin teclear nada |
| Copias, 1 | `specs/copias-1-copia.e2e.ts` | Crea algo más, espera a que la nube lo tenga todo y guarda una copia |
| Copias, 2 | `specs/copias-2-recuperar.e2e.ts` | Con la base rota: la app arranca igual y ofrece recuperar; la copia ilegible se aparta con la base rota y no se ofrece (AUD-06); restaura la buena, reconcilia y abre el login |
| Copias, 3 | `specs/copias-3-nube.e2e.ts` | Con la base rota otra vez: **«Recuperar el estado actual de la nube»**, sin copia local (el volcado de la recuperación) |
| La licencia | `specs/licencia.e2e.ts` | Anulada → se bloquea sola → desanulada y la misma clave vuelve a activar sin perder datos → caducada → pantalla de bloqueo → renovada y «Reintentar» la desbloquea |

La licencia va la última porque le rompe la licencia a todo el equipo. Los estados se provocan por el API
de administración (`revoke`, `unrevoke`, `shorten`). **El paso de la anulación no llama a nada**: espera a
que la pantalla se bloquee sola, y con poca espera, porque anular empuja (cierra el socket) y el job
`licencia` tarda 2 minutos en su primera vuelta. La caducidad no empuja, y por eso sí usa
`license_check_now`.

## La Handy de Android

La Main la mueve WDIO por `tauri-driver`; la Handy, una segunda sesión de **Appium** que abre el propio
recorrido (`helpers/handy.ts`), dentro de la WebView de la app: los mismos botones y los mismos gestos
(`gestosEn(navegador)`). No van juntas en un *multiremote*: `@wdio/tauri-service` está hecho para una sola
app de escritorio.

Una vez por máquina, además de `tauri-driver`:

- El SDK de Android con un emulador (`Pixel_7`), el NDK y el JDK de Android Studio, como en
  [compilar-android.md](../../../docs/guias/compilar-android.md).
- **Appium, fuera del repo**, en `%LOCALAPPDATA%\tpv-e2e\appium` (o donde diga `TPV_E2E_APPIUM_HOME`):
  trae unos 190 paquetes que sólo hacen falta aquí, y en una ruta larga Windows no llega a extraer sus
  APK.

  ```bat
  mkdir "%LOCALAPPDATA%\tpv-e2e\appium" && cd "%LOCALAPPDATA%\tpv-e2e\appium"
  echo {"private":true} > package.json
  pnpm add appium@3.9.0 appium-uiautomator2-driver@8.7.3
  ```

Antes de cada tanda, el emulador arrancado:
`"%LOCALAPPDATA%\Android\Sdk\emulator\emulator.exe" -avd Pixel_7 -no-snapshot-save`. La tanda instala el
APK, arranca Appium (su salida, en `target/e2e/appium.log`) y lo para al terminar.

- **Es el APK de depuración**, el único que deja entrar a Appium en la WebView, y **sin la información de
  depuración de Rust**: con ella pesa más de 500 MB y no cabe en el emulador. Para un teléfono de verdad,
  `TPV_E2E_ANDROID_TARGET=aarch64`.
- **El APK lleva la misma huella que el binario** y la tanda se niega si no es la del código. Lo que hay
  bajo `src-tauri/gen/android` no entra en ella: tras tocarlo, `build:e2e:android` a mano.
- **Cada sesión estrena Handy**: Appium le borra los datos a la app (`noReset: false`), y con ellos su
  identidad y su emparejamiento. Por eso, con dos Android conectados, la tanda no elige: hay que decirle
  cuál con `TPV_E2E_HANDY_SERIAL`.
- **`TPV_E2E_SIN_HANDY=1`** corre sólo los recorridos de la Main.

## Piezas

| Pieza | Archivo |
|---|---|
| El equipo de la tanda (negocio, PIN, obligado) | `helpers/equipo.ts` |
| Arranque compartido (modo, activación, PIN, login, también sin PIN y en la Handy) | `helpers/arranque.ts` |
| Vender por mesa (en la Main o en la Handy) | `helpers/vender.ts` |
| La Handy: emulador, APK, Appium y su sesión | `helpers/handy.ts` |
| Lo fiscal | `helpers/fiscal.ts` |
| Lo común a los tramos de copias | `helpers/copias.ts` |
| Licencias de la tanda (emitir, revocar, desrevocar, acortar, retirar) | `helpers/licencias.ts` |
| Aislamiento del equipo (verificar el binario, preparar AppData, romper la base) | `helpers/entorno.ts` |
| Gestos (pulsar, escribir, leer por IPC) | `helpers/ui.ts` |
| Esperar a la nube (outbox a cero) | `helpers/nube.ts` |
| Huella del código que entra en el binario | `helpers/huella.ts` |
| Configuración, recetas y captura al fallar | `wdio.conf.ts` |
| Build aislado | `construir.ts` + `../src-tauri/tauri.e2e.conf.json` |
| APK de la Handy | `construir-android.ts` |

## Reglas

- **Los secretos del build de E2E van aparte** (`device-id`, clave, tokens): con el identificador `….e2e`,
  la app los guarda en el almacén del sistema con otro nombre (`lib.rs::espacio_de_secretos`). Antes
  compartía los de la app de trabajo del mismo Windows, y si ésa era la Main de una licencia viva, la de
  la tanda se canjeaba en ella (REV-13).
- **El aislamiento es un identificador, no una variable de entorno.** `app_data_dir()` sale de
  `SHGetKnownFolderPath`, que no mira `%APPDATA%`: lanzar el `.exe` con otro `APPDATA` usaría la carpeta
  real. El build de E2E tiene su propio `identifier` (`…tpv.e2e`).
- **Por eso el binario se verifica antes de borrar nada.** `tauri build --no-bundle` no renombra el
  ejecutable, así que el de E2E y el de producción escribirían los dos en `target/release/tpv.exe`.
  `construir.ts` deja una copia en `target/e2e/tpv-e2e.exe`, y `onPrepare` abre el fichero y comprueba el
  identificador que lleva dentro. La limpieza se niega si la ruta no termina en `.e2e`.
- **Un binario viejo pasaría sin decir nada**, así que `construir.ts` deja junto al binario la huella
  (sha256 por fichero) de lo que entra en él, y el arranque la recalcula y se niega diciendo qué cambió.
  Compara contenido, no fechas, y deja fuera `e2e/` y `test/`.
- **Lo que impide ejecutar no es un test que falla**: las guardias del arranque (identificador, huella,
  licencia) terminan el proceso. WDIO registraría el error de un hook y seguiría.
- **Una licencia por tanda, nunca fija**: activar graba en el tenant el hash de `0001_inicial.sql`, y un
  tenant con historia se traería por catch-up lo de tandas anteriores.
- **La tanda estrena un equipo y una licencia, y los recorridos se los pasan.** Un fallo arrastra a los de
  detrás: en un informe rojo, el que importa es **el primero**.
- **Con la nube encendida**, como se vende. Con el worker desplegado por detrás del esquema, la tanda falla
  (en las copias, que esperan a que suba todo): tras un cambio de esquema, redesplegar antes.
- **Cada recorrido declara qué hay que hacerle al equipo** (`RECETAS` en `wdio.conf.ts`: nuevo, el de
  antes, el de antes roto, con copia mala) y se hace en `beforeSession`, con la app cerrada (en Windows
  SQLite tiene la base cogida).
- ⚠️ **Un recorrido no importa a otro**: importar un fichero de recorrido lo ejecuta. Lo compartido va en
  `helpers/`.
- **La mesa se pulsa por coordenadas**: el plano es un `<canvas>` de Konva. El test lee el layout y calcula
  el punto con la misma función que la pantalla (`fitTransform`), importada.
- **El IPC se usa para leer, nunca para sembrar** (`leerDeLaApp`): dónde cae una mesa, si ha vuelto a
  libre, el número de ticket.
- **Un clic se comprueba**: el teclado del PIN se lee de vuelta tras cada tecla, y `pulsar` elige el primer
  candidato **visible** (la app duplica bloques para móvil y escritorio).
- ⚠️ **`aria-label="Cerrar"` también es el aspa de la ventana**: los selectores dentro de un modal se
  anclan a su cabecera.
- **El servicio pregunta por `tauri-plugin-wdio`, que la app no lleva**, y sin respuesta reintenta cada
  comando 100 veces: el hook `beforeSuite` hace que ese puente falle en el acto. `driverProvider` es
  `external`. Instalar el plugin metería un servidor de depuración en el binario que se distribuye.
- **`timeoutMsg` se construye al llamar**, no al fallar: lo que cuente el último intento va en un `throw`
  después de esperar.
- **Pasa por el typecheck de CI** aunque no se ejecute allí (`e2e/tsconfig.json` en el script
  `typecheck`).
- **Un fallo deja una captura** en `e2e/fallos/` (no se versiona).
- **Sus errores llegan a Sentry como `e2e`**: lo decide el identificador (`lib.rs::entorno_de_sentry`).
- **Cada tanda da de alta un negocio** (su base, en su `TenantHub`) y lo retira al terminar, con
  `/v1/admin/pruebas/retirar`. Lo que deje una tanda que no llegue al final lo borra la siguiente.

## Lo que no sube a E2E

- Las reglas de `recovery.rs` (retención, copias importadas, exportar): tests de Rust sobre ficheros, sin
  React ni IPC.
- La guardia del outbox al restaurar: la interfaz no puede producir ese caso.
- La reconciliación bloqueada tras cinco ciclos: serían unos quince minutos. La cuenta la lleva
  `src-tauri/src/replicacion.rs` (`fallos >= 5`), sin test propio; lo que enseña la pantalla bloqueada
  está en `test/react/recuperarDatos.test.tsx`, y que reintentar quita el bloqueo, en
  `test/estadoSync.test.ts`.
