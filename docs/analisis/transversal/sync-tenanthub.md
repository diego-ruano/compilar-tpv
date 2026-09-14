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
  La escritura de negocio y su registro en el outbox van en **una sola transacción**.
- **Drenado (Main→nube):** `useMainSocket` envía cada op del outbox por WS (`apply`), espera
  `apply_ack`, y marca la op como enviada ascendiendo su `Seq` real. El DO aplica en Turso dentro de
  un **batch atómico** con un gate idempotente `INSERT INTO Applied_Operations` (sin `ON CONFLICT`:
  un reintento viola `UNIQUE(Op_Id)` y hace rollback de todo → recupera resultado/seq).
- **Autorización del `apply`:** solo el rol `tpv` (la Main) puede ejecutar SQL por WS, y el rol lo
  dicta la BD central, no la cabecera del cliente. Las escrituras de Handy van por REST → comandos
  de dominio acotados (`hub.ts` → `/internal/apply`).
- **Broadcast (nube→resto):** tras confirmar, el DO difunde `change` (sentencias resueltas + seq) a
  los dispositivos autenticados excepto el originador. La Main secundaria las aplica a su SQLite; la
  Handy solo hace refetch (**selectivo**: se derivan las claves de feature de las tablas tocadas).
- **Catch-up:** al autenticarse, la Main pide `/v1/sync/changes` desde su `Last_Seq` y aplica en orden
  (bufferizando los `change` en vivo hasta terminar).
- **Op envenenada:** una op que falla al aplicarse se reintenta 5 veces y luego pasa a **cuarentena**
  (se salta, avanza el checkpoint y se señala), para no atascar la cola indefinidamente.
- **Freeze:** si no hay Main (rol `tpv`) conectada, el DO rechaza escrituras con `main_offline` y las
  Handy bloquean su UI.
- **Determinismo temporal (CFG-04):** la hora la fija quien escribe, nunca una base. La Main
  resuelve toda forma de «ahora» a literal con un instante por operación y ejecuta en local la misma
  sentencia que sube; el DO resuelve con la hora del emisor (`X-Client-Now`) y rechaza lo que no
  puede fijar (`hora_no_determinista`). El esquema no tiene `DEFAULT` de hora.
- **Hibernación (SYNC-16):** el DO usa la **WebSocket Hibernation API**. Las conexiones siguen
  abiertas mientras el objeto está evacuado de memoria (no factura duración) y el runtime lo despierta
  al llegar un mensaje real; el latido se contesta en el edge sin despertarlo. Consecuencia de diseño:
  **no puede haber estado de sesión en campos de la instancia** — ver la sección siguiente.

---

## SYNC-16 — Hibernación del DO: reglas de diseño (vigentes)

- **Origen:** con `server.accept()`, **cualquier** WebSocket abierto mantenía el `TenantHub` cargado
  en memoria y facturando **duración (GB-s)** aunque no pasara ni un mensaje. Como el DO es **uno por
  tenant**, un cliente con la app abierta lo tenía despierto toda la jornada, y el coste escalaba
  lineal con el nº de tenants.
- **Arreglo aplicado:** migración a la **WebSocket Hibernation API**:
  - `state.acceptWebSocket(server, [deviceId])` en lugar de `server.accept()`.
  - Los `server.addEventListener("message"|"close"|"error")` pasan a métodos de clase
    `webSocketMessage` / `webSocketClose` / `webSocketError`.
  - `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}',
    '{"type":"pong"}'))` en el constructor: el latido de 30 s se responde **en el edge**, sin
    despertar al DO ni facturar. **El frontend no cambió** (el par casa la cadena exacta que ya
    enviaban `useMainSocket`/`useHandySocket`).
- **Sin cambios de despliegue:** misma clase, mismo binding, `migrations` intacto. Hibernar **no
  cierra** las conexiones.

### Reglas que impone la hibernación (leer antes de tocar el DO)

1. **Prohibido el estado de sesión en campos de instancia.** Al despertar, la instancia es **nueva**
   (campos vacíos, sin closures). Todo lo que describe a un socket va en su **attachment**
   (`WsAttachment`: `tenantId`, `deviceId`, `role`, `authed`, `pubkeyB64`, `challenge`) vía
   `ws.serializeAttachment()`. Hay que **re-serializar tras cada mutación** (p. ej. al autenticar).
2. **El censo de conexiones es `state.getWebSockets()`**, con etiqueta `deviceId` para buscar uno
   concreto. Ojo: `getWebSockets()` **puede devolver sockets ya cerrados**, por eso `liveSocketsFor()`
   filtra por `readyState` y `isMainConnected(except)` permite excluir el socket que se está cerrando
   (sin ese `except`, el freeze `main_offline` no se dispararía nunca).
3. **Nada que mantenga el DO vivo.** Ni `setInterval`/`setTimeout` en el DO, ni un `alarm()`
   periódico: despertarían el objeto y anularían el ahorro. Por eso `last_seen` **no** se refresca con
   un temporizador.
4. **Las cachés en memoria son best-effort y se pierden al hibernar.** Afecta a
   `lastSeenPushedAtMs` (throttle de `last_seen`), `lastPurgeAtMs` (la purga podrá correr algo más a
   menudo) y la resolución cacheada de la BD del tenant (`TENANT_DB_CACHE_TTL_MS`: se re-resuelve tras
   cada despertar, una query extra). Ninguna es crítica; si alguna molestara, se movería a
   `state.storage`.
5. **Si cambia el formato del latido en el frontend**, hay que cambiar el par del auto-response en el
   constructor: casa **cadenas exactas**. Si dejan de coincidir, todo seguirá funcionando pero el DO
   despertará en cada ping y se pierde el ahorro (fallo silencioso de coste, no de función).
6. **Los cierres iniciados por el servidor no son de fiar para la contabilidad.** La documentación de
   Cloudflare no garantiza que llamar a `ws.close()` desde el DO dispare `webSocketClose`. Por eso la
   presencia/freeze vive en `sessionGone(ws, att)`, que se invoca desde `webSocketClose` **y**
   explícitamente en el revoke. Es idempotente y se auto-inhibe si queda otro socket vivo del mismo
   dispositivo. **Cualquier cierre nuevo iniciado por el DO debe llamar a `sessionGone` igual.**

> **Sentry:** `instrumentDurableObjectWithSentry` (v10) envuelve explícitamente `webSocketMessage`,
> `webSocketClose` y `webSocketError`, así que la instrumentación cubre el ciclo de vida del WebSocket.

---

**Invariante a preservar en cualquier cambio:** escritor único en la Main, idempotencia por `Op_Id`
(nube `Applied_Operations` + Main `_Sync_Applied_Ops`), IDs y tiempos **deterministas** resueltos a
literal antes de replicar, y el rol `tpv` como único autorizado a ejecutar SQL por WebSocket.
