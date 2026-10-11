# Sincronización: Main ↔ nube ↔ Handy

La Main es **Local-First**: vende contra su SQLite haya red o no. Cuando hay conexión replica sus
escrituras a la nube (un Durable Object `TenantHub` por negocio, sobre una base Turso por negocio) y
recibe las de las Handy. La **Handy no tiene base local**: lee por REST del worker y escribe por REST;
sin nube no opera.

```
┌──────────────────────┐        WebSocket /ws          ┌────────────────────────────┐
│ MAIN (Tauri + Rust)  │── apply / bulk_apply ────────►│ Durable Object TenantHub   │
│ SQLite (rusqlite)    │◄── change (en vivo) ──────────│ · aplica idempotente       │
│ _Sync_Outbox         │                               │   (Applied_Operations)     │
│ _Sync_Applied_Ops    │   REST /v1/sync/changes       │ · cola de entrada          │
│ _Sync_State          │◄── catch-up ──────────────────│ · difunde a los demás      │
└──────────────────────┘                               └─────────────┬──────────────┘
┌──────────────────────┐   REST /v1/<dominio>                        │
│ HANDY (sin base)     │── escrituras ──► lib/hub.ts → RPC aplicar
│ lee por REST         │◄── change (WS): vuelve a pedir lo que cambió
└──────────────────────┘                                             ▼
                                                           ┌──────────────────┐
                                                           │ Turso del tenant │
                                                           └──────────────────┘
```

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Captura | `crates/tpv-infra-sqlite/src/db.rs` | `WriteGuard::execute` reescribe la hora a literal, ejecuta y guarda la sentencia en `_Sync_Outbox` en la misma transacción. `raw()` escribe sin capturar |
| Repositorio de sync | `crates/tpv-infra-sqlite/src/sync.rs` | Outbox, aplicar cambios remotos, cuarentenas, catch-up, bootstrap, backfill, contraste con la nube |
| Reparación por estado | `crates/tpv-infra-sqlite/src/sync_reparacion.rs` | Reencola la fila tal como está ahora |
| Casos de uso y comandos | `tpv-application/src/use_cases/sync.rs` · `commands/sync.rs` | La interfaz Tauri |
| Réplica de la Main | `src-tauri/src/replicacion.rs` · `tpv-application/src/use_cases/replicacion.rs` | Transporte nativo TLS, catch-up, outbox, confirmaciones, recuperación y estado de conexión. La UI observa `sync:estado` y `sync:cambio`, sin SQL ni credenciales (RI-31/RI-57) |
| Socket de la Handy | `src-tauri/src/socket_handy.rs` · `tpv-application/src/use_cases/presencia_handy.rs` | Servicio nativo de presencia y avisos, independiente de React. La UI observa `handy:estado` y `handy:cambio` |
| Transporte común | `tpv-infra-http/src/websocket.rs` · `tpv-application/src/use_cases/saludo_socket.rs` | TLS, latido, buffers y tiempos acotados; saludo firmado y rol confirmado. Main y Handy conservan casos de uso distintos |
| Qué refrescar | `tpv-application/src/use_cases/avisos_nube.rs` · `src/shared/lib/syncStatements.ts` | Rust deriva tablas e IDs sin exponer SQL; React los traduce a sus cachés y al ticket abierto |
| El DO | `apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts` | Adaptador RPC y callbacks del runtime; motor interno en `tenantHub.motor.ts` |
| …lo que llega por WS | `tenantHub.mensajes.ts` | Una rama por mensaje |
| …el transporte | `tenantHub.rutas.ts`, `tenantHub.rpc.ts` | Upgrade WebSocket y contratos de aplicar, revocar y avisar |
| …el saludo | `tenantHub.identidad.ts` | Quién llama y qué puede hacer |
| …la cola | `tenantHub.cola.ts` | `_Cola_Entrada`, `_Cola_Estado`, `_Cola_Muerta` |
| …el lote | `tenantHub.lote.ts`, `tenantHub.sentencias.ts`, `tenantHub.envelope.ts` | De un comando a sentencias; el sobre que se guarda en `Sync_Changes` |
| …la hora | `tenantHub.tiempo.ts` | Fijar `'now'` con la hora del emisor |
| …los errores | `tenantHub.errores.ts` | Permanente, pasajero o desconocido |
| Escrituras de la Handy | `src/lib/hub.ts` + `domains/*/*.commands.ts` | Cada dominio construye su transacción y la aplica vía el DO |
| REST de sync | `domains/sync/sync.routes.ts` | `/changes`, `/bootstrap`, `/historico`, `/initialize-empty`, `/verificar`, `/verificar-claves`, `/salud` |

### Servicio de avisos de la Handy

Arranca en el shell de Tauri y espera modo Handy y un vínculo válido. React sólo observa su estado
actual y eventos pequeños; desmontar la interfaz no cierra la conexión. Al cambiar de modo o guardar
un nuevo vínculo, Rust invalida la generación anterior y sustituye el transporte. La UI descarta los
avisos antiguos, la sesión mostrada, las consultas y las cachés de ajustes e imágenes; las respuestas
pendientes de los ajustes anteriores tampoco pueden repoblarlas.

El saludo exige `hello_ok` con rol Handy y un `main_status` válido antes de confirmar presencia. Un
corte de red conserva la presencia anterior durante cinco segundos; la gracia vence también si se
está esperando un ticket o una reconexión. Sin Main o durante su volcado se mantiene el bloqueo.
Rechazos de licencia y revocación se distinguen de la red, con reintentos cada cinco minutos.

Cada conexión confirmada tiene un contador nativo. Al volver a observarla, reconectar o terminar el
volcado se releen consultas, ajustes y ticket abierto: la Handy no conserva ni reproduce SQL perdido.
Los cambios en vivo siguen invalidando sólo las áreas afectadas. Tauri avisa a Rust del foco y de la
reanudación en Android; `online` en la webview es sólo una pista para el servicio. No se requiere un
servicio Android en segundo plano: la conexión se recupera al volver si el sistema suspendió la app.

---

## Las reglas

### Escritor único y captura

La ejecución local de SQLite pertenece a cinco hilos propios: uno para el escritor y cuatro para
las conexiones de lectura (RI-16). Tokio espera sus respuestas; nunca ejecuta SQL ni avanza cursores
nativos, tampoco por `raw()`. Cada ejecutor admite hasta 32 trabajos pendientes y entrega filas
copiadas en lotes de 64. El motor es rusqlite con su SQLite empaquetado, el mismo en Windows,
Windows 7 y Android. `query` y `execute` ejecutan **una** sentencia: un texto con varias es un
error, y varias seguidas van por `execute_batch`. Unos parámetros que no cuadran con los marcadores
se toleran —los que faltan valen NULL, los de más se ignoran— y dejan un aviso. La sentencia va
aparte, en `debug`, que no sube a la nube (OBS-02): se ve en el log local arrancando con
`TPV_LOG=info,tpv::sql=debug`. Una cancelación no interrumpe SQL ya iniciado: la limpieza del guard
se encola antes del siguiente escritor. Para sustituir el fichero se espera el cierre confirmado de
los ejecutores. Abrir, migrar y comprobar copias efímeras también ocurre fuera del runtime async.

Las operaciones con varias sentencias usan `Writer::transaccion(async { … })` (RI-32), también
para lotes locales y remotos sin captura. El helper confirma negocio y outbox juntos y revierte
si falla el cuerpo, el outbox o el COMMIT. Una guarda encola la reversión al cancelar o entrar en
pánico. Los mutex síncronos del buffer y del instante nunca se retienen al esperar una operación.

- **Toda escritura local de negocio pasa por `WriteGuard::execute`**, que la captura en el outbox. Qué
  es escritura lo decide la cabeza de la sentencia **sin los comentarios de delante**
  (`sin_comentarios_iniciales` → `is_write_sql`), y lo que sube va sin ellos. Un `WITH … INSERT` no se
  reconoce como escritura; si alguna vez hace falta, hay que enseñárselo a `is_write_sql`.
- **Lo que es estado local del equipo va por `raw()`**: `_Jobs_State`, `_Sync_*`, `_Verifactu_*`,
  `_Backfill_Historico`, `_Recovery_State`, el backfill. Por `execute()` se replicaría a la nube.
- **Idempotencia** por `Op_Id`: `Applied_Operations` en la nube y `_Sync_Applied_Ops` en la Main evitan
  duplicados en catch-up y en vivo, y los ecos de las propias escrituras.
- **IDs deterministas**: toda columna `TEXT PRIMARY KEY` recibe su UUID generado **antes** del
  `INSERT` (en el worker, un paso `kind:"value"` con `nuevoId()`, un UUIDv7 como el `new_id()` de
  Rust), sin `DEFAULT` ni trigger. Una función no determinista dentro de una sentencia replicada
  (`randomblob`, `random`) se evaluaría otra vez al aplicarla; el arnés de contrato lo rechaza
  (`SQL_NO_DETERMINISTA`). Que sean v7 importa: donde no hay columna de fecha (`Detalle_Comanda`), «la
  última» es la de clave mayor. Donde la hay, «lo más reciente» se ordena por ella.
- **Los agregados derivados se re-derivan en el SQL** (`Total_Comanda = SUM(…)`), no se escriben como
  literal: tienen dos escritores (Main por el outbox, Handy por el DO) y sólo convergen así.
- **Las FK están activas en los dos motores**: la Main las activa en su conexión y Turso las trae
  activadas en cada una (comprobado con el cliente HTTP del DO, RI-06). Las cascadas (`ON DELETE
  CASCADE / SET NULL`) las ejecuta cada motor al aplicar, y el `defer_foreign_keys` del lote aplaza la
  comprobación al `COMMIT`. Un `PRAGMA foreign_keys` suelto en el DO no serviría: el cliente HTTP abre
  un stream por llamada y el ajuste es por conexión.
- Las tablas que sólo usa la nube (`Applied_Operations`, `Sync_Changes`, `Sync_Main_Checkpoints`) están
  en el esquema único, así que existen también, vacías, en la Main. Un volcado o una comparación que
  recorra tablas **se las salta**, igual que todo lo que empieza por `_`.

### La hora la pone quien escribe

Ver la decisión en [../decisiones/0004-la-hora-la-pone-quien-escribe.md](../decisiones/0004-la-hora-la-pone-quien-escribe.md).

- **Una operación, un instante.** La Main fija la hora al abrir la transacción (o al ejecutar una
  escritura suelta) y `rewrite_now_literals` resuelve con ella todas sus sentencias: `'now'` con
  `'localtime'` (con o sin modificadores) pasa a la hora local fija; `'now'` sin él y `CURRENT_*`, a la
  UTC fija. **En local se ejecuta la misma sentencia que sube.**
- **El esquema no tiene `DEFAULT` de hora** (lo vigila un test): quien inserta, la informa.
- En la nube sólo se puede fijar la hora **local** del emisor (`X-Client-Now`). Un `'now'` en UTC o un
  `CURRENT_*` en una escritura de la Handy se rechaza (`hora_no_determinista`), y lo mismo si falta
  `X-Client-Now` (`missing_client_now`), **por los dos caminos**: en vivo y en la cola. Los dos rechazos
  son permanentes.
- **Las lecturas de la Handy también**: `lib/tenantClient.ts::tenantQuery`, por donde pasan todas,
  fija `'now'` con `X-Client-Now` usando la misma función que el DO (`rewriteNowInSql`). Sin cabecera
  manda el reloj de Turso (UTC). El cliente de Rust pone `x-client-now` en todas las peticiones, también
  en los GET. Lo cubre `test/lecturasEnHoraLocal.test.ts`; el arnés de contrato no lo ve, porque corre
  las dos implementaciones en la misma zona horaria.
- Un `'localtime'` aplicado a un valor (`datetime(Fecha,'localtime')`) depende de quien lo ejecuta. En
  desarrollo falla; en el equipo del cliente no bloquea la escritura, pero queda anotado.

### Conectividad

- **No hay ajuste online/offline en la interfaz.** El motor nativo `src-tauri/src/replicacion.rs`
  intenta conectar automáticamente en modo `tpv`, con licencia aprovisionada y la base lista o en
  reconciliación, salvo que la palanca técnica esté en `off`. Publica `sync:estado`; la UI lo observa
  con `iniciarSocketMain`, actualiza `useEstadoSync` y lo pinta en Configuración → Conectividad.
  Entre sus estados están `conectando`, `conectado`, `reintentando`, `sin_identidad`, `rechazado` y
  `pausada`. Desmontar la UI no detiene la réplica nativa.
- **Palanca de emergencia sin interfaz**: `connectivity: "auto" | "off"` en `device_config.json`
  (`get/set_connection_mode`), con `auto` por defecto. Los antiguos valores `online`/`offline` y
  cualquier valor desconocido se leen como ausencia del campo, que también implica `auto`.
  La captura del outbox no depende de ella. Para todos los equipos a la vez están los interruptores
  remotos ([jobs-e-interruptores.md](jobs-e-interruptores.md)).
- **La autoridad es el worker.** El cliente no decide si puede conectarse: lo intenta y obedece. La
  licencia se comprueba en **todas** las rutas autenticadas (`tenantAuth` → `lib/licenciaEnUso.ts`,
  caché de 60 s), y se veta al rol `tpv` que ya no sea el `main_device_id`. No puede haber ninguna ruta
  autenticada que no pase por `tenantAuth`. La gracia por caducidad (`expiry_grace`) sincroniza.
- **Un 403 es `rechazado`**: se espacian los reintentos y se lanza un `license_check_now`, que emite
  `license:changed` y tapa la aplicación. Anular una licencia cierra el socket desde el worker y eso es
  lo que hace que el equipo se entere en segundos ([licencias.md](licencias.md#anular-desde-la-administración)).
- **Se firma con la hora de la nube** (Rust construye y firma el saludo). Un
  rechazo por la hora es `RelojDesfasado`, no falta de red.
- **Latido**: `{"type":"ping"}` cada 30 s; si en 65 s no llega `pong`, se cierra. Se reconecta al
  instante ante `online`, `focus` o `visibilitychange`, y si no, con espera creciente de 3 a 30 s.
- **Un socket abandonado no toca nada**: sustituir el canal cancela su transporte y la generación
  anterior deja de publicar estado o avisos. El DO echa al socket anterior de un
  dispositivo cuando conecta uno nuevo (`replaced`).
- **Mientras faltan los datos, no se abre el socket** (`datosPerdidos` → `pausada`): un catch-up desde
  `Last_Seq = 0` no reconstruye nada ([recuperacion.md](recuperacion.md)).

### Subir el outbox

- El outbox está **ordenado**: se sube una operación (en tandas de 50) y no se pasa a la siguiente hasta
  que llega su `apply_ack` (10 s de espera).
- **Quien clasifica un fallo es el DO**, que tiene la excepción delante (`tenantHub.errores.ts`), y el
  veredicto viaja en el ack: `permanente` (apartar ya), `transitorio` (`esFalloPasajero`, no cuenta) o
  ninguno de los dos, que cuenta. **Se falla hacia transitorio**: apartar deja la nube divergente.
  El cliente no compara textos de error de libsql.
- **El transporte no cuenta nunca** como intento de la operación: `socket_not_open`, `ack_timeout` y
  `socket_soltado` (un vencimiento o cierre del canal nativo nunca se trata como rechazo de aplicación). Cuando lo roto es el cable,
  apartar la cabeza de la cola no desatasca nada.
- Una operación con **20 intentos** contados (`MAX_SUBIDA_ATTEMPTS`) o un rechazo permanente se
  **aparta** (`outbox_mark_failed`, SYNC-20): sale de la cola, se cuenta aparte de lo pendiente
  (`outbox_pending` es lo que aún puede subir), no se borra ni se reintenta, y avisa a dos sitios: a
  Sentry el diagnóstico (op, comando y error, nunca las sentencias), al usuario la consecuencia. Ver
  la reparación abajo.
- El camino normal es el evento `outbox:pending`, que Rust emite al confirmar cada escritura. Además
  hay un sondeo de seguridad, para los reintentos: cada 3 s mientras queda algo pendiente, y cada 30 s
  con el outbox vacío (RI-33).

### Volcar el atraso (SYNC-18)

- Si al conectar hay **más de 100** operaciones pendientes, la Main no las sube una a una: las manda por
  trozos (`bulk_apply`, hasta 200 operaciones o 256 KB por trozo) a la **cola durable del DO**
  (`_Cola_Entrada`, en el SQLite del propio DO) y termina en cuanto sube la última. A partir de ahí el
  TPV puede volver a quedarse sin red. El umbral sólo se mira al conectar.
- **Encolada no es aplicada.** La fila sigue en el outbox marcada en `_Sync_Encoladas`, y lo que la da
  por buena es **verla volver por el catch-up**. Una encolada sin confirmar en 1 h vuelve a ofrecerse.
- **Con cola pendiente todo va a la cola**, también un `apply` en vivo: colarse por delante sería
  aplicar el futuro antes que el pasado. Las Handy esperan (`main_volcando`) mientras la cola no esté
  vacía; no hay flag, el estado es la cola.
- El DO la drena por `alarm` en lotes de 50 (`applyBatchIdempotent`, que filtra antes las ya
  aplicadas). **Se aplica en Turso primero y se borra de la cola después.** El `alarm` captura sus
  excepciones y se reprograma a mano, y para si una vuelta no reduce la cola.
- **De quién es la culpa cuando falla** (`aplicarLote`):
  - un rechazo permanente se aparta en el acto y la cola sigue;
  - cualquier otro fallo pregunta a la base (`SELECT 1`): si no contesta, no se le anota nada a nadie
    y se espera 5 s, 30 s, 2 min, 5 min, 15 min (la escalera vive en `_Cola_Estado`); `encolar` adelanta
    la alarma si la Main vuelve a escribir;
  - si contesta, la culpa es de esa operación: un intento más (cinco y se aparta) y el lote se para ahí.
- **Un error de credenciales sale del drenado** para que `withTenantDbRetry` rote el token. Por eso el
  test no sustituye `withTenantDbRetry`: sustituye el resolutor de credenciales.
- **`_Cola_Muerta` es una bandeja de salida.** Cada fila espera hasta que una Main la acuse
  (`cola_apartada` → `cola_apartada_ack`; sólo al rol `tpv`, en cada conexión). Al acusarla, la Main la
  pone en cuarentena (`outbox_mark_failed`, repetible: `ya_apartada`), suelta su marca de encolada y
  encola la reparación por estado. El TTL de 30 días es para un equipo que no vuelve nunca.
- El interruptor `cola_do` pausa el drenado; con él apagado se vuelve a mirar cada 5 minutos.

### Recibir

- Al autenticarse, la Main pide `/v1/sync/changes` desde su `Last_Seq` y aplica en orden, guardando
  los `change` en vivo hasta terminar.
- Una operación remota que falla al aplicarse se reintenta 5 veces (`MAX_APPLY_ATTEMPTS`) y pasa a
  cuarentena de bajada (`_Sync_Failed`): se salta, avanza el checkpoint y se señala.
- Cada cambio se aplica en **una** transacción (confirmación de subida, gate de idempotencia,
  sentencias, checkpoint) y el escritor se suelta cada 50 (`CAMBIOS_POR_TURNO_DE_ESCRITOR`): una
  página de catch-up de 500 no deja a un cobro esperando a que termine entera (RI-33).
- La Handy no aplica nada: refresca las claves de React Query de las tablas tocadas.
- **Freeze**: si no hay ninguna Main conectada al DO, las Handy reciben `main_offline` y bloquean su
  interfaz.
- `Sync_Changes` se purga por encima de un suelo: lo de más de 7 días que todas las Main activas (las
  que reportaron checkpoint en los últimos 7 días) ya tienen, con 1000 de margen. Como mucho una purga
  por hora y por DO.

### Reparar una divergencia (SYNC-22, SYNC-24, SYNC-25)

Apartar una operación evita el atasco pero deja la nube distinta, y la Handy enseña entonces otra cosa
que la Main. Se repara **por estado**, nunca reintentando la sentencia:

- Se manda **cómo está la fila ahora** con `INSERT … ON CONFLICT(pk) DO UPDATE`. ⚠️ **Nunca `INSERT OR
  REPLACE`**: en SQLite borra y reinserta, y dispara los `ON DELETE CASCADE` que la apuntan (reparar una
  `Zona` se llevaría sus `Mesas`).
- Una reparación es **una escritura más**: entra en el outbox y sube por el camino de siempre. Lleva su
  propio `Command_Name` y una reparación no se repara.
- Al subir, retira en la misma transacción la operación apartada que la motivó (`Repara_Op_Id`): el
  aviso se apaga solo.
- Un `DELETE` apartado no se puede reparar por estado (la ausencia de una fila no es una fila): se
  cuenta y se informa (SYNC-23).
- **El contraste diario** (job `verificar_nube`, `/v1/sync/verificar` y `/verificar-claves`) compara la
  ventana de 30 días de la nube con la base local, repara e informa a Axiom (`tenant_salud_sync`), no al
  usuario. La comparación tolera las dos formas de escribir un número (`2.5` y `"2.50"`).
- **Nada se toca si esta Main no puede afirmar que está al día**: su checkpoint tiene que alcanzar el
  `Seq` de la foto (leído después de las filas) y no puede haber cuarentena de bajada. Vale para
  actualizar y para borrar. Una fila que la nube tiene y aquí no, sólo se borra arriba en ese caso; con
  una lista de claves truncada no se borra nada.
- Con el interruptor `reparacion_nube` apagado se compara e informa, sin escribir.

`/verificar-claves` reparte un presupuesto común entre las tablas: lo que no cabe sale `truncada` y se
vuelve a pedir. El techo va en la respuesta, no en cada pieza.

---

## Hibernación del Durable Object (SYNC-16)

El `TenantHub` usa la **WebSocket Hibernation API**: `state.acceptWebSocket(server, [deviceId])`, los
handlers `webSocketMessage` / `webSocketClose` / `webSocketError`, y
`setWebSocketAutoResponse('{"type":"ping"}' → '{"type":"pong"}')`, que contesta el latido en el edge sin
despertarlo. Mientras las conexiones están ociosas el DO sale de memoria sin cerrarlas y deja de
facturar duración.

Reglas para tocar **cualquier** `tenantHub*.ts`:

1. **Ningún estado de sesión en campos de la instancia**: al despertar está vacía. Lo que describe a un
   socket va en su *attachment* (`WsAttachment`: tenant, dispositivo, rol, autenticado, clave pública,
   reto, recuperando), serializado con `ws.serializeAttachment()` **tras cada cambio**.
2. **El censo es `state.getWebSockets()`**, con la etiqueta `deviceId`. Puede devolver sockets ya
   cerrados: `liveSocketsFor()` filtra por `readyState` e `isMainConnected(except)` excluye el que se
   está cerrando.
3. **Nada que mantenga vivo el DO**: ni `setInterval` ni `setTimeout`. El único `alarm` es el de la cola
   de entrada, y sólo mientras hay cola o está en pausa.
4. **Las cachés de instancia se pierden al hibernar, y eso no cuesta nada**: la conexión a la base del
   tenant (`TENANT_DB_CACHE_TTL_MS`), `lastSeenPushedAtMs`, `lastPurgeAtMs`. Se quedan como campos a
   propósito.
5. ⚠️ **En los módulos de funciones libres no puede haber variables de módulo con estado**: en Workers
   una variable de módulo es por **isolate**, compartido entre DO de **tenants distintos**. Lo que haya
   que recordar entre invocaciones va al SQL del DO (como `_Cola_Estado`).
6. Si cambia el texto del latido en el frontend, hay que cambiar el par del auto-response: casa cadenas
   exactas, y si no coinciden todo funciona pero el DO se despierta en cada ping.
7. Un cierre iniciado por el servidor no garantiza `webSocketClose`: la presencia vive en
   `sessionGone(ws, att)`, que se llama desde `webSocketClose` y desde el revoke. Todo cierre nuevo
   iniciado por el DO llama a `sessionGone`.

`instrumentDurableObjectWithSentry` envuelve los tres handlers del WebSocket.

## Las escrituras de la Handy

Cada dominio del worker tiene su `*.commands.ts`, que construye la transacción (`BuiltCommand`) y la
aplica por `lib/hub.ts` → RPC `aplicar` del DO, que la ejecuta en Turso y la difunde. Sólo el rol
`tpv` puede ejecutar SQL por el WebSocket, y el rol lo dicta la base central, no el cliente. Lo que la
Handy no puede hacer, lo veta un middleware antes de leer el cuerpo ([worker.md](worker.md)). La lógica
duplicada entre Rust y estos comandos la sujetan los arneses de contrato
([tests/contract/README.md](../../tests/contract/README.md)).

La `X-Idempotency-Key` la pone el `CloudClient` de `tpv-infra-http`, una por escritura, salvo cuando el
resultado de la anterior quedó **incierto** (fallo de transporte, timeout o 5xx): entonces la misma
petición vuelve a salir con su clave y sus bytes durante 5 minutos, y el DO devuelve el resultado de
la primera si se aplicó (RI-64). Así, el camarero que vuelve a pulsar tras un error no duplica la
línea. Con una respuesta clara la clave se olvida, y pedir dos veces lo mismo son dos operaciones.

### Frontera con la webview (RI-31/RI-57)

El motor se inicia en el shell y sigue vivo al desmontar React. La webview sólo consulta
`sync_estado`, pide un reintento o consulta salud/progreso. Aplicar SQL, confirmar el outbox,
liberar encoladas y desbloquear la reconciliación son capacidades internas. El proxy HTTP
admite sólo rutas concretas de emparejamiento/administración; los tickets y saludos de ambos
modos permanecen en Rust y no permite usar las rutas de réplica. El saludo Handy lleva `WS_HANDY_HELLO` y
no sirve para autenticar una Main, incluso si cambia el modo local.

Las notificaciones llevan tablas y las comandas afectadas, sin sentencias ni argumentos.
Una revisión creciente evita que un snapshot antiguo pise un evento reciente.
