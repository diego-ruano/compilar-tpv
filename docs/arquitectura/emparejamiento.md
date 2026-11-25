# Emparejar una Handy

Una Handy (tablet o móvil Android) no tiene licencia propia ni base local: se vincula a la Main de un
negocio y trabaja contra la nube con un token. Vincularla es un código de 6 cifras que la Handy reclama
y la Main aprueba.

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Rutas | `apps/cloud-worker-licensing/src/domains/pairing/pairing.routes.ts` | `claim`, `fetch-token`, `cancel` (anónimas); `create`, `pending`, `approve`, `reject` (la Main) |
| Lado de la Main | `…/pairing/pairing.main.ts` | Crear el código, listar, aprobar, rechazar |
| Lado de la Handy | `…/pairing/pairing.handy.ts` | Reclamar, recoger el token, cancelar |
| Firma de las anónimas | `…/pairing/pairing.firma.ts` | La acción va dentro de lo firmado |
| Freno por IP | `…/pairing/pairing.intentos.ts` | Esperas por tramos y tope por minuto |
| Dispositivos vinculados | `…/pairing/dispositivos.routes.ts` (`/v1/device/list`, `/revoke`) | Listar y revocar |
| Proxy del TPV | `apps/tpv-main/src-tauri/src/commands/pairing.rs` (`tpv_server_post_json`) | Firma la petición; gate de Administrador salvo las anónimas |
| Handy | `src/app/arranque/{EmparejarHandy.tsx,emparejamiento.ts,useEmparejamientoHandy.ts}` | La pantalla y la espera |
| Lector de QR | `src/app/arranque/escanearQr.ts` (plugin `barcode-scanner`, sólo Android e iOS) | Leer con la cámara el QR de la Main |
| Main | Configuración → Vincular Handy | Generar el código y aprobar |
| Token | `crates/tpv-infra-licensing/src/{lib,device}.rs` · `crates/tpv-infra-http/src/client.rs` | Guardarlo y renovarlo |

## El flujo

1. La Main crea un código (`/v1/pair/create`): 6 cifras, válido **10 minutos**. Lo enseña con su
   secreto en un QR (`tpv://pair?code=…&secret=…`, `contenidoDelQr`). En la Handy, «Conecta este
   Handy» lo lee con la cámara («Escanear el QR», sólo en móvil), lo acepta pegado o acepta las seis
   cifras a mano; lo escaneado sigue el mismo camino que lo pegado. La cámara va detrás de la webview
   (`windowed`) y la pantalla pinta encima sólo el visor, con su «Cancelar»: sin eso, en Android la
   cámara tapaba la aplicación sin forma de salir. Sin permiso de la cámara, o cancelado, se avisa y
   quedan las otras dos vías.
2. La Handy lo reclama (`/v1/pair/claim`) con su `device_id` y su clave pública, y recibe un reto y
   cuánto le queda (`caducaEnMs`, en relativo: no depende de que los relojes coincidan). Un dispositivo
   ya aprobado puede volver a reclamar su propio código y recibe un reto nuevo, que es lo que salva a
   una aplicación que se cerró esperando.
3. La Main ve la solicitud (`/pending`) y la aprueba o la rechaza.
4. La Handy pregunta por el token (`/fetch-token`) firmando el reto con su clave y la acción
   `PAIR_FETCH`. **El dispositivo se da de alta en `devices` al recoger el token**, no al aprobar, y es
   entonces cuando la Main recibe el aviso. Pregunta cada 1,5 s mientras le contesten `not_approved`,
   hasta que caduca el código; cualquier otro fallo termina la espera, también un 503 o un 429
   pasajeros ([EMPAREJAR-ESPERA](../pendientes.md#emparejar-espera--la-handy-deja-de-esperar-la-aprobación-al-primer-503-o-429)).
5. Cancelar en la Handy (`/v1/pair/cancel`, acción `PAIR_CANCEL`) suelta el código en la nube, para que
   la solicitud no siga en la lista de la Main. Lo ya aprobado no se deshace cancelando: eso es revocar.
6. Si la Handy se cierra o se reinicia esperando, nadie pulsa «Cancelar»: mientras espera, apunta la
   espera (el código y su reto, sin el secreto) en el almacenamiento de la aplicación, y al volver a
   abrirse, o al volver a su vínculo desde el selector, suelta la que encuentre como lo hace «Cancelar»
   (`soltarEsperaAnterior`) y la olvida. Un código nuevo no se reclama hasta que se ha soltado la
   anterior: con el mismo código, soltarla después soltaría el reclamo nuevo. Lo hace la Handy y no la
   nube, porque desde la nube no se sabe si alguien espera: una Handy vinculada que pulsa
   «← Ir a vinculación» y vuelve a pedir el mismo negocio sigue conectada con su vínculo de antes mientras
   espera, y soltar las solicitudes de quien ha vuelto a conectar (`last_seen_at_ms`) le quitaba a la
   Main la que esa Handy esperaba. Si la Handy no se vuelve a abrir, o la nube no contesta, la
   solicitud caduca con el código.

Rust construye el mensaje y fija la hora y la identidad; el IPC acepta únicamente acción, código
y reto, nunca texto libre (RI-20). La acción abre el mensaje como separación de dominio, distinta
de `WS_HELLO` y `DEVICE_PROOF`. La acción va dentro de lo que se firma, para que la firma de una consulta no sirva para cancelar ni al
revés.

## Las reglas

- **Freno por IP** (`pairing.intentos.ts`): cada 3 fallos, una espera de 30 s, luego 5 min, luego
  30 min; se olvidan tras un día sin fallar, y sólo así: emparejar bien **no** borra la cuenta
  (AUD-11), porque el reclamo del propio código se puede repetir y la ponía a cero a voluntad.
  Delante, un tope de 20 peticiones por minuto y por IP antes de tocar la base. Por IP y no por
  dispositivo porque el `deviceId` lo elige quien llama (el precio: las Handy de un bar comparten la
  cuenta). En IPv6 la cuenta es del **/64** (`claveDeFreno`, en `lib/limitador.ts`), en la tabla y en
  el filtro exterior: los 64 bits de abajo los elige cada equipo. La espera se mira **antes** de leer
  el código, o un intento bloqueado seguiría diciendo si existe. Una petición mal formada no cuenta: la
  rechaza el validador, que va detrás del filtro exterior.
- **Los números se comparten y se liberan** (AUD-12). `pair_code` es la clave primaria de la base
  central: un millón de números para todos los negocios. Un negocio no tiene más de **20 códigos vivos**
  a la vez (`CODIGOS_VIVOS_POR_NEGOCIO`, comprobado dentro del mismo `INSERT`); el 21.º contesta 429
  `too_many_attempts` («Usa el que se ve en la pantalla o espera unos minutos»). La purga diaria
  (`server/purga.ts`) borra los códigos caducados hace más de un día, en cualquier estado.
- **Lo que una Handy deja en la base central tiene techo** (AUD-13). El `deviceId` y el nombre no pasan
  de 200 caracteres (`invalid_deviceId`, `invalid_deviceName`): cada reclamo, que el propio dispositivo
  puede repetir sin gastar nada, guarda un reto con su `deviceId` en `device_challenges`. La purga
  diaria borra los retos caducados, que caducan con su código. Sin las dos cosas, una Main y un script
  dejaban la copia diaria de la base central por encima de su techo.
- **A quien no lo reclamó, un código no existe** (AUD-10). `fetch-token` y `cancel` son anónimas y no
  tienen el freno de `claim` (la Handy pregunta cada 1,5 s): sólo el filtro holgado de las puertas de
  la sesión (`LIMITADOR_SESION`), que recorta volumen antes de que lleguen a la base central
  ([worker.md](worker.md#un-solo-hilo)). Así que no pueden servir para saber qué códigos viven:
  si no hay código o el `deviceId` no es el del reclamante, contestan `pair_code_not_found`, y la firma
  se comprueba **antes** que el estado (pendiente, rechazado, gastado, caducado). `approve` contesta lo
  mismo a la Main de otro negocio, como `reject`.
- **El identificador del error es contrato** con la Handy, que no tiene sesión ni dónde mirar: estas
  rutas usan `cuerpoConIdentificador`.
- **Una ruta anónima nueva** hay que eximirla también en el proxy (`PAIRING_SIN_SESION` en
  `commands/pairing.rs`); todo lo demás de `/v1/pair/…` y `/v1/device/…` exige Administrador.
- **Un equipo tiene una identidad para los dos modos.** Vincularlo como Handy de otro negocio mueve su
  fila de `devices` a ese negocio. Si vuelve a ser la Main del suyo, `/v1/license/status` y `/refresh`
  lo readmiten (`readmitirMain`) cuando firma con su clave registrada y sigue siendo el
  `main_device_id`; si la licencia ya está en otro equipo, contestan `device_replaced`.
- **Esa mudanza la hace el propio dispositivo, firmando.** Las dos puertas que dan de alta un
  dispositivo comprueban la firma de la clave que se les presenta: activar una licencia, sobre la
  petición entera ([licencias.md](licencias.md#activar)); recoger este token, sobre su reto de un solo
  uso. Después, antes de mover una fila de `devices`, llaman a `exigirClaveSiEsDeOtroNegocio`: si la
  fila del `device_id` está en **otro** negocio, no se toca con otra clave que la registrada, ni si
  no tiene ninguna registrada (`device_key_missing`): la firma sólo prueba la clave presentada. La
  clave pública sola no prueba nada: la Main de un negocio ve la de cada equipo que pasó por él
  (`/v1/device/list`, `/v1/pair/pending`). Dentro del mismo negocio, que la clave cambie al volver a
  vincular es la vía de recuperación de una Handy revocada (o de una fila que se quedó sin clave), y
  lo aprueba el dueño. Activar una licencia no lo deja ni dentro del mismo negocio.
- **Esa regla va también dentro de la sentencia del alta.** La comprobación y la escritura no son un
  lote, así que el upsert de `fetch-token` sólo toca una fila que ya existe si es de este negocio o
  si su clave registrada es la presentada. Si no escribe, contesta `device_key_mismatch` y no
  entrega el token: de dos recogidas simultáneas del mismo `device_id` en negocios y con claves
  distintos entra una sola. A la que llega tarde le queda el código gastado.

## El token de la Handy

- Dura lo que dice `handyTokenTtlSeconds` (por defecto 30 días; un único sitio para quien lo emite al
  emparejar y para `/refresh`).
- **Lo renueva el transporte**, no cada pantalla, y lo hacen los dos: el POST firmado de
  `tpv-infra-licensing` (por donde va el ticket del WebSocket) y el `CloudClient` de `tpv-infra-http`
  (por donde va todo lo demás).
- **Se renueva porque el token ha caducado según su `exp`** (`device::token_caducado`), no porque haya
  salido un 401: por ese transporte va el login de la Handy, que contesta 401 con un PIN incorrecto y
  cuenta el intento.
- Repetir una escritura tras renovar es seguro: el 401 por token caducado lo pone la autenticación
  antes de que nada se aplique, y el reintento lleva la **misma** `X-Idempotency-Key`.
- Quien lo reemite mira el **rol de la fila**, nunca el token, y no hace la comprobación de traslado
  (una Handy nunca es el `main_device_id`). Un dispositivo revocado no recibe token nuevo.

## Cuando la nube dice que no

Sin ticket del WebSocket, un corte de red y un rechazo se ven igual; se distinguen por el código
(`presencia_handy.rs::rechazar`: `license_expired`, `license_not_found`,
`device_revoked`):

- Un rechazo **se pinta, no se gira**: `useMainPresence.rechazo` separa «no hay Main» (una espera que
  acaba sola) de «la nube no te deja entrar», y `HandyEsperandoMain` dice cuál es y qué hacer.
- Se reintenta cada **5 minutos** y no al volver a primer plano. «Reintentar» avisa al servicio
  Rust, que sustituye la conexión; el aviso se retira cuando la nube vuelve a dejar entrar.
- Sin Main conectada, el DO congela a las Handy (`main_offline`); mientras la Main vuelca su atraso,
  esperan (`main_volcando`). Ver [sincronizacion.md](sincronizacion.md).

## Revocar

Configuración → dispositivos vinculados → revocar (`/v1/device/revoke`, Administrador). El dispositivo
queda marcado en `devices` y todo lo que intente después le contesta `device_revoked`.

El WebSocket de la Handy usa un ticket efímero. JavaScript sólo consulta el identificador del
negocio (`handy_get_tenant`); el JWT permanece en el keyring.
Guardar un nuevo token avisa al servicio nativo para sustituir el socket anterior inmediatamente;
la sesión y las cachés de presentación del vínculo anterior se retiran, sin recargar la aplicación.

## Salir del vínculo

Ir al selector de modo y borrar el vínculo son dos cosas (AUD-23):

- **«← Volver»** en la vinculación (a la que lleva «← Ir a vinculación», en la espera de la Main o
  con la Handy rechazada) cierra la sesión y enseña el selector **sin
  tocar nada guardado**: ni el token, ni el negocio, ni el modo de `device_config.json` (si la
  aplicación se reinicia ahí, vuelve a la Handy). No pide nada, tampoco con la Main desaparecida o la
  nube rechazando a la Handy. Desde el selector:
  - **«Handy»** vuelve al vínculo guardado (`handy_get_tenant`) sin pedir un código, y su tarjeta
    lo dice («Vuelve a la vinculación de este equipo.»);
  - **«TPV»** sigue el camino de la activación de la licencia, con el vínculo de Handy todavía en el
    almacén; si se vuelve atrás desde la activación, «Handy» lo recupera;
  - el **código de otra Main** lo sustituye (`handy_set_token`), igual que desde la vinculación.
- **Desvincular** es Configuración → Dispositivo, en la propia Handy (administrador y confirmación),
  y es el único camino a la vinculación con la Handy trabajando: la aplicación no tiene otro atajo.
  `device_reset_mode` borra el token y el negocio del almacén, pone el modo a cero y cierra la sesión;
  la pantalla retira también la suya y vuelve al selector. La identidad del equipo se conserva.

`handy_get_tenant` sólo contesta «no hay» cuando consta: si el almacén no responde es un error, y la
vinculación lo enseña en vez de pedir un código como a una Handy sin vincular. Un valor que no se
puede descifrar (la copia de Android restaurada en otro teléfono) cuenta como ausente: no se va a
poder leer nunca, y lo arregla vincularla de nuevo.

Mientras `handy_get_tenant` no ha contestado, la Handy no está «sin vincular»: el arranque enseña la
pantalla de carga, no el formulario (`useEmparejamientoHandy` empieza en `leyendo`, SYN-INC-08). Y
ese comando, como los demás de la vinculación, la licencia, el socket, la réplica, el modo del
equipo y la impresora que no son `async`, lleva `#[tauri::command(async)]`: un comando síncrono corre en el hilo principal, que en
Android es el de la interfaz, y leer el Keystore por JNI con el equipo sin red congelaba la pantalla
hasta el ANR. Lo vigila `lib.rs::tests_hilo_de_la_interfaz`.
