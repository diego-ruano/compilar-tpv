# D5 — Clientes

> **Ámbito.** Ficha de clientes, ranking (por reservas / por gasto / recientes) y su gasto acumulado.
> Fue el **módulo piloto** de la migración hexagonal.
> **Capas:** `crates/tpv-infra-sqlite/src/clientes.rs`, `use_cases/clientes.rs`,
> `crates/tpv-domain/src/clientes.rs`, `apps/cloud-worker-licensing/src/domains/clientes/*`,
> FE `apps/tpv-main/src/features/ClientsComponents/*` (React Query; `clientesQueries.ts` es la
> referencia del patrón de caché).

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| CLI-05 | 🔵 | **Doble implementación** Rust/worker del overview (parity) | `clientes.rs` ↔ `clientes.queries.ts` |

### CLI-05 🔵 Doble implementación del overview
El cálculo del overview/ranking existe en Rust (Main) y en TS (worker, para Handy) y debe dar los
mismos números.

**Estado (2026-08-22): verificado idéntico a mano, pero sin test que lo sujete.** Las dos consultas
son equivalentes sentencia a sentencia —mismos CTE (`ult_reserva` con `ROW_NUMBER`, `agg_reservas`),
mismo `ORDER BY` por ranking y mismo `LIMIT 10`—; la única diferencia es cómo cada lado nombra las
columnas de salida (Rust lee por posición y mapea al DTO, el worker las aliasea a snake_case), y el
DTO resultante es el mismo.

**Por qué sigue abierto:** el harness de contrato compara el **efecto de una escritura**, así que
**no cubre lecturas**. Cerrarlo pide un harness hermano que, con el mismo estado sembrado, compare
las **filas que devuelve la consulta** en los dos lados. (El caso equivalente de estadísticas se
retiró como hallazgo: los datos de los que salen los KPI convergen, así que los agregados van
detrás. Aquí se mantiene porque el overview además ordena y recorta a 10, y un desempate distinto
cambiaría *qué clientes* salen en el ranking, no solo el número.)
