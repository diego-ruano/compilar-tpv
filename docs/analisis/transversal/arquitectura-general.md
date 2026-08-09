# T5 — Arquitectura general (contracts · errores · cliente · React Query · patrones transversales)

> **Ámbito.** Los patrones que cruzan todos los dominios: generación de tipos (ts-rs), contrato de
> errores (`AppError`→String), cliente unificado (`invokeClient`), capa de datos (React Query), y —lo
> más importante— el **patrón de doble implementación** Main(Rust)/Handy(worker). Este documento
> **sintetiza** los temas recurrentes de los demás `.md`.
> **Capas:** `packages/contracts` (ts-rs), `packages/client` (`invokeClient`),
> `crates/tpv-application/src/error.rs`, `crates/tpv-domain`, worker `domains/*/*.schemas.ts`,
> FE `shared/lib/queryClient.ts` + `*Queries.ts`.

## Valoración general

La **arquitectura hexagonal** está bien lograda (separación domain/application/infra, comandos Tauri
finos, `ts-rs` como fuente única de tipos para el camino Main↔FE, Local-First coherente). El problema
transversal no es la estructura, sino la **duplicación de la lógica de negocio** entre la Main (Rust)
y la Handy (worker), que debe permanecer idéntica para que la sincronización converja.

**ARCH-07 🔵 — aciertos a mantener, no un pendiente:** hexagonal, ts-rs como fuente única de tipos,
Local-First y React Query con hooks co-locados por feature.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| ARCH-01 | 🟠 | **(Sistémico) Doble implementación** Main/Handy + doble tipado (ts-rs vs zod) + doble validación | todo el repo |
| ARCH-02 | 🟡 | Errores cruzan la frontera como **strings opacos** (`AppError`→String) → el FE no distingue por tipo/código | `error.rs`, `commands/*` |
| ARCH-03 | 🟡 | Tipos del worker (zod) **no derivan** de la misma fuente que los contracts ts-rs → la Handy puede divergir | `contracts` vs `domains/*/schemas.ts` |
| ARCH-05 | 🔵 | `AppError::Raw` mezcla el **contrato de error** (unos con código, otros prosa) | `error.rs` |

### ARCH-01 🟠 Doble implementación de la lógica de negocio — SISTÉMICO
- **Evidencia:** cada operación de **escritura** existe dos veces: en Rust (`crates/tpv-infra-sqlite/*`,
  para la Main) y en TS (`apps/cloud-worker-licensing/src/domains/*/*.commands.ts`, para la Handy).
  Además hay **dos sistemas de tipos** (ts-rs para el Main, zod `*.schemas.ts` para el worker) y
  **dos validaciones** (`tpv-domain` en Rust, zod en el worker).
- **Fallo:** ambas implementaciones deben producir **exactamente** las mismas sentencias y resultados
  para que el sync converja. Mantenerlas idénticas a mano es frágil y la deriva **ya ocurrió**
  (MESA-04, MESA-07, CUENTA-03 — todas corregidas a mano).
- **Estado:** la lógica está hoy igualada y verificada, pero **sin red de seguridad**. Es el paraguas
  de todos los `-parity`: MESA-11, VR-05, INV-07, STAT-06, LOGIN-05, CONF-06, PROV-07, RES-07,
  TAR-04, TRAB-06, CLI-05.
- **Arreglo:** empezar por **tests de contrato (SQL golden)**, que convierten cada divergencia futura
  en un test rojo sin cambiar la arquitectura. Opciones más ambiciosas (SQL en fuente compartida,
  WASM, codegen) en [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).
- **Decisión del responsable:** refactor **gradual post-lanzamiento**; el producto funciona y converge.

### ARCH-02 🟡 Errores como strings opacos
`AppError` se mapea a `String` en la frontera Tauri, así que el FE ramifica por *string matching*.
**Arreglo:** un DTO `{ kind, code, message }` (ts-rs) que el worker devuelva con la misma forma.
**Cuándo:** junto con el resto de la infra al pasar el worker a plan de pago.

### ARCH-03 🟡 Tipos del worker sin fuente única
Los `*.schemas.ts` (zod) se escriben a mano en vez de derivar de los contracts ts-rs. **Arreglo:** el
patrón ya probado en OBS-05 (drift-guard de tipos: `SpoolEvent` → `telemetry.ts` + guard en
`telemetry.routes.ts`), replicado por dominio.

### ARCH-05 🔵 Contrato de error inconsistente
`AppError::Raw` permite propagar verbatim códigos de negocio del worker (p. ej. `not_approved` del
pairing), lo que mezcla mensajes con código y mensajes en prosa. Es la misma pieza que ARCH-02: al
introducir el catálogo de códigos compartido, `Raw` se retira.
