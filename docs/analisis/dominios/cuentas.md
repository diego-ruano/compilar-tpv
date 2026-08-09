# D3 — Cuentas / Caja

> **Ámbito.** El "libro de caja": entradas (pagos), salidas (gastos), y la edición/borrado de pagos y
> gastos. Es la vista contable del negocio.
> **Capas:** `crates/tpv-infra-sqlite/src/cuentas.rs`, `crates/tpv-application/src/use_cases/cuentas.rs`,
> `crates/tpv-domain/src/cuentas.rs`, `apps/cloud-worker-licensing/src/domains/cuentas/*`,
> FE `apps/tpv-main/src/features/cuentas/*` (React Query).

## Cómo funciona hoy

- **Entradas** = `Pagos` unidos a comanda/mesa/cliente, clasificados como `Tarjeta`/`Efectivo`.
- **Salidas** = `Cuentas_Gastos` (con tipo y proveedor opcional).
- CRUD de gastos y edición/borrado de pagos, con reversión completa y recálculo server-side.
- Listados **paginados** con búsqueda server-side y resumen agregado.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| CUENTA-06 | 🔵 | No hay **cierre/arqueo de caja** persistido (fondo inicial, sesiones, descuadre) | dominio |

### CUENTA-06 🔵 Sin arqueo de caja
No existe el concepto de sesión de caja: no se guarda fondo inicial, ni cierre, ni descuadre entre
lo contado y lo registrado. **Aplazado por decisión del responsable**, a revisar en el futuro; es
una funcionalidad nueva, no un bug.
