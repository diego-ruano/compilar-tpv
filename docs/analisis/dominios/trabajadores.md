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

> **Verificado y descartado (2026-08-22), lo que era TRAB-06:** la **ficha de trabajador** no
> diverge — el worker **no escribe** DNI/IBAN/nº SS a propósito (la Handy no tiene la clave, TRAB-03)
> y esas columnas se rellenan desde la Main: es una asimetría diseñada, no un fallo de replicación.
> `set_predeterminado_desde_semana` **también está bien**: genera el UUID en JS y lo pasa como
> argumento, así que la fila que se replica lleva el ID ya resuelto. El **fichaje** quedó cubierto
> por el harness. De todo aquel bloque solo salió mal `copiar_semana`, y ya está corregido: el
> comando construye un INSERT por fila con el UUID resuelto **antes** de escribir, como hacía Rust.
> Con eso `horarios.copiar_semana` sale de las exclusiones y tiene su caso de contrato.
>
> **La lección, que vive en el harness:** el snapshot compara el efecto, y un `randomblob()` dentro
> de la sentencia deja un efecto **válido en cada lado por separado** — IDs distintos, pero no
> vacíos ni repetidos. O sea que el caso de contrato, por sí solo, no lo habría cazado. Lo que lo
> caza es el guard que mira la **sentencia replicada** y falla si lleva SQL no determinista
> (`SQL_NO_DETERMINISTA` en `contract.test.ts`), porque lo que viaja a la Main es el texto.

## Hallazgos abiertos

Ninguno.


