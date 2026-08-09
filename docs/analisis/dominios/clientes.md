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
mismos números. Hoy están igualados a mano. Es una instancia más de **ARCH-01**; lo cubre el mismo
harness de tests de contrato → ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).
