# D7 — Proveedores + Pedidos a proveedor

> **Ámbito.** Gestión de proveedores (CRUD, vínculos con productos) y **pedidos de compra**
> (borrador → enviado, líneas, envío por email al proveedor).
> **Capas:** `crates/tpv-infra-sqlite/src/proveedores.rs`, `pedidos_proveedor.rs`,
> `use_cases/{proveedores,pedidos_proveedor}.rs`, `commands/{proveedores,pedidos_proveedor}.rs`,
> `apps/cloud-worker-licensing/src/domains/proveedores/*`,
> FE `apps/tpv-main/src/features/proveedores/*` (React Query).

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
