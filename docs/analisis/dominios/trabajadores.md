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

### TRAB-06 🔵 Doble implementación (lo que queda)
**El fichaje ya está cubierto** (2026-08-22): los casos `login__punch_entrada` y `login__punch_salida`
contrastan el efecto en los dos lados, saltándose la verificación del PIN —que es autenticación, no
contrato de replicación— vía `exec_punch`. Esa cobertura nació de un bug real que entró justo por
ahí: el `INSERT` del worker se dejaba `ID_Fichaje`, y el caso nuevo **falla** con el código viejo.

Lo que sigue sin contrastar de este dominio son las escrituras de **ficha de trabajador**
(`crear`/`actualizar`: PII cifrada que el worker ni escribe, y `Password_Hash` con salt aleatorio) y
los **horarios** `copiar_semana` / `set_predeterminado` (generan los IDs nuevos de forma distinta en
cada lado). Están excluidos con motivo en
[`cobertura.json`](../../../tests/contract/cobertura.json); cubrirlos exige cablear el *field cipher*
y decidir qué columnas son comparables.
