# Análisis integral del TPV — Índice

> **Propósito.** Auditoría profunda del monorepo TPV (escritorio Tauri/React + worker Cloudflare
> `tpv-api` + backend Rust hexagonal) buscando **bugs de correctitud, problemas de seguridad,
> cuellos de rendimiento y deuda de calidad/consistencia**. Cada módulo tiene su propio `.md` con
> hallazgos priorizados y un **workflow de corrección** paso a paso.
>
> **Cómo usar este documento.** Se trabaja **un módulo a la vez**. Abre el `.md` del módulo, revisa
> la tabla de hallazgos (ordenados por severidad), y sigue el workflow. Marca el estado en la tabla
> de progreso de abajo a medida que se resuelven.

---                                 

## Metodología

- **Cobertura por módulo:** para cada dominio se revisan las **tres capas** implicadas —
  frontend (`apps/tpv-main/src/features/*`), worker (`apps/cloud-worker-licensing/src/domains/*`),
  y backend Rust (`crates/*` + `apps/tpv-main/src-tauri/src/commands/*`)— además del esquema SQL y
  la ruta de sincronización (outbox → TenantHub → broadcast).
- **Severidades:**
  - 🔴 **Crítico** — corrupción de datos, pérdida de dinero, fallo de seguridad, o caída del flujo de venta.
  - 🟠 **Alto** — bug funcional visible, inconsistencia FE↔BE, o riesgo de seguridad acotado.
  - 🟡 **Medio** — comportamiento incorrecto en casos límite, rendimiento degradado, o UX rota.
  - 🔵 **Bajo / Mejora** — refactor, consistencia, tipos, deuda técnica, tests ausentes.
- **Cada hallazgo lleva:** ID estable (`<MOD>-NN`), ubicación `archivo:línea`, descripción del
  fallo, escenario reproductor concreto, impacto y propuesta de arreglo.
- **Verificación:** los hallazgos marcados **CONFIRMADO** se han razonado hasta un escenario
  reproductor; los **PLAUSIBLE** requieren validación en ejecución (se indica cómo).

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

## Tabla de progreso

Leyenda: ⬜ pendiente · 🔍 análisis hecho (doc generado) · 🛠️ en corrección · ✅ resuelto

Recuento por severidad (🔴 crítico / 🟠 alto / 🟡 medio / 🔵 bajo-mejora). No se han encontrado
🔴 críticos "en frío" (varios 🟠 son serios y dependen de condiciones concretas — ver cada doc).

| Módulo | Análisis | Corrección | Nº hallazgos (🔴/🟠/🟡/🔵) |
|--------|----------|-----------|----------------------------|
| T1 Esquema DB | 🔍 | ⬜ | 0 / 4 / 5 / 6 (15) |
| T2 Sync/TenantHub | 🔍 | ⬜ | 0 / 4 / 7 / 4 (15) |
| D1 Mesas | 🔍 | ⬜ | 0 / 5 / 6 / 4 (15) |
| D2 Venta rápida | 🔍 | ⬜ | 0 / 2 / 4 / 4 (10) |
| D3 Cuentas | 🔍 | ⬜ | 0 / 2 / 3 / 1 (6) |
| D4 Inventario | 🔍 | ⬜ | 0 / 0 / 4 / 4 (8) |
| D5 Clientes | 🔍 | ⬜ | 0 / 1 / 2 / 3 (6) |
| D6 Reservas | 🔍 | ⬜ | 0 / 1 / 3 / 3 (7) |
| D7 Proveedores | 🔍 | ⬜ | 0 / 0 / 4 / 3 (7) |
| D8 Tareas | 🔍 | ⬜ | 0 / 0 / 1 / 4 (5) |
| D9 Trabajadores | 🔍 | ⬜ | 0 / 0 / 4 / 2 (6) |
| D10 Configuración | 🔍 | ⬜ | 0 / 1 / 3 / 2 (6) |
| D11 Login | 🔍 | ⬜ | 0 / 1 / 3 / 2 (6) |
| D12 Estadísticas | 🔍 | ⬜ | 0 / 0 / 4 / 2 (6) |
| T3 Licensing/pairing | 🔍 | ⬜ | 0 / 0 / 3 / 3 (6) |
| T4 Observabilidad | 🔍 | ⬜ | 0 / 0 / 2 / 3 (5) |
| T5 Arquitectura general | 🔍 | ⬜ | 0 / 1 / 3 / 3 (7) |
| **TOTAL** | | | **0 / 22 / 61 / 53 (≈136)** |

### Temas transversales más importantes (leer primero)

1. **Doble implementación Main(Rust)/Handy(worker)** (ARCH-01): cada escritura está codificada dos
   veces y debe converger; la deriva **ya ocurre** (MESA-04, MESA-07, CUENTA-03). Es la deuda #1.
2. **Determinismo temporal del sync** (DB-02, SYNC-04/05, RES-03, TAR-01): columnas con `DEFAULT`
   temporal e `INSERT…SELECT` sobre catálogo divergen entre Main y nube.
3. **Modelo de cobro inconsistente** (MESA-01/05, CUENTA-01/02, CLI-01, STAT-01/02): stock, gasto de
   cliente, caja y KPIs no comparten una única fuente de verdad ni revierten al anular.
4. **Seguridad** (LOGIN-01 PIN débil + hash en nube, DB-04/CONF-01 SMTP en claro, TRAB-02/03 fraude
   horario + PII, LIC-01 licencia sin firma pineada, OBS-01 scrubbing).
5. **Robustez del sync** (SYNC-01 poison-op atasca el pipeline, SYNC-02 outbox no atómico).

---

## Orden de trabajo recomendado

1. **T1 Esquema DB** y **T2 Sync** primero: son la base sobre la que se apoyan todos los dominios;
   entender sus reglas (idempotencia, IDs deterministas, captura de outbox) hace más afilado el
   resto del análisis.
2. Luego el **núcleo del POS** (D1 Mesas, D2 Venta rápida, D3 Cuentas): es donde vive el dinero y
   el mayor volumen de lógica transaccional.
3. Después el resto de dominios (D4–D12).
4. Cierre con **T3 Licensing**, **T4 Observabilidad** y **T5 Arquitectura**.

> Nota de método: los `.md` se generan **uno a uno** con análisis a fondo (no en lote), para
> maximizar la calidad del detalle en cada módulo.
