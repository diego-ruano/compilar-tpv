# D6 — Reservas

> **Ámbito.** Reservas de mesa (calendario mensual, alta/edición, estado, borrado) y su vínculo con
> clientes y mesas. Incluye el `upsert_cliente` que crea/actualiza el cliente al reservar.
> **Capas:** `crates/tpv-infra-sqlite/src/reservas.rs`, `use_cases/reservas.rs`,
> `crates/tpv-domain/src/reservas.rs`, `apps/cloud-worker-licensing/src/domains/reservas/*`,
> FE `apps/tpv-main/src/features/reservas/*` (React Query).
>
## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| RES-05 | 🔵 | **Segundo punto** de alta de clientes, con criterio de identidad propio | `reservas.rs` (`upsert_cliente`) |
| RES-07 | 🔵 | Doble implementación Rust/worker (parity) | `reservas.rs` ↔ `reservas.commands.ts` |

### RES-05 🔵 Segundo punto de alta de clientes
Hay **dos** sitios que crean e identifican clientes: el dominio de clientes (D5) y el
`upsert_cliente` de reservas, que resuelve por email y, si no hay, por teléfono. (Mesas y cuentas
también escriben en `Clientes`, pero solo suman o restan `Total_Gastado` de una ficha existente: no
crean ni deduplican, así que no cuentan como un tercer punto — el enunciado original de este
hallazgo decía tres y era inexacto.)

Las dos rutas ya coinciden en lo que importa: normalizan el email a minúsculas y buscan
case-insensitive contra `lower(Email)`, que es el criterio del índice único `ux_clientes_email`.
Lo que sigue difiriendo: reservas deduplica **además** por teléfono, y **no** valida el formato del
email (a propósito: una reserva se coge a menudo por teléfono y con datos a medias).

**Arreglo:** un único punto de resolución de cliente que consuman ambos flujos. Prioridad baja
mientras los criterios no vuelvan a separarse.

### RES-07 🔵 Doble implementación
Instancia de **ARCH-01**; lo cubre el harness de tests de contrato → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).
