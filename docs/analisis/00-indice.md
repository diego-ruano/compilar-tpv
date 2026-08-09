# Análisis integral del TPV — Índice

> **Propósito.** Auditoría profunda del monorepo TPV (escritorio Tauri/React + worker Cloudflare
> `tpv-api` + backend Rust hexagonal) buscando **bugs de correctitud, problemas de seguridad,
> cuellos de rendimiento y deuda de calidad/consistencia**.
>
> **Estado (revisado 2026-08-09).** De los ~136 hallazgos del análisis original **quedan 16 abiertos**,
> y son lo único que contienen estas fichas. **Un hallazgo corregido se borra de aquí**: la traza del
> arreglo vive en el código, no en un documento (ver *Trazabilidad* abajo). Si buscas un ID que no
> aparece, está resuelto.

---

## Metodología

- **Cobertura por módulo:** para cada dominio se revisan las **tres capas** implicadas —
  frontend (`apps/tpv-main/src/features/*`), worker (`apps/cloud-worker-licensing/src/domains/*`),
  y backend Rust (`crates/*` + `apps/tpv-main/src-tauri/src/commands/*`)— además del esquema SQL y
  la ruta de sincronización (outbox → TenantHub → broadcast).
- **Severidades:** 🔴 crítico · 🟠 alto · 🟡 medio · 🔵 bajo/mejora.
- **Cada hallazgo lleva:** ID estable (`<MOD>-NN`), ubicación, descripción, escenario reproductor,
  impacto y propuesta de arreglo.
- **Trazabilidad en el código:** las correcciones llevan el ID del hallazgo en un comentario
  (`// MESA-01: …`), así que `grep -rn "MESA-01" crates/ apps/` lleva directo al arreglo. Por eso al
  cerrar un hallazgo **se borra de la ficha** en vez de moverlo a una lista de "ya corregidos": el
  código y el historial de git son la traza, y una lista paralela solo se queda vieja.

---

## Mapa de módulos

### Dominios de negocio (`dominios/`)

| # | Módulo | Frontend | Worker | Rust | Doc |
|---|--------|----------|--------|------|-----|
| D1 | Mesas (salón + comanda + cocina) | `features/mesasComponents` | `domains/mesas` | `*/mesas.rs` | [mesas.md](dominios/mesas.md) |
| D2 | Venta rápida (POS mostrador) | `features/ventaRapida` | `domains/venta_rapida` | `*/venta_rapida.rs` | [venta-rapida.md](dominios/venta-rapida.md) |
| D3 | Cuentas / Caja | `features/cuentas` | `domains/cuentas` | `*/cuentas.rs` | [cuentas.md](dominios/cuentas.md) |
| D4 | Inventario (productos + lotes) | `features/InventaryComponents` | `domains/inventario` | `*/inventario.rs` | [inventario.md](dominios/inventario.md) |
| D5 | Clientes | `features/ClientsComponents` | `domains/clientes` | `*/clientes.rs` | [clientes.md](dominios/clientes.md) |
| D6 | Reservas | `features/reservas` | `domains/reservas` | `*/reservas.rs` | [reservas.md](dominios/reservas.md) |
| D7 | Proveedores + pedidos | `features/proveedores` | `domains/proveedores` | `*/proveedores.rs` | [proveedores.md](dominios/proveedores.md) |
| D8 | Tareas | `features/tareas` | `domains/tareas` | `*/tareas.rs` | [tareas.md](dominios/tareas.md) |
| D9 | Trabajadores + fichajes + turnos | `features/trabajadores` | `domains/trabajadores` | `*/trabajadores.rs` | [trabajadores.md](dominios/trabajadores.md) |
| D10 | Configuración (negocio/ticket/email) | `features/configuracion` | `domains/configuracion` | `*/configuracion.rs` | [configuracion.md](dominios/configuracion.md) |
| D11 | Login / autenticación / arranque | `features/login` | `domains/login` | `*/login.rs` | [login.md](dominios/login.md) |
| D12 | Estadísticas | `features/estadisticas` | `domains/stats` | `*/stats.rs` | [estadisticas.md](dominios/estadisticas.md) |

### Piezas transversales (`transversal/`)

| # | Módulo | Ubicación | Doc |
|---|--------|-----------|-----|
| T1 | Esquema de base de datos + migraciones | `packages/database`, `crates/tpv-infra-sqlite` | [esquema-db.md](transversal/esquema-db.md) |
| T2 | Sincronización (outbox + WS + TenantHub) | `db.rs`, `useMainSocket`, `useHandySocket`, `durableObjects/tenantHub.ts` | [sync-tenanthub.md](transversal/sync-tenanthub.md) |
| T3 | Licensing + pairing | `crates/tpv-infra-licensing`, `domains/licensing`, `routes/pairing.ts` | [licensing-pairing.md](transversal/licensing-pairing.md) |
| T4 | Observabilidad (Sentry + Axiom) | `crates/tpv-telemetry`, `shared/observability`, `src/observability` | [observabilidad.md](transversal/observabilidad.md) |
| T5 | Arquitectura general (contracts/ts-rs, errores, invokeClient, React Query) | `packages/contracts`, `packages/client`, `crates/tpv-contracts` | [arquitectura-general.md](transversal/arquitectura-general.md) |

---

## Lo que queda abierto

| Módulo | Abiertos | Cuáles |
|--------|----------|--------|
| T5 Arquitectura | 4 | ARCH-01 🟠 · ARCH-02 🟡 · ARCH-03 🟡 · ARCH-05 🔵 |
| D1 Mesas | 2 | MESA-11 🟡 · MESA-14 🔵 |
| D2 Venta rápida | 3 | VR-05 🟡 · VR-06 🟡 · VR-07 🔵 |
| D4 Inventario | 2 | INV-06 🔵 · INV-07 🔵 |
| D6 Reservas | 2 | RES-05 🔵 · RES-07 🔵 |
| D8 Tareas | 2 | TAR-04 🔵 · TAR-05 🔵 |
| D9 Trabajadores | 2 | TRAB-03 🟡 · TRAB-06 🔵 |
| D11 Login | 3 | LOGIN-03 🔵 · LOGIN-04 🔵 · LOGIN-05 🔵 |
| T1 Esquema DB | 1 | DB-14 🔵 |
| T3 Licensing | 2 | LIC-02 🔵 · LIC-04 🔵 |
| D3 Cuentas | 1 | CUENTA-06 🔵 |
| D5 Clientes · D7 Proveedores · D10 Configuración · D12 Estadísticas | 1 c/u | CLI-05 · PROV-07 · CONF-06 · STAT-06 (todos 🔵 parity) |
| T2 Sync | 0 | *(SYNC-17 vive en el [BACKLOG](BACKLOG.md))* |
| T4 Observabilidad | 0 | — |

### Nota importante sobre el recuento

**11 de los abiertos son la misma cosa**: la doble implementación Main(Rust)/Handy(worker). ARCH-01
es el paraguas y MESA-11, VR-05, INV-07, STAT-06, LOGIN-05, CONF-06, PROV-07, RES-07, TAR-04,
TRAB-06 y CLI-05 son sus instancias por dominio. **Un solo trabajo —el harness de tests de contrato
(SQL golden)— los cierra todos.** Es, con diferencia, el pendiente de mayor retorno.

El resto se agrupa en:
- **Reconciliación de datos derivados:** INV-06 y VR-06 (stock) + DB-14 (`Total_Gastado`). Misma
  clase de tarea: un chequeo que compare el valor guardado con el recalculado y avise de la deriva.
- **Contrato de errores:** ARCH-02 + ARCH-05, aplazados a la migración de infra del worker.
- **Seguridad de datos:** TRAB-03 (PII replicada) y LOGIN-04 (keyspace del PIN).
- **Decisiones de producto pendientes, no bugs:** CUENTA-06 (arqueo), TAR-05 (papelera),
  MESA-14 (troceo de UI), RES-05 (unificar gestión de clientes), LOGIN-03, LIC-02, LIC-04.

---

## Dónde está el resto

- **Aplazados con motivo** (incluido SYNC-17 y la deuda transversal): [BACKLOG.md](BACKLOG.md).
- **Seguridad de red / superficie de ataque:** [auditoria-fable.md](../../auditoria-fable.md).
- **Sistema de licencias propio:** [PLAN_LICENCIAS_PROPIAS.md](../PLAN_LICENCIAS_PROPIAS.md).
