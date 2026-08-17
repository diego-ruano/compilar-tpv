# D9 — Trabajadores (fichajes · turnos · horarios)

> **Ámbito.** Personal: ficha de trabajador (con PII), roles, **fichajes** (control horario, turno
> partido), **turnos** y **asignaciones** semanales, horario predeterminado.
> **Capas:** `crates/tpv-infra-sqlite/src/trabajadores.rs` (CRUD, turnos, asignaciones),
> `crates/tpv-infra-sqlite/src/login.rs` (**fichajes** `exec_punch`), `stats.rs` (lectura de horas),
> `use_cases/{trabajadores,login}.rs`, `apps/cloud-worker-licensing/src/domains/{trabajadores,login}/*`,
> FE `apps/tpv-main/src/features/trabajadores/*`.

## Nota de cohesión

El **control horario** (fichajes) vive en `login.rs` (fichar al identificarse), no en `trabajadores.rs`.
La lógica de jornada laboral está **repartida** entre `login.rs`, `stats.rs` y `trabajadores.rs`.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TRAB-06 | 🔵 | Doble implementación Rust/worker de la lógica de **fichaje** (crítica) | `login.rs` ↔ `login.commands.ts` |

### TRAB-06 🔵 Doble implementación del fichaje
La lógica de fichaje está codificada en Rust (Main) y en TS (worker, para Handy). Es la instancia
más delicada de **ARCH-01** porque de ella salen las horas trabajadas. Lo cubre el harness de tests
de contrato → ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).
