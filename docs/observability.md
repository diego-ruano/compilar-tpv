# Observabilidad (Sentry + Axiom)

Guía operativa del sistema de logging/telemetría del TPV. El **código** ya está implementado y es
seguro de desplegar **sin configurar nada** (todo queda en no-op hasta que se rellenan los
secretos). Este documento explica qué hace, qué secretos poner para activarlo y qué alertas/paneles
montar.

## 1. División de responsabilidades

- **Sentry = errores/crashes.** Panics de Rust, crashes nativos (minidump), errores de la Webview
  (React) y excepciones del Worker/Durable Object.
- **Axiom = telemetría estructurada.** Logs de los dispositivos (reenviados por la nube) y eventos
  de salud del sistema de sincronización (TenantHub).

## 2. Flujo de datos

```
Escritorio (Rust + Webview)
  ├─ Sentry (plugin tauri-plugin-sentry) ───────────────► Sentry  (DSN público embebido)
  ├─ logs `tracing` ─► fichero local 7 días  (<AppData>/logs/tpv.log)   [fuente de verdad]
  └─ logs `tracing` ─► cola durable (<AppData>/telemetry-spool/)
                         └─ worker bg ─POST /v1/telemetry (firma device-proof)─► CF Worker ─► Axiom

CF Worker (Hono) ── @sentry/cloudflare ───────────────────► Sentry
TenantHub (DO)   ── emitSyncEvent() ──────────────────────► Axiom  (dataset de sync)
```

Reglas clave:
- El **token de Axiom NUNCA está en el dispositivo**: vive sólo como secreto del Worker. Los
  dispositivos suben a `/v1/telemetry` (autenticado device-proof) y el Worker retransmite.
- El **fichero local de 7 días es la fuente de verdad** para soporte; Sentry/Axiom son envíos
  resilientes. La cola a Axiom es **durable** ("no perder ninguno"): el lote sólo se borra del
  dispositivo tras un 2xx del Worker; si Axiom falla, el Worker responde 5xx y el dispositivo
  reintenta.
- El endpoint **fija `tenant_id`/`device_id` desde el JWT** (no del cliente): los datos en Axiom
  siempre quedan correlacionados al dispositivo/restaurante autenticado.
- **Scrubbing de contenido (OBS-01):** antes de salir a un tercero, el `message` y los `fields` de
  cada evento (y los mensajes/excepciones de Sentry) pasan por un redactor de patrones sensibles
  (emails, IBAN, DNI/NIE, teléfonos, JWT, secretos `clave=valor`). `sendDefaultPii=false` sólo cubre
  el contexto automático de Sentry, no las cadenas que compone el código. El **fichero local** de 7
  días NO se redacta (es el propio equipo del usuario y la fuente de verdad para soporte).

## 3. Activación — secretos y variables

Mientras falten estos valores, todo es **no-op** (sin errores).

### 3.1 Sentry

| Pieza | Dónde | Cómo |
|---|---|---|
| DSN escritorio | build de la app | variable de entorno **`TPV_SENTRY_DSN`** al compilar (`option_env!`). DSN público, embebido. |
| DSN worker | secreto del Worker | `wrangler secret put SENTRY_DSN` (en `apps/cloud-worker-licensing`) |
| Entorno worker | `wrangler.json` `vars` | `ENVIRONMENT`. **Hoy NO está puesta**, así que todo entra en Sentry como `prod` (`env.ENVIRONMENT ?? "prod"` en `observability/sentry.ts`). Es correcto mientras solo haya producción; separar entornos de verdad exige montar staging → ver [BACKLOG §Entorno de staging](analisis/BACKLOG.md#entorno-de-staging-infra-01--pendiente-completo). |
| Entorno escritorio | automático | No hay variable: `Environment::detect()` (`tpv-telemetry/src/config.rs`) etiqueta `dev` en builds de debug y `prod` en release. Solo existen esas dos variantes; un canal `staging` exigiría añadirla. |

- Crea **2 proyectos** en Sentry: `tpv-desktop` (Rust+JS, comparten cliente vía el plugin) y
  `tpv-api` (Worker).
- Elige **región UE** (GDPR). `Session Replay` queda desactivado a propósito (PII de un TPV).
- `nodejs_compat` ya está en `wrangler.json` (lo exige `@sentry/cloudflare`).

### 3.2 Axiom

| Variable (secreto/var del Worker) | Propósito |
|---|---|
| `AXIOM_TOKEN` | Token de ingesta (secreto). `wrangler secret put AXIOM_TOKEN` |
| `AXIOM_DATASET` | Dataset de logs de dispositivo (por defecto `tpv-device-logs`) |
| `AXIOM_DATASET_SYNC` | Dataset de eventos de salud del sync (TenantHub) |

- Crea los datasets en **región UE**.
- El token es **ingest-only** y vive sólo en el Worker.

#### Retención (configúrala en Axiom, no hay knob en código)

La retención es una propiedad **del dataset** en el panel de Axiom (no se fija por `wrangler`/código).
Como estos datos son **operativos** (no de negocio), conviene una retención corta para acotar coste:

| Dataset | Retención sugerida | Motivo |
|---|---|---|
| `AXIOM_DATASET_SYNC` | **30 días** | Salud del sync: sólo se emiten **fallos** (`apply_error`) y ciclo de vida (`main_*`); volumen bajo, valor a corto plazo. |
| `AXIOM_DATASET` (device-logs) | **30–90 días** | Logs de dispositivo `INFO`/`WARN`/`ERROR`; ventana suficiente para soporte. La **fuente de verdad** larga sigue siendo el fichero local de 7 días + tickets. |

> Nota: el plan gratuito de Axiom tiene un tope de retención; fija el valor en el dataset al crearlo
> y revísalo si cambias de plan. El coste crece con **volumen ingerido × retención**, así que la
> combinación "sólo fallos" (§7) + retención corta mantiene el gasto plano aunque suba la actividad.

## 4. Dónde mirar el código

| Capa | Archivo |
|---|---|
| Crate de telemetría (Rust) | `crates/tpv-telemetry/` (subscriber, fichero rotado, cola durable, worker de subida, cliente Sentry) |
| Cableado escritorio | `apps/tpv-main/src-tauri/src/lib.rs` (`init`, plugin Sentry, firmante, contexto). **No en `main.rs`**: desde la compilación a Android, `main.rs` es solo el shim del binario de escritorio (`fn main() { tpv_lib::run() }`) y toda la app vive en `lib.rs`. |
| Sentry Webview | `apps/tpv-main/src/shared/observability/sentry.ts` (+ error boundary y listener global) |
| Sentry Worker | `apps/cloud-worker-licensing/src/observability/sentry.ts` + `src/index.ts` |
| Axiom (helper) | `apps/cloud-worker-licensing/src/observability/axiom.ts` |
| Endpoint de ingesta | `apps/cloud-worker-licensing/src/domains/telemetry/telemetry.routes.ts` |
| Eventos de sync | `apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts` (`emitSyncEvent`) |
| Scrubbing de contenido (OBS-01) | `crates/tpv-telemetry/src/scrub.rs` (Rust) · `apps/tpv-main/src/shared/observability/scrub.ts` (Webview) |
| Esquema de evento (fuente única) | `crates/tpv-telemetry/src/event.rs` → `packages/contracts/src/generated/telemetry.ts` (ts-rs) |

## 5. Tags de correlación

Cada evento/error lleva: `tenant_id`, `device_id`, `device_mode` (tpv/handy), `app_version`,
`environment`. En Sentry se fijan como tags globales; en Axiom como campos. Permiten filtrar por
restaurante/dispositivo/versión.

## 6. Alertas y paneles recomendados (configurar en la UI)

### Sentry
- **Alerta de regresión**: nuevo *issue* o pico de errores en `tpv-desktop` / `tpv-api`.
- **Alerta de crashes**: subida de *crash-free rate* por debajo de un umbral.
- Activar **Spike Protection** y filtros de entrada (un DSN público puede ser sondeado).

### Axiom (monitors)
- **Main caída**: contar eventos `event == "main_offline"` sin `main_online` posterior en N minutos
  por `tenant_id` → alerta (las Handy de ese restaurante están congeladas).
- **Errores de apply**: tasa/volumen del evento `apply_error` por `tenant_id` (fallos al aplicar en
  el DO). Los apply con éxito **no se emiten** a Axiom (OBS-04): sólo interesan los fallos.
- **Errores de dispositivo**: tasa de `level == "ERROR"` en `tpv-device-logs` por `tenant_id`.
- **Backlog de subida**: si un `device_id` deja de mandar lotes durante > X (puede estar offline o
  con la cola atascada).

## 7. Eventos del sistema de sync (dataset `AXIOM_DATASET_SYNC`)

Sólo se emiten **fallos** y **ciclo de vida** (OBS-04): los apply con éxito NO van a Axiom. Antes se
emitía un evento `apply` por **cada** escritura; a volumen alto eso disparaba coste y ruido sin
aportar (un apply correcto no se investiga). El payload de `apply_error` va **recortado**: nombre de
comando + ids + error truncado, **sin** el comando ni sus args (ni datos ni volumen de más).

| `event` | Cuándo | Campos útiles |
|---|---|---|
| `apply_error` | un apply **falla** en el DO (excepción/DB) | `command_name`, `op_id`, `device_id`, `error`, `latency_ms` |
| `main_online` | una Main (tpv) se autentica | `device_id`, `connected_devices` |
| `main_offline` | se va la última Main → freeze | `device_id`, `connected_devices` |

> **Nota (SYNC-16, hibernación del DO).** `connected_devices` se calcula recorriendo
> `state.getWebSockets()` y contando los sockets con sesión autenticada (antes era el tamaño de un
> `Set` en memoria); el valor es el mismo. Además, el latido de 30 s ya **no despierta** al DO (lo
> contesta el auto-response en el edge), así que `last_seen_at_ms` de un dispositivo se refresca al
> **conectar** y con su **actividad real** (`apply`/`event`), no cada 30 s: no interpretes un
> `last_seen` de hace minutos como que el dispositivo se ha ido — la presencia real la dan
> `main_online`/`main_offline`.

## 8. Notas y próximos pasos

- **Logpush → Axiom** (logs de petición HTTP del Worker, sin código): **activado** en el worker
  (`"logpush": true` en `wrangler.json`). El destino del job se configura en el panel de Cloudflare,
  fuera del repo. La telemetría de negocio sigue yendo por el SDK/fetch directo, que es otra cosa.
- **Rate-limit por dispositivo** en `/v1/telemetry`: hoy el guardarraíl son los topes de tamaño y
  la autenticación. Un límite por `device_id` (KV/DO) es el siguiente endurecimiento si hiciera
  falta.
- **PII en Rust**: usar `#[tracing::instrument(skip_all, fields(...))]` en los casos de uso para no
  volcar DTOs con datos de cliente en los spans (registrar sólo IDs/contadores seguros).
