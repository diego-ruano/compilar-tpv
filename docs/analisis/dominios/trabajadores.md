# D9 — Trabajadores (fichajes · turnos · horarios)

> **Ámbito.** Personal: ficha de trabajador (con PII), roles, **fichajes** (control horario, turno
> partido), **turnos** y **asignaciones** semanales, horario predeterminado.
> **Capas:** `crates/tpv-infra-sqlite/src/trabajadores.rs` (CRUD, turnos, asignaciones),
> `crates/tpv-infra-sqlite/src/login.rs` (**fichajes** `exec_punch`), `stats.rs` (lectura de horas),
> `use_cases/{trabajadores,login}.rs`, `apps/cloud-worker-licensing/src/domains/{trabajadores,login}/*`,
> FE `apps/tpv-main/src/features/trabajadores/*`.
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: TRAB-01, TRAB-02, TRAB-04, TRAB-05.

## Nota de cohesión

El **control horario** (fichajes) vive en `login.rs` (fichar al identificarse), no en `trabajadores.rs`.
La lógica de jornada laboral está **repartida** entre `login.rs`, `stats.rs` y `trabajadores.rs`.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TRAB-03 | 🟡 | **PII sensible** (DNI, IBAN, Nº Seg. Social) en claro y **replicada a la nube** (Turso) | esquema `Trabajadores`, `create_trabajador` |
| TRAB-06 | 🔵 | Doble implementación Rust/worker de la lógica de **fichaje** (crítica) | `login.rs` ↔ `login.commands.ts` |

### TRAB-03 🟡 PII en claro y replicada
La ficha del trabajador guarda DNI, IBAN y nº de Seguridad Social en texto plano, y esas columnas
viajan por el outbox a la BD del tenant en Turso. **Arreglo:** cifrado a nivel de campo y/o
minimizar la replicación (preguntarse si la nube/Handy necesitan esos datos). Es una tarea de
arquitectura/GDPR transversal, aplazada a un pase dedicado → ver [BACKLOG.md](../BACKLOG.md).

### TRAB-06 🔵 Doble implementación del fichaje
La lógica de fichaje está codificada en Rust (Main) y en TS (worker, para Handy). Es la instancia
más delicada de **ARCH-01** porque de ella salen las horas trabajadas. Lo cubre el harness de tests
de contrato → ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| TRAB-01 | Cierre automático de jornadas colgadas: los fichajes `ABIERTO` de días anteriores se cierran marcándolos con `Cerrado_Automatico`/`Cierre_Motivo`, para que no corrompan las horas que lee `stats`. |
| TRAB-02 | El `punch` **ignora deliberadamente** la fecha/hora que envía el cliente y usa siempre el reloj de confianza del backend: se acabó el backdating/forward-dating desde un dispositivo. |
| TRAB-04 | Guard de doble asignación (mismo trabajador + fecha + turno). El lock de escritura serializa el check-then-insert. |
| TRAB-05 | `copy_semana` y `set_predeterminado_desde_semana` son transaccionales (BEGIN/COMMIT) y generan un UUIDv7 propio por copia, para que las filas sincronicen igual en Main y nube. |
