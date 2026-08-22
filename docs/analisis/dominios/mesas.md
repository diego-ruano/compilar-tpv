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
riesgo estructural de fondo, pero ya **no queda suelto**: el harness de tests de contrato por
efecto cubre el dominio completo —incluido el `save_layout` grande— y corre en CI en los dos lados,
así que una divergencia futura sale como test rojo. Ver
[tests/contract/README.md](../../../tests/contract/README.md).

---

## Hallazgos abiertos

Ninguno.


---

**Invariantes a preservar:** cobros y totales **recalculados server-side**; sentencias replicables
**deterministas** (sin depender del catálogo del lado que aplica); paridad de comportamiento entre la
implementación Rust (Main) y la del worker (Handy).
