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

## 3. Activación — secretos y variables

Mientras falten estos valores, todo es **no-op** (sin errores).

### 3.1 Sentry

| Pieza | Dónde | Cómo |
|---|---|---|
| DSN escritorio | build de la app | variable de entorno **`TPV_SENTRY_DSN`** al compilar (`option_env!`). DSN público, embebido. |
| DSN worker | secreto del Worker | `wrangler secret put SENTRY_DSN` (en `apps/cloud-worker-licensing`) |
| Entorno worker | `wrangler.json` `vars` | `ENVIRONMENT` = `prod`/`staging` (por defecto `prod`) |

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

## 4. Dónde mirar el código

| Capa | Archivo |
|---|---|
| Crate de telemetría (Rust) | `crates/tpv-telemetry/` (subscriber, fichero rotado, cola durable, worker de subida, cliente Sentry) |
| Cableado escritorio | `apps/tpv-main/src-tauri/src/main.rs` (`init`, plugin Sentry, firmante, contexto) |
| Sentry Webview | `apps/tpv-main/src/shared/observability/sentry.ts` (+ error boundary y listener global) |
| Sentry Worker | `apps/cloud-worker-licensing/src/observability/sentry.ts` + `src/index.ts` |
| Axiom (helper) | `apps/cloud-worker-licensing/src/observability/axiom.ts` |
| Endpoint de ingesta | `apps/cloud-worker-licensing/src/domains/telemetry/telemetry.routes.ts` |
| Eventos de sync | `apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts` (`emitSyncEvent`) |

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
- **Latencia de apply**: percentil de `latency_ms` del evento `apply` por encima de umbral.
- **Errores de dispositivo**: tasa de `level == "ERROR"` en `tpv-device-logs` por `tenant_id`.
- **Backlog de subida**: si un `device_id` deja de mandar lotes durante > X (puede estar offline o
  con la cola atascada).

## 7. Eventos del sistema de sync (dataset `AXIOM_DATASET_SYNC`)

| `event` | Cuándo | Campos útiles |
|---|---|---|
| `apply` | escritura aplicada con éxito en el DO | `command`, `op_id`, `seq`, `latency_ms`, `device_id` |
| `main_online` | una Main (tpv) se autentica | `device_id`, `connected_devices` |
| `main_offline` | se va la última Main → freeze | `device_id`, `connected_devices` |

## 8. Notas y próximos pasos

- **Logpush → Axiom** (logs de petición HTTP del Worker, sin código) requiere plan de pago de
  Cloudflare. Pendiente hasta tenerlo; de momento la telemetría va por el SDK/fetch directo.
- **Rate-limit por dispositivo** en `/v1/telemetry`: hoy el guardarraíl son los topes de tamaño y
  la autenticación. Un límite por `device_id` (KV/DO) es el siguiente endurecimiento si hiciera
  falta.
- **PII en Rust**: usar `#[tracing::instrument(skip_all, fields(...))]` en los casos de uso para no
  volcar DTOs con datos de cliente en los spans (registrar sólo IDs/contadores seguros).
