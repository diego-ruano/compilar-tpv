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

**Borrado reversible (TAR-05, hecho).** Borrar una tarea la manda a la **papelera**
(`Tareas.Estado='ELIMINADA'`): sale de las listas y del escáner de avisos —que ya filtraban por
`COALESCE(Estado,'ABIERTA')='ABIERTA'`— pero **conserva sus asignaciones**, que es lo que permite
restaurarla tal y como estaba. Vaciar la papelera es el único camino que borra de verdad. Los tres
casos de contrato (`tareas__eliminar`, `tareas__restaurar`, `tareas__vaciar_papelera`) fijan esa
semántica en los dos lados.

## Hallazgos abiertos

Ninguno.


