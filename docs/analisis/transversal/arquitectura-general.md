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

### ARCH-01 🟠 Doble implementación de la lógica de negocio — SISTÉMICO
- **Evidencia:** cada operación de **escritura** existe dos veces: en Rust (`crates/tpv-infra-sqlite/*`,
  para la Main) y en TS (`apps/cloud-worker-licensing/src/domains/*/*.commands.ts`, para la Handy).
  Además hay **dos sistemas de tipos** (ts-rs para el Main, zod `*.schemas.ts` para el worker) y
  **dos validaciones** (`tpv-domain` en Rust, zod en el worker).
- **Fallo:** ambas implementaciones deben producir **exactamente** las mismas sentencias y resultados
  para que el sync converja. Mantenerlas idénticas a mano es frágil y la deriva **ya ocurrió**
  (MESA-04, MESA-07, CUENTA-03 — todas corregidas a mano).
- **Estado (2026-08-22):** las **escrituras** ya tienen red: el harness de contrato por efecto corre
  en CI en los dos lados (60 casos, 0 comandos sin cubrir ni excluir con motivo) y cerró MESA-11,
  VR-05, INV-07, RES-07, TAR-04, PROV-07 y CONF-06. Sigue **sin red** lo que el harness no mira:
  la paridad de **lectura** (STAT-06, CLI-05 — compara escrituras, no consultas) y lo **excluido con
  motivo** (LOGIN-05, TRAB-06: PIN verificado en Rust, PII cifrada, salt aleatorio). Que esa segunda
  laguna no es teórica lo demuestra **TRAB-07**, un bug real que entró justo por ahí.
- **Arreglo:** hecho el primer paso (**tests de contrato por efecto**). Siguientes: un harness
  hermano de **paridad de lectura** y cubrir el efecto del fichaje. Opciones más ambiciosas (SQL en fuente compartida,
  WASM, codegen) en [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).
- **Decisión del responsable:** refactor **gradual post-lanzamiento**; el producto funciona y converge.

