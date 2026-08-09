# D8 — Tareas

> **Ámbito.** Tareas internas del personal: alta/edición, asignación a trabajadores, "mis tareas",
> marcar finalizada.
> **Capas:** `crates/tpv-infra-sqlite/src/tareas.rs`, `use_cases/tareas.rs`,
> `crates/tpv-domain/src/tareas.rs`, `apps/cloud-worker-licensing/src/domains/tareas/*`,
> FE `apps/tpv-main/src/features/tareas/*` (React Query).

## Valoración general

**Uno de los dominios más limpios.** Transacciones bien delimitadas (BEGIN/COMMIT/ROLLBACK), IDs
UUIDv7 explícitos, y patrón correcto de fechas en `get_mis_tareas`
(`date(a.Finalizada_At) = date('now','localtime')`, sin doble conversión de zona horaria). Además es
el dominio que estrena la emisión de notificaciones (asignar / modificar / reasignar).

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TAR-04 | 🔵 | Doble implementación Rust/worker (parity) | `tareas.rs` ↔ `tareas.commands.ts` |
| TAR-05 | 🔵 | Borrado es **hard delete**; sin reapertura de tarea finalizada ni papelera | `tareas.rs` (`delete_tarea`) |

### TAR-04 🔵 Doble implementación
Instancia de **ARCH-01**; lo cubre el harness de tests de contrato → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

### TAR-05 🔵 Hard delete
`delete_tarea` borra la fila (y sus asignaciones por CASCADE). No hay papelera ni forma de reabrir
una tarea finalizada. Es una decisión de producto pendiente, no un bug: hoy nadie ha pedido
recuperar una tarea borrada.
