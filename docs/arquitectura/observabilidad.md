# Observabilidad

| Herramienta | Para qué |
|---|---|
| **Sentry** | Errores y crashes: panics de Rust, minidumps nativos, errores de la Webview y excepciones del worker y del Durable Object |
| **Axiom** | Telemetría estructurada: logs de los dispositivos reenviados por el worker y eventos de salud de la sincronización |
| **Better Stack** | Vigilancia desde fuera: la sonda de `/health` y los latidos del cron |
| Fichero local | `<AppData>/logs/tpv.log`, 7 días: la fuente de verdad para soporte |

La copia previa a migrar y las migraciones confirmadas se registran con `tracing` (target
`tpv::migrations`): éxitos a INFO y copia fallida a WARN. Incluyen nombre de fichero/migración,
bytes o error, sin la ruta absoluta de AppData.

En desarrollo la captura es **no-op** si faltan los secretos. Una publicación exige la configuración
de Sentry completa y sus mapas verificados; no se despliega sin esa comprobación.

El código propio, incluido licencias, emite con `tracing`. En Android, `JNI_OnLoad` inicializa
el logger de plataforma antes de usar JNI: conserva el diagnóstico temprano en Logcat
(`TPVRust`, INFO o superior). Cuando se instala el subscriber, el mismo logger pasa a conectar
las dependencias que usan `log` con `tracing`; una capa escribe directamente a Logcat sin bucles
ni duplicados. El subscriber se registra por separado del logger: un logger ya instalado no
interrumpe la creación del guard, el estado y el worker. En escritorio se instala `LogTracer`
si la fachada `log` está libre.

## El flujo

```
Escritorio (Rust + Webview)
  ├─ tauri-plugin-sentry ───────────────────────────────► Sentry   (DSN público embebido)
  ├─ tracing ─► fichero local de 7 días                  [fuente de verdad]
  └─ tracing ─► cola durable <AppData>/telemetry-spool/
                  └─ hilo propio ─ POST /v1/telemetry (device-proof) ─► worker ─► Axiom

Worker (Hono)    ── @sentry/cloudflare ─────────────────► Sentry
TenantHub (DO)   ── emitSyncEvent() ────────────────────► Axiom (dataset de sync)
Better Stack     ── GET /health, latidos del cron
```

- **El token de Axiom no está en el dispositivo**: es un secreto del worker. Los equipos suben a
  `/v1/telemetry` autenticados y el worker retransmite. El endpoint fija `tenant_id` y `device_id` desde
  el token, no desde el cliente.
- **La cola a Axiom está en disco**: la antesala se persiste aproximadamente al segundo, en un
  segmento JSONL que se cierra a los 60 s, 500 eventos o 512 KiB. El envío agrupa también ficheros
  antiguos y respeta 500 eventos y 512 KiB de cuerpo JSON. Hay al menos 10 s entre peticiones
  cuando hay atraso, con backoff hasta 5 min y jitter ante fallos. Un POST lento no detiene el
  drenado; al quedar vacía, la cola espera una notificación sin sondear el disco.
- Un 2xx confirma los eventos enviados; un cursor en disco conserva el progreso parcial tras un
  reinicio. Los temporales se recuperan descartando únicamente la última línea incompleta. No hay
  fsync ni garantía frente a cortes de corriente. Puede haber duplicados si la entrega llega al
  servidor pero su confirmación no llega al dispositivo (entrega al menos una vez).
- **Retención acotada (RI-19)**: 256 MiB en Main y 64 MiB en Handy, podando los segmentos más
  antiguos. La antesala tiene un máximo de 20.000 eventos y un presupuesto conservador de memoria
  de 16 MiB en Main y 4 MiB en Handy (también en Android antes de conocer el modo). Se contabilizan
  las capacidades de las cadenas, los nodos de campos y el máximo de huecos del anillo. Un evento
  extraído sigue contando hasta terminar su escritura: no se vacía el anillo a una segunda cola.
  Se descarta lo más antiguo que no esté en escritura; si ese evento ocupa el presupuesto restante,
  se descarta la nueva entrada. Los descartes, errores de E/S y líneas
  corruptas quedan en el log local con target `tpv::telemetry`, excluido del reenvío para evitar
  realimentación. Los errores de escritura conservan los eventos no persistidos para reintentar.
- El cliente recorta el texto conforme al schema del servidor y omite campos estructurados
  excesivos con un marcador. Un 400/413/422 divide el lote hasta aislar el evento rechazado;
  autenticación, rate limit, red y 5xx conservan el lote. El servidor limita el cuerpo antes de
  autenticar y espera Axiom: si falla, responde 502. Sin token de Axiom, sigue siendo un no-op.
- La captura a la antesala limita el mensaje a 4.000 bytes y cada campo de texto a 4 KiB, sin
  construir antes su representación completa. Los campos se limitan conjuntamente a 32 KiB de
  memoria estimada y 64 entradas, más el marcador `telemetry_captura_recortada` cuando se recortan
  u omiten datos. Un evento de más de 64 KiB de memoria estimada no entra en la antesala. Estos
  límites se aplican sólo al reenvío; el fichero local conserva el diagnóstico completo.
- **Escritorio**: el DSN entra al compilar con `TPV_SENTRY_DSN` (`option_env!`, con
  `rerun-if-env-changed` en `build.rs`). Sólo lo pone el workflow de release: en `pnpm tauri dev` no hay
  Sentry, y como la Webview manda sus eventos por el cliente de Rust, tampoco del frontend. El entorno lo
  decide el identificador de la app (`lib.rs::entorno_de_sentry`: `e2e`, `dev` o `prod`), así que la
  tanda E2E no se mezcla con los clientes. Los minidumps se inicializan sólo con DSN y sólo en
  escritorio.
- **Worker**: `SENTRY_DSN` es un secreto de Cloudflare. El artefacto de release fija `ENVIRONMENT=prod`,
  `SENTRY_RELEASE=tpv-api@<versión>` y `BUILD_COMMIT`. `nodejs_compat` está activado (lo exige `@sentry/cloudflare`).
  `instrumentDurableObjectWithSentry` cubre los handlers del WebSocket del DO.
- **Logpush** está activado en el worker (`"logpush": true`); el destino se configura en el panel de
  Cloudflare.

## Los errores salen sin datos personales (OBS-01)

Antes de mandar algo a Sentry o a Axiom, el mensaje y los campos pasan por un filtro que sustituye por un
marcador lo que tenga forma de dato personal o de secreto: DNI, NIE, IBAN, número de la Seguridad
Social, teléfono, tarjeta, correo, PIN y tokens. `sendDefaultPii = false` sólo cubre el contexto
automático de Sentry, no las cadenas que compone el código.

Hay **tres copias** porque no pueden compartir código: la Webview (`src/shared/observability/scrub.ts`),
el core de Rust (`crates/tpv-telemetry/src/scrub.rs`, que vuelve a filtrar todo lo que sale de la Main)
y el worker (`apps/cloud-worker-licensing/src/observability/scrub.ts`, en el `beforeSend` de Sentry).
Lo que sale a Axiom se filtra también en `ingestToAxiom`, sobre una copia del lote: cubre los eventos
generados por el worker/DO sin modificar el estado del llamante. Si copiar, filtrar o serializar falla,
no se envía el lote y la ingesta del dispositivo responde 502 para conservarlo.
Lo que las mantiene iguales es `crates/tpv-telemetry/src/scrub_casos.json`, la tabla que leen los tests de
las tres: **una regla nueva lleva su caso ahí**, o las otras copias no se enteran. Usa fronteras y dígitos
ASCII (`(?-u:\b)`, `[0-9]`) para que Rust y JavaScript decidan igual.

No reconoce nombres ni direcciones: un mensaje de error no se compone con ellos. No toca el fichero local.

RI-42: conserva UUIDs completos, fechas ISO, timestamps identificados por claves temporales
(`*_ms`, `timestamp`, `epoch`, `ts`) y hashes identificados como tales. Las credenciales se
ocultan antes de proteger esos intervalos; las claves estructuradas de secretos también se
redactan. Detecta teléfonos españoles de nueve cifras con prefijo opcional `+34`, `0034`, `34`
o `(+34)`, incluidos varios teléfonos consecutivos separados por espacios, y candidatos a tarjeta
de 13–19 cifras que pasan Luhn. Reconoce claves de credenciales entre comillas en texto JSON y
variantes explícitas como `access_token`, `refreshToken`, `id-token` y `client_secret`, también
en objetos anidados. Los valores entre comillas se redactan completos, incluidos espacios y escapes.
Si la captura termina dentro de un valor entre comillas, se redacta hasta el final del texto.
La autorización consume el esquema Bearer/Basic y su credencial, sin borrar el texto siguiente;
las pasadas posteriores conservan los marcadores y el diagnóstico.
No redacta cualquier número largo por su longitud. Rust preselecciona reglas con RegexSet y conserva cadenas prestadas sin
reemplazos. La tabla compartida cubre texto y objetos anidados, incluida su idempotencia.

## Piezas

| Capa | Archivo |
|---|---|
| Crate de telemetría | `crates/tpv-telemetry/` (`config`, `context`, `event`, `forward`, `spool`, `worker`, `sentry`, `scrub`, `state`) |
| Cableado del escritorio | `apps/tpv-main/src-tauri/src/lib.rs` |
| Sentry de la Webview | `apps/tpv-main/src/shared/observability/sentry.ts` (más el error boundary y el listener global) |
| Sentry del worker | `apps/cloud-worker-licensing/src/observability/sentry.ts` |
| Axiom | `apps/cloud-worker-licensing/src/observability/axiom.ts` |
| Ingesta | `apps/cloud-worker-licensing/src/domains/telemetry/telemetry.routes.ts` |
| Eventos de sync | `durableObjects/tenantHub.ts` (`emitSyncEvent`), `tenantHub.cola.ts`, `tenantHub.mensajes.ts` |
| Latidos | `apps/cloud-worker-licensing/src/observability/latido.ts` |
| Salud | `apps/cloud-worker-licensing/src/server/salud.ts` |
| Esquema de evento | `crates/tpv-telemetry/src/event.rs` → `packages/contracts/src/generated/telemetry.ts` (ts-rs) |

## Release de Sentry y source maps

El cliente usa la release que fija `build.rs` a partir de la versión de `tpv` y del target.
`sentry-config.mjs` comprueba Cargo, `tauri.conf.json`, `package.json`, el tag y la identidad de
Sentry. Vite y Rust usan `tpv-desktop@<versión>`; Windows 7 usa `tpv-desktop-win7@<versión>`.
Comparten proyecto, con releases distintas. Los eventos nativos llevan `build_variant` y, en CI,
`build_commit`.

RI-24: `release.yml` exige DSN y token, comprueba por API que el DSN es una Client Key activa de
`altaria-lights/tpv-desktop` y pasa la identidad derivada del tag al build. Si falla la configuración, la subida
o la comprobación de los artefactos remotos, no llega a los jobs de firma y publicación.

Los mapas se generan como `hidden`, se suben con el JavaScript a `~/assets/` y se borran del bundle.
Se usa `release.uploadLegacySourcemaps`, sin inyección de Debug IDs: `tauri-plugin-sentry 0.5` pasa
el sobre a `sentry-rust 0.42`, cuyo deserializador no acepta imágenes `sourcemap` en `debug_meta`.
Inyectarlas haría que el puente descartase el evento. Las rutas relativas permiten simbolizar
tanto `http://tauri.localhost/assets/…` como el protocolo de Tauri.

El plugin nativo usa `init_with_no_injection`: la Webview ya inicializa su SDK con el filtro de
datos personales. Así no hay un segundo SDK inyectado que capture eventos sin ese filtro.

El token interno de CI necesita **Release → Admin**, **Organization → Read** y **Project → Read**:
el último permite comprobar el DSN activo y leer un evento controlado para verificar su traza.

### Worker: mapas, captura y datos seleccionados

El tag moderno `v<versión>` publica escritorio y API con una misma versión. El worker lleva
`tpv-api@<versión>`, en su propio proyecto. `win7-v<versión>` sólo publica Windows 7: una rama
congelada nunca reemplaza el backend compartido con código antiguo.

`worker.mjs` compila con Wrangler, inyecta Debug IDs y sube los mapas con la CLI oficial. Un
manifiesto guarda hashes del JS, mapas, módulos SQL y configuración. Antes de desplegar se
comprueban los hashes y el Debug ID remoto. Wrangler recibe `no_bundle`, para ejecutar los mismos
bytes que se subieron. `verify-worker-sentry.mjs` ejecuta ese artefacto en workerd local sin
credenciales de Turso y exige que Sentry reciba el fallo con archivo, línea y contexto TypeScript.
Las pruebas van a `sentry-verification` y fallan antes de abrir una conexión o escribir datos.

Los `catch` de correo, Stripe, aprovisionamiento, cron y sincronización notifican errores técnicos
y conservan su respuesta o reintento. Se filtran rechazos HTTP tipados de entrada/autorización y
rechazos de negocio de `HubError`, incluido `main_offline`. Los fallos desconocidos se notifican.
Una caída de red o una cuota agotada puede impedir recibir un evento; Better Stack conserva la
vigilancia externa.

La recogida automática de cuerpo, cabeceras, cookies, IP y query está desactivada. Después de
autenticar y validar, `requestContext.ts` selecciona campos por operación: importes en céntimos,
stock, IVA, booleanos y enums cerrados. En pedidos sólo guarda cantidad de líneas y longitud de
notas. Una ruta o campo nuevo no envía su cuerpo hasta incorporarlo expresamente a la lista.
No se envían nombres, notas, destinatarios, PIN, JWT ni identificadores de personas. El filtro
final elimina usuario, extras libres y consola; el filtro común redacta patrones reconocibles en
los mensajes de error. La revisión de proveedores y retención sigue en
[LEGAL-01](../pendientes.md#legal-01--rgpd).

Los transportes Rust añaden `X-TPV-Version` y `X-TPV-Variant`, obtenidas del shell. El worker
guarda valores con formato de versión y variantes conocidas como `client_version` y
`client_variant`. Son contexto diagnóstico, no autorización.
No se embebe el token en el frontend ni en Rust. En builds locales sin token Sentry sigue siendo
opcional; una release oficial se marca con `TPV_RELEASE_BUILD=1` y no permite omitirlo.

Para verificar una traza controlada, guardar un JSON con `eventId`, `source` (sufijo del archivo
original) y `line`, y ejecutar `node scripts/release/check-sentry-event.mjs <json>` con las variables
de build. El script espera la recepción y exige la versión, plataforma, archivo y línea correctos.

El worker tiene su propio proyecto y su propia versión (`SENTRY_RELEASE` del worker, no la versión
de escritorio). `upload_source_maps` de Wrangler sube mapas a Cloudflare; no los entrega al SDK
de Sentry. Para simbolizar sus eventos también hay que subir a su proyecto el bundle y sus mapas
exactos al desplegar, con una versión compartida por esa subida y el runtime. La comprobación real
del 10-10-2026 confirmó recepción en `node-cloudflare-workers`, entorno `prod`, pero sin release
ni simbolización TypeScript; esto requiere completar el despliegue del worker.

## Configuración

| Variable | Dónde | Qué |
|---|---|---|
| `TPV_SENTRY_DSN` | Entorno del build de escritorio (release) | DSN de `tpv-desktop` |
| `SENTRY_AUTH_TOKEN` | Secret de GitHub; sólo validación/build Vite | Token interno para subir mapas y comprobar la configuración |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Variables de GitHub | `altaria-lights`, `tpv-desktop` |
| `SENTRY_RELEASE` | Lo calcula el workflow desde el tag | Versión compartida de eventos y mapas; por defecto, versión de Tauri |
| `TPV_RELEASE_BUILD` | Lo fija el workflow a `1` | Bloquea la release si faltan los datos de Sentry |
| `SENTRY_DSN` | Secreto del worker | DSN de su proyecto (`node-cloudflare-workers` en la cuenta actual) |
| `ENVIRONMENT` | `vars` del worker (hoy ausente) | Entorno en Sentry |
| `AXIOM_TOKEN` | Secreto del worker | Ingesta |
| `AXIOM_DATASET` | `wrangler.json` (`tpv-device-logs`) | Logs de dispositivo |
| `AXIOM_DATASET_SYNC` | `wrangler.json` (`tpv-sync`) | Eventos del worker y del DO |
| `AXIOM_DOMAIN` | `wrangler.json` (`eu-central-1.aws.edge.axiom.co`) | Región de Axiom |
| `BETTERSTACK_HEARTBEAT_URL` | Secreto del worker | Latido del cron (suena siempre al acabar) |
| `BETTERSTACK_HEARTBEAT_COPIAS_URL` | Secreto del worker | Latido de la copia de la base central (sólo si se subió) |

Sentry: dos proyectos para este sistema (`tpv-desktop` y `node-cloudflare-workers`), región UE,
sin Session Replay. Axiom: tres datasets
(`cloudflare-logpush`, `tpv-sync`, `tpv-device-logs`), separados por la **retención**, que es propiedad
del dataset y no se aplica hacia atrás; cada evento lleva `service` (`tpv-device`, `tpv-sync`,
`tpv-api`). Retención sugerida: 30 días para `tpv-sync`, 30–90 para `tpv-device-logs`.

Para comprobar la ingesta sin esperar a que pase algo, una petición sin autenticar a una ruta de tenant
emite un `device_auth_rechazado`:

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/sync/verificar \
  -H "Authorization: Bearer sonda" -H "Content-Type: application/json" -d '{}'
```

Devuelve 401 y en `tpv-sync` debe aparecer el evento con `motivo: invalid_jwt`.

## Correlación

Cada evento y error lleva `tenant_id`, `device_id`, `device_mode` (tpv/handy), `app_version` y
`environment`: tags en Sentry, campos en Axiom. Los eventos del DO añaden `connected_devices` y
`main_connected`. `connected_devices` cuenta los sockets autenticados de `state.getWebSockets()`; el
`last_seen_at_ms` de un dispositivo se refresca al conectar y con su actividad, no con el latido (que no
despierta al DO): la presencia real la dan `main_online` / `main_offline`.

## Eventos de `tpv-sync`

Sólo **fallos** y **ciclo de vida**: un `apply` correcto no se emite.

| `event` | Cuándo |
|---|---|
| `apply_error` | Un apply falla en el DO. `command_name`, `op_id`, `device_id`, error recortado y `latency_ms`, sin el comando ni sus args |
| `main_online` / `main_offline` | Una Main se autentica / se va la última (freeze de las Handy) |
| `device_auth_rechazado` | El worker rechaza a un dispositivo. `motivo`, `ruta`, `metodo` |
| `tenant_salud_sync` | El contraste diario de una Main con la nube (descuadres, reparadas) |
| `cola_volcado_inicio` / `cola_volcado_fin` | La Main vuelca su atraso a la cola del DO |
| `cola_pausada`, `cola_base_caida`, `cola_ciclo_error` | La cola no avanza: interruptor, Turso que no contesta, fallo de una vuelta |
| `cola_apartada` / `cola_apartada_acusada` | Una operación sale a `_Cola_Muerta` / una Main la acusa |

## Alarmas recomendadas

- **Sentry**: issue nuevo o pico en cada proyecto, caída del *crash-free rate*, Spike Protection y
  filtros de entrada (un DSN público se puede sondear).
- ⚠️ **`outbox_op_apartada` en Sentry** (lo emite el TPV): un equipo tiene un dato que la nube no va a
  tener. Trae `op_id`, `command_name`, `intentos`, `permanente` y `error_nube`, sin sentencias ni args. Su
  pareja en el worker es el `apply_error` de esa misma `op_id`.
- **Main caída**: `main_offline` sin `main_online` posterior en N minutos por `tenant_id`.
- **Errores de apply**: volumen de `apply_error` por `tenant_id`.
- **Dispositivo rechazado**: una racha de `device_auth_rechazado` del mismo `device_id`; agrupar por
  `motivo` (`device_revoked`, `bad_device_signature`, `device_ts_out_of_range`). No van a Sentry: un 401
  suelto es normal.
- **Descuadres**: `tenant_salud_sync` con descuadres.
- **Errores de dispositivo**: tasa de `level == "ERROR"` en `tpv-device-logs` por tenant.
- **Better Stack**: `/health` en rojo, y cualquiera de los dos latidos que deje de sonar.

## Por qué `/health` y los latidos

Sentry y Axiom dependen de que el código se ejecute y consiga emitir: si el worker no despliega, la
cuenta se suspende o el DNS se rompe, un panel vacío se ve igual que «no pasa nada». Por eso hay una
sonda externa contra el **mismo hostname que usan los clientes**, y `/health` toca la base central
([worker.md](worker.md#salud-y-vigilancia-externa)): un `{ ok: true }` que no comprueba nada estaría verde
durante una avería de Turso. Ninguna petición HTTP ve que el cron lleve meses sin dispararse; eso lo dice
su latido.

## Pendiente

- Un límite por dispositivo en `/v1/telemetry` (hoy: topes de tamaño y autenticación).
- En Rust, `#[tracing::instrument(skip_all, fields(...))]` en los casos de uso para no volcar DTOs con
  datos de cliente en los spans.
