# T4 — Observabilidad (Sentry + Axiom)

> **Ámbito.** Telemetría de errores/crashes (Sentry) y de negocio/salud del sync (Axiom), en
> escritorio, worker y Durable Object. Cola durable (spool) offline en el escritorio, reenvío al
> worker autenticado por device-proof, y eventos de sync fire-and-forget.
> **Capas:** `crates/tpv-telemetry/*` (config, context, event, forward, spool, sentry, worker),
> `apps/tpv-main/src/shared/observability/*`, `apps/cloud-worker-licensing/src/observability/*`,
> `durableObjects/tenantHub.ts:emitSyncEvent`. Ver también [docs/observability.md](../../observability.md).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: OBS-01, OBS-02, OBS-04, OBS-05. **No queda
> ningún hallazgo abierto en este módulo.**

## Valoración general

**Diseño cuidado:** `send_default_pii: false` en Sentry; Axiom **fire-and-forget** que jamás afecta
al camino de escritura del sync; **spool durable** para no perder eventos offline; reenvío al worker
**autenticado** por el mismo device-proof ed25519; DSN público (cliente) y token Axiom (worker env)
bien segregados.

**OBS-03 🔵 — aciertos a mantener, no un pendiente:** PII desactivada, fire-and-forget, spool y
autenticación del reenvío. Conviene no perderlos al tocar `tpv-telemetry`.

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| OBS-01 | Scrubbing de contenido (`scrub.rs`) aplicado en el `before_send` de Sentry y en el pipeline del spool: los mensajes y campos ya no viajan verbatim a terceros. |
| OBS-02 | Los errores del backend ya no embeben el SQL crudo con sus valores. |
| OBS-04 | Muestreo acotado: del sync solo se emiten **fallos** (no un evento por `apply`), con la retención documentada. |
| OBS-05 | El esquema de evento se genera con ts-rs desde una **fuente única** (`event.rs` → `telemetry.ts`), con drift-guard en `telemetry.routes.ts`. Es el patrón que ARCH-03 quiere replicar por dominio. |

> **Pendiente de infraestructura, no de código:** Logpush (exportar los logs de petición del Worker a
> un destino con retención) — anotado en
> [BACKLOG.md §Dependiente del plan de pago](../BACKLOG.md#dependiente-del-plan-de-pago-de-cloudflare-workers).
