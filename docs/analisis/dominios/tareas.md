# D8 — Tareas

> **Ámbito.** Tareas internas del personal: alta/edición, asignación a trabajadores, "mis tareas",
> marcar finalizada.
> **Capas:** `crates/tpv-infra-sqlite/src/tareas.rs`, `use_cases/tareas.rs`,
> `crates/tpv-domain/src/tareas.rs`, `apps/cloud-worker-licensing/src/domains/tareas/*`,
> FE `apps/tpv-main/src/features/tareas/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos o decididos y retirados: TAR-01, TAR-02, TAR-03.

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

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| TAR-01 | El INSERT escribe `Fecha_Creacion` explícita con `datetime('now','localtime')` → mismo valor en Main y nube (ya no depende del DEFAULT). |
| TAR-02 | **Semántica decidida**, no bug: `INSERT OR IGNORE` es intencional. Si quien ya finalizó sigue en el conjunto de asignados, su fila `FINALIZADA` se conserva; solo quien se quita del conjunto se borra, y si se le vuelve a añadir entra como fila nueva (`PENDIENTE`). Documentado en el código. |
| TAR-03 | Se valida que todos los trabajadores existan antes de asignar, sin delegar en la FK (en la nube podría no aplicarse — DB-03 — y dejar asignaciones huérfanas). |
