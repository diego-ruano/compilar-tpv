# 0001 · Monorepo híbrido y arquitectura hexagonal en Rust

**Estado:** vigente.

## Contexto

El producto tiene tres piezas que comparten tipos y reglas: la aplicación de escritorio (Tauri + React),
su backend en Rust sobre SQLite y el worker de Cloudflare en TypeScript. La lógica de negocio tiene que
poder probarse sin base de datos, sin red y sin Tauri, y los tipos que cruzan la frontera entre Rust y
TypeScript no pueden escribirse dos veces a mano.

## Decisión

- **Un monorepo**: pnpm workspaces (`apps/*`, `packages/*`), un Cargo workspace virtual (`crates/*` y
  `apps/tpv-main/src-tauri`) y Turborepo para ordenar las tareas (`build` depende de `generate-types`).
- **Rust por capas**:
  - `tpv-domain`: entidades y reglas puras.
  - `tpv-application`: puertos (traits) en `ports/` y casos de uso en `use_cases/`.
  - Adaptadores: `tpv-infra-sqlite` (persistencia), `tpv-infra-http` (los mismos puertos contra el worker,
    para la Handy), `tpv-infra-licensing` (cripto, keyring, HTTP firmado), `tpv-infra-aeat` (Veri\*factu),
    `tpv-telemetry`.
  - `tpv-contracts`: los DTO que cruzan a la interfaz.
  - `apps/tpv-main/src-tauri`: comandos Tauri **finos** que adaptan la entrada, llaman al caso de uso y
    devuelven el resultado. Sin SQL ni reglas.
- **Contratos generados con Specta**: cada DTO deriva `specta::Type`, cada comando lleva
  `#[specta::specta]` y el registro es `tauri_specta::Builder` en `lib.rs`. `pnpm generate-types`
  exporta tipos (`@tpv/contracts`), funciones (`@tpv/client`) y metadatos para E2E desde el ejecutable
  real con `--export-bindings`, sin abrir la aplicación. Los contadores se exportan como `number`, los
  IDs siguen siendo UUID `string` y el dinero conserva `Dinero` ([0005](0005-dinero-en-centimos.md)).
- **Los errores** de un caso de uso son `AppError`, que en la frontera se convierte en
  `AppErrorDto { code, message }` con `code` del catálogo cerrado `ErrorCode`.

## Consecuencias

- La aritmética que importa (dinero, huella fiscal, arqueo, licencia) se prueba en `tpv-domain` sin nada
  alrededor.
- La Handy reutiliza los casos de uso cambiando el adaptador (`tpv-infra-http`); el worker, en cambio,
  tiene su propia implementación de las escrituras ([0003](0003-replicacion-por-sentencias-con-escritor-unico.md)).
- TypeScript comprueba nombre, parámetros y respuesta de cada comando. ESLint impide saltarse el
  cliente generado y CI comprueba que sus ficheros coinciden con las firmas Rust.
- Un DTO con contrapartida en un schema zod del worker lleva un drift-guard de claves
  (`lib/typeGuards.ts`).
