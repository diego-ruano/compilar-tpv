# D1 — Mesas (salón · comanda · cocina · barra)

> **Ámbito.** El núcleo del POS de servicio en mesa: layout del salón, apertura/cierre de comandas,
> alta/borrado de líneas, cobro fraccionado por detalle, venta rápida de barra, y tablero de cocina.
> Es el dominio con más lógica transaccional y donde vive el dinero.
> **Capas revisadas:** `crates/tpv-infra-sqlite/src/mesas.rs` (SQL real),
> `crates/tpv-application/src/use_cases/mesas.rs`, `apps/tpv-main/src-tauri/src/commands/mesas.rs`,
> `apps/cloud-worker-licensing/src/domains/mesas/*` (implementación paralela para Handy), y FE
> `apps/tpv-main/src/features/mesasComponents/*` (API + modal + cocina).

## Observación estructural

Existen **dos implementaciones** completas del dominio: la de la **Main** (Rust, `mesas.rs`) y la
del **worker** (TS, `mesas.commands.ts`) que sirve las escrituras de la **Handy**. Ambas construyen
el mismo tipo de sentencias pero **por separado y a mano**. Hoy están igualadas (las divergencias
históricas MESA-04 y MESA-07 se corrigieron), pero nada impide que vuelvan a separarse: es el
riesgo estructural que queda en pie (MESA-11).

---

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| MESA-11 | 🟡 | **Doble implementación** del dominio mantenida a mano → riesgo de divergencia (saveLayout duplica ~140 líneas) | `mesas.rs` ↔ `mesas.commands.ts` |
| MESA-14 | 🔵 | `MesaComandaModal.tsx` (~70 KB) / `KitchenBoard.tsx` (~18 KB) monolíticos → mantenibilidad | `features/mesasComponents/` |

### MESA-11 🟡 Doble implementación mantenida a mano
- **Ubicación:** todo el dominio duplicado en `mesas.rs` (Rust) y `mesas.commands.ts` (worker);
  `saveLayout` replica ~140 líneas de lógica de borrado/renombrado de zonas y mesas.
- **Fallo:** cada cambio hay que hacerlo dos veces y mantenerlo idéntico. Las divergencias **ya
  ocurrieron** (MESA-04 y MESA-07, ambas corregidas a mano); nada garantiza que no se repita.
- **Arreglo:** tests de contrato (SQL golden) que comparen las sentencias que producen ambas
  implementaciones para los mismos inputs. Es la tarea transversal ARCH-01 → ver
  [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

### MESA-14 🔵 Componentes de UI monolíticos
- **Ubicación:** `MesaComandaModal.tsx` (~70 KB), `KitchenBoard.tsx` (~18 KB).
- **Fallo:** difícil de leer, testear y evolucionar; concentra estado del ticket, cobro, cocina y
  reservas en un único archivo.
- **Arreglo:** extraer subcomponentes (ticket, panel de cobro, selector de productos) y hooks.
- **Estado:** pospuesto por prioridad (no hay bug de negocio detrás).

---

**Invariantes a preservar:** cobros y totales **recalculados server-side**; sentencias replicables
**deterministas** (sin depender del catálogo del lado que aplica); paridad de comportamiento entre la
implementación Rust (Main) y la del worker (Handy).
