# Hallazgos del repaso completo (2026-09-10)

> Repaso del repo entero —crates, frontend, worker, esquema, CI— con las suites en verde delante.
> **No es una lista de sospechas**: cada punto se verificó leyendo el camino completo, y los que se
> apoyan en una suposición lo dicen.
>
> **Aquí sólo queda lo abierto.** Un hallazgo resuelto se borra: su traza vive en el código, en un
> comentario con su ID (`grep -rn "SYNC-20" crates/ apps/`); lo que enseñó, en CLAUDE.md o junto al
> código al que afecta; y el relato del arreglo, en su commit. Si buscas un ID que no aparece, está
> resuelto.
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja
>
> **Estado (2026-09-14):** nada de lo que queda impide entrar en un bar: TEST-03 salió de arreglar
> SYNC-20 y CFG-04 es mantenimiento.

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| TEST-03 | 🟡 | Cada recorrido E2E estrena su equipo y su tenant: seis bases de Turso por tanda | Sin empezar |
| CFG-04 | 🔵 | La guardia de fuentes de tiempo es un `debug_assert!`: en release no protege | Sin empezar |

---


## TEST-03 🟡 · Cada recorrido E2E estrena su equipo, y son seis

`wdio.conf.ts` prepara el equipo por receta en `beforeSession`, así que cada uno de los seis ficheros
de recorrido monta su AppData, activa su licencia y **crea su tenant de Turso**. Son seis bases por
tanda que no se borran solas, y el arranque completo se repite cinco veces para probar cinco cosas
distintas que podrían compartirlo.

**Qué haría falta.** Mover la preparación del equipo del `beforeSession` al `describe`, y encadenar
dentro los pasos que hoy son ficheros distintos. No todos pueden agruparse, y conviene saber cuáles
antes de empezar:

- **Sí pueden**: `venta` y `fiscal` estrenan los dos un equipo limpio, sin nube, y hacen recorridos
  contiguos (vender y cobrar / mirar la factura de ese cobro).
- **Los tres de copias YA son uno partido en tres**, y lo están por una razón que no se puede
  deshacer: en medio hay que **apagar la aplicación** (en Windows la base no se reemplaza con SQLite
  teniéndola abierta). Agruparlos es unificar su receta y su licencia, no sus `describe`.
- **`licencia` no puede**: necesita anular y caducar su propia licencia, así que compartirla con otro
  recorrido lo rompería.

⚠️ **El aislamiento no es negociable** y es lo que hay que vigilar al agruparlos: cada recorrido
estrena su licencia (y por tanto su tenant) **a propósito** — CLAUDE.md §16 explica que con una
licencia fija el catch-up arrastra lo que dejaron las tandas anteriores, y eso se vio como un fichaje
que la app rechazaba unas veces sí y otras no. Agrupar tiene que reducir el número de tenants
compartiendo uno **dentro** de un grupo, no reutilizando uno **entre** tandas.


## CFG-04 🔵 · La guardia de fuentes de tiempo es un `debug_assert!`

[`db.rs:371`](../../crates/tpv-infra-sqlite/src/db.rs#L371) comprueba con `debug_assert!` que ningún
SQL replicable lleve una fuente de tiempo no determinista fuera de las dos formas canónicas. En
release no hace nada, así que una escritura nueva por un camino sin test viajaría al outbox con su
`datetime('now')` sin resolver y la nube la reevaluaría en otro instante.

Está decidido así («en release no penaliza») y la cobertura de contrato al 94 % cubre casi todo. Se
anota por si algún día conviene convertirlo en un error devuelto en vez de en un panic de debug: la
comprobación es una búsqueda de subcadenas sobre un SQL que ya se está recorriendo, así que el coste
real de dejarla en release es difícil de medir.
