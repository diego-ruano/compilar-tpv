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
| Main | Configuración → Vincular Handy | Generar el código y aprobar |
| Token | `crates/tpv-infra-licensing/src/{lib,device}.rs` · `crates/tpv-infra-http/src/client.rs` | Guardarlo y renovarlo |

## El flujo

1. La Main crea un código (`/v1/pair/create`): 6 cifras, válido **10 minutos**.
2. La Handy lo reclama (`/v1/pair/claim`) con su `device_id` y su clave pública, y recibe un reto y
   cuánto le queda (`caducaEnMs`, en relativo: no depende de que los relojes coincidan). Un dispositivo
   ya aprobado puede volver a reclamar su propio código y recibe un reto nuevo, que es lo que salva a
   una aplicación que se cerró esperando.
3. La Main ve la solicitud (`/pending`) y la aprueba o la rechaza.
4. La Handy pregunta por el token (`/fetch-token`) firmando el reto con su clave y la acción
   `PAIR_FETCH`. **El dispositivo se da de alta en `devices` al recoger el token**, no al aprobar, y es
   entonces cuando la Main recibe el aviso.
5. Cancelar en la Handy (`/v1/pair/cancel`, acción `PAIR_CANCEL`) suelta el código en la nube, para que
   la solicitud no siga en la lista de la Main. Lo ya aprobado no se deshace cancelando: eso es revocar.

Rust construye el mensaje y fija la hora y la identidad; el IPC acepta únicamente acción, código
y reto, nunca texto libre (RI-20). La acción abre el mensaje como separación de dominio, distinta
de `WS_HELLO` y `DEVICE_PROOF`. La acción va dentro de lo que se firma, para que la firma de una consulta no sirva para cancelar ni al
revés.

## Las reglas

- **Freno por IP** (`pairing.intentos.ts`): cada 3 fallos, una espera de 30 s, luego 5 min, luego
  30 min; se olvidan al emparejar bien o tras un día sin fallar. Delante, un tope de 20 peticiones por
  minuto y por IP antes de tocar la base. Por IP y no por dispositivo porque el `deviceId` lo elige
  quien llama (el precio: las Handy de un bar comparten la cuenta). La espera se mira **antes** de leer
  el código, o un intento bloqueado seguiría diciendo si existe. Una petición mal formada no cuenta: la
  rechaza el validador, que va detrás del filtro exterior.
- **El identificador del error es contrato** con la Handy, que no tiene sesión ni dónde mirar: estas
  rutas usan `cuerpoConIdentificador`.
- **Una ruta anónima nueva** hay que eximirla también en el proxy (`PAIRING_SIN_SESION` en
  `commands/pairing.rs`); todo lo demás de `/v1/pair/…` y `/v1/device/…` exige Administrador.
- **Un equipo tiene una identidad para los dos modos.** Vincularlo como Handy de otro negocio mueve su
  fila de `devices` a ese negocio. Si vuelve a ser la Main del suyo, `/v1/license/status` y `/refresh`
  lo readmiten (`readmitirMain`) cuando firma con su clave registrada y sigue siendo el
  `main_device_id`; si la licencia ya está en otro equipo, contestan `device_replaced`.
- **Esa mudanza la hace el propio dispositivo, firmando.** Antes de mover una fila de `devices`, las dos
  puertas que dan de alta un dispositivo (activar una licencia y recoger este token) llaman a
  `exigirClaveSiEsDeOtroNegocio`: si el `device_id` tiene clave registrada en **otro** negocio y no es
  ésta, no se toca nada. Dentro del mismo negocio, que la clave cambie es la vía de recuperación de una
  Handy revocada que se vuelve a vincular, y lo aprueba el dueño.

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
