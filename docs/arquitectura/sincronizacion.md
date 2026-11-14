# Sincronización: Main ↔ nube ↔ Handy

La Main es **Local-First**: vende contra su SQLite haya red o no. Cuando hay conexión replica sus
escrituras a la nube (un Durable Object `TenantHub` por negocio, que guarda la base del negocio en su
propio SQLite) y recibe las de las Handy. La **Handy no tiene base local**: lee y escribe por REST
del worker, que pasa cada consulta al `TenantHub` de su negocio; sin nube no opera.

```
┌──────────────────────┐        WebSocket /ws          ┌────────────────────────────┐
│ MAIN (Tauri + Rust)  │── apply_lote ────────────────►│ Durable Object TenantHub   │
│ SQLite (rusqlite)    │◄── change (en vivo) ──────────│ · aplica idempotente       │
│ _Sync_Outbox         │                               │   (Applied_Operations)     │
│ _Sync_Applied_Ops    │   REST /v1/sync/changes       │ · numera (Sync_Changes)    │
│ _Sync_State          │◄── catch-up ──────────────────│ · difunde a los demás      │
└──────────────────────┘                               │ · la base del negocio      │
┌──────────────────────┐   REST /v1/<dominio>          │   (su SQLite)              │
│ HANDY (sin base)     │── la ruta entera: RPC ───────►│ · ejecuta la ruta junto a  │
│ lee y escribe        │   ejecutarRuta (un viaje)     │   su base                  │
│                      │◄── change (WS) ───────────────│                            │
└──────────────────────┘                               └────────────────────────────┘
```

---

## Piezas

| Pieza | Archivo | Rol |
|---|---|---|
| Captura | `crates/tpv-infra-sqlite/src/db.rs` | `WriteGuard::execute` reescribe la hora a literal, ejecuta y guarda la sentencia en `_Sync_Outbox` en la misma transacción. `raw()` escribe sin capturar |
| Repositorio de sync | `crates/tpv-infra-sqlite/src/sync.rs` | Outbox, aplicar cambios remotos, cuarentenas, catch-up, bootstrap, backfill, contraste con la nube |
| Reparación por estado | `crates/tpv-infra-sqlite/src/sync_reparacion.rs` | Reencola la fila tal como está ahora |
| Cuarentenas de bajada | `crates/tpv-infra-sqlite/src/filas_tocadas.rs` · `cuarentenas_bajada.rs` | Qué filas toca un cambio de la nube que no entra; sus datos caducan y el contraste lo trae de la nube por estado (SYNC-36) |
| Casos de uso y comandos | `tpv-application/src/use_cases/sync.rs` · `commands/sync.rs` | La interfaz Tauri |
| Réplica de la Main | `src-tauri/src/replicacion.rs` · `tpv-application/src/use_cases/replicacion.rs` | Transporte nativo TLS, catch-up, outbox, confirmaciones, recuperación y estado de conexión. La UI observa `sync:estado` y `sync:cambio`, sin SQL ni credenciales (RI-31/RI-57) |
| Reservas web | `src-tauri/src/reservas_web.rs` · `tpv-application/src/use_cases/reservas_web_recogida.rs` | Lo que se reserva desde la web espera en la agenda del worker (`AgendaWeb`), no en la base del negocio. El motor pide recogerlo al conectar, al terminar una recuperación y cuando el `TenantHub` manda `{"type":"reservas_web"}`; la recogida va por REST en segundo plano y registra con el outbox ([plan](../estudios/reservas-web.md#54-recoger-las-reservas-web)) |
| Socket de la Handy | `src-tauri/src/socket_handy.rs` · `tpv-application/src/use_cases/presencia_handy.rs` | Servicio nativo de presencia y avisos, independiente de React. La UI observa `handy:estado` y `handy:cambio` |
| Transporte común | `tpv-infra-http/src/websocket.rs` · `tpv-application/src/use_cases/saludo_socket.rs` | TLS, latido, buffers y tiempos acotados; saludo firmado y rol confirmado. Main y Handy conservan casos de uso distintos |
| Qué refrescar | `tpv-application/src/use_cases/avisos_nube.rs` · `src/shared/lib/syncStatements.ts` | Rust deriva tablas e IDs sin exponer SQL; React los traduce a sus cachés y al ticket abierto |
| El DO | `apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts` | Adaptador RPC y callbacks del runtime; motor interno en `tenantHub.motor.ts` |
| …lo que llega por WS | `tenantHub.mensajes.ts` | Una rama por mensaje |
| …el transporte | `tenantHub.rutas.ts`, `tenantHub.rpc.ts` | Upgrade WebSocket y contratos de aplicar, revocar y avisar |
| …el saludo | `tenantHub.identidad.ts` | Quién llama y qué puede hacer |
| …el lote de la Main | `tenantHub.motor.ts` (`aplicarLote`) | Lo que sube del outbox, hasta 200 operaciones por mensaje, aplicado en un turno |
| …la base del negocio | `tenantHub.sqlite.ts` | El `Client` de libsql sobre el SQLite del DO, el lote atómico (`loteEnBruto`) y las migraciones (`migrarBaseLocal`) |
| …el lote atómico | `tenantHub.lote.ts`, `tenantHub.sentencias.ts`, `tenantHub.envelope.ts` | De un comando a sentencias (`loteDe`); el cuerpo que identifica la operación (`Request_Hash`) |
| …la hora | `tenantHub.tiempo.ts` | Fijar `'now'` con la hora del emisor |
| …los errores | `tenantHub.errores.ts` | Permanente, pasajero o desconocido |
| Rutas de la Handy | `src/lib/enElHub.ts` · `src/lib/hubLocal.ts` | El Worker autentica y pasa la petición entera al `TenantHub` del negocio (`ejecutarRuta`), que ejecuta la ruta junto a su base: un viaje por petición |
| Lecturas de la Handy | `src/lib/tenantClient.ts` | `tenantQuery`: un `Client` sobre el SQLite del DO, para las rutas que se ejecutan dentro (`alHub`) |
| Escrituras de la Handy | `src/lib/hub.ts` + `domains/*/*.commands.ts` | Cada dominio construye su transacción y la aplica vía el DO |
| REST de sync | `domains/sync/sync.routes.ts` | `/changes`, `/bootstrap`, `/historico`, `/initialize-empty`, `/verificar/resumen`, `/verificar/filas`, `/verificar/por-clave`, `/verificar/claves`, `/salud` |
| El contraste con la nube | `domains/sync/verificar.ts` · `resumenCubos.ts` · `tpv-infra-sqlite/src/contraste.rs` · `tpv-domain/src/contraste.rs` | El resumen por cubos de cada lado y lo que se baja cuando no cuadra |

### Servicio de avisos de la Handy

Arranca en el shell de Tauri y espera modo Handy y un vínculo válido. React sólo observa su estado
actual y eventos pequeños; desmontar la interfaz no cierra la conexión. Al cambiar de modo o guardar
un nuevo vínculo, Rust invalida la generación anterior y sustituye el transporte. La UI descarta los
avisos antiguos, la sesión mostrada, las consultas y las cachés de ajustes e imágenes; las respuestas
pendientes de los ajustes anteriores tampoco pueden repoblarlas.

El saludo exige `hello_ok` con rol Handy y un `main_status` válido antes de confirmar presencia. Un
corte de red conserva la presencia anterior durante cinco segundos; la gracia vence también si se
está esperando un ticket o una reconexión. Sin Main, mientras se pone al día al conectar o durante
su volcado se mantiene el bloqueo.
Si la Handy ya ha trabajado con ese vínculo, el bloqueo se pone encima de la aplicación sin
desmontarla (`inert`), y al volver la Main sigue lo que estaba abierto; al arrancar o al vincular de
nuevo, es la pantalla entera (`app/arranque/pantallaDeArranque.ts`).
Rechazos de licencia y revocación se distinguen de la red, con reintentos cada cinco minutos.

Cada conexión confirmada tiene un contador nativo. Al volver a observarla, reconectar o terminar el
volcado se releen consultas, ajustes y ticket abierto: la Handy no conserva ni reproduce SQL perdido.
Los cambios en vivo siguen invalidando sólo las áreas afectadas, y un cambio en una tabla de ajustes
relee sólo su store (`shared/lib/recargarAjustes.ts`): los tres se releen con una conexión nueva o
con un cambio sin clasificar. Tauri avisa a Rust del foco y de la
reanudación en Android; `online` en la webview es sólo una pista para el servicio. No se requiere un
servicio Android en segundo plano: la conexión se recupera al volver si el sistema suspendió la app.

**Volver a primer plano no corta una conexión que funciona** (`HandyNativo::reintentar`,
`PresenciaHandy::al_volver`). Con la conexión confirmada se le manda un ping a demanda
(`Latido::comprobar`, el mismo texto del latido, que el `TenantHub` contesta sin despertarse) y sólo
se reconecta si el `pong` no llega en 3 s. Si el último `pong` tiene más de 35 s —el latido va cada
30, así que el anterior se quedó sin respuesta o el equipo ha estado suspendido— se reconecta sin
esperar. Sin conexión abierta se intenta ya, sin agotar la espera; con un intento ya en marcha
(`Conectando`) no se hace nada, porque en Android volver y recuperar el foco llegan juntos y el
segundo aviso cancelaba el intento del primero y pedía otro ticket: si ese intento se quedó colgado
al suspenderse, se espera el plazo del paso en que estaba (20 s: el ticket, abrir el socket, el
saludo). Con un rechazo de licencia o de dispositivo tampoco se
hace nada, y el botón «Reintentar» reconecta siempre, también a mitad de un intento. Una reconexión cuesta un
ticket (la base central), un saludo con el `TenantHub` y, en la interfaz, releer consultas y ajustes:
por eso no se hace en cada foco.

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

**El escritor no admite `ATTACH`** (`db::sin_attach`, `SQLITE_LIMIT_ATTACHED` a 0; AUD-02): es la
conexión que ejecuta tal cual las sentencias que llegan de la nube, y con un `ATTACH` una de ellas
abría como base cualquier ruta del disco y escribía en ella. Un cambio que lo traiga falla como
cualquier otro que no entra (se reintenta y acaba en cuarentena) sin crear ningún fichero. Las
conexiones de lectura lo conservan: las copias locales (`VACUUM INTO`) van por ellas y SQLite las
hace adjuntando el destino por dentro, así que por el escritor fallarían.

Las operaciones con varias sentencias usan `Writer::transaccion(async { … })` (RI-32), también
para lotes locales y remotos sin captura. El helper confirma negocio y outbox juntos y revierte
si falla el cuerpo, el outbox o el COMMIT. Una guarda encola la reversión al cancelar o entrar en
pánico. Los mutex síncronos del buffer y del instante nunca se retienen al esperar una operación.

- **Toda escritura local de negocio pasa por `WriteGuard::execute`**, que la captura en el outbox. Qué
  es escritura lo decide la cabeza de la sentencia **sin los comentarios de delante**
  (`sin_comentarios_iniciales` → `is_write_sql`), y lo que sube va sin ellos. Un `WITH … INSERT` no se
  reconoce como escritura; si alguna vez hace falta, hay que enseñárselo a `is_write_sql`.
- **Lo que es estado local del equipo va por `raw()`**: `_Jobs_State`, `_Sync_*`, `_Verifactu_*`,
  `_Backfill_Historico`, `_Recovery_State`, `_Verificacion_Nube`, `_Negocio`, el backfill. Por
  `execute()` se replicaría a la nube.
- **Lo que sube tiene que caber en el SQLite del DO**, que admite 100 parámetros y 100 KB por
  sentencia ([worker.md](worker.md#la-base-del-negocio-dentro-de-su-tenanthub)). Una lista de
  tamaño variable (las líneas de un cobro, las mesas de una zona, los asignados a una tarea) va
  como **un único parámetro JSON**, `IN (SELECT value FROM json_each(?n))`
  (`consultas::lista_json`), nunca con un `?` por elemento: con más de 98 líneas, el cobro de una
  mesa subía una sentencia que la nube rechazaba como permanente (DO-01). `WriteGuard` lo vigila
  al capturar (`no_cabe_en_la_nube`): una sentencia con más de 100 valores o más de 100 KB de SQL
  **revienta en desarrollo y en los tests**, y en el equipo del cliente no bloquea la escritura
  (podría ser un cobro): la deja anotada como error, con el verbo y la tabla y sin sus datos.
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
- **Las FK están activas en los dos motores**: la Main las activa en su conexión y el SQLite del DO
  las trae activadas (RI-06). Las cascadas (`ON DELETE CASCADE / SET NULL`) las ejecuta cada motor al
  aplicar. La Main confirma cada transacción con `defer_foreign_keys`, así que una operación correcta
  puede escribir una hija antes que su padre, y el lote la sube con el mismo `PRAGMA`. En el DO, una
  FK aplazada que llega rota al `COMMIT` **resetea el objeto entero** en vez de lanzar, así que
  `loteEnBruto` prueba primero sin aplazar y, sólo si falla por una FK, repite aplazando y mira
  `PRAGMA foreign_key_check` antes de cerrar: una FK rota de verdad sale como un error normal.
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
  `X-Client-Now` o no vale (`missing_client_now`), **sea cual sea el camino**: una escritura de la
  Handy o cada operación de un lote de la Main. Los dos rechazos son permanentes. Vale una `YYYY-MM-DD HH:MM:SS` que sea un instante del calendario
  (`lib/fechas.ts::diaDeInstante`: ni las 24:30 ni un 29 de febrero que no existe, AUD-21) a menos de
  14 h 05 min del reloj del worker (`tenantHub.tiempo.ts::parseClientNow`).
- **Las lecturas de la Handy también**: `lib/tenantClient.ts::tenantQuery`, por donde pasan todas,
  fija `'now'` con `X-Client-Now` usando la misma función que el DO (`rewriteNowInSql`) y con el
  mismo criterio de lo que vale (`parseClientNow`). Sin cabecera, o con una que no vale, manda el
  reloj de la nube (UTC). El cliente de Rust pone `x-client-now` en todas las peticiones, también
  en los GET y en las lecturas que van por POST ([worker.md](worker.md#cómo-se-escribe-una-ruta)). Lo
  cubre `test/lecturasEnHoraLocal.test.ts`; el arnés de contrato no lo ve, porque corre las dos
  implementaciones en la misma zona horaria.
- Un `'localtime'` aplicado a un valor (`datetime(Fecha,'localtime')`) depende de quien lo ejecuta. En
  desarrollo falla; en el equipo del cliente no bloquea la escritura, pero queda anotado.

### Conectividad

- **No hay ajuste online/offline en la interfaz.** El motor nativo `src-tauri/src/replicacion.rs`
  intenta conectar automáticamente en modo `tpv`, con licencia aprovisionada y la base lista o en
  reconciliación, salvo que la palanca técnica esté en `off`. Publica `sync:estado`; la UI lo observa
  con `iniciarSocketMain`, actualiza `useEstadoSync` y lo pinta en Configuración → Conectividad.
  Entre sus estados están `conectando`, `conectado`, `reintentando`, `sin_identidad`, `rechazado` y
  `pausada`. Desmontar la UI no detiene la réplica nativa.
- **Con la sesión abierta, si sigue tocando conectar se mira como mucho cada 10 s**
  (`COMPROBAR_DISPONIBLE_CADA`, `use_cases/replicacion.rs`), no con cada mensaje del socket: es leer
  `device_config.json`, mirar si hay un traslado y dos consultas. Se mira al volver de cada espera
  del socket, así que en reposo es cuando vence la espera (hasta 30 s), como antes. Cambiar el modo
  (`contexto_cambiado`) o la palanca (`set_connection_mode`) despierta al motor, y entonces se mira
  en el momento.
- **Palanca de emergencia sin interfaz**: `connectivity: "auto" | "off"` en `device_config.json`
  (`get/set_connection_mode`), con `auto` por defecto. Los antiguos valores `online`/`offline` y
  cualquier valor desconocido se leen como ausencia del campo, que también implica `auto`.
  La captura del outbox no depende de ella. Para todos los equipos a la vez están los interruptores
  remotos ([jobs-e-interruptores.md](jobs-e-interruptores.md)).
- **La autoridad es el worker.** El cliente no decide si puede conectarse: lo intenta y obedece. La
  licencia se comprueba en **todas** las rutas autenticadas (`tenantAuth` → `lib/licenciaEnUso.ts`,
  caché de 60 s; el ticket del WebSocket, sin ella), y se veta al rol `tpv` que ya no sea el `main_device_id`. No puede haber ninguna ruta
  autenticada que no pase por `tenantAuth`. La gracia por caducidad (`expiry_grace`) sincroniza.
- **Un 403 es `rechazado`**: se espacian los reintentos y se lanza un `license_check_now`, que emite
  `license:changed` y tapa la aplicación. Anular o trasladar una licencia cierra el socket desde el
  worker y eso es lo que hace que el equipo se entere en segundos
  ([licencias.md](licencias.md#anular-desde-la-administración)).
- **Dentro del `TenantHub` sólo es Main la de la licencia**, y eso se vuelve a comprobar con la
  sesión abierta: ver [Quién es la Main dentro del `TenantHub`](#quién-es-la-main-dentro-del-tenanthub-aud-02).
- **Abrir el socket es un viaje a la base central**: el Worker canjea el ticket, lee la fila del
  dispositivo y apunta su `last_seen` en un lote (`GET /ws`, `domains/ws/canje.ts`), y le pasa al
  `TenantHub` el negocio, el dispositivo, su rol y su clave pública en cuatro cabeceras que sólo pone
  él: las que mande el cliente se quitan antes. Un dispositivo sin clave no abre el socket
  (`device_pubkey_not_registered`). El `TenantHub` verifica el saludo con ese rol y esa clave, sin
  volver a la base central (`test/abrirElSocket.test.ts`); una baja entretanto le cierra el socket
  (`revocarDispositivo`). Una que llega entre el canje y el upgrade, sin socket que cerrar, queda
  anotada en el objeto, y el upgrade de un ticket canjeado antes (`x-ws-canje-ms`, la hora del canje
  que pone el Worker) se rechaza con 401 `device_revoked`.
- **Se firma con la hora de la nube** (Rust construye y firma el saludo). Un
  rechazo por la hora es `RelojDesfasado`, no falta de red.
- **Latido**: `{"type":"ping"}` cada 30 s; si en 65 s no llega `pong`, se cierra. Se reconecta al
  instante ante `online`, `focus` o `visibilitychange`, y si no, con espera creciente de 3 a 30 s.
- **Un socket abandonado no toca nada**: sustituir el canal cancela su transporte y la generación
  anterior deja de publicar estado o avisos. El DO echa al socket anterior de un
  dispositivo cuando conecta uno nuevo (`replaced`).
- **Mientras faltan los datos, no se abre el socket** (`datosPerdidos` → `pausada`): un catch-up desde
  `Last_Seq = 0` no reconstruye nada ([recuperacion.md](recuperacion.md)).

### Quién es la Main dentro del `TenantHub` (AUD-02)

El rol `tpv` de una sesión se fija al saludar y vive en su attachment, que no se entera de lo que
cambie después en la base central. Ser la Main es otra cosa: ser el `main_device_id` de la licencia
sin anular del negocio (`tenantHub.identidad.ts::mainDeLaLicencia`; la caducidad no cuenta: caducar
no cierra el socket).

**Quién es la Main lo dice una tabla del propio DO** (`_Main_Vigente`, `tenantHub.main.ts`), y lo
que depende de ello la mira sin esperar a nadie (`esLaMain`). Sólo la sesión `tpv` autenticada, no
echada y del dispositivo que nombra la tabla escribe (`apply_lote`) y suelta a las Handy
(`recovery_ready`); recibe lo del negocio (cambios,
`pair_request`, `reservas_web`), y cuenta como Main para las Handy (`isMainConnected`,
`isMainReady`, `isMainRecovering`). Si la tabla dice que no hay Main (la licencia está anulada),
ninguna lo es. Se mira justo antes de actuar, después de la última espera de cada rama y con el
attachment releído: entre la pregunta y el acto no cabe nada.

**La tabla la ponen al día lecturas de la base central, numeradas al empezar.** La respuesta de una
lectura sólo se apunta si no se ha apuntado ya la de otra que empezó después: una respuesta vieja que
llega tarde no deshace una nueva. Apuntarla y echar a toda sesión `tpv` de otro dispositivo son un
solo paso, sin esperas (`fijarMain`), y es el único sitio que echa por este motivo. Se lee:

- **En el saludo de un `tpv`**, con la firma ya verificada. Después decide la tabla, no lo que le
  contestaron a ese saludo: si su respuesta no se apuntó porque ya había una más nueva, manda la
  nueva. Un `tpv` que no es la Main no entra (`hello_failed` con `device_replaced` o
  `license_revoked`): el ticket del socket dura 30 s y pudo emitirse antes de un traslado. Sin
  respuesta de la base central tampoco entra.
- **Por actividad, como mucho una vez por minuto y por negocio** (`comprobarMain`), si hay alguna
  sesión `tpv` dentro. Quien pregunta se queda la marca de la tabla antes de esperar
  (`tocaComprobar`) y los demás siguen con lo que dice la tabla: veinte mensajes a la vez son una
  lectura, sin promesas compartidas ni campos de instancia. Esperan la respuesta antes de decidir:
  - lo que la Main manda y entra en el acto (`apply_lote`), **en fila**
    (`enTurnoDeEntrada`): si al primero le toca esperar, los de detrás esperan con él y entran en el
    orden en que llegaron, porque la fila no suelta al siguiente hasta que el anterior tiene sitio en
    el turno del log (`alReservarTurno`), que es lo que fija el orden en que se confirman: antes de
    eso cada escritura calcula su hash y abre la base del negocio (al despertar, el DO comprueba sus
    migraciones), y una que acabara antes se adelantaría. Lo que tarde la escritura después no
    retiene la fila;
  - una escritura que entra en el turno del log (de una Handy, o lo que manda la Main), dentro del
    turno y justo antes de aplicarse: lo que va detrás espera su turno;
  - el saludo de una Handy, a la que se le dice si hay Main, y los avisos para la Main, que salen
    después de la respuesta.

  No la piden `recovery_ready`, que decide con la tabla (a la Main no se le rechaza nunca: el cliente
  da a las Handy por soltadas en cuanto lo manda), ni un mensaje mal formado o vacío, que se contesta
  antes. La lectura lleva un plazo de 5 s. **No hay temporizador ni alarma**: un negocio sin
  actividad no pregunta ni se despierta por esto.
- **Con un aviso de cambio de licencia** (un traslado, una anulación, un reembolso:
  `lib/hub.ts::avisarCambioDeLicencia` → `releerMain`, con el negocio): se lee en el acto, sin esperar
  al minuto, y `fijarMain` echa a la sesión `tpv` que no sea la Main que resulte. Se lee también sin
  ninguna sesión `tpv` autenticada: si hay un saludo a medias cuya lectura salió antes del cambio,
  ésta empieza después y es la que vale, y el saludo, que decide con la tabla, no entra. El aviso no nombra a quién
  echar, así que uno que llega tarde —el del traslado B→A entregado después de que la licencia
  volviera a B— no echa a la Main que ha vuelto a serlo. Si esa lectura no contesta, la tabla se
  queda como está y la siguiente actividad pregunta sin esperar al minuto.

La baja de un dispositivo (`cerrarSocketsDelDispositivo` → `revocarDispositivo`) es otra cosa: cierra
sus sesiones en el acto, sin condición, porque no se deshace con otro aviso.

**Las rutas REST de un `tpv` miran la misma tabla** (`ejecutarRuta` → `vetoDeMain`), justo antes de
ejecutar la ruta, en todas: es lo que rechaza el veto de licencia del Worker, que guarda su respuesta
un minuto por isolate, y una ruta nueva queda cubierta sola. Si la tabla no se ha leído o nombra a ese
equipo, pasa sin preguntar nada. Si nombra a otro (o a ninguno), pregunta a la base central antes de
rechazar, porque el Worker acaba de darlo por bueno y una de las dos cosas está atrasada: su caché, o
la tabla, si el aviso de un traslado se perdió y el que llama es la Main nueva. Esa lectura pone la
tabla al día como cualquier otra (`fijarMain`). Si sigue sin ser la Main, `device_replaced` (o
`license_revoked`, sin Main), lo mismo que el Worker; sin respuesta de la base central, 503
`main_sin_comprobar`, que quien llama repite. Una Handy no pasa por aquí. Lo cubre
`test/mainDesplazadaRest.test.ts`.

**Todo cierre deja la sesión fuera**: los que inicia el DO (`cerrar`: echarla, la baja, la sesión
anterior de un dispositivo que reconecta con 4000, el saludo que falla, un error del socket) y los que le llegan (`webSocketClose`). Le quita la autenticación y la marca `fuera`
en su attachment, y contabiliza su salida (`sessionGone`), una vez: el cierre que llega después de
uno que inició el DO es de una sesión que ya está fuera, y no se vuelve a contabilizar. Sin autenticar
no se le atiende ningún mensaje ni se le difunde nada, y no cuenta como Main, aunque el cliente no conteste al cierre. Lo que
estuviera esperando tampoco sigue: cada rama mira, después de su última espera, que el socket siga
abierto y la sesión no esté fuera (`sesionAbierta`); una escritura lleva la sesión que la mandó y se
vuelve a mirar dentro del turno, antes de aplicarla; y **un saludo cuyo socket se cierra,
se echa o se reemplaza mientras espera a la base central se abandona** sin autenticar ni anunciar
nada: las Handy no reciben un `main_online` después del `main_offline` de ese cierre.

La Main no recibe respuesta a lo que mandó: para ella es un corte de transporte, que no cuenta como
intento de la operación, y al reconectar el ticket le dice por qué. El cliente Rust no cambia: ni
mira los códigos de cierre ni depende de un mensaje nuevo.

**Si la base central no contesta o rechaza la consulta**, la tabla se queda como está, se registra
(`sync.main_vigente`) y no se rechaza ningún mensaje: la Main sigue replicando y las Handy trabajando,
y se vuelve a preguntar al minuto. Una Main cerrada no puede reconectar sin la base central (el
ticket la necesita), así que cortar por no saber la dejaría sin replicar durante toda la avería.
Sólo el saludo de un `tpv` no entra sin respuesta.

**Los límites**, tal como están:

- **Si el aviso de cambio de licencia no llega** y la Main nueva no ha saludado, el equipo
  anterior sigue siendo la Main para el hub hasta la siguiente comprobación por actividad: como
  mucho un minuto después de la última lectura, más lo que tarde esa lectura (5 s de plazo). En ese rato escribe,
  recibe y cuenta como Main. Sin actividad sigue conectado, y no le llega nada del negocio porque no
  hay nada que entregar.
- **Con la base central caída**, ese rato dura lo que dure la avería.
- **Mientras una lectura está en vuelo, lo que no va detrás de quien la pidió se decide con la tabla
  de antes**: sólo esperan la respuesta quien la pidió y lo que va detrás de él, en la fila de
  entrada o en el turno del log. Lo que va por otro camino (una escritura de la Handy si la lectura
  la pidió la fila de entrada, un saludo) no espera.
- **Un aviso de cambio de licencia cuya lectura no contesta** no echa a nadie: es como un aviso
  perdido, salvo que la siguiente actividad pregunta sin esperar al minuto.
- **La numeración ordena las lecturas por cuándo salieron, no por cuándo las atendió la base
  central.** Una petición que tarda en llegar puede ver un estado más nuevo que otra que salió después
  y quedar descartada; lo corrige la lectura siguiente (otro saludo, o la siguiente comprobación).
- **Lo que no lleva datos del negocio** (`main_online`, `main_offline`) va a todos los sockets,
  también a los que no han saludado.
- **Una tabla que no se ha leído nunca** da por Main a cualquier sesión `tpv` autenticada, como antes
  de que existiera. Sólo puede pasar con una sesión que saludó antes (el saludo de un `tpv` siempre
  la lee), y dura hasta la primera comprobación por actividad, que la lee y echa a la que no lo sea.

### Subir el outbox

- El outbox está **ordenado** y sube **por lotes** (`use_cases/replicacion.rs::subir_pendientes`): el
  principio de lo pendiente, hasta 200 operaciones y 256 KB de sentencias (una operación mayor va
  sola), en un `apply_lote`. **Sólo hay un lote en vuelo**: el siguiente no se lee del outbox hasta que
  llega el acuse de éste (`apply_lote_ack`, con su `loteId`; 30 s de espera) y lo aplicado está
  confirmado aquí. Es el único camino, con atraso o sin él: con una venta pendiente, el lote lleva una.
- **El acuse trae el veredicto de cada operación**, por `opId`, y la Main lo lee en el orden del lote:
  - **aplicada**, con el `Seq` que le dio el log, o **«ya estaba»** (`yaEstaba`), con el de entonces:
    era el reenvío de un lote cuyo acuse se perdió;
  - **rechazo permanente**: se aparta y se repara por estado (SYNC-22), y se sigue leyendo, porque la
    nube ha seguido aplicando lo de detrás;
  - **rechazo pasajero** (`transitorio`) o **sin intentar** (`noIntentada`, o una de la que el acuse no
    dice nada): no se le cuenta nada a nadie y se deja de leer; lo que queda sale en el lote siguiente;
  - **rechazo sin clasificar**: un intento más para esa operación, y se deja de leer.

  Todo lo aplicado se confirma **en una transacción** (`outbox_confirmar_lote`): el anti-eco pasa a
  llevar su `Seq`, la fila sale del outbox y, si era una reparación, sale con ella la apartada que
  reparaba (SYNC-26). Un corte a mitad deja el lote confirmado entero o sin confirmar, y sin confirmar
  vuelve a subir: la nube contesta «ya estaba» a lo que ya tenía (idempotencia por `Op_Id`).
- **Sin acuse no hay veredicto**: es el transporte, no le cuenta nada a nadie y la sesión acaba. Dos
  lotes seguidos sin respuesta pueden ser uno que la nube no consigue atender, así que el siguiente va
  de una operación, y cada lote aplicado dobla el siguiente hasta volver a 200 (`RitmoDeSubida`, que
  vive lo que el proceso: un lote sin respuesta acaba con su sesión).
- **Un lote que la nube rechaza entero** (`ok: false`: la sesión ya no es la de la Main, la forma de una
  de sus operaciones) no ha aplicado nada. Si el rechazo habla de cómo está ella (`transitorio`), no
  cuenta; si no, no dice por cuál, y se repite de una en una. Un mensaje que no le cabe
  (`payload_too_large`) sólo puede ser de una operación enorme, que sola se aparta.
- **Quien clasifica un fallo es el DO**, que tiene la excepción delante (`tenantHub.errores.ts`), y el
  veredicto viaja en el acuse: `permanente` (apartar ya), `transitorio` (`esFalloPasajero`, no cuenta) o
  ninguno de los dos, que cuenta. **Se falla hacia transitorio**: apartar deja la nube divergente.
  El cliente no compara textos de error.
  - **Primero por el código**, si el fallo es nuestro: el de un `HubError`, o el identificador con
    el que empieza el mensaje de un `Error` (`missing_ref:total`). Es permanente lo que dice que la
    operación está mal escrita (`hora_no_determinista`, `missing_client_now`, sin identidad, el mismo
    `Op_Id` con otro contenido, o que no se deja montar: sin pasos, sin SQL, con una referencia a un
    paso que no está) y pasajero lo que habla de cómo está la nube y no de la operación (sin base, el
    esquema del negocio sin cuadrar, sin Main, la sesión que ya no es la de la Main). Lo que un
    fallo nuestro lleva detrás de su identificador es un trozo de la operación (el SQL de un paso),
    y no se lee como una frase del runtime.
  - **Después, si el mensaje es de SQLite, por su código.** El SQLite del DO cierra sus mensajes
    con él (`…: SQLITE_BUSY`, `…: SQLITE_CONSTRAINT (extended: …)`). Es pasajero el que habla del
    estado de la base (`SQLITE_BUSY`, `SQLITE_LOCKED`, `SQLITE_IOERR`, `SQLITE_NOMEM`, `SQLITE_FULL`,
    `SQLITE_READONLY`). Lo que va delante del código no decide si es pasajero: lo escribe en parte
    quien escribió la sentencia (`no such column: sqlite_full`, `no such table: database is
    locked`), y leído por su texto un rechazo permanente saldría como pasajero y pararía el outbox.
    El texto sólo dice si es de la sentencia, y entonces es permanente: lo que no encaja con el
    esquema o con los datos, y los límites del SQLite del DO (parámetros, patrón de `LIKE`, `SELECT`
    compuesto, tamaño de la sentencia o de un valor).
  - **Lo que no es de SQLite, por sus frases**: las del runtime del Durable Object cuando está
    saturado, reiniciado o sin su almacenamiento, que son pasajeras y se miran antes que las
    permanentes. La base está en el propio DO, así que no hay firmas de red (`socket`, `timeout`,
    `503`).
  - **Una base llena o en sólo lectura no aparta nada** (`esBaseLlena`): es pasajero para la
    operación, y el DO avisa una vez por instancia (Sentry, y `base_llena` en Axiom). Hacerle sitio
    es cosa de una persona.
- **El transporte no cuenta nunca** como intento de la operación: un acuse que no llega, un socket que
  se cae o un mensaje que no sale acaban la sesión sin anotar nada (un vencimiento o cierre del canal
  nativo nunca se trata como rechazo de aplicación). Cuando lo roto es el cable, apartar la cabeza de
  la cola no desatasca nada.
- Una operación con **20 intentos** contados (`MAX_SUBIDA_ATTEMPTS`) o un rechazo permanente se
  **aparta** (`outbox_mark_failed`, SYNC-20): sale de la cola, se cuenta aparte de lo pendiente
  (`outbox_pending` es lo que aún puede subir), no se borra ni se reintenta, y avisa a dos sitios: a
  Sentry el diagnóstico (op, comando y error, nunca las sentencias), al usuario la consecuencia. Ver
  la reparación abajo.
- El camino normal es el evento `outbox:pending`, que Rust emite al confirmar cada escritura. Además
  hay un sondeo de seguridad, para los reintentos: cada 3 s mientras queda algo pendiente, y cada 30 s
  con el outbox vacío (RI-33).

### El lote en el `TenantHub` (`aplicarLote`)

- **Antes de aplicar nada**: el tamaño del mensaje se mira antes de leerlo (4 MiB de UTF-8: una
  operación tiene que poder llevar cualquier valor que admita el SQLite del DO), sólo la Main manda
  lotes (`forbidden_not_tpv`), y la forma de **todas** sus operaciones se comprueba antes de aplicar
  ninguna: una mal hecha rechaza el lote entero (`missing_apply_fields`). El lote entra en la fila
  de entrada de la Main (AUD-02) y, fuera del turno, se prepara cada operación (la hora fijada, su
  hash, sus sentencias): lo que falla ahí es el veredicto de esa operación, como un rechazo
  permanente.
- **En el turno del log, la única espera es la comprobación por actividad** (AUD-02, si toca: hasta
  5 s, y lo que va detrás en el turno espera con ella). Después ya no hay ninguna: se vuelve a mirar
  que la sesión siga siendo la de la Main y se aplican en orden. **Cada operación es una
  escritura suelta**: su lote atómico (`loteDe` + `loteEnBruto`) en su propio `transactionSync`, su
  gate de idempotencia, su línea en el log y su `change`, que sale en el acto (AUD-18). La que ya
  estaba viola el UNIQUE del gate: contesta con su `Seq` y se difunde otra vez (SYNC-03).
- **Un rechazo permanente se anota y el lote sigue**: esa operación no va a entrar nunca. **Cualquier
  otro fallo lo para**: lo de detrás se apoya en ella y sale `noIntentada`.
- **El acuse sale dentro del turno.** Lo escrito en un turno se confirma junto al acabarlo, y lo que se
  manda por un socket no sale hasta que es duradero (`test/sondaSqliteDo.test.ts`): la Main no puede
  recibir el acuse de algo que se pierda. Si el objeto se cae a mitad, no queda nada del turno y no
  hay acuse; la Main reenvía el lote.
- **El tope es de trabajo, no de tiempo**: en producción el reloj no avanza mientras el objeto consume
  CPU. Como mucho 200 operaciones, 512 KB de sentencias en UTF-8 (como corta la Main) y 3 que
  necesiten aplazar las claves foráneas (cada una recorre las tablas con FK antes de cerrar); lo que
  pasa del tope sale `noIntentada`, y la primera se intenta siempre. El outbox de un servicio
  real, 1.185 operaciones, sube en 8 lotes de unos 120 ms (en local; el más lento, 157 ms) y ninguna
  necesita aplazar. `test/outboxRepetido.test.ts` sube sus 300 primeras de una en una, en lotes y con
  lotes reenviados o cortados, y exige que las tres dejen lo mismo.
- **No se calcula el resultado de cada operación**: el gate guarda el que se puede saber sin ejecutar,
  y de lo que sube la Main sólo se usa el `Seq`.

### Ponerse al día (AUD-15)

- **Las Handy esperan a que la Main se ponga al día**: si no, decidirían sobre una nube a la que le
  falta lo hecho sin conexión. Toda sesión de la Main saluda con `recovering`
  (`replicacion.rs::saludar`), haya atraso o no: mirarlo antes dejaría fuera lo que se confirme
  mientras se autentica. En el DO eso sólo congela a las Handy (`main_volcando`) y deja pasar lo que
  suba la Main; el modo recuperación es otra cosa ([recuperacion.md](recuperacion.md)). La Main manda
  `recovery_ready` una vez por sesión, cuando `subir_pendientes` encuentra el outbox vacío, con las
  reparaciones de lo apartado ya subidas. Esa subida es la frontera: lo que se confirme después es
  trabajo en vivo.
- Una reparación que la nube tampoco acepta queda en cuarentena, fuera de lo pendiente, y no las
  retiene, a propósito: congelarlas sin fin por algo irreparable bloquearía al personal, y lo
  apartado ya queda con su aviso y lo repara el contraste diario. `recovery_ready` limpia también el
  congelado que dejara una sesión anterior cortada a medias.
- En el DO, lo que cuenta es la Main de ahora: sólo las sesiones autenticadas con el socket abierto
  (`getWebSockets()` devuelve también los que se están cerrando), y la sesión que se reemplaza al
  reconectar pierde la autenticación en su attachment antes de cerrarse. Las guardias de una
  escritura de la Handy (Main conectada, Main lista) se vuelven a mirar dentro del turno del log,
  justo antes de enviarla: la Main pudo dejar de estar lista mientras esperaba.

### Recibir

- Al autenticarse, la Main pide `/v1/sync/changes` desde su `Last_Seq` y aplica en orden, guardando
  los `change` en vivo hasta terminar.
- **Una página de `/v1/sync/changes` tiene dos topes**: los cambios que se piden (`limit`, hasta 1.000) y
  4 MiB de sentencias (`CAMBIOS_MAX_BYTES`, `sync.routes.ts::leerPaginaDeCambios`), lo que antes llegue;
  un cambio puede llevar cientos de sentencias. El corte lo hace la propia sentencia con la suma
  acumulada de lo que ocupa cada cambio, y nunca deja la página vacía: un cambio que solo ya pasa
  viaja solo. La página cortada lleva el `nextSince` de su último cambio, como una completa, y la
  Main sigue hasta una vacía (`test/cambiosConTecho.test.ts`).
- **Un `change` lleva lo que se lee**: `opId`, `seq` y `statements` (las sentencias ya resueltas). La
  Main lee los tres (`replicacion.rs::cambio`); la Handy, las sentencias, de las que saca qué
  refrescar (`presencia_handy.rs`). Ni el comando, ni quién lo mandó, ni su payload, ni su resultado.
- **Por el socket no hay más mensajes que los del protocolo**: el saludo (`connected`, `challenge`,
  `helloSigned`, `hello_ok`), lo que sube la Main (`apply_lote`, `recovery_ready` y sus acuses), lo que baja (`change`) y los avisos
  (`main_status`, `main_online`, `main_offline`, `main_volcando`, `pair_request`, `reservas_web`).
  Un dispositivo no manda mensajes a los demás, y no se difunde quién entra o sale: lo que hay que
  saber de los otros es si hay Main. Un tipo que no está en la lista se contesta `unknown_type`.
  Lo cubre `test/difusionAjustada.test.ts`.
- **Antes de aplicar una página, la Main comprueba que no le falte nada** (AUD-19). La ruta devuelve
  también el mayor `Seq` que se ha purgado (`purgadoHasta`), leído en la misma lectura que los
  cambios, y si pasa del `since`, lo de en medio ya no está. Es exacto: no depende de que `Seq` sea
  contiguo ni de que la purga quite un prefijo (no siempre lo hace: ver la purga, abajo). La Main
  se para entonces sin aplicar ni subir nada ni mover el checkpoint, así que `verificar_nube`
  tampoco toca la nube.
  - En la recuperación es un error, «Esta copia es anterior a lo que guarda la nube»
    ([recuperacion.md](recuperacion.md#reconciliar-y-desbloquear)).
  - En la sesión normal, a la que sólo se llega así con una base cambiada por fuera de la
    aplicación, la sesión acaba en `FinDeSesion::AnteriorAlLog` y se trata como un traslado de
    licencia (SYNC-32): el caso de uso deja la marca `AppData/anterior-a-la-nube` y cierra las
    escrituras de negocio, el motor publica `detenida`, y la interfaz relee el estado de la
    recuperación (`OlderThanCloud`), cierra la sesión y lleva a la pantalla de recuperación, que
    sólo ofrece traer el estado actual de la nube. Lo que el outbox tuviera no sube: al traer la
    nube se guarda aparte con la base entera
    ([recuperacion.md](recuperacion.md#una-base-anterior-a-lo-que-guarda-la-nube-sync-32)).
  - Sin `purgadoHasta` (un worker anterior), toda recuperación falla cerrada, también la que sigue a
    traer la nube, y la sesión normal sigue: el worker se despliega antes.
- **La bajada va estrictamente en orden de `Seq` (AUD-18)**: nunca se aplica un cambio posterior antes
  que uno anterior, y el checkpoint sólo pasa por encima de lo que ya se procesó. Lo garantizan dos
  lados: el DO difunde en orden de `Seq` (ver «El orden de la difusión») y la Main aplica así:
  - Un cambio con `Seq` igual o menor que el checkpoint ya se procesó (un reenvío, el solape del
    catch-up con lo que llegó en vivo al conectar): no se aplica, aunque su registro de idempotencia
    ya se haya purgado, y deja un `warn`.
  - Uno que falla al aplicarse **detiene la bajada**: se anota en `_Sync_Failed` (sentencias, error,
    intentos), no se aplica nada posterior y el checkpoint no lo pasa. El repositorio lo garantiza
    por su cuenta: mientras haya un fallo sin cuarentena por delante del checkpoint, lo posterior no
    entra ni da nada por hecho, tampoco el eco de una escritura propia (que sigue en el outbox hasta
    que vuelva en su turno).
  - Se reintenta **dentro de la sesión**, con las sentencias que se guardaron al fallar
    (`cambio_detenido`), tras 1, 2, 4 y 8 s (`espera_para_reintentar`): lo pasajero de escribir en
    el SQLite local se resuelve en segundos, y lo que falla siempre (una columna que esta versión no
    tiene, una restricción, una clave foránea) no se arregla esperando. Mientras tanto el socket se
    sigue atendiendo, pero lo que llega en vivo no se aplica: lo trae después el catch-up desde el
    checkpoint, que es la fuente de verdad. Si la sesión se cae, la siguiente empieza por él.
  - El reintento no se coordina con lo que el personal escribe aquí durante la espera: si toca la
    misma fila, el cambio remoto la pisa al entrar. Es el riesgo aceptado SYNC-29
    ([pendientes](../pendientes.md)), y la espera lo agranda en unos segundos.
  - Al quinto intento (`MAX_APPLY_ATTEMPTS`) pasa a **cuarentena** (`Quarantined = 1`, con lo
    necesario para diagnosticarlo): el checkpoint pasa por encima y la bajada sigue en orden desde ahí.
    El intento contado, el marcador de `_Sync_Applied_Ops`, la marca de cuarentena y el checkpoint van
    en una sola transacción (`anotar_fallo`): una copia de la base tiene los cuatro o ninguno.
  - **Con el primer fallo se apunta qué filas toca** (`Filas_Json`: su tabla y su clave primaria,
    SYNC-36), que es con lo que su cuarentena sale después ([abajo](#la-salida-de-una-cuarentena-de-bajada-sync-36)).
    Ni el cambio ni el log de la nube lo dicen, y muchas sentencias no nombran sus filas (`UPDATE …
    WHERE ID_Proveedor = ?1`, `INSERT … SELECT`), así que se ejecutan en un **simulacro**
    (`Connection::simulacro`: una transacción con las foráneas aplazadas que se deshace siempre, y que
    no ejecuta nada que no sea leer o escribir filas) con un `RETURNING` de la clave, sobre la base de
    justo antes del cambio (`filas_tocadas.rs`). De la sentencia que choca, y de lo que se salta al
    chocar, se miran antes las claves de lo que inserta o las de las filas que cumplen las igualdades
    de su `WHERE` sobre la clave o una foránea; de un `ON CONFLICT` sobre otra columna que la clave
    (actualiza la fila que ya tiene ese valor), sólo el `RETURNING`. Lo que borra se marca, y las
    tablas cuyas filas salen de esta base y no de la sentencia, también (`por_filtro`, con las que
    lee para decidirlo, las de sus vistas incluidas). Si al apuntarlo hay algo apartado de la subida
    en una de ésas, lo sacado de aquí pudo no ser lo de arriba, y queda `dudosa` para siempre: no se
    trae nunca, tampoco cuando lo apartado se retire. Lo que no se sabe (una tabla que esta versión
    no tiene, un `REPLACE`, ese `ON CONFLICT` sin poder ejecutarse, más de 5.000 filas) queda como
    incierto, con todo lo que nombran sus sentencias como `por_filtro`, y se vuelve a mirar en cada
    intento y en cada pasada mientras quedan sentencias. Mientras siga incierto, cada pasada lo
    cruza con lo apartado de la subida: si lo apartado se retirase antes de saberse qué toca, ya no
    se vería.
  - El catch-up sigue la misma regla en cada página, y no pide la siguiente si el checkpoint no llegó
    al final de la actual.
- «Reintentándose» (Configuración → Conectividad) son los fallos sin cuarentena: la bajada está
  detenida en uno de ellos. «En cuarentena», los que se saltaron.
- **Lo apartado de la subida se guarda 30 días** desde su último intento, y después lo retira
  `purga_sync` (`RETENCION_CUARENTENAS_MS`, `use_cases/sync.rs`). Para entonces se registró en la
  telemetría al apartarse, se encoló la reparación por estado y el contraste con la nube ha pasado
  decenas de veces; lo que queda es la sentencia, con los datos que llevara, y un contador en rojo
  que ya no se apagaría. Una apartada cuya reparación sigue sin subir no se retira: la retira esa
  subida. **Lo que no entró de la bajada no se retira**: es la barrera del contraste
  (`_Sync_Failed` vacía es una de las condiciones para reparar), que sin ella daría esta base por al
  día y borraría arriba lo que la Handy escribió y aquí falta. Lo cierra el contraste al traerlo de
  la nube ([abajo](#la-salida-de-una-cuarentena-de-bajada-sync-36)). **Sus datos sí caducan** (SYNC-36):
  a los mismos 30 días de apartarse, `purga_sync` vacía sus sentencias (`Datos_Vaciados_At_Ms`) y deja
  su error en su clase (`sentencia #2: unique (Clientes.Email)`; lo que no es de una clase conocida,
  `otro`). Queda lo que no es de nadie: su operación, su `Seq`, sus intentos, sus fechas y las filas
  que tocó, por su clave, que se miran por última vez antes de vaciarla si no se sabían. Va por
  tandas de 20, soltando el escritor entre una y otra, hasta que no queda ninguna caducada. Como el
  job es diario, una puede llegar a
  vaciarse hasta un día después de cumplir los 30, y nada se vacía mientras el equipo no está
  operativo (apagado o recuperando sus datos).
- Cada cambio se aplica en **una** transacción (confirmación de subida, gate de idempotencia,
  sentencias, checkpoint) y el escritor se suelta cada 50 (`CAMBIOS_POR_TURNO_DE_ESCRITOR`): una
  página de catch-up de mil cambios (los que pide la Main, `CAMBIOS_POR_PAGINA`) no deja a un cobro
  esperando a que termine entera (RI-33).
- **El checkpoint no deja atrás un fallo sin resolver** (AUD-18): lo único que lo mueve
  (`pasar_el_checkpoint`) borra a la vez el fallo de ese cambio si no está en cuarentena, entre o
  salga por el anti-eco al reintentarlo (el eco propio que no pudo mover el checkpoint). Fuera de
  eso, sólo la restauración desde la nube lo mueve, y vacía `_Sync_Failed` en la misma transacción.
  Un fallo olvidado por debajo del checkpoint no lo reintentaría nadie y bloquearía `verificar_nube`.
  Por lo mismo, **no se anota el fallo de algo que ya no pasa del checkpoint** (un duplicado con el
  que algo falló: `anotar_fallo` relee el checkpoint en su transacción), y el que hubiera se resuelve
  cuando llega su duplicado: se borra si la operación consta como procesada y, si no (un fallo de
  antes de AUD-18), pasa a cuarentena.
- El anti-eco de una operación propia (`_Sync_Applied_Ops`) no se retira por antigüedad mientras su
  `Seq` vaya por delante del checkpoint: volverá por el catch-up, y sin él se aplicaría otra vez.
  Uno con `Seq = 0` fuera del outbox sí, porque ya no puede volver: una operación cuyo acuse se perdió
  sale del outbox al volver su eco, y si ese eco falla, `anotar_fallo` le pone su `Seq` en la misma
  transacción. Y la nube sólo contesta `Seq` 0 si ya purgó el log de la operación, por debajo del
  checkpoint de las Main activas; un error al leerlo sale como error.
- La Handy no aplica nada: refresca las claves de React Query de las tablas tocadas.
- **Freeze**: si no hay ninguna Main conectada al DO, las Handy reciben `main_offline` y bloquean su
  interfaz.
- `Sync_Changes` se purga por encima de un suelo: lo de más de 7 días que todas las Main activas (las
  que reportaron checkpoint en los últimos 7 días) ya tienen, con 1000 de margen. Como mucho una purga
  por hora y por DO. Como mira también la antigüedad, y `Created_At_Ms` se fija antes de que el turno
  numere, puede llevarse el 12 y dejar el 11. En la misma transacción que borra anota el mayor `Seq`
  que se ha llevado, en una fila reservada de `Sync_Main_Checkpoints` (`_purgado_hasta`, que el suelo
  no cuenta); una purga que no borra nada no la toca. `/v1/sync/changes` devuelve como `purgadoHasta`
  el mayor entre esa marca y el primer `Seq` conservado menos uno, que cubre un log purgado antes de
  que existiera la marca (el porqué, en `sync.routes.ts`). Una Main que sólo ha estado sin conexión no
  queda por debajo: mientras reporta, el suelo no pasa de su checkpoint, y cuando deja de contar, sin
  otra Main activa no se purga nada. Quien sí puede quedar debajo es una base anterior (una copia
  restaurada). `Applied_Operations`, por antigüedad (7 días): un reenvío nunca llega tan tarde.

### El orden de la difusión (AUD-18)

- El DO confirma y difunde **de una escritura en una** (el turno del log, `enTurnoDelLog`), también
  dentro de un lote de la Main. La base numera al confirmar y la difusión va justo después, antes de soltar el
  turno: sale en orden de `Seq`, sin suponer que sea contiguo. El WebSocket entrega en orden, y el
  catch-up de cada conexión de la Main va después de autenticarse: lo confirmado antes le llega por
  REST y lo posterior por el socket.
- El turno hace falta aunque el SQL del DO sea síncrono: entre confirmar y difundir hay `await`, y por
  ahí puede colarse otra escritura.
- **No hay confirmaciones inciertas.** La base está dentro del DO: el lote entra entero o se deshace
  en el acto (`transactionSync`), y si el DO se apaga a medias se deshace solo. Lo único que puede
  perderse es la difusión de algo ya confirmado, si el DO se apaga justo después. Las Main lo traen
  por el catch-up al reconectar (el apagado cierra todos los sockets); las Handy vuelven a pedir lo que
  ven al reconectar; y el emisor que reintenta recibe el resultado guardado y provoca otra difusión
  (SYNC-03). Un lote reenviado difunde otra vez, en su sitio y antes que lo nuevo, lo que encuentra
  ya aplicado.

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
- **El contraste con la nube** (job `verificar_nube`) compara la base de la Main con la de la nube,
  repara lo que no cuadra e informa a Axiom (`tenant_salud_sync`), no al usuario. Va por resúmenes y
  sólo baja filas de lo que no cuadra (abajo).
- **Corre tras un cierre de caja o a las veinte horas de la última pasada, y sólo en un momento
  tranquilo** (VERIF-02): sin nada pendiente de subir ni un cambio de la nube detenido, y con un
  cuarto de hora sin escrituras. La regla y sus plazos están en
  [jobs-e-interruptores.md](jobs-e-interruptores.md#cuándo-se-contrasta-con-la-nube-verif-02).
- **Con el histórico a medias no se contrasta** (VERIF-01). Una Main recién recuperada de la nube
  tiene el checkpoint en el `Seq` de la foto de la fase 1, así que por el marcapáginas está al día,
  y le falta todo lo que la fase 2 no ha bajado todavía: para el contraste, filas que la nube tiene
  de más. Mientras quede una tabla sin completar en `_Backfill_Historico`, el caso de uso no pide
  nada, y el repositorio, por su cuenta, no da permiso para borrar, para pisar ni para subir nada.

#### El contraste por resúmenes

La Main no baja la ventana para compararla: la de un bar con mucho movimiento no cabe en una
respuesta. Cada lado **resume** sus filas y sólo se comparan los resúmenes:

1. **`/v1/sync/verificar/resumen`** (`verificar.ts`), con el checkpoint de la Main. La nube contesta
   de una vez, sin soltar el hilo del `TenantHub` (una foto): por cada tabla de negocio, su `COUNT(*)`
   entero, la **sentencia de su ventana** (la de la fase 1, `sentenciaVolcado`, la misma de la
   recuperación) con sus argumentos y sus columnas, y el **resumen por cubos** de lo que esa sentencia
   devuelve. Y el `Seq` del final del log (`hasta_seq`).
2. **La Main ejecuta esa misma sentencia** sobre su base (`tpv-infra-sqlite/src/contraste.rs`): la
   definición de la ventana vive en el worker y en ningún otro sitio. La ejecuta en una conexión de
   lectura puesta en `query_only`, dentro de una transacción de lectura (`Connection::foto`), y sólo si
   es UNA sentencia que empieza por `SELECT` o `WITH` y que SQLite da por de sólo lectura. Una que no
   sabe ejecutar (una columna que aquí no existe) deja esa tabla sin comparar, y lo dice.
3. **De los cubos que no cuadran se bajan sus filas** (`/v1/sync/verificar/filas`, por páginas de
   hasta 4 MiB; cada una ejecuta la sentencia de la ventana con su `LIMIT … OFFSET …` y no recorre
   más de un millón de filas) y se comparan una a una
   con la tolerancia de siempre (`sync_reparacion::fila_difiere`: `4` y `4.0` son el mismo número, y
   un número y su texto también). Lo que llega de cada cubo tiene que sumar lo que el resumen decía
   de él; si no, esas filas no son las de la foto y de esa tabla no se repara nada.
4. **Lo de aquí que no ha venido en su cubo se busca por su clave** (`/v1/sync/verificar/por-clave`,
   de 500 en 500, que viajan en un solo parámetro JSON: el SQLite del DO no admite más de cien por
   sentencia): o falta arriba, o está arriba fuera de la ventana (la de una línea depende de su
   comanda), y sólo comparándola se sabe si además es distinta. Una fila igual que sólo ha cambiado
   de ventana no se repara.
5. **Fuera de la ventana sólo hay conteos.** Si los de una tabla no cuadran, sus claves primarias se
   recorren **por páginas y en orden de clave** (`/v1/sync/verificar/claves`, hasta 20.000 por
   página y 2 MiB), y de cada tramo se restan las de aquí, que también se cargan de 20.000 en 20.000
   (si aquí hay más, el tramo se corta en la última). Una pasada no ve más de dos millones de
   claves; la siguiente sigue donde lo dejó (en memoria: un reinicio vuelve a empezar).

**El resumen.** Cada fila va a un **cubo** que sale del hash de su clave primaria, así que cae en el
mismo cubo en los dos lados aunque cambie su contenido; de cada cubo se guarda cuántas filas tiene y
la **suma (módulo 2⁶⁴) del hash de cada una**. Una tabla lleva la menor potencia de dos de cubos que
deja unas 32 filas por cubo, hasta 256 (una maestra pequeña va en uno). El hash es FNV-1a de 64 bits
sobre una **forma canónica** de la fila: `NULL`; un número (`INTEGER` o `REAL`) como sus 8 bytes de
doble IEEE-754, con `-0` como `+0`; un texto en UTF-8 con su longitud; un blob con la suya. Un entero
es su doble porque el SQLite del Durable Object entrega a JavaScript un `INTEGER` y un `REAL` como el
mismo `number`. Un texto que parece un número (`"2.50"`) es un texto: si en un lado una columna
guardara el número y en el otro su texto, ese cubo bajaría y la comparación fila a fila los daría por
iguales (cuesta una descarga, no una reparación). El cubo sale del hash de la clave mezclado con el
`fmix32` de MurmurHash3, porque FNV-1a apenas lleva a sus bits altos lo que cambia al final de una
clave. Los dos lados no comparten código: comparten la tabla de casos
[`verificacion_casos.json`](../../crates/tpv-domain/src/verificacion_casos.json) (forma canónica, hash,
cubo, resúmenes, número de cubos), y [`tests/contract/contraste/`](../../tests/contract/contraste)
fija que los dos SQLite resumen igual las mismas filas.

**Las dos fotos tienen que ser del mismo instante.** Comparar la nube de las 9:00 con la base de las
9:01 da por descuadre lo que se ha vendido en ese minuto. Así que:

- **La nube aplaza** (`200 {aplazar: true, motivo, reintentar_en_s}`) si se escribió en el log hace
  menos de dos minutos (`actividad`), si por encima del checkpoint de la Main hay cambios que no son
  suyos (`por_delante`: todavía no los ha aplicado) o si su checkpoint no casa con el log (`desfase`).
  Lo de la Main por encima de su checkpoint no cuenta: lo tiene, lo escribió ella.
- **La Main sólo compara sin nada por subir**, y con una **marca** de su base —el checkpoint, el
  contador del outbox (que no vuelve atrás) y lo pendiente de subir— que se lee antes de pedir el
  resumen, otra vez en la foto que resume la base, otra vez antes de mirar lo que falta arriba y, con
  el escritor cogido, justo antes de encolar. Cada página de filas o de claves trae el `hasta_seq` de
  su foto, que tiene que ser el del resumen.
- Si algo se mueve, la pasada se deja sin tocar nada y sin informar (`Contraste::Aplazado`): no es un
  fallo, y el job vuelve a los diez minutos.

**Qué se repara.** La Main es el escritor único: una fila **distinta** se repara mandando cómo está
aquí, una que **falta arriba** se sube por estado y una que **sobra arriba** se borra, porque con las
dos fotos del mismo instante lo que la nube tiene y aquí no está no puede ser algo de camino. Nada se
toca si hay **alguna fila en `_Sync_Failed`** (AUD-18; en cuarentena o pendiente de reintentar), si
queda histórico por bajar (VERIF-01) o con el interruptor `reparacion_nube` apagado: se compara y se
informa como `aplazado`. Lo que está en cuarentena se intenta traer antes en la misma pasada (abajo).

- **Un borrado sólo borra si la nube no ha cambiado desde la foto**: el `DELETE` lleva la condición
  de que en `Sync_Changes` no haya nada por encima del `hasta_seq` del resumen salvo las reparaciones
  de esa pasada. Entre la última página y el momento en que el `TenantHub` aplica la reparación, una
  Handy puede haber escrito algo que cuelga de esa fila, y el borrado se lo llevaría con sus
  cascadas. El `TenantHub` aplica las operaciones de la Main en el turno del log, así que la condición
  y el borrado son del mismo instante; si algo ha cambiado no borra, y la pasada siguiente lo mira.
  La sentencia queda en el log y una Main que sustituyera a ésta la recibiría: exige además que el log
  tenga algo a partir del `hasta_seq`, así que en una Main, con `Sync_Changes` vacía, no hace nada.
- Lo que se sube va padres primero (las tablas por sus foráneas y, en una que se apunta a sí misma
  como `Pagos` con su `ID_Pago_Origen`, sus filas) y lo que se borra, hijas primero (en una tabla que
  se apunta a sí misma, de la clave mayor a la menor: con UUIDv7 una devolución va antes que su
  cobro), en operaciones de 500 sentencias que entran juntas en el outbox.
- Lo que no se ha podido mirar entero (el tope de la pasada, 250.000 filas bajadas y 2.000.000 de
  claves, o una tabla sin comparar) se informa como `aplazado`, y lo que falta arriba en las hijas
  de una tabla así no se sube: podría apuntar a una fila suya que falta arriba sin saberse (lo que le
  sobra sí se borra). Lo que sí se ha visto se repara, borrados incluidos: cada fila que sobra se
  sabe que sobra. Un recorrido de claves que sigue donde lo dejó la pasada anterior y llega al final
  cuenta como completo.

#### La salida de una cuarentena de bajada (SYNC-36)

Un cambio de la nube en cuarentena deja al contraste sin reparar, y sin salida se quedaría así para
siempre. Por qué acaba ahí un cambio: lo que el SQLite de la Main no deja escribir y el de la nube sí
—una columna o una tabla que esta versión aún no tiene; un `UNIQUE` con algo de aquí que todavía no
ha subido (la comanda abierta de la mesa, el correo de una clienta); una clave foránea cuyo padre está
en otra cuarentena o aquí se borró y el borrado aún no ha subido— y que no se arregla en los
segundos de los reintentos. Reintentar después sus sentencias no sirve: lo de detrás ya habría pasado
por esas filas, y aplicarlas encima devolvería una fila a un valor viejo o repetiría un `Stock - 1`.

Así que **se trae de la nube cómo están ahora las filas que tocó**, en la pasada del contraste con
permiso para reparar, después del resumen y antes de comparar nada (`cuarentenas_bajada.rs`):

- **Con la foto del resumen.** Que no esté aplazado ya dice que en la nube no hay nada ajeno por
  encima del checkpoint de esta Main; cada página de `/v1/sync/verificar/por-clave` tiene que traer su
  mismo `hasta_seq`, y con el escritor cogido la marca tiene que ser la de antes de pedirlo, sin
  histórico por bajar. Lo que se trae no es anterior al cambio (su `Seq` no pasa del checkpoint) ni
  lleva nada que esta Main no haya aplicado ya: un cambio que aún no ha bajado no se le aplicaría
  encima otra vez. Si algo se mueve antes de aplicar, la pasada entera es `SeHaMovido` sin haber
  escrito nada.
- **Sólo se escribe aquí**, por `raw()`; nada sube ni se borra en la nube. Lo que está arriba se
  escribe como está, con `INSERT … ON CONFLICT(clave) DO UPDATE`; lo que no está sólo se borra aquí si
  el cambio lo borraba (que la nube ya no tenga lo que el cambio insertó o cambió dice que se borró
  después, y ese borrado ya bajó o tiene su propia cuarentena), con sus cascadas, como arriba.
- **Una a una, en orden de `Seq`**, cada una en su transacción con las foráneas aplazadas: primero lo
  que se borra, hijas primero, y después lo que se escribe, padres primero. Si todo entra, la
  cuarentena se borra en la misma transacción y se informa (`INFO`, con su `op_id`); la hija cuyo
  padre estaba en otra cuarentena entra en cuanto entra la del padre. Sin ninguna, la guarda deja
  reparar y el contraste repara en esa misma pasada.
- **Lo que no se puede traer, se queda**, con su motivo en la telemetría (`WARN`, sin datos): sus
  filas son inciertas o dudosas; toca lo mismo que algo apartado de la subida (la nube no tiene lo
  que esta Main escribió ahí, y traerla lo desharía aquí), o sus filas de una tabla salieron de esta
  base y no de la sentencia (`por_filtro`: un `WHERE` por una foránea, un `INSERT … SELECT`) y en esa
  tabla hay algo apartado (aquí pudo cumplir el filtro otra fila que arriba), o borra una fila cuyas
  cascadas (`ON DELETE CASCADE`, `SET NULL`) llegan a una tabla con algo apartado (se lo llevarían
  aquí); sigue sin entrar (el `UNIQUE` con el que chocaba sigue ahí: `no_entra: …`, con la clase del
  error); o la tabla tiene columnas que esta versión no tiene. Se vuelve a intentar en la pasada
  siguiente. Lo apartado de la subida se retira a los 30 días, y con ello esta protección (salvo la
  de `dudosa`, que no caduca): para entonces lo que la Main escribió y la nube rechazó ya no va a
  subir, y lo que se trae es lo de la nube.
- **Trabajo acotado**: se intentan hasta 50 cuarentenas y 5.000 filas por pasada (la primera se
  intenta siempre), en peticiones de 500 claves. Cada pasada empieza por las que hace más que no se
  miran (`Ultima_Salida_Ms`) y las aplica en orden de `Seq`; las que no caben se dejan para otra
  pasada, que empieza por ellas, y las que ni se intentan (inciertas, dudosas o que chocan con lo
  apartado) no cuentan: unas atascadas no dejan sin intentar a las demás. De las inciertas se
  vuelven a mirar 20 por pasada, y las que no caben tampoco se marcan; de las cuarentenas se leen
  10.000, y de lo apartado de la subida, 1.000 operaciones (con más se da todo por chocado).
- Funciona igual con los datos ya vaciados: sólo usa las filas que tocó.
- **Lo que no puede salir solo se avisa.** Una cuarentena de filas inciertas o dudosas (o sin
  `Filas_Json`) no la trae nunca la salida, y mientras esté ahí el contraste no repara. Si lleva una
  semana apartada (`BAJADA_ATASCADA_TRAS_MS`, desde su primer fallo), cuenta en el panel de salud
  (`SyncHealth::bajada_atascada`, `cuarentenas_bajada::atascadas`) y el job `bajada_atascada` avisa
  a los administradores (`use_cases::sync::avisar_bajada_atascada`): una notificación con clave, que
  no se repite mientras siga activa y se cierra sola cuando ya no queda ninguna, y que no bloquea
  nada. Su acción lleva a Configuración → Conectividad, que lo explica y ofrece «Recuperar el
  estado actual de la nube» sólo si es seguro: sin nada de este equipo por subir ni apartado de la
  subida (se perdería al sustituir la base; la guardia de `bootstrap_restaurar` lo vuelve a
  comprobar dentro de su transacción). Pide confirmación (durante unos minutos no se vende ni en el
  TPV ni en las Handy), sólo la puede pedir un administrador, y después cierra la sesión y sigue
  como cualquier otra recuperación desde la nube, que vacía las cuarentenas
  ([recuperacion.md](recuperacion.md#desde-la-nube-dos-fases-sync-19)). Mientras se trae, el motor
  de réplica está parado (`SyncNativo::pausar_hasta_sin_sesion`, que espera a que acabe la sesión
  en marcha): una sesión viva que aplicara un cambio después de restaurar llevaría el checkpoint
  más allá de los cambios que la foto no trae y esa sesión había aplicado sobre la base de antes.

**Lo que cuesta.** Con todo en orden, una petición: el resumen, de unos 100-200 KB. En la nube,
resumir es leer cada fila de la ventana y hacerle su hash sin soltar el hilo del `TenantHub`: con el
mes de un bar de mil comandas diarias (unas 690.000 filas) son unos segundos de CPU del objeto
(`test/verificarVolumen.test.ts`), y por eso sólo se resume con el negocio quieto. En la Main, resumir
600.000 filas cuesta menos de dos segundos en una conexión de lectura. Un resumen no lee más de un
millón de filas (`RESUMEN_MAX_FILAS`): si el mes no cabe, la ventana se encoge por los mismos
escalones que la de la recuperación, y si no cabe ni lo imprescindible van los conteos solos
(`ventana_omitida`), que se comparan con sus claves. Las páginas tienen su techo en bytes; una fila
que sola pasa de él viaja igual, como en el histórico.

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
   reto, recuperando y si se ha echado), serializado con `ws.serializeAttachment()` **tras cada
   cambio**. Y después de una espera se relee: mientras tanto pudo cambiar.
2. **El censo es `state.getWebSockets()`**, con la etiqueta `deviceId`. Puede devolver sockets ya
   cerrados: `liveSocketsFor()` filtra por `readyState` e `isMainConnected(except)` excluye el que se
   está cerrando.
3. **Nada que mantenga vivo el DO**: ni `setInterval` ni `setTimeout`, y no tiene `alarm`. El único
   temporizador es el plazo de la
   lectura de la base central que pone al día quién es la Main (`fetchConPlazo`), y vive lo que su
   petición: se quita al leer la respuesta entera, al fallar o al cancelarse.
4. **Las cachés de instancia se pierden al hibernar, y eso no cuesta nada**: el cliente de la base del
   negocio (`baseLocal`, que al volver comprueba otra vez las migraciones), `lastSeenPushedAtMs`,
   `lastPurgeAtMs` y lo que ya se ha avisado de una avería de la base (`avisados`: al despertar se
   avisa otra vez). Se quedan como campos a propósito. Lo mismo el turno del log (`turnoDelLog`) y la
   fila de entrada de la Main (`turnoDeEntrada`): son lo que está en vuelo, y el DO sólo hiberna sin
   nada en vuelo. Lo que sí tiene que sobrevivir va al SQL del DO: quién es la Main (`_Main_Vigente`).
5. ⚠️ **En los módulos de funciones libres no puede haber variables de módulo con estado**: en Workers
   una variable de módulo es por **isolate**, compartido entre DO de **tenants distintos**. Lo que haya
   que recordar entre invocaciones va al SQL del DO (como `_Main_Vigente`).
6. Si cambia el texto del latido (`PING`, en `tpv-infra-http/src/websocket.rs`; lo usan el latido de
   cada 30 s y el ping a demanda de la Handy), hay que cambiar el par del auto-response: casa cadenas
   exactas, y si no coinciden todo funciona pero el DO se despierta en cada ping.
7. Un cierre iniciado por el servidor no garantiza `webSocketClose`: la salida de una sesión (si se
   va la Main, las Handy tienen que saberlo) se contabiliza en `sessionGone(ws, att)`, que se llama desde `webSocketClose` y desde `cerrar`, por donde pasa todo
   cierre que inicia el DO: la baja, la sesión que ya no es la Main, la anterior de un dispositivo que
   reconecta, el saludo que falla, `webSocketError` y retirar el negocio (`borrarTodo`). Los dos
   dejan la sesión fuera antes de nada, y a una que ya está fuera no le vuelven a contar la salida.
   Todo cierre nuevo iniciado por el DO va por `cerrar`.

`instrumentDurableObjectWithSentry` envuelve los tres handlers del WebSocket.

## Las escrituras de la Handy

Cada dominio del worker tiene su `*.commands.ts`, que construye la transacción (`BuiltCommand`) y la
aplica por `lib/hub.ts` → RPC `aplicar` del DO, que la ejecuta en la base del negocio y la difunde. Sólo el rol
`tpv` puede ejecutar SQL por el WebSocket, mientras sea la Main de la licencia, y las dos cosas las
dicta la base central, no el cliente. Lo que la
Handy no puede hacer, lo veta un middleware antes de leer el cuerpo ([worker.md](worker.md)). La lógica
duplicada entre Rust y estos comandos la sujetan los arneses de contrato
([tests/contract/README.md](../../tests/contract/README.md)).

Una ruta decide leyendo la base fuera del lote (SYNC-30), y lo que llega a la Main es la sentencia, que
la Main aplica con sus datos: puede tener sin subir lo que la ruta no vio. Por eso la regla que no
puede romperse va también **dentro de la sentencia replicada**, y cada base la vuelve a evaluar al
aplicarla: una línea sólo entra en una comanda abierta (INC-20261030-016) y borrar un ticket no borra
nada si tiene algún cobro o alguna línea cobrada (AUD-14). La ruta de borrar un ticket mira lo mismo
antes de mandar el lote (`hasPaidLines`), y vuelve a mirarlo cuando no consta que el lote lo haya
borrado: no tocó ninguna fila, o es el reintento de una operación ya aplicada y el resultado guardado
lleva `null` en lo que dependía de la base. Un ticket borrado con su cobro todavía en camino deja la nube sin él (SYNC-31).

Toda escritura de la Handy lleva su `X-Idempotency-Key`, que es el `Op_Id` de la operación: un UUIDv7.
El worker exige que tenga de 16 a 64 letras, cifras, guiones o guiones bajos (`lib/rutas.ts`) y
rechaza otra cosa con `invalid_op_id`, sin llamar al DO (AUD-32).

La `X-Idempotency-Key` la pone el `CloudClient` de `tpv-infra-http`, una por escritura, salvo cuando el
resultado de la anterior quedó **incierto** (fallo de transporte, timeout o 5xx): entonces la misma
petición vuelve a salir con su clave y sus bytes durante 5 minutos, y el DO devuelve el resultado de
la primera si se aplicó (RI-64). Así, el camarero que vuelve a pulsar tras un error no duplica la
línea. Con una respuesta clara la clave se olvida, y pedir dos veces lo mismo son dos operaciones.
Una lectura que va por POST (`post_lectura`: lo que busca lleva datos de una persona o texto libre,
AUD-27) no es una escritura: sale sin clave, no entra en ese reintento y no pasa por el motor de
escrituras del DO: ni se aplica ni se replica nada.

El id de lo que da de alta la Handy lo elige el dispositivo. Las altas de venta rápida (un ticket,
una línea) y la de un lote son **altas puras** (`ON CONFLICT … DO NOTHING`): un id que ya existe no
toca la fila, y la ruta contesta como siempre. Ningún flujo de la app reenvía un id esperando que se
actualice (su reintento va por la clave de idempotencia), y con `DO UPDATE` el id de una línea
cobrada la movía a otro ticket y el de una comanda cobrada la reabría (AUD-16); el de un lote le
pisaba las existencias (INV-02).

Lo que acompaña a un alta tampoco se escribe si la fila ya estaba (AUD-20). El movimiento `ALTA` de
un lote va delante de su alta y sólo entra si el lote no existe, y el del stock suelto de un producto
nuevo, sólo si el producto no existe; en el worker y en la Main. Sin esa condición quedaba otra
entrada de existencias que la reconciliación daba por descuadre y que ningún ajuste cerraba. La
condición va en la sentencia y la vuelve a evaluar quien aplica la réplica: la ruta del worker da un
producto por nuevo leyendo fuera del lote, y aunque la Main lo decide dentro de su transacción, la
nube puede tener ya ese id (dos equipos que vuelven a crear a la vez un producto que otro borró).

### Frontera con la webview (RI-31/RI-57)

El motor se inicia en el shell y sigue vivo al desmontar React. La webview sólo consulta
`sync_estado`, pide un reintento o consulta salud/progreso. Aplicar SQL, confirmar el outbox y
desbloquear la reconciliación son capacidades internas. El proxy HTTP
admite sólo rutas concretas de emparejamiento/administración; los tickets y saludos de ambos
modos permanecen en Rust y no permite usar las rutas de réplica. El saludo Handy lleva `WS_HANDY_HELLO` y
no sirve para autenticar una Main, incluso si cambia el modo local.

Las notificaciones llevan tablas y las comandas afectadas, sin sentencias ni argumentos.
Una revisión creciente evita que un snapshot antiguo pise un evento reciente.
