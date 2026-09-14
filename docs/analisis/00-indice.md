# Análisis integral del TPV — Índice

> **Propósito.** Auditoría profunda del monorepo TPV (escritorio Tauri/React + worker Cloudflare
> `tpv-api` + backend Rust hexagonal) buscando **bugs de correctitud, problemas de seguridad,
> cuellos de rendimiento y deuda de calidad/consistencia**.
>
> **Estado (2026-09-14).** Lo abierto vive en dos listas, aparte de este índice:
> **[HALLAZGOS.md](HALLAZGOS.md)** —lo que salió del repaso completo del 10/09: quedan seis, ninguno
> bloqueante— y **[BACKLOG.md](BACKLOG.md)** —lo aplazado, cada uno con su motivo—. Este índice
> recoge la auditoría original por módulos, de la que no queda ningún bug abierto.
>
> **Un hallazgo corregido se borra**, de aquí y de las otras dos listas: la traza del arreglo vive en
> el código, no en un documento (ver *Trazabilidad* abajo). Si buscas un ID que no aparece, está
> resuelto.

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

Ningún bug. Lo que queda son decisiones de producto aplazadas.

| Módulo | Abiertos | Cuáles |
|--------|----------|--------|
| T5 Arquitectura | 1 | ARCH-01 🟠 (lo poco que queda excluido del harness de escritura, y el WASM de fondo) |
| D11 Login | 1 | LOGIN-04 🔵 (keyspace del PIN) |
| T3 Licensing | 1 | LIC-02 🔵 |
| D1 Mesas · D2 Venta rápida · D3 Cuentas · D4 Inventario · D5 Clientes · D6 Reservas · D7 Proveedores · D8 Tareas · D9 Trabajadores · D10 Configuración · D12 Estadísticas · T1 Esquema DB · T2 Sync · T4 Observabilidad | 0 | — |

### Nota importante sobre el recuento

**Qué cierran los harness de contrato y qué no.** Son **dos**, y están verdes en los dos lados:

- **Escritura** — mismo comando → mismas filas. **66 casos** sobre 63 comandos, 4 excluidos con
  motivo en [`cobertura.json`](../../tests/contract/cobertura.json).
- **Lectura** — mismas filas → mismo resultado devuelto, **y en el mismo orden**. **65 casos** sobre
  las **61** lecturas: cobertura completa, **sin exclusiones**. Cerró CLI-05 y STAT-07.

`scripts/check-contract-coverage.mjs` avisa en CI —sin romperlo— de todo lo que entre sin caso. Hoy
señala **0 pendientes** en las dos vertientes: lo que queda fuera está excluido con su motivo.

Sigue **excluido con motivo**: `login.complete_initial_setup` (salt aleatorio: el golden nunca
casaría; la compatibilidad del formato **sí** se verificó a mano, ver [login.md](dominios/login.md)),
la ficha de trabajador con PII (asimetría diseñada: el worker no escribe esas columnas). Del lado de
las **lecturas no queda ninguna exclusión**: `mesas.mesasOcupadas` se arregló en la Main y las cinco
de `stats` se portaron al worker.

**Las tres lecciones del recuento**, que valen más que la cifra:

1. **Los dos bugs vivían en comandos excluidos o sin caso del harness.** De los 11 `-parity`
   originales, 9 estaban bien. Lo que decide si un fallo aparece no es lo bajo que parezca su
   riesgo, sino si alguien contrasta ese comando.
2. **Comparar el efecto no basta para todo.** TRAB-08 dejaba un efecto *válido en cada lado por
   separado* (IDs distintos, pero ni vacíos ni repetidos): el snapshot no lo veía. Lo que lo caza es
   mirar la **sentencia replicada** —lo que de verdad viaja a la Main— y rechazar el SQL no
   determinista. Ese guard (`SQL_NO_DETERMINISTA`) vive en el harness y tiene su propio test.
3. **Verificar a mano no es lo mismo que contrastar.** Es la lección más cara de todo el análisis.
   CLI-05 se revisó consulta a consulta el 22/08 y se dio por equivalente; STAT-06 se **retiró** el
   23/08 razonando que «los agregados van detrás de los datos». Al ejecutar las dos implementaciones
   en paralelo el 24/08 aparecieron **trece divergencias reales** —incluidas dos consultas de la Handy
   que devolvían siempre vacío por coercionar a número un id que es texto— y el módulo entero de
   estadísticas a medias. Leer dos SQL en paralelo compara lo que uno **cree** que hacen; ejecutarlos
   compara lo que hacen.

## Dónde está el resto

- **Qué falta para el piloto en un bar real** (auditoría 2026-09-02: fiscal, control de caja,
  permisos, operación): [BACKLOG.md §Auditoría previa al piloto](BACKLOG.md#auditoría-previa-al-piloto-2026-09-02).
- **Aplazados con motivo** (incluida la deuda transversal): [BACKLOG.md](BACKLOG.md).
- **Seguridad de red / superficie de ataque:** [auditoria-fable.md](../../auditoria-fable.md).
- **Sistema de licencias propio:** [PLAN_LICENCIAS_PROPIAS.md](../PLAN_LICENCIAS_PROPIAS.md).
