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


> **CUENTA-06 cerrado (2026-08-25).** Ya existe el cierre de caja: `Cierres_Caja` +
> `Cierre_Denominaciones`, con fondo heredado, esperado, contado, descuadre, retirada y el doble
> recuento por denominación. El periodo va de un cierre al siguiente —sin fechas de por medio, que es
> lo único que sabe partir la jornada de un bar— y lo que se deja en el cajón es el fondo del
> siguiente, así que se encadenan solos. Cerrar no bloquea nada (CAJA-01): corregir un apunte de un
> cierre hecho avisa, pide motivo si mueve un descuadre y rectifica el cierre; deshacer, sólo el
> último. Diseño y porqués en
> [PLAN_CIERRE_CAJA.md](../../PLAN_CIERRE_CAJA.md).
