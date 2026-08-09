# D6 — Reservas

> **Ámbito.** Reservas de mesa (calendario mensual, alta/edición, estado, borrado) y su vínculo con
> clientes y mesas. Incluye el `upsert_cliente` que crea/actualiza el cliente al reservar.
> **Capas:** `crates/tpv-infra-sqlite/src/reservas.rs`, `use_cases/reservas.rs`,
> `crates/tpv-domain/src/reservas.rs`, `apps/cloud-worker-licensing/src/domains/reservas/*`,
> FE `apps/tpv-main/src/features/reservas/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: RES-01, RES-02, RES-03, RES-04, RES-06.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| RES-05 | 🔵 | **Tercer punto** de gestión de clientes (además de D5 y mesas) → lógica dispersa y dedup heurístico | `reservas.rs` (`upsert_cliente`) |
| RES-07 | 🔵 | Doble implementación Rust/worker (parity) | `reservas.rs` ↔ `reservas.commands.ts` |

### RES-05 🔵 Tercer punto de gestión de clientes
Además del dominio de clientes (D5) y del cobro en mesa, reservar también crea/completa fichas de
cliente. La deduplicación es heurística (busca por email y, si no, por teléfono). Ya no corrompe
datos —RES-01 hizo que solo rellene campos vacíos— pero la lógica de identidad del cliente sigue
viviendo en tres sitios. **Arreglo:** un único punto de resolución de cliente que consuman los tres
flujos.

### RES-07 🔵 Doble implementación
Instancia de **ARCH-01**; lo cubre el harness de tests de contrato → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| RES-01 | `upsert_cliente` **conserva** los datos del cliente existente: solo rellena los campos vacíos (p. ej. añadir un email que no tenía). Reservar a nombre de alguien que comparte teléfono ya no renombra la ficha. Paridad en el worker (`fillEmpty`). |
| RES-02 | Comprobación autoritativa de doble reserva del mismo hueco (mesa + día + hora), contando solo las reservas que ocupan mesa y excluyendo la propia al editar. Cubre carreras y escrituras de otros dispositivos. |
| RES-03 | El INSERT escribe `Created_At` explícito con `datetime('now','localtime')`, que el capturador del outbox convierte a literal → mismo valor en Main y nube. |
| RES-04 | `mes` usa **LEFT JOIN**: una reserva cuyo cliente/mesa/zona ya no exista sigue apareciendo en el calendario en vez de desaparecer. |
| RES-06 | Eliminado el fallback muerto de `meta`. |
