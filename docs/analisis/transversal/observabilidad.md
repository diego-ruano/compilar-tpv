# T4 — Observabilidad (Sentry + Axiom)

> **Ámbito.** Telemetría de errores/crashes (Sentry) y de negocio/salud del sync (Axiom), en
> escritorio, worker y Durable Object. Cola durable (spool) offline en el escritorio, reenvío al
> worker autenticado por device-proof, y eventos de sync fire-and-forget.
> **Capas:** `crates/tpv-telemetry/*` (config, context, event, forward, spool, sentry, worker),
> `apps/tpv-main/src/shared/observability/*`, `apps/cloud-worker-licensing/src/observability/*`,
> `durableObjects/tenantHub.ts:emitSyncEvent`. Ver también `docs/observability.md`.

## Valoración general

**Diseño cuidado:** `send_default_pii: false` en Sentry; Axiom **fire-and-forget** que "jamás afecta
al camino de escritura del sync"; **spool durable** para no perder eventos offline; reenvío al worker
**autenticado** por el mismo device-proof ed25519; DSN público (cliente) y token Axiom (worker env)
bien segregados. El hueco principal es el **scrubbing a nivel de mensaje/campo**.

## Resumen de hallazgos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| OBS-01 | 🟡 → ✅ | **Sin scrubbing de mensaje/campo**: `SpoolEvent.message`/`fields` y errores de Sentry se envían verbatim a terceros | `sentry.rs`, `event.rs`, `scrub.rs` |
| OBS-02 | 🟡 → ✅ | Errores del backend **embeben SQL** (p. ej. `SQL={stmt}`) → riesgo de filtrar valores si se loguean | `sync.rs` |
| OBS-03 | 🔵 | Buenas prácticas (PII-off, fire-and-forget, spool, auth) — **mantener** | `tpv-telemetry`, `observability/*` |
| OBS-04 | 🔵 → ✅ | **Muestreo/retención** (un evento de sync por `apply`): sólo se emiten fallos; retención documentada | `tenantHub.ts:emitSyncEvent` |
| OBS-05 | 🔵 → ✅ | Esquema de evento mantenido **a mano** en Rust y TS → ahora generado por ts-rs (fuente única) | `event.rs` → `telemetry.ts` |

---

## Detalle de hallazgos

### OBS-01 🟡 Falta scrubbing a nivel de contenido — CONFIRMADO
- **Ubicación:** el `before_send` de Sentry (`sentry.rs:38-42`) solo anula `event.user` y
  `event.server_name`. Los **mensajes de excepción/breadcrumbs** no se filtran. La telemetría propia
  (`SpoolEvent`) reenvía `message` + `fields` (`event.rs:20-23`) **verbatim** al worker y a Axiom.
- **Fallo:** cualquier `tracing::error!`/`warn!` (o panic) que incluya en su mensaje/campos datos de
  cliente (nombre, email, teléfono), contenido de comanda, o **secretos** (p. ej. un error del envío
  SMTP que arrastre la contraseña) se envía a un **tercero** (Sentry/Axiom) sin depurar. `send_default_pii`
  cubre el contexto de request/usuario, no las cadenas que compone el desarrollador.
- **Impacto:** posible fuga de PII/secretos a servicios externos; implicaciones GDPR.
- **Arreglo:** una función de **scrubbing** en `before_send` (Sentry) y en el pipeline del spool que:
  (a) redacte patrones sensibles (emails, IBAN/DNI, tokens, `Password`), (b) trunque/omita args de SQL,
  (c) tenga allowlist de campos. Tests que verifiquen que un evento con datos sensibles sale redactado.

### OBS-02 🟡 Errores que embeben SQL
- **Ubicación:** p. ej. `sync.rs` compone errores con `SQL={stmt}` (aunque colapsa espacios y **no**
  incluye los args), y otros errores propagan `libsql` (`UNIQUE constraint failed: …`).
- **Fallo:** si esos errores se elevan por `tracing`, el SQL (y en algunos casos valores) llega a la
  telemetría. Riesgo moderado (los args suelen ir aparte), pero conviene auditarlo.
- **Arreglo:** normalizar los mensajes de error para no incluir valores; centralizar el formateo de
  errores de repositorio. Cruce con [arquitectura-general.md](arquitectura-general.md) (manejo de
  errores).

### OBS-03 🔵 Buenas prácticas a mantener
- PII desactivada por defecto, Axiom no bloqueante, spool durable, auth por device-proof, segregación
  de credenciales. **No tocar**, solo reforzar con OBS-01.

### OBS-04 🔵 Muestreo y volumen
- `emitSyncEvent` emite un evento por cada `apply` de sync. En picos de escritura multi-dispositivo,
  el volumen (y coste de Axiom) puede dispararse.
- **Arreglo:** revisar `sample_rate`/agregación; considerar muestrear los eventos de éxito y conservar
  al 100% los de error.

### OBS-05 🔵 Esquema de evento duplicado
- El esquema de `SpoolEvent` se mantiene "en paralelo" entre Rust y el paquete TS `@tpv/observability`
  a mano (comentado en `event.rs`). Riesgo de deriva (como el resto de dobles implementaciones del repo).
- **Arreglo:** generar el tipo desde una única fuente (ts-rs, como el resto de contracts) o test de contrato.

---

## Workflow de corrección (T4)

1. **OBS-01 (scrubbing).** ✅ **Resuelto.** Scrubber común (`crates/tpv-telemetry/src/scrub.rs` +
   espejo TS `apps/tpv-main/src/shared/observability/scrub.ts`) que redacta emails, IBAN, DNI/NIE,
   teléfonos, JWT y secretos `clave=valor`. Se aplica en el `before_send` de Sentry (Rust + Webview)
   y en el worker de subida del spool (fuera del hilo caliente, antes de persistir/subir). Tests de
   redacción en `scrub.rs`. El fichero local (fuente de verdad) no se redacta.
2. **OBS-02 (errores con SQL).** ✅ **Resuelto.** `sync.rs` ya no embebe el SQL en el error
   propagado; la sentencia queda sólo en un `tracing::debug!` local (que la telemetría no reenvía a
   la nube). Barrido: era el único punto que concatenaba SQL en el mensaje de error.
3. **OBS-04 (volumen).** ✅ **Resuelto.** El evento de `apply` con éxito ya **no** se emite a Axiom;
   sólo `apply_error` (100%, payload recortado sin comando/args). Retención documentada en
   `docs/observability.md §3.2` (sugerido: sync 30 días, device-logs 30–90). Nota: `command` en el
   evento era sólo el **nombre** del comando (no el objeto con SQL/args), así que el ahorro real es
   el volumen (1 evento por escritura), no el tamaño.
4. **OBS-05 (esquema).** ✅ **Resuelto.** `SpoolEvent` deriva `ts_rs::TS` y genera
   `packages/contracts/src/generated/telemetry.ts` (fuente única). El zod del worker
   (`telemetry.routes.ts`) lleva un drift-guard de tipos contra `SpoolEvent`: un cambio de campo en
   Rust rompe la compilación del worker.

**Invariante clave:** ningún dato de cliente ni secreto debe salir a un servicio externo **sin
depurar**; la observabilidad **nunca** debe afectar al camino de escritura del sync (ya se cumple).
