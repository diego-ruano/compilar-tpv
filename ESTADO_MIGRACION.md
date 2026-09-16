# Estado de la migración — TPV Monorepo

> Resumen del estado tras la sesión de refactorización. Enfocado en **qué está migrado y qué
> falta**, no en bugs funcionales (que existen y quedan fuera de este resumen).

**Veredicto: la refactorización estructural está COMPLETA.** ✅

---

## Workers de Cloudflare — FUSIONADOS EN UNO (`tpv-api`) ✅

Los dos workers se han **unificado en uno solo**: `apps/cloud-worker-licensing/` (desplegado como
`tpv-api`). El antiguo `apps/cloud-worker-api/` (`tpv-server`) se **eliminó**.

- `tpv-api` reúne: API Hono (enrutador + subenrutadores), el DO **TenantHub** (movido desde el
  worker viejo, ahora resuelve credenciales de Turso en local con caché TTL en vez de la llamada
  HTTP cruzada entre workers), **pairing** (`/v1/pair/*`), revoke, WS y las licencias
  (`/v1/license/*`, `/v1/stripe/*`, `/v1/admin/*`).
- **Schema único**: los ficheros `packages/database/migrations/*.sql` (aplicados en orden) los
  consumen la app (Rust, `include_dir!` en `migrations.rs`) y el worker (`tenantMigrations.ts`).
  Limpiadas las tablas muertas de la antigua capa `dualCall`.
- El cliente Rust (`tpv-infra-licensing`) apunta a `https://tpv-api.altarialights.workers.dev`.

---

## Lo que se ha completado

### Arquitectura hexagonal (Rust)
- Monorepo híbrido **pnpm + Cargo + Turborepo** funcionando.
- Crates por capa: `tpv-domain`, `tpv-application` (`ports/` + `use_cases/`), `tpv-infra-sqlite`,
  `tpv-infra-licensing`, `tpv-contracts`.
- **Todos los dominios migrados** (monolito desmontado por completo): `clientes`, `stats`,
  `tareas`, `trabajadores`, `venta_rapida`, `mesas`, `inventario`, `cuentas`, `reservas`,
  `proveedores`, `configuracion`, `login`, y `licensing`/`pairing` (en `tpv-infra-licensing`).
- `apps/tpv-main/src-tauri/src/` ya **sólo** contiene `main.rs` (shell), `lib.rs` (boilerplate) y
  `commands/` (un fichero fino por dominio, sin SQL ni lógica).

### Tipos automáticos (ts-rs)
- DTOs anotados con `#[derive(TS)]` → `packages/contracts/src/generated/bindings.ts` (fichero único).
- `cargo test -p tpv-contracts` / `pnpm generate-types`: **176 tests OK**.

### Local-First puro — capa de sync ELIMINADA
- **Rust**: borrados `cloud_sync.rs`, `sync_manager.rs`, `fallback_local.rs` + su wiring y los
  comandos `*_after_remote_ok`.
- **Frontend**: borrados `net/*` (`dualCall`, `cloudSync`, `outboxSync`, `realtimeSocket`,
  `healthCheck`) y los stores `useNet`/`useSync`.
- El frontend invoca directamente vía `@tpv/client` (`invokeClient`), sin red/outbox/op_id.
- **Pairing/Handy** se conserva (latente para el futuro), como estaba acordado.

### Otros hitos
- **Conexión/seed** de la BD movidos a `tpv-infra-sqlite::connection` (`init_main_db`); el esquema
  lo construyen las migraciones embebidas (`migrations.rs`) y el shell sólo aporta la ruta AppData.
- Añadida **alta/edición local de trabajador** (`trabajadores_create` / `trabajadores_update`),
  que antes era online-only sobre `dualCall`.
- **Auditoría de fidelidad** de `licensing`/`pairing`: 1 bug real detectado y corregido
  (`AppError::Raw` para propagar verbatim códigos del worker como `not_approved`).
- Reparado el **pipeline de Turbo** (claves `"//"` inválidas + `packageManager` ausente), que
  rompía `pnpm dev/build/generate-types`.

### Frontend reestructurado a `app/ · features/ · shared/`
- `src/app/` → arranque, router, providers, `pages/`, `layouts/`, `layoutComponent/`.
- `src/features/` → un directorio por dominio.
- `src/shared/` → `stores/` (Zustand), `ui/`, `toast.tsx`, `ticket/`, `lib/`.
- (+ `src/assets/`). Entry de `index.html` → `/src/app/main.tsx`.

### Verificación final — TODO VERDE
| Gate | Resultado |
|------|-----------|
| `cargo build` (workspace completo) | ✅ |
| `cargo test -p tpv-contracts` | ✅ 176 tests |
| `pnpm generate-types` (turbo) | ✅ |
| `tsc --noEmit` (frontend) | ✅ |

---

## Lo que NO está hecho (opcional / futuro, no bloqueante)

- **`tpv-infra-backup`**: **eliminado** (no aplica). Era un esqueleto cuyo adaptador de backups
  dependía de la antigua sync, ya retirada.
- **Pairing/Handy**: conservado pero **latente** (no reimplementado), por decisión de diseño.
- **`packages/database`** (`@tpv/database`): reservado para el esquema cloud futuro; sin uso.
- **Caché con TanStack Query**: ✅ aplicada. 9 features sobre React Query (clientes, proveedores,
  cuentas, reservas, tareas, trabajadores, estadísticas, inventario y el catálogo de salones de mesas).
  El POS transaccional (cobro/comanda/cocina, `venta_rapida`), `configuracion` (stores Zustand) y
  `login` (arranque) se dejan con `invokeClient` directo a propósito. Ver CLAUDE.md §8.
- **Refinamiento opcional del frontend**: las `pages/` viven bajo `app/`; si se quisiera, podrían
  distribuirse dentro de cada `features/<dominio>` (puramente cosmético).
- **Bugs funcionales**: existen y no se han abordado aquí (fuera del alcance de este resumen).

---

## Commits de la sesión (de más reciente a más antiguo)

```
2f244e0 docs(claude): marca la refactorizacion estructural como completada
4d9c682 fix(build): repara el pipeline de turbo (generate-types/dev/build)
6d9f3e9 refactor(frontend): consolida pages/ y layoutComponent en app/
e077860 refactor(frontend): reubica los dominios de componentes a features/
3ed3a78 refactor(frontend): extrae UI transversal a shared/ (toast, ticket, ui)
9cbd987 refactor(frontend): mueve el shell a app/ (App, AppBoot, Router, main, layouts)
13ceca5 refactor(frontend): introduce shared/ (stores + lib)
fd9df90 refactor(infra): mueve conexion/seed de la BD a tpv-infra-sqlite::connection
d92016f refactor(local-first): trabajadores create/update local + elimina la capa de sync legacy
47ecb1e fix(licensing): propaga verbatim los errores de negocio del worker
5ba37ee feat(licensing): migra licensing y pairing a arquitectura hexagonal
```
