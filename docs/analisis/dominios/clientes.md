# D5 — Clientes

> **Ámbito.** Ficha de clientes, ranking (por reservas / por gasto / recientes) y su gasto acumulado.
> Fue el **módulo piloto** de la migración hexagonal.
> **Capas:** `crates/tpv-infra-sqlite/src/clientes.rs`, `use_cases/clientes.rs`,
> `crates/tpv-domain/src/clientes.rs`, `apps/cloud-worker-licensing/src/domains/clientes/*`,
> FE `apps/tpv-main/src/features/ClientsComponents/*` (React Query; `clientesQueries.ts` es la
> referencia del patrón de caché).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: CLI-01, CLI-02, CLI-03, CLI-04, CLI-06.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| CLI-05 | 🔵 | **Doble implementación** Rust/worker del overview (parity) | `clientes.rs` ↔ `clientes.queries.ts` |

### CLI-05 🔵 Doble implementación del overview
El cálculo del overview/ranking existe en Rust (Main) y en TS (worker, para Handy) y debe dar los
mismos números. Hoy están igualados a mano. Es una instancia más de **ARCH-01**; lo cubre el mismo
harness de tests de contrato → ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| CLI-01 / CLI-03 | La tabla `Facturas` (que nunca se escribía) **se retiró del esquema**: el cobro vive íntegramente en `Pagos` + `Pago_Detalles`, que es la fuente de verdad (DB-13). El gasto del cliente ya no depende de una tabla muerta. |
| CLI-02 | El overview se reescribió con dos CTEs que recorren `Reservas` una sola vez (se acabaron las subconsultas correlacionadas O(clientes × reservas)) y el esquema añadió `idx_reservas_cliente` (DB-05). |
| CLI-04 | Email y teléfono se validan y normalizan en el dominio (`normaliza_email`: trim + minúsculas) y hay índice único parcial `ux_clientes_email` sobre `lower(Email)`; el duplicado se rechaza con mensaje claro. |
| CLI-06 | `create` sigue siendo un UPSERT por `ID_Cliente`, pero ahora es **intencional y está documentado**: hace la operación idempotente ante reintentos y catch-up de sync. Un conflicto de email de OTRO cliente sí se rechaza. |
