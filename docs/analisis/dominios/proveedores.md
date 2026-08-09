# D7 — Proveedores + Pedidos a proveedor

> **Ámbito.** Gestión de proveedores (CRUD, vínculos con productos) y **pedidos de compra**
> (borrador → enviado, líneas, envío por email al proveedor).
> **Capas:** `crates/tpv-infra-sqlite/src/proveedores.rs`, `pedidos_proveedor.rs`,
> `use_cases/{proveedores,pedidos_proveedor}.rs`, `commands/{proveedores,pedidos_proveedor}.rs`,
> `apps/cloud-worker-licensing/src/domains/proveedores/*`,
> FE `apps/tpv-main/src/features/proveedores/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: PROV-01, PROV-02, PROV-03, PROV-04,
> PROV-05, PROV-06.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| PROV-07 | 🔵 | Doble implementación Rust/worker (parity) | `proveedores.rs` ↔ `proveedores.commands.ts` |

### PROV-07 🔵 Doble implementación
Instancia de **ARCH-01**; lo cubre el harness de tests de contrato → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

> **Nota (no es un hallazgo):** el correo de pedido lo envía el worker con **Cloudflare Email
> Service** (binding `EMAIL`); Resend quedó retirado. Sin claves de API en el cliente ni
> credenciales SMTP en ningún sitio.

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| PROV-01 | El guard `Estado='borrador'` cubre **toda** la operación: si el UPDATE no afecta filas (pedido inexistente, ya enviado o cancelado) se aborta sin tocar las líneas y se devuelve `Ok(false)` en vez del engañoso `Ok(true)`. |
| PROV-02 | Reglas de transición claras: un pedido solo transita **desde** `'borrador'`, y los enviados/cancelados son inmutables. El envío real del correo y el cierre del aviso quedaron cableados al mismo flujo. |
| PROV-03 | Listado paginado (`get_page` + `total`) con búsqueda server-side; ya no se cargan todos los pedidos y toda la tabla de líneas en memoria. |
| PROV-04 | La cascada de borrado se hace **explícita** (UPDATE … SET ID_Proveedor = NULL para `Pedidos_Proveedor` y `Cuentas_Gastos`), sin depender de que `foreign_keys=ON` persista en la nube (DB-03). Queda capturada en el outbox y converge Main↔nube. |
| PROV-05 | La violación de `UNIQUE(Email/CIF)` se traduce a un error de validación con mensaje claro para la UI. |
| PROV-06 | Sin credenciales SMTP: el correo sale por el worker (DB-04). |
