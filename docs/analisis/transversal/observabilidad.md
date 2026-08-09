# T4 — Observabilidad (Sentry + Axiom)

> **Ámbito.** Telemetría de errores/crashes (Sentry) y de negocio/salud del sync (Axiom), en
> escritorio, worker y Durable Object. Cola durable (spool) offline en el escritorio, reenvío al
> worker autenticado por device-proof, y eventos de sync fire-and-forget.
> **Capas:** `crates/tpv-telemetry/*` (config, context, event, forward, spool, sentry, worker),
> `apps/tpv-main/src/shared/observability/*`, `apps/cloud-worker-licensing/src/observability/*`,
> `durableObjects/tenantHub.ts:emitSyncEvent`. Ver también [docs/observability.md](../../observability.md).

## Valoración general

**Sin hallazgos abiertos en este módulo.**

**Diseño cuidado:** `send_default_pii: false` en Sentry; Axiom **fire-and-forget** que jamás afecta
al camino de escritura del sync; **spool durable** para no perder eventos offline; reenvío al worker
**autenticado** por el mismo device-proof ed25519; DSN público (cliente) y token Axiom (worker env)
bien segregados.

**OBS-03 🔵 — aciertos a mantener, no un pendiente:** PII desactivada, fire-and-forget, spool y
autenticación del reenvío. Conviene no perderlos al tocar `tpv-telemetry`.

**Logpush:** activado en el worker (`"logpush": true` en `wrangler.json`). El destino del job
(Axiom/R2/…) se configura en el panel de Cloudflare, fuera del repo.
