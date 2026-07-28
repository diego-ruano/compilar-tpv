# T2 — Sincronización (outbox + WebSocket + TenantHub)

> **Ámbito.** El sistema de replicación a nivel de sentencia entre la Main (SQLite local), la nube
> (Durable Object `TenantHub` + Turso por tenant) y las Handy (sin BD local). Cubre captura de
> outbox, drenado por WS, motor idempotente del DO, catch-up REST, freeze por presencia y
> determinismo temporal. Ficheros:
> `crates/tpv-infra-sqlite/src/db.rs` (`WriteGuard`, `capture_write`, `write_op`,
> `rewrite_now_literals`), `crates/tpv-infra-sqlite/src/sync.rs` (`SqliteSyncRepository`),
> `apps/tpv-main/src/shared/lib/useMainSocket.ts`, `useHandySocket.ts`,
> `apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts`,
> `apps/cloud-worker-licensing/src/lib/hub.ts`,
> `apps/cloud-worker-licensing/src/domains/sync/sync.routes.ts`.

## Cómo funciona hoy (resumen)

- **Escritor único (Main):** toda escritura local pasa por `WriteGuard`, que captura la sentencia (con
  el tiempo resuelto a literal) en `_Sync_Outbox` y la auto-marca en `_Sync_Applied_Ops` (anti-eco).
- **Drenado (Main→nube):** `useMainSocket` envía cada op del outbox por WS (`apply`), espera
  `apply_ack`, y marca la op como enviada ascendiendo su `Seq` real. El DO aplica en Turso dentro de
  un **batch atómico** con un gate idempotente `INSERT INTO Applied_Operations` (sin `ON CONFLICT`:
  un reintento viola `UNIQUE(Op_Id)` y hace rollback de todo → recupera resultado/seq).
- **Broadcast (nube→resto):** tras confirmar, el DO difunde `change` (sentencias resueltas + seq) a
  los dispositivos autenticados excepto el originador. La Main secundaria las aplica a su SQLite; la
  Handy solo hace refetch.
- **Catch-up:** al autenticarse, la Main pide `/v1/sync/changes` desde su `Last_Seq` y aplica en orden
  (bufferizando los `change` en vivo hasta terminar).
- **Freeze:** si no hay Main (rol `tpv`) conectada, el DO rechaza escrituras con `main_offline` y las
  Handy bloquean su UI.
- **Determinismo temporal:** el emisor fija la hora (`X-Client-Now`); el DO y el `WriteGuard`
  reescriben `datetime('now','localtime')` a literal antes de ejecutar/replicar.
- **Hibernación (SYNC-16):** el DO usa la **WebSocket Hibernation API**. Las conexiones siguen
  abiertas mientras el objeto está evacuado de memoria (no factura duración) y el runtime lo despierta
  al llegar un mensaje real; el latido se contesta en el edge sin despertarlo. Consecuencia de diseño:
  **no puede haber estado de sesión en campos de la instancia** — ver la sección SYNC-16.

---

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| SYNC-01 | 🟠 | Una op "veneno" **atasca todo el pipeline**: el aplicador para en el primer fallo y no avanza el checkpoint → cada reconexión reintenta y vuelve a fallar, indefinidamente | `sync.rs:198-220` + `useMainSocket.ts:112-130` |
| SYNC-02 | 🟠 | Captura de outbox **no atómica** en escrituras autocommit → un crash entre el write y el `write_op` pierde la replicación de esa escritura (divergencia silenciosa) | `db.rs:346-353` |
| SYNC-03 | 🟠 | Broadcast **best-effort no reintentado**: si el DO cae tras el commit y antes del broadcast, las Handy nunca reciben el cambio (no tienen checkpoint) | `tenantHub.ts:781-805` |
| SYNC-04 | 🟠 | Escrituras de Handy pueden quedar con **timestamp UTC** si el constructor de comando no manda `clientNow` → filas con zona horaria inconsistente | `tenantHub.ts:232-240`, `hub.ts:68` |
| SYNC-05 | 🟡 | Reescritura de tiempo **de cobertura estrecha** (espejo de DB-15): solo formas exactas; cualquier otra función temporal replica verbatim | `db.rs:116`, `tenantHub.ts:244-250` |
| SYNC-06 | 🟡 | `invalidateQueries()` **sin filtro** en cada cambio (Main y Handy) → refetch de todo lo montado; tormentas bajo actividad multi-dispositivo | `useMainSocket.ts:124`, `useHandySocket.ts:157` |
| SYNC-07 | ✅ | El challenge WS **no era de un solo uso**: no se borraba tras verificar → replay dentro de la ventana de 60 s | `tenantHub.ts` (`webSocketMessage`, rama `helloSigned`) |
| SYNC-08 | ✅ | `touchLastSeen` escribía en la BD central **en cada ping** (30 s) por dispositivo → amplificación de escrituras | `tenantHub.ts` (`touchLastSeen`) |
| SYNC-09 | 🟡 | **Sin backoff** de reconexión: 3 s fijos en ambos hooks → reconexiones constantes ante un corte prolongado | `useMainSocket.ts:261-267`, `useHandySocket.ts:68-74` |
| SYNC-10 | 🟡 | `storageResult` best-effort → el **reintento idempotente devuelve un resultado degradado** (campos derivados de DB en null) distinto al de la primera vez | `tenantHub.ts:826-828,935-952` |
| SYNC-11 | 🟡 | `evalValueStep`: **acoplamiento frágil** al set cerrado de 3 regex; un nuevo `*.commands.ts` con otra forma rompe la replicación en runtime | `tenantHub.ts:461-470` |
| SYNC-12 | 🔵 | `Sync_Changes` y `Applied_Operations` **crecen sin límite** en la nube → catch-up escanea una tabla cada vez mayor | `tenantHub.ts:577-587,759-766` |
| SYNC-13 | 🔵 | Catch-up limitado a 2000×500 = 1M ops; una Main mucho tiempo offline podría **cortar el catch-up** en silencio | `useMainSocket.ts:240` |
| SYNC-14 | 🔵 | Falta **observabilidad de salud** al usuario: profundidad del outbox / lag de catch-up / pipeline atascado son invisibles | (transversal) |
| SYNC-15 | 🔵 | Token en el **query string** del WS (`?token=`) → visible en logs de proxy/CF | `useMainSocket.ts:279-281` |
| SYNC-16 | ✅ | El DO permanecía **cargado en memoria facturando duración** mientras hubiera un WS abierto, aunque estuviera ocioso → migrado a la WebSocket Hibernation API | `tenantHub.ts` (clase completa) |

---

## Detalle de hallazgos

### SYNC-01 🟠 Una op "veneno" atasca todo el pipeline — CONFIRMADO
- **Ubicación:** `SqliteSyncRepository::apply_changes` (`sync.rs:204-212`) aplica ops en orden y usa
  `apply_one(conn, ch).await?`: **el `?` propaga el error y aborta el lote**; el checkpoint no avanza
  más allá de la op fallida. En `useMainSocket.ts:112-130`, `enqueue` captura el error con un
  `console.warn` y sigue, pero el siguiente catch-up vuelve a pedir **desde el mismo `Last_Seq`**.
- **Fallo:** cualquier op que no se pueda aplicar localmente (violación de FK diferida al COMMIT
  porque falta la fila padre, una sentencia no idempotente, una divergencia de esquema, un dato que
  la Main rechaza) **bloquea permanentemente** toda la sincronización nube→Main: se reintenta la
  misma op en cada reconexión y vuelve a fallar. Las ops posteriores (seq mayores) nunca se aplican.
- **Escenario:** el DO aplica en Turso con `defer_foreign_keys` y captura la sentencia; llega a la
  Main una op cuya fila padre no existe localmente (p. ej. se perdió una op anterior por SYNC-02, o
  un borrado la eliminó). `apply_one` falla en el COMMIT → toda la cola se atasca; el TPV deja de
  recibir cambios de otros dispositivos sin ningún aviso.
- **Impacto:** pérdida total de convergencia para ese dispositivo, invisible para el usuario.
- **Arreglo:** política de **poison-message**: reintentar N veces; si persiste, **cuarentena** de la
  op (registrar en una tabla `_Sync_Failed`, avanzar el checkpoint y **alertar** por observabilidad)
  para no bloquear el resto. Considerar además aplicar el lote completo en una sola transacción con
  "todo o nada por op" pero **continuando** con las siguientes. Emitir métrica a Sentry/Axiom.

### SYNC-02 🟠 Captura de outbox no atómica en autocommit — CONFIRMADO
- **Ubicación:** `WriteGuard::capture_write`, rama autocommit (`db.rs:346-353`): ejecuta la escritura
  de negocio (que en autocommit **ya confirmó**) y **después**, en una transacción separada, llama a
  `write_op` para insertar en `_Sync_Outbox`.
- **Fallo:** entre ambos autocommits no hay atomicidad. Si el proceso cae (o la 2ª escritura falla) 
  justo después de confirmar el negocio y antes de `write_op`, la fila de negocio queda escrita pero
  **sin entrada en el outbox** → esa escritura **nunca se replica** a la nube.
- **Escenario:** un `UPDATE` de una sola sentencia (no envuelto en `BEGIN/COMMIT`) sobre, p. ej.,
  `Business_Settings` o un `Estado` de comanda; corte de energía en el instante exacto. La Main tiene
  el cambio; la nube y las Handy, no. Divergencia permanente (el catch-up no lo recupera: nace en la
  Main y solo sale por el outbox).
- **Impacto:** divergencia silenciosa; probabilidad baja por operación pero no nula, y crece con el
  volumen de escrituras sueltas.
- **Arreglo:** envolver **también** la escritura autocommit + su `write_op` en una única transacción
  (o forzar que todas las escrituras replicables pasen por el camino transaccional). El camino
  `BEGIN/COMMIT` ya es atómico (captura dentro de la tx); el problema es solo la rama suelta.

### SYNC-03 🟠 Broadcast best-effort no reintentado — PLAUSIBLE
- **Ubicación:** `applyInternalCommandIdempotent` (`tenantHub.ts:791-805`) hace `broadcastChange`
  **después** del commit del batch. El reintento idempotente (`recoverAppliedOp`, `tenantHub.ts:781-784`)
  retorna **sin** re-emitir el broadcast.
- **Fallo:** si el DO se reinicia/evicta entre el commit en Turso y el `broadcastChange`, el cambio
  queda confirmado pero **no difundido**. Las Main lo recuperarán por catch-up (tienen `Last_Seq`);
  las **Handy no** (no tienen checkpoint, dependen del broadcast en vivo + refetch). Un reintento del
  emisor entra por el path idempotente y **no** vuelve a difundir.
- **Escenario:** la Main confirma un cambio; el DO cae antes del broadcast; una Handy conectada nunca
  se entera hasta que otro cambio cualquiera la haga refetch (o el usuario navega).
- **Impacto:** las Handy pueden mostrar datos desactualizados de forma indefinida tras un fallo del DO.
- **Arreglo:** que las Handy también tengan un **cursor de catch-up ligero** (pedir el último `Seq`
  de `Sync_Changes` al (re)autenticarse y refetch si es mayor que el último visto), o re-emitir el
  broadcast en el path idempotente. Alternativamente, un "refetch de seguridad" periódico en la Handy.

### SYNC-04 🟠 Escrituras de Handy con timestamp UTC — PLAUSIBLE (verificar callers)
- **Ubicación:** `resolveClientNow` (`tenantHub.ts:232-240`) cae a `serverNowFixed()` (**UTC**) si el
  cliente no manda un `X-Client-Now` válido. `hub.ts:68` solo pone la cabecera **si** `clientNow` es
  truthy.
- **Fallo:** si algún constructor de comando de Handy invoca `applyViaHub` sin `clientNow`, el DO
  resuelve `datetime('now','localtime')` a **UTC**, no a hora local. Esas filas quedan con zona
  horaria distinta al resto (Main siempre usa `localtime`).
- **Escenario:** una reserva/pedido creado desde Handy aparece con hora desplazada respecto a los
  creados desde la Main. Afecta a ordenaciones y KPIs por día/hora.
- **Impacto:** inconsistencia de fechas entre dispositivos; sutil.
- **Arreglo:** verificar que **todos** los `*.commands.ts` que escriben pasan `clientNow` (hora local
  del dispositivo). Añadir un test/guardia que rechace un `apply` de Handy sin `X-Client-Now`. Cruce
  con [esquema-db.md](esquema-db.md) DB-02/DB-15.

### SYNC-05 🟡 Reescritura de tiempo de cobertura estrecha
- Espejo exacto de **DB-15**. Tanto `rewrite_now_literals` (Rust) como `rewriteNowInSql` (DO) solo
  cubren `datetime('now','localtime')` y `date('now','localtime')`. `datetime('now')` (sin
  `localtime`), `strftime`, `CURRENT_TIMESTAMP` o `julianday('now')` replican verbatim → divergen.
- **Arreglo:** ampliar cobertura o **prohibir por lint/test** esas formas en SQL replicable. Test que
  escanee `*.commands.ts` + SQL Rust de escritura.

### SYNC-06 🟡 `invalidateQueries()` sin filtro en cada cambio
- **Ubicación:** `useMainSocket.ts:124` y `useHandySocket.ts:157` llaman `queryClient.invalidateQueries()`
  **sin clave**, invalidando TODAS las queries en cada lote de cambios.
- **Fallo:** cada `change` recacha todas las queries montadas, aunque el cambio afecte a un solo
  dominio. Con varios dispositivos escribiendo, se producen ráfagas de refetch.
- **Arreglo:** derivar de `statements` (ya se hace parcialmente con `affectedComandas`) las **claves
  de feature afectadas** e invalidar solo esas (`invalidateQueries({ queryKey: [feature] })`).

### SYNC-07 ✅ Challenge WS no era de un solo uso — RESUELTO
- **Ubicación:** rama `helloSigned` de `webSocketMessage`.
- **Fallo (original):** el mismo `nonce`/firma podía reenviarse dentro de la ventana de 60 s (hasta
  expirar) para re-autenticar. Exploit acotado (mismo dispositivo, misma clave) pero rompía la
  propiedad de "un challenge = un uso".
- **Arreglo aplicado:** el challenge vive en el **attachment del socket** y se consume poniéndolo a
  `null` de forma **síncrona, antes de cualquier `await`**, en cuanto llega un `helloSigned` (éxito o
  fallo). Hacerlo antes del primer `await` es lo que impide que dos `helloSigned` seguidos lean el
  mismo nonce. Un reintento legítimo obliga a reconectar (nueva conexión → nuevo challenge).

### SYNC-08 ✅ `touchLastSeen` en cada ping — RESUELTO
- **Fallo (original):** `UPDATE devices SET last_seen_at_ms=?` en la BD central por cada ping (30 s)
  y por dispositivo → escritura periódica constante proporcional al nº de dispositivos.
- **Arreglo aplicado:** dos capas. (1) Throttle en memoria del DO (`LAST_SEEN_THROTTLE_MS`, 5 min) por
  dispositivo. (2) Con SYNC-16 el ping **ya ni siquiera llega al DO** (lo contesta el auto-response en
  el edge), así que `last_seen` se alimenta solo de la **conexión** (`force`) y de la **actividad
  real** (`apply`/`event`). El throttle se pierde al hibernar: como mucho un UPDATE extra por
  despertar.

### SYNC-09 🟡 Sin backoff de reconexión
- **Ubicación:** `RECONNECT_MS = 3000` fijo en ambos hooks.
- **Fallo:** ante un corte prolongado (worker caído, sin red) se reintenta cada 3 s de forma
  indefinida (consumo de batería/CPU y presión sobre el worker al volver).
- **Arreglo:** backoff exponencial con tope y jitter (p. ej. 3 s → 30 s), reseteando al conectar.

### SYNC-10 🟡 Reintento idempotente devuelve resultado degradado
- **Ubicación:** `buildApplyBatch` guarda `storageResult` best-effort (literales sí; derivados de DB
  → null) (`tenantHub.ts:826-828`); `recoverAppliedOp` lo devuelve en el reintento.
- **Fallo:** una **Handy** que reintente una escritura REST (timeout + retry) recibe en el 2º intento
  un `data` reconstruido solo con literales (sin los campos que dependían de la DB), distinto al del
  1er intento. Si el cliente usa ese `data`, puede comportarse distinto según sea 1er intento o retry.
- **Arreglo:** o bien persistir el resultado **real** completo en `Result_Json` tras ejecutar (no el
  best-effort), o documentar que el retry solo garantiza `seq` y que el cliente debe refetch.

### SYNC-11 🟡 `evalValueStep` acoplamiento frágil
- **Ubicación:** `tenantHub.ts:461-470`: evalúa en JS solo 3 formas (`SELECT ?N`, constante numérica,
  `'pref' || ?N`); cualquier otra lanza `value_step_no_evaluable_en_batch`.
- **Fallo:** el conjunto de formas válidas de un paso `value` está **implícitamente acoplado** a lo
  que generan los `*.commands.ts`. Un dominio nuevo con otra forma de `value` rompe la aplicación en
  la nube en **runtime** (no en compilación/tests, salvo que haya cobertura específica).
- **Arreglo:** test de contrato que ejercite **cada** comando contra `buildApplyBatch`/`evalValueStep`;
  documentar el "lenguaje" permitido de pasos `value`.

### SYNC-12 🔵 `Sync_Changes` / `Applied_Operations` crecen sin límite (nube)
- **Ubicación:** `tenantHub.ts` inserta en `Sync_Changes` (`:763-766`) y `Applied_Operations`
  (`:759-762`) por cada escritura; no se ve purga.
- **Fallo:** el catch-up (`sync.routes.ts`) escanea `Sync_Changes WHERE Seq > since ORDER BY Seq`
  sobre una tabla que crece indefinidamente; y `Applied_Operations` idem.
- **Arreglo:** purga/compactación periódica con **suelo** por encima del checkpoint más atrasado de
  cualquier Main del tenant (p. ej. TTL de N días + no borrar por encima del mínimo `Last_Seq`
  conocido). Requiere rastrear el checkpoint de cada Main.

### SYNC-13 🔵 Corte silencioso del catch-up a 1M ops
- **Ubicación:** `useMainSocket.ts:240` (`for i < 2000`) × `limit 500` = 1.000.000 ops máximas por
  ciclo de catch-up.
- **Fallo:** una Main offline muchísimo tiempo (o `Sync_Changes` enorme) podría no terminar el
  catch-up en un ciclo y quedarse a medias sin señal clara.
- **Arreglo:** continuar el catch-up en la siguiente vuelta (ya reintenta al reconectar) y **emitir
  telemetría** si se alcanza el tope.

### SYNC-14 🔵 Falta observabilidad de salud al usuario
- **Fallo:** no hay indicador de profundidad del outbox, lag de sincronización, ni de un pipeline
  atascado (SYNC-01). Un fallo de convergencia es invisible.
- **Arreglo:** exponer en Configuración → Conectividad: nº de ops pendientes en el outbox, `Last_Seq`
  vs último `Seq` de la nube, y un aviso si hay ops en cuarentena.

### SYNC-15 🔵 Token en el query string del WS
- **Ubicación:** `useMainSocket.ts:279-281` / `useHandySocket.ts:87-89`: `?token=<jwt>`.
- **Fallo:** los navegadores no permiten cabeceras en `WebSocket`, así que el token va en la URL;
  queda en logs de proxies/CF y en historiales.
- **Arreglo:** aceptable por limitación del protocolo, pero preferir un **ticket de un solo uso y
  corta vida** (canjear el JWT por un ticket efímero para el WS) para minimizar exposición.

### SYNC-16 ✅ El DO facturaba duración mientras hubiera un WS abierto — RESUELTO

- **Fallo (original):** con `server.accept()`, **cualquier** WebSocket abierto mantenía el
  `TenantHub` cargado en memoria y facturando **duración (GB-s)** de forma continua, aunque no
  pasara ni un solo mensaje. Como el DO es **uno por tenant**, un cliente con la app abierta durante
  su jornada tenía el hub despierto toda la jornada. El coste escala **lineal con el nº de tenants**
  y es un medidor distinto (y mucho más restrictivo) que el de requests.
- **Arreglo aplicado:** migración a la **WebSocket Hibernation API**:
  - `state.acceptWebSocket(server, [deviceId])` en lugar de `server.accept()`.
  - Los `server.addEventListener("message"|"close"|"error")` pasan a métodos de clase
    `webSocketMessage` / `webSocketClose` / `webSocketError`.
  - `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}',
    '{"type":"pong"}'))` en el constructor: el latido de 30 s se responde **en el edge**, sin
    despertar al DO ni facturar. **El frontend no cambió** (el par casa la cadena exacta que ya
    enviaban `useMainSocket`/`useHandySocket`).
- **Sin cambios de despliegue:** misma clase, mismo binding, `migrations` intacto. Los clientes no se
  enteran: hibernar **no cierra** las conexiones.

#### Reglas de diseño que impone la hibernación (leer antes de tocar el DO)

1. **Prohibido el estado de sesión en campos de instancia.** Al despertar, la instancia es **nueva**
   (campos vacíos, sin closures). Todo lo que describe a un socket va en su **attachment**
   (`WsAttachment`: `tenantId`, `deviceId`, `role`, `authed`, `pubkeyB64`, `challenge`) vía
   `ws.serializeAttachment()`. Hay que **re-serializar tras cada mutación** (p. ej. al autenticar).
   Los antiguos `Map`s (`sockets`/`roles`/`authed`/`pubkeyByDevice`/`challengeByDevice`) han
   desaparecido.
2. **El censo de conexiones es `state.getWebSockets()`**, con etiqueta `deviceId` para buscar uno
   concreto. Ojo: `getWebSockets()` **puede devolver sockets ya cerrados**, por eso `liveSocketsFor()`
   filtra por `readyState` y `isMainConnected(except)` permite excluir el socket que se está cerrando
   (sin ese `except`, el freeze `main_offline` no se dispararía nunca).
3. **Nada que mantenga el DO vivo.** Ni `setInterval`/`setTimeout` en el DO, ni un `alarm()`
   periódico: despertarían el objeto y anularían el ahorro. Por eso `last_seen` **no** se refresca con
   un temporizador (ver SYNC-08).
4. **Las cachés en memoria son best-effort y se pierden al hibernar.** Afecta a
   `lastSeenPushedAtMs` (throttle de `last_seen`), `lastPurgeAtMs` (SYNC-12: la purga podrá correr algo
   más a menudo) y la resolución cacheada de la BD del tenant (`TENANT_DB_CACHE_TTL_MS`: se
   re-resuelve tras cada despertar, una query extra). Ninguna es crítica; si alguna molestara, se
   movería a `state.storage`.
5. **Si cambia el formato del latido en el frontend**, hay que cambiar el par del auto-response en el
   constructor: casa **cadenas exactas**. Si dejan de coincidir, todo seguirá funcionando pero el DO
   despertará en cada ping y se pierde el ahorro (fallo silencioso de coste, no de función).
6. **Los cierres iniciados por el servidor no son de fiar para la contabilidad.** La documentación de
   Cloudflare no garantiza que llamar a `ws.close()` desde el DO dispare `webSocketClose`. Por eso la
   presencia/freeze vive en `sessionGone(ws, att)`, que se invoca desde `webSocketClose` **y**
   explícitamente en el revoke. Es idempotente y se auto-inhibe si queda otro socket vivo del mismo
   dispositivo, así que da igual que se llame una o dos veces. **Cualquier cierre nuevo iniciado por
   el DO debe llamar a `sessionGone` igual.**

> **Sentry:** `instrumentDurableObjectWithSentry` (v10) envuelve explícitamente `webSocketMessage`,
> `webSocketClose` y `webSocketError`, así que la instrumentación sigue cubriendo el ciclo de vida del
> WebSocket tras la migración.

---

## Nota de verificación (corrige DB-03)

`TenantHub.probeTenantDb` **sí** ejecuta `PRAGMA foreign_keys = ON` sobre la conexión del tenant al
resolverla (`tenantHub.ts:569`), y el batch de escritura antepone `PRAGMA defer_foreign_keys = ON`
(`:771`). Es decir, el intento de aplicar FK en la nube **existe**. La duda que queda (y que rebaja
DB-03 de "probablemente OFF" a "verificar") es si, con el cliente HTTP `@libsql/client/web`, el
`PRAGMA foreign_keys=ON` fijado en el `probe` (autocommit, cacheado 6 h) **persiste** hasta los
`db.batch(...)` posteriores (que son otras peticiones HTTP): si el protocolo no reutiliza la misma
conexión servidor, el `foreign_keys` podría no estar activo en el batch (y dentro de la transacción
no puede activarse). **Acción:** confirmar empíricamente con una escritura que viole una FK contra
Turso y observar si la rechaza.

---

## Workflow de corrección (T2)

Orden sugerido (robustez de datos primero):

1. **SYNC-02 (atomicidad del outbox).** Envolver la rama autocommit de `capture_write` (write +
   `write_op`) en una única transacción, o encaminar toda escritura replicable por el camino
   `BEGIN/COMMIT`. Test: matar el proceso entre write y outbox (o simularlo) y comprobar que o ambos
   o ninguno.
2. **SYNC-01 (poison-message).** Implementar cuarentena + avance de checkpoint + alerta; test con una
   op que viole FK deliberadamente y comprobar que el resto del lote sí converge.
3. **SYNC-03 / SYNC-04 (convergencia de Handy y timestamps).** Añadir cursor/refetch de seguridad a
   la Handy; garantizar `clientNow` en todos los comandos; test de zona horaria.
4. **SYNC-05 (determinismo temporal).** Lint/test que prohíba formas de tiempo no cubiertas en SQL
   replicable (coordinar con T1 DB-15).
5. **SYNC-07 (challenge de un solo uso).** Borrar el challenge tras verificar. Test de replay.
6. **SYNC-12 (crecimiento en la nube).** Diseñar purga con suelo por checkpoint mínimo.
7. **Rendimiento/robustez menor (SYNC-06, 08, 09, 10, 11, 13, 15).** Invalidación selectiva, throttle
   de `last_seen`, backoff, contrato de `value`-steps, telemetría.
8. **SYNC-14 (observabilidad).** Panel de salud de sync en Configuración.

**Invariante a preservar en cualquier cambio:** escritor único en la Main, idempotencia por `Op_Id`
(nube `Applied_Operations` + Main `_Sync_Applied_Ops`), IDs y tiempos **deterministas** resueltos a
literal **antes** de capturar/replicar. Todo arreglo debe mantener estas tres propiedades.
