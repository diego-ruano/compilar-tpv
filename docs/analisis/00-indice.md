# Análisis integral del TPV — Índice

> **Propósito.** Auditoría profunda del monorepo TPV (escritorio Tauri/React + worker Cloudflare
> `tpv-api` + backend Rust hexagonal) buscando **bugs de correctitud, problemas de seguridad,
> cuellos de rendimiento y deuda de calidad/consistencia**.
>
> **Estado (2026-08-23).** De los ~136 hallazgos del análisis original **quedan 8 abiertos**, y
> **solo uno es un bug**: TRAB-08. La revisión del 22-23 de agosto fue hallazgo por hallazgo contra
> el código, y de ahí salieron los dos únicos fallos reales que quedaban escondidos, los dos en el
> mismo sitio —el camino de escritura de la Handy que el harness no contrastaba—: **TRAB-07**
> (fichaje sin `ID_Fichaje`, **corregido** y con caso de contrato) y **TRAB-08** (`copiar semana`
> genera los IDs dentro del SQL replicado, **abierto**).
>
> Se cerraron además: los 7 `-parity` de escritura que el harness ya sujeta (MESA-11, VR-05, INV-07,
> RES-07, TAR-04, PROV-07, CONF-06), **TAR-05** (papelera de tareas, implementada), **LOGIN-05** (la
> compatibilidad del hash de PIN entre Rust y worker se verificó en las dos direcciones) y **TRAB-06**
> (la PII de la ficha es una asimetría diseñada; lo único que estaba mal era `copiar_semana` →
> TRAB-08). Y se retiraron por decisión del responsable **MESA-14**, **RES-05**, **LOGIN-03** y
> **VR-07**. **Un hallazgo corregido se borra de aquí**: la traza del arreglo vive en el código, no
> en un documento (ver *Trazabilidad* abajo). Si buscas un ID que no aparece, está resuelto.

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
| D9 Trabajadores | 1 | **TRAB-08 🟠 — el único bug abierto** |
| T5 Arquitectura | 1 | ARCH-01 🟠 (lo que queda: las **lecturas** y lo excluido del harness) |
| D5 Clientes | 1 | CLI-05 🔵 (paridad de **lectura**) |
| D12 Estadísticas | 1 | STAT-06 🔵 (paridad de **lectura**) |
| D11 Login | 1 | LOGIN-04 🔵 |
| T3 Licensing | 2 | LIC-02 🔵 · LIC-04 🔵 |
| D3 Cuentas | 1 | CUENTA-06 🔵 |
| D1 Mesas · D2 Venta rápida · D4 Inventario · D6 Reservas · D7 Proveedores · D8 Tareas · D10 Configuración · T1 Esquema DB · T2 Sync · T4 Observabilidad | 0 | — |

### Nota importante sobre el recuento

**Qué cierra el harness de contrato y qué no.** El harness compara el **efecto de una escritura**
(mismo seed → mismas filas) y está en verde en los dos lados: **62 casos** sobre 59 comandos, 5
excluidos con motivo en [`cobertura.json`](../../tests/contract/cobertura.json) y 0 pendientes;
`scripts/check-contract-coverage.mjs` avisa en CI —sin romperlo— de todo comando que entre sin caso.
Eso cerró los `-parity` de escritura y, desde el 2026-08-22, también el **fichaje**.

Lo que **no** cierra:

- **Paridad de lectura** — CLI-05 (overview de clientes) y STAT-06 (los 7 KPI). El harness no mira
  consultas. Ambos están verificados idénticos a mano, pero nada los vigila; los cierra un harness
  hermano que compare **las filas devueltas** por cada lado con el mismo seed.
- **Lo que sigue excluido con motivo** — `login.complete_initial_setup` (salt aleatorio: el golden
  nunca casaría; la compatibilidad del formato **sí** se verificó a mano, ver
  [login.md](dominios/login.md)), la ficha de trabajador con PII (asimetría diseñada: el worker no
  escribe esas columnas) y `horarios.copiar_semana` (**que es justo donde vive TRAB-08**; al
  arreglarlo, deja de ser incomparable y puede salir de las exclusiones).

**La lección del recuento:** de los 11 `-parity` originales, 9 estaban bien y 2 escondían un bug
real. Los dos bugs vivían en comandos **excluidos o sin caso** del harness. Lo que decide si un
fallo aparece o no es si alguien contrasta ese comando, no lo bajo que parezca su riesgo.

## Dónde está el resto

- **Aplazados con motivo** (incluida la deuda transversal): [BACKLOG.md](BACKLOG.md).
- **Seguridad de red / superficie de ataque:** [auditoria-fable.md](../../auditoria-fable.md).
- **Sistema de licencias propio:** [PLAN_LICENCIAS_PROPIAS.md](../PLAN_LICENCIAS_PROPIAS.md).
