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
| TRAB-07 | 🔴 | El fichaje de **entrada desde la Handy** inserta `Fichajes` **sin `ID_Fichaje`** → PK NULL y la salida no cierra nunca | `login.commands.ts:70` |
| TRAB-06 | 🔵 | Doble implementación Rust/worker de la lógica de **fichaje** (crítica) | `login.rs` ↔ `login.commands.ts` |

### TRAB-07 🔴 El fichaje de la Handy nace con la clave primaria a NULL

- **Ubicación:** `apps/cloud-worker-licensing/src/domains/login/login.commands.ts` (`punchEntrada`).
- **Fallo:** el `INSERT INTO Fichajes (...)` **omite `ID_Fichaje`**, que es `TEXT PRIMARY KEY` sin
  `DEFAULT`. En SQLite una PK de texto **admite NULL** (solo `INTEGER PRIMARY KEY` implica NOT
  NULL), así que la fila entra con la clave vacía en vez de rechazarse. Es el **único** `INSERT` de
  todo el worker que se salta el patrón `kind:"value"` + `crypto.randomUUID()` de CLAUDE.md §9
  (comprobado sobre las 27 tablas con `TEXT PRIMARY KEY`).
- **Escenario:** un trabajador ficha **entrada** desde la Handy → se crea el fichaje con
  `ID_Fichaje = NULL`. Al fichar **salida**, la ruta busca el fichaje abierto y manda
  `UPDATE … WHERE ID_Fichaje = ?` con ese NULL (`String(null)` → `'null'`): **no casa ninguna fila**,
  la jornada no se cierra y el endpoint responde 200 igual. Fichar entrada otra vez tampoco arregla
  nada: sigue habiendo un fichaje abierto. Y como los NULL son distintos entre sí en un índice
  único, pueden acumularse varias filas así.
- **Alcance en la Main:** la fila se replica; el `exec_punch` de Rust lee `ID_Fichaje` y corta con
  `ID_Fichaje inválido`, así que la Main tampoco puede cerrar ese fichaje. Al día siguiente
  `auto_close_stale_punches` lo marca `Cerrado_Automatico` + `Incidencia`, o sea que **la jornada
  queda sin horas y como incidencia**, que es justo lo que TRAB-02 quería evitar.
- **Arreglo:** un paso `{ kind: "value", saveAs: "id_fichaje", sql: "SELECT ?1;", args:
  [crypto.randomUUID()] }` y meter la referencia en el INSERT, como hacen los demás dominios; el
  comando pasa de `tenantDb.exec` a `tenantDb.transaction`. Conviene además dejar de excluir
  `login.punch*` del harness de contrato (hoy excluido por el hash del PIN), aunque sea con un caso
  que ataque solo la parte del fichaje: esto lo habría cazado el primer día.

### TRAB-06 🔵 Doble implementación del fichaje
La lógica de fichaje está codificada en Rust (Main) y en TS (worker, para Handy). Es la instancia
más delicada de **ARCH-01** porque de ella salen las horas trabajadas, y **es la que el harness no
cubre**: `login.punchEntrada`/`punchSalida` están excluidos con motivo en
[`cobertura.json`](../../../tests/contract/cobertura.json) (el camino real de Rust verifica el PIN
contra el hash, que el fixture tendría que sembrar precomputado). TRAB-07 es la prueba de que esa
exclusión sale cara.
