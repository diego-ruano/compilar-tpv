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
> **Estado (2026-09-14):** nada de lo que queda impide entrar en un bar: CFG-04 es mantenimiento.

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| CFG-04 | 🔵 | La guardia de fuentes de tiempo es un `debug_assert!`: en release no protege | Sin empezar |

---


## CFG-04 🔵 · La guardia de fuentes de tiempo es un `debug_assert!`

[`db.rs:371`](../../crates/tpv-infra-sqlite/src/db.rs#L371) comprueba con `debug_assert!` que ningún
SQL replicable lleve una fuente de tiempo no determinista fuera de las dos formas canónicas. En
release no hace nada, así que una escritura nueva por un camino sin test viajaría al outbox con su
`datetime('now')` sin resolver y la nube la reevaluaría en otro instante.

Está decidido así («en release no penaliza») y la cobertura de contrato al 94 % cubre casi todo. Se
anota por si algún día conviene convertirlo en un error devuelto en vez de en un panic de debug: la
comprobación es una búsqueda de subcadenas sobre un SQL que ya se está recorriendo, así que el coste
real de dejarla en release es difícil de medir.
