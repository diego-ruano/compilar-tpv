# El worker `tpv-api`

Un único Cloudflare Worker (`apps/cloud-worker-licensing/`, desplegado como `tpv-api`; la carpeta
conserva su nombre) sirve todo lo que es nube: la API de datos de la Handy, el Durable Object
`TenantHub`, el emparejamiento, las licencias, la compra por Stripe, la administración, las
actualizaciones, el correo, las imágenes y la telemetría. El cliente Rust apunta a él con
`CLOUD_API_BASE` (`crates/tpv-infra-licensing/src/lib.rs`) y el WebSocket con `CLOUD_WS_URL`
(`src/shared/lib/cloudApi.ts`): `https://tpv-api.altarialights.workers.dev`.

## Mapa

| Ruta | Dominio | Quién la usa |
|---|---|---|
| `GET /health` | `server/salud.ts` | La sonda externa |
| `GET /ws`, `/v1/ws` | `src/index.ts`, `domains/ws` | El WebSocket del `TenantHub` (con ticket de un solo uso) |
| `/v1/clientes`, `/configuracion`, `/cuentas`, `/inventario`, `/login`, `/mesas`, `/notificaciones`, `/proveedores`, `/reservas`, `/stats`, `/tareas`, `/trabajadores`, `/venta-rapida` | `domains/<dominio>/` | La Handy (lecturas y escrituras de negocio) |
| `/v1/sync/*` | `domains/sync/` | La Main: catch-up, volcado, histórico, contraste ([sincronizacion.md](sincronizacion.md)) |
| `/v1/images/*` | `domains/images/` | Subir, servir y borrar imágenes en R2 |
| `/v1/email/*` | `domains/email/` | Pedidos a proveedores |
| `/v1/pair/*`, `/v1/device/*` | `domains/pairing/` | Emparejamiento ([emparejamiento.md](emparejamiento.md)) |
| `/v1/license/*`, `/v1/stripe/*`, `/v1/admin/*` | `domains/{licensing,stripe,admin}/` | Licencias ([licencias.md](licencias.md)) |
| `/v1/interruptores` | `domains/interruptores/` | La Main ([jobs-e-interruptores.md](jobs-e-interruptores.md)) |
| `/v1/update/*` | `domains/updates/` | El updater de escritorio y la publicación ([publicar-version.md](../guias/publicar-version.md)) |
| `/v1/telemetry/*` | `domains/telemetry/` | Reenvío de eventos ([observabilidad.md](observabilidad.md)) |

Cada dominio de negocio tiene `*.routes.ts` (rutas), `*.queries.ts` (lecturas), `*.commands.ts`
(escrituras, que se aplican por el `TenantHub`) y `*.schemas.ts` (zod). Bindings (`wrangler.json`): el
DO `TenantHub` (SQLite), R2 `tpv-images` (público por `r2.dev`) y `tpv-copias-control` (privado),
`send_email` (`EMAIL`), los limitadores por IP `LIMITADOR_CLAIM` y `LIMITADOR_LICENCIA` (`lib/limitador.ts`)
y el cron diario `0 7 * * *`.

RI-46: los bindings de R2 son exclusivamente `IMAGES` y `COPIAS`. En desarrollo local, R2 y
`EMAIL` se simulan; no llevan `remote: true`. Turso conserva la configuración externa existente.
La fecha de compatibilidad (`2026-05-29`) coincide con el runtime instalado; los tests reutilizan
el mismo `wrangler.json` y los tipos se regeneran con `pnpm cf-typegen`.

## Dos bases, y sólo una se migra desde el código

- **La base de cada tenant** (Turso, una por negocio) se construye con las migraciones de
  `packages/database/migrations/`, registradas a mano en `src/server/tenantMigrations.ts`
  ([esquema.md](esquema.md)). `ensureTenantMigrated` la deja al día en el DO y en el REST.
- **La base central** (control-plane: licencias, tenants, dispositivos, emparejamientos, interruptores,
  correo, releases…) **no cambia de estructura desde el código**: el worker lee y escribe filas, nunca
  hace `CREATE`, `ALTER` ni `DROP`. Su estructura se cambia **a mano en Turso, antes de desplegar** el
  worker que la use, y se refleja en `docs/sql/control-plane/esquema-actual.sql`, que es lo único que la
  documenta y lo que cargan los tests (`test/helpers/planoDeControl.ts`).

### El token de la base del tenant

Dura 7 días (`?expiration=7d`) y se rota cada 24 h (`server/db/tenantDb.ts`). **Que no se pueda rotar
no es una caída**: si la API de plataforma de Turso falla, `resolveTenantDbCredentials` sigue con el
token guardado, salvo que venga de un 401 (`forceRotate`) o que le queden menos de 12 h.

## Cómo se escribe una ruta

- **Una ruta no lee su propio cuerpo.** Lo valida `lib/validacion.ts` —`cuerpo(schema)`,
  `consulta(schema)`— y el handler lo recoge con `c.req.valid("json")`.
- **Todo lo que decide antes de leer el cuerpo es middleware y va delante**: el veto de rol
  (`soloLaMain…`), un tope de tamaño, un token de administración, el filtro por IP del emparejamiento. Un
  `*.routes.ts` no resuelve roles. Lo vigilan `test/anularSoloMain.test.ts` y
  `test/vetoAntesDelCuerpo.test.ts`.
- **Toda ruta autenticada pasa por `tenantAuth`** (`middleware/tenant.ts`): token, device-proof, rol de
  la fila, licencia en uso. Tenant y dispositivo salen del token, nunca del cuerpo.
- **Lo que la Handy no puede hacer** lo vetan middlewares: `soloLaMainCobra` (`cobro_solo_en_main`),
  `soloLaMainEscribeCaja` (`caja_solo_en_main`), y `lib/hub.ts::TABLAS_SOLO_MAIN` para las tablas
  fiscales.
- `cuerpoConIdentificador` es sólo para el emparejamiento. Los cuatro cuerpos permisivos de `sync`
  (`/changes`, `/historico`, `/verificar-claves`, `/salud`) usan `cuerpoTolerante` con schemas que
  coercen y ponen valores por defecto: están en el camino de la recuperación, donde se falla hacia
  «sigue trabajando».
- **Un schema con contrapartida en Rust lleva drift-guard**:
  `Assert<SameKeys<z.infer<typeof xSchema>, XInput>>` (`lib/typeGuards.ts`) compara las claves en las
  dos direcciones; los tipos de los valores los cubre el paso a los command builders.
- **Lo que ese schema acepta o rechaza es lo mismo que acepta o rechaza la Main**, y lo fija la tabla
  [`validacion_casos.json`](../../crates/tpv-domain/src/validacion_casos.json): una entrada base válida
  por dominio y casos que la cambian, con `acepta` y, si hace falta, el valor normalizado que `queda`.
  La leen `tpv-domain/src/validacion_casos.rs` contra los `validar` del dominio y
  `test/validacionCasos.test.ts` contra los schemas. El arnés de contrato no lo ve: entra por debajo de
  la validación.
- **Una fecha que llega como texto se valida con `lib/fechas.ts`** (`zDia`, `normalizarDia`,
  `esFechaYmd`; espejo de `tpv_domain::fechas`): forma `YYYY-MM-DD` y día real de calendario. Una
  expresión regular deja pasar un 31 de febrero, y un `throw` dentro de un `transform` de zod no sale
  como fallo de validación sino como un 500.
- **El techo va en la respuesta, no en cada pieza**: una ruta que devuelve listas reparte un presupuesto
  común (como `leerClaves` en `/verificar-claves`, que marca `truncada` lo que no cabe). Un isolate
  tiene 128 MB.
- **Un importe que llega por la API viene en céntimos enteros** (`zDinero`); un `12.5` se rechaza.

## Errores

- Toda respuesta de error lleva `code` del catálogo cerrado `ErrorCode`
  (`crates/tpv-contracts/src/errors.rs`, exportado a TS) además del identificador `error`. Se ramifica
  por `code`; el resto es diagnóstico.
- **Lo que ve la persona es `message`, nunca un identificador.** La frase vive en `lib/errorCodes.ts`:
  `MENSAJES` para lo que alguien puede provocar usando el programa, `SIN_MENSAJE_PROPIO` para lo que ya
  tiene código de negocio o sólo sale con un bug. Un identificador nuevo va a una de las dos o
  `test/mensajesDeError.test.ts` falla. No se añade al enum `ErrorCode` lo que sólo se enseña.
- La aplica un middleware a todas las respuestas (`middleware/completarErrores.ts`); un `message`
  escrito en la llamada gana a la tabla.
- **Un error no cuenta su detalle interno** (FABLE-B): `serverError`, `unauthorized` y `forbidden`
  no aceptan detalles, y un 500 inesperado sale como `internal_error` sin más. La traza y el texto
  de Turso quedan en el log (`wrangler tail`) y en Sentry, donde se captura el error. Los `details`
  de un `HubError` sí viajan: los escribe quien lo lanza y son parte del contrato
  (`test/sinDetalleInterno.test.ts`).

## Correo

`/v1/email` manda pedidos a proveedores con el binding `EMAIL` (Cloudflare Email Service) desde
`EMAIL_FROM_ADDRESS`. Se acota **por destinatario** (sólo al `Email` de un proveedor dado de alta) **y
por volumen**: `TOPE_DIARIO` (100) envíos por negocio en una ventana de 24 h, contados en `email_sends`.
Sólo cuentan los pedidos entregados (`tipo = 'pedido'`, `ok = 1`), y si no se puede contar se deja
pasar. Las trazas se purgan a los 90 días (`RETENCION_ENVIOS_MS`).

Los correos al cliente de una reserva web salen de `domains/reservas_web/correos.ts`, desde
`EMAIL_RESERVAS_FROM_ADDRESS` con el nombre del negocio y su correo de contacto como `Reply-To`. Sólo
llevan datos estructurados (nada que haya escrito el visitante), van a la dirección del alta o al
cliente de la reserva web en la nube, y tienen sus topes: 600 al día por negocio y 10 por
destinatario, sobre lo entregado y lo que está saliendo (`tipo = 'reserva_web'`). Cada uno lleva su
id en `email_sends`, y el id y el cupo se reservan en una sola sentencia antes de enviar: el mismo
no sale dos veces, muchos a la vez no pasan de los topes y uno que falló se puede repetir. Sin la
base central no se envía (no se sabría si ya salió). Qué correo y cuándo:
[reservas-web.md](../estudios/reservas-web.md#48-correos).

RI-60: el envío exige nombre y correo comercial, leídos de la base del negocio junto con el
proveedor. Sale desde nuestro dominio verificado, con el nombre del negocio y su correo en
`Reply-To`. Dirección y teléfono son opcionales. Compra y recuperación del PIN conservan sus
correos independientes; el esquema del negocio sólo guarda el contacto comercial.

## Sincronización y firmas

El binding `TenantHub` está tipado y llama por RPC a `aplicar`, `revocarDispositivo` y
`avisarEmparejamiento`. El adaptador moderno extiende `DurableObject`; los helpers y credenciales
permanecen en un motor interno que no pertenece al prototipo RPC. No se publican rutas
`/internal/*`. Obtener el binding es la capacidad de acceso: no debe compartirse con otro Worker
ni convertirse en un proxy público. La autenticación del cliente y los gates de cada ruta siguen
ejecutándose antes de llamar al DO. Sentry instrumenta también las llamadas RPC, con tracing de
rendimiento desactivado. Los errores de negocio cruzan como un resultado tipado y los inesperados
como excepciones. WebSockets, attachments, alarmas y almacenamiento conservan su funcionamiento.

RI-44: `/v1/sync/changes` valida en SQLite que las sentencias guardadas sean un array JSON y
conserva ese fragmento en la respuesta. Un registro inválido falla explícitamente; no se sustituye
por una operación vacía. Ed25519 firma y verifica exclusivamente con WebCrypto en producción;
Noble sólo sirve de referencia independiente en tests. Placement sigue desactivado; véase
[cómo medir antes de decidir](../guias/medir-worker.md).

## Imágenes

Se guardan en R2 con prefijo por tenant y una expresión contra rutas con `..` (`REL_PATH_RE`). El GET
público las sirve con `max-age=31536000, immutable`; borrar una la quita también del caché del edge,
pero **sólo del centro de datos que atiende la petición** (barrer los demás pediría el API de purga). La
Handy no lee por esa ruta: lee del `r2.dev` del bucket (`src/shared/lib/imageUrl.ts`,
[INFRA-03](../pendientes.md#infra-03--imágenes-por-r2dev)).

La clave de la Cache API omite la query: no hay transformaciones por parámetros, así que distintas
queries reutilizan la misma imagen y el borrado usa esa misma URL. No requiere opciones del plan
de Cloudflare; `ignoreSearch` no está soportado por esta API. Esto no modifica las cachés TanStack
del cliente ni la lectura directa de la Handy desde `r2.dev`.

Main y Handy guardan su cola local en `image_uploads.json`, con escritura temporal y sustitución
atómica. Solo hay un drenaje activo; cada confirmación modifica su propia revisión, conservando
las entradas añadidas durante una subida. Los rechazos de contenido (400/413/415/422) y archivos
locales ausentes o inválidos se apartan, sin detener las siguientes imágenes. Los errores de red,
credenciales y servidor conservan la entrada para reintentar. Una cola ilegible devuelve un error:
no se trata como vacía ni se sobrescribe. Configuración → Conectividad muestra el estado y permite
reintentar; sustituir una imagen desde su ficha elimina su entrada anterior. Cada rechazo nuevo
se registra a nivel ERROR, que la integración existente con Sentry captura una sola vez.

## Salud y vigilancia externa

- **`/health` toca la base central** (`server/salud.ts`) y contesta 200 o 503. El cuerpo no cuenta por
  qué falla (el error de libsql lleva la URL de la base). Caché de 30 s por isolate: la ruta es pública.
  No toca ninguna base de tenant. Lo vigila `test/salud.test.ts`.
- **También descifra el canario de `LICENSE_STORE_KEY`** (`canario_cifrado`, RI-73): con una clave
  equivocada contesta 503 (`cifrado: "falla"`). La fila la crea el propio `/health` la primera vez. Sin la
  tabla, `cifrado: "sin_comprobar"` y la sonda sigue en verde.
- Una sonda externa (Better Stack) la consulta en `tpv-api.altarialights.workers.dev/health`, el mismo
  hostname que usan los clientes.

## El cron diario

`scheduled` en `src/index.ts`. Cada tarea va en su `try` y ninguna propaga:

1. **Avisos de caducidad** de licencias ([licencias.md](licencias.md#avisos-de-caducidad)).
2. **Purga de la base central** (`server/purga.ts`): fallos de emparejamiento, trazas de correo y
   eventos del código de cambio de equipo.
3. **Copia de la base central a R2** (`server/copiaBaseCentral.ts`) y, sólo si se subió, su latido
   (`BETTERSTACK_HEARTBEAT_COPIAS_URL`).
4. Al final y fuera de los `try`, el latido del cron (`BETTERSTACK_HEARTBEAT_URL`), aunque una tarea
   haya fallado: responde a «¿se ejecuta el cron?». Un latido nunca propaga (`observability/latido.ts`).

### La copia de la base central

Es la base que no se puede perder: si el worker contesta `license_not_found`, el TPV borra su licencia
local, así que perder `licenses` o `devices` desactivaría a todos. La copia cubre lo que el PITR de
Turso no (más de 24 h en el plan Free, una base borrada, el propio proveedor):

- **Sólo lee**, en una transacción de lectura, y sale en formato `sqlite3 .dump` comprimido.
- Va al bucket **privado** `tpv-copias-control`, nunca a `tpv-images`: lleva correos de clientes y DEK
  cifradas.
- La retención la pone el ciclo de vida del bucket (35 días), por debajo de los 90 de
  `RETENCION_ENVIOS_MS`.
- Sin `LICENSE_STORE_KEY` las DEK y los tokens de Turso de la copia no se pueden descifrar: ese secreto
  tiene que estar guardado fuera de Cloudflare.
- ⚠️ **Restaurar cambia de base**: `turso db create <nueva> --from-db tpvcontrol --timestamp <RFC3339>`
  (PITR) o `--from-dump copia.sql`, un token nuevo (`TURSO_AUTH_TOKEN`), su URL en `TURSO_DATABASE_URL`
  de `wrangler.json` y desplegar, **deprisa**: mientras el worker apunte a una base sin esas filas, cada
  TPV que compruebe su licencia la borra. Las licencias activadas después del punto restaurado hay que
  rehacerlas a mano.

## Secretos

Van con `pnpm exec wrangler secret put <NOMBRE>` desde `apps/cloud-worker-licensing/`, nunca en
`wrangler.json`. Los de licencias están en [licencias.md](licencias.md#secretos-del-worker); además:
`TURSO_AUTH_TOKEN` y `TURSO_PLATFORM_TOKEN` (base central y API de plataforma), `PAIR_PEPPER`,
`RELEASE_ADMIN_TOKEN` (publicar releases), `SENTRY_DSN`, `AXIOM_TOKEN`,
`BETTERSTACK_HEARTBEAT_URL`, `BETTERSTACK_HEARTBEAT_COPIAS_URL` y, opcional, `HANDY_TOKEN_TTL_SECONDS`.
Una ruta que depende de un secreto ausente responde 503 o 500 (fail-closed).

## Desplegar

Producción se despliega desde GitHub con un tag `v<versión>`. El workflow comprueba la misma versión
en worker y escritorio, sube los mapas a Sentry y verifica un error real antes de desplegar los mismos
bytes. Los tags `win7-v<versión>` publican únicamente el escritorio de Windows 7.

El worker lleva el esquema del tenant compilado dentro: **con un cambio de esquema, se despliega antes
de que los TPV escriban la columna nueva**, o la primera escritura se rechaza. Y cualquier tabla o
columna nueva de la base central se crea a mano en Turso antes. Más en
[publicar-version.md](../guias/publicar-version.md).
