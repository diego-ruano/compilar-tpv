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
> por el harness. De todo aquel bloque solo salió mal `copiar_semana` → **TRAB-08**.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| TRAB-08 | 🟠 | **`copiar semana` desde una Handy** genera los `ID_Asignacion` con `randomblob` **dentro** de la sentencia replicada → la nube y la Main acaban con IDs distintos para las mismas filas | `trabajadores.commands.ts:307` |

### TRAB-08 🟠 Copiar semana desde la Handy deja IDs distintos en cada lado

- **Ubicación:** `apps/cloud-worker-licensing/src/domains/trabajadores/trabajadores.commands.ts`
  (`copySemana`).
- **Fallo:** el comando inserta con `INSERT INTO Asignacion_Turnos (...) SELECT
  lower(hex(randomblob(16))), ...`. Ese `randomblob` va **dentro del SQL que se replica**: el DO
  resuelve a literal los `datetime('now')` y los `$ref` de los pasos `value`, pero **no** las
  funciones aleatorias. La Main recibe el texto y lo vuelve a ejecutar, así que genera **otros**
  ID_Asignacion distintos de los que quedaron en Turso. El propio motor asume lo contrario
  ([tenantHub.ts:993](../../../apps/cloud-worker-licensing/src/durableObjects/tenantHub.ts#L993):
  *"los IDs son UUID de JS"*).
- **Rust ya lo evitaba, y lo dice:** `copy_semana` en
  [trabajadores.rs:802](../../../crates/tpv-infra-sqlite/src/trabajadores.rs#L802) lee las filas
  origen y las inserta una a una precisamente porque *"un INSERT…SELECT no puede generar ids
  deterministas que sincronicen"*. Copiar semana **desde la Main es correcto**; el fallo es solo del
  camino de la Handy.
- **Escenario:** copiar una semana desde una Handy. Los turnos aparecen bien en los dos sitios (los
  datos son iguales), pero con clave distinta. A partir de ahí, editar o borrar uno de esos turnos
  —desde cualquiera de los dos lados— viaja con un ID que en el otro no existe: afecta a 0 filas y
  el cambio se pierde en silencio. El cuadrante deja de coincidir y no converge solo.
- **Arreglo:** el patrón de siempre (CLAUDE.md §9): leer las filas origen y emitir un INSERT por
  fila con el UUID generado en JS, como hace Rust. Con eso el caso de contrato deja de ser
  incomparable y `horarios.copiar_semana` puede salir de las exclusiones de `cobertura.json`.
- **Estado:** detectado el 2026-08-22 al verificar TRAB-06; pendiente de arreglo.

