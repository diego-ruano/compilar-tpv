# Observabilidad

| Herramienta | Para qué |
|---|---|
| **Sentry** | Errores y crashes: panics de Rust, minidumps nativos, errores de la Webview y excepciones del worker y del Durable Object |
| **Axiom** | Telemetría estructurada: logs de los dispositivos reenviados por el worker y eventos de salud de la sincronización |
| **Better Stack** | Vigilancia desde fuera: la sonda de `/health` y los latidos del cron |
| Fichero local | `<AppData>/logs/tpv.log`, 7 días: la fuente de verdad para soporte |

Todo es **no-op** mientras falten los secretos: el código se puede desplegar sin configurar nada.

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
- **La cola a Axiom es durable**: un lote sólo se borra del equipo tras un 2xx del worker; si Axiom
  falla, el worker contesta 5xx y el equipo reintenta. Va en su propio hilo, fuera del camino del POS.
- **Escritorio**: el DSN entra al compilar con `TPV_SENTRY_DSN` (`option_env!`, con
  `rerun-if-env-changed` en `build.rs`). Sólo lo pone el workflow de release: en `pnpm tauri dev` no hay
  Sentry, y como la Webview manda sus eventos por el cliente de Rust, tampoco del frontend. El entorno lo
  decide el identificador de la app (`lib.rs::entorno_de_sentry`: `e2e`, `dev` o `prod`), así que la
  tanda E2E no se mezcla con los clientes. Los minidumps se inicializan sólo con DSN y sólo en
  escritorio.
- **Worker**: `SENTRY_DSN` es un secreto; el entorno es `ENVIRONMENT`, que no está en `wrangler.json`,
  así que todo entra como `prod`. `nodejs_compat` está activado (lo exige `@sentry/cloudflare`).
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
y el worker (`apps/cloud-worker-licensing/src/observability/scrub.ts`, en el `beforeSend` de Sentry). Lo
que las mantiene iguales es `crates/tpv-telemetry/src/scrub_casos.json`, la tabla que leen los tests de
las tres: **una regla nueva lleva su caso ahí**, o las otras copias no se enteran. Usa fronteras y dígitos
ASCII (`(?-u:\b)`, `[0-9]`) para que Rust y JavaScript decidan igual.

No reconoce nombres ni direcciones: un mensaje de error no se compone con ellos. No toca el fichero local.

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

## Configuración

| Variable | Dónde | Qué |
|---|---|---|
| `TPV_SENTRY_DSN` | Entorno del build de escritorio (release) | DSN de `tpv-desktop` |
| `SENTRY_DSN` | Secreto del worker | DSN de `tpv-api` |
| `ENVIRONMENT` | `vars` del worker (hoy ausente) | Entorno en Sentry |
| `AXIOM_TOKEN` | Secreto del worker | Ingesta |
| `AXIOM_DATASET` | `wrangler.json` (`tpv-device-logs`) | Logs de dispositivo |
| `AXIOM_DATASET_SYNC` | `wrangler.json` (`tpv-sync`) | Eventos del worker y del DO |
| `AXIOM_DOMAIN` | `wrangler.json` (`eu-central-1.aws.edge.axiom.co`) | Región de Axiom |
| `BETTERSTACK_HEARTBEAT_URL` | Secreto del worker | Latido del cron (suena siempre al acabar) |
| `BETTERSTACK_HEARTBEAT_COPIAS_URL` | Secreto del worker | Latido de la copia de la base central (sólo si se subió) |

Sentry: dos proyectos (`tpv-desktop` y `tpv-api`), región UE, sin Session Replay. Axiom: tres datasets
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
