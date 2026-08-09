# D3 — Cuentas / Caja

> **Ámbito.** El "libro de caja": entradas (pagos), salidas (gastos), y la edición/borrado de pagos y
> gastos. Es la vista contable del negocio.
> **Capas:** `crates/tpv-infra-sqlite/src/cuentas.rs`, `crates/tpv-application/src/use_cases/cuentas.rs`,
> `crates/tpv-domain/src/cuentas.rs`, `apps/cloud-worker-licensing/src/domains/cuentas/*`,
> FE `apps/tpv-main/src/features/cuentas/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos o decididos y retirados: CUENTA-01 a CUENTA-05.

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

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| CUENTA-01 | `eliminar_pago` revierte de forma **atómica** el estado de la comanda, el gasto del cliente y el stock. |
| CUENTA-02 | `actualizar_pago` recalcula el importe **desde los detalles**; ya no se puede desacoplar el total de lo cobrado. |
| CUENTA-03 | Un único normalizador de método de pago en `tpv_domain::pago`, compartido por cuentas y mesas. |
| CUENTA-04 | **Aceptado como está** (won't fix): solo Efectivo/Tarjeta. La fragilidad del match exacto quedó mitigada por CUENTA-03. |
| CUENTA-05 | Paginación + búsqueda server-side + resumen agregado; los históricos grandes ya no se traen enteros. |
