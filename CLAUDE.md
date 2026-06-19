# TPV — Monorepo (✅ REFACTORIZACIÓN ESTRUCTURAL COMPLETADA)

> **Estado:** la refactorización profunda está **completada**. El TPV (Terminal Punto de Venta) es
> ahora un **monorepo híbrido JS/Rust** con **arquitectura hexagonal** en Rust, **generación
> automática de tipos** a TypeScript con `ts-rs`, y un frontend **Local-First** (modo TPV) con
> **sincronización WebSocket** (modo online / Handy) reestructurado en `app/ · features/ · shared/`.
>
> Todos los dominios están migrados (monolito desmontado). La capa antigua `dualCall` fue eliminada y
> reemplazada por el sistema outbox + WS + TenantHub (§9). La verificación final (`cargo build` +
> `tsc` + `pnpm generate-types`) pasa. Para el detalle por capa y el patrón de referencia, mira
> [**Estado de la migración**](#estado-de-la-migración).

---

## 1. Qué es este proyecto

Un TPV de escritorio (hostelería) construido con **Tauri 2 + React 19 + TypeScript** y backend
**Rust** sobre **SQLite local (libsql)**. Acompañado de dos **Cloudflare Workers** (API de datos
y licencias). El producto se distribuye como app de escritorio Windows; los datos viven en
`AppData` del dispositivo (`data.db`).

Dominios de negocio: `mesas`, `venta_rapida`, `inventario`, `cuentas` (caja), `clientes`,
`reservas`, `proveedores`, `tareas`, `trabajadores`, `login`, `configuracion`, `stats`,
`licensing`, `pairing`.

---

## 2. Objetivo de la refactorización

1. **Monorepo** gestionado por **pnpm workspaces** (JS/TS) + **Cargo workspace** (Rust) + **Turborepo** (orquestación).
2. **Arquitectura hexagonal** en Rust, partiendo el backend monolítico (`src-tauri/src/*.rs`)
   en crates por capa (dominio / aplicación / infraestructura).
3. **`ts-rs`**: las structs que cruzan la frontera UI↔Rust se anotan con `#[derive(TS)]` y se
   autogeneran en `packages/contracts/src/generated/bindings.ts`.
4. **Local-First en modo TPV**: se elimina el patrón síncrono dual (`dualCall.ts`). El frontend
   (modo TPV) invoca **directamente** comandos Tauri contra el SQLite local. En modo **online /
   Handy** existe una capa de sincronización WebSocket con replicación de sentencias SQL (ver §9).

---

## 3. Mapa de estructura del monorepo

```
tpv-completa/                  # raíz del monorepo (git init aquí)
├── package.json               # pnpm + Turborepo (raíz JS)
├── pnpm-workspace.yaml        # registra apps/* y packages/*
├── Cargo.toml                 # Cargo workspace virtual (crates/* + apps/tpv-main/src-tauri)
├── turbo.json                 # tarea generate-types antes del build del frontend
├── CLAUDE.md                  # este fichero (ÚNICO claude.md del repo)
│
├── apps/
│   ├── tpv-main/              # APP ESCRITORIO (Tauri + React)
│   │   ├── package.json       # @tpv/main — depende de @tpv/contracts y @tpv/client
│   │   ├── vite.config.ts · index.html · tsconfig*.json
│   │   ├── src/               # Frontend Local-First
│   │   │   ├── main.tsx
│   │   │   ├── app/           # Router, startup, providers          (objetivo de migración)
│   │   │   ├── features/      # mesas, venta-rapida, caja… + hooks  (objetivo de migración)
│   │   │   └── shared/        # UI genérica, dinero/fechas, stores Zustand (objetivo)
│   │   └── src-tauri/         # Backend local (invocador/orquestador de las crates)
│   │       ├── tauri.conf.json · Cargo.toml · build.rs   (schema en packages/database)
│   │       └── src/
│   │           ├── main.rs    # entrada Tauri
│   │           ├── lib.rs     # registro de comandos + estado (AppState)
│   │           └── commands/  # mapeadores finos → llaman a tpv-application (objetivo)
│   │
│   └── cloud-worker-licensing/   # Worker ÚNICO `tpv-api` (fusión de tpv-server + tpv-licensing):
│                                  #   Hono + DO TenantHub + pairing + licencia. (Carpeta sin renombrar.)
│
├── crates/                    # CEREBRO RUST (multi-crate hexagonal)
│   ├── tpv-domain/            # Entidades puras + validaciones (no sabe de DB ni Tauri)
│   ├── tpv-application/       # Puertos (traits) en ports/ + casos de uso en use_cases/
│   ├── tpv-infra-sqlite/      # Adaptador de persistencia (implementa puertos con libsql)
│   ├── tpv-infra-licensing/   # Adaptador cripto ed25519 + HTTP del worker de licencias
│   └── tpv-contracts/         # DTOs con #[derive(TS)] → exportan a packages/contracts
│
└── packages/                  # CÓDIGO JS COMPARTIDO
    ├── database/              # schema.sql ÚNICO (app SQLite vía include_str! + worker vía módulo Text)
    ├── contracts/             # @tpv/contracts — tipos autogenerados (src/generated/bindings.ts)
    └── client/                # @tpv/client — invokeClient.ts (envoltura de invoke de Tauri)
```

---

## 4. Reglas tácticas de la refactorización

### 4.1 Workspaces (monorepo híbrido)
- **`pnpm-workspace.yaml`** registra `apps/*` y `packages/*`.
- **`Cargo.toml`** raíz: workspace **virtual**; `members` = todas las `crates/*` + `apps/tpv-main/src-tauri`.
  Versiones de dependencias compartidas centralizadas en `[workspace.dependencies]` (usar `dep = { workspace = true }`).
- **`turbo.json`**: tarea `generate-types` de la que depende el `build` del frontend
  (`build.dependsOn = ["^generate-types", "^build"]`), garantizando que `packages/contracts`
  esté lleno antes de compilar el frontend.

### 4.2 Arquitectura hexagonal en Rust — qué va dónde
- **`tpv-domain`** ← todo struct de negocio puro y sus validaciones. **Sin** dependencias de DB/red/Tauri.
- **`tpv-application/src/ports/`** ← todos los **traits** (interfaces de repositorio y de servicios).
- **`tpv-application/src/use_cases/`** ← lógica de orquestación (ej. `abrir_comanda.rs`).
- **`tpv-infra-sqlite`** ← todas las ejecuciones SQL / interacción con libsql, implementando los puertos.
- **`tpv-infra-licensing`** ← cripto ed25519, keyring y HTTP al worker de licencias, implementando puertos.
- **`apps/tpv-main/src-tauri/src/commands/`** ← comandos `#[tauri::command]` **finos**: inyectan estado
  (`AppState`), invocan el caso de uso de `tpv-application` y devuelven el resultado. Nada de SQL ni lógica aquí.

### 4.3 Automatización de tipos con `ts-rs` (VERIFICADO empíricamente)
- ts-rs **v12.0.1**, feature `chrono-impl` (declarada en `[workspace.dependencies]`); `serde-compat` activa por defecto.
- En `crates/tpv-contracts`, cada DTO expuesto a la UI lleva:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, TS)]
  #[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
  ```
  ⚠️ **Ojo con la ruta**: ts-rs v12 resuelve `export_to` relativo a `<crate>/bindings/`, así que desde
  `crates/tpv-contracts` hacen falta **tres** `../` para llegar a `packages/contracts/...`. (Con `../../` cae
  por error en `crates/packages/...`.)
- **Fichero único confirmado**: aunque haya muchos DTOs repartidos en varios `.rs`, todos apuntando al mismo
  `bindings.ts` se **fusionan** en ese único fichero (orden alfabético, referencias cruzadas resueltas sin imports).
- `packages/contracts/src/index.ts` re-exporta `./generated/bindings` → el frontend importa de `@tpv/contracts`.
- **Disparador**: `cargo test -p tpv-contracts` ejecuta los tests `export_bindings_*` que genera ts-rs. La tarea
  pnpm `generate-types` (en `packages/contracts`) hace exactamente eso.
- **Mapeos**: `i32`/`u32`/`f64`→`number`; `i64`/`u64`→`bigint`; `String`→`string`; `NaiveDate`/`DateTime`→`string`;
  `Vec<T>`→`Array<T>`; `Option<T>` + `#[ts(optional)]`→`campo?: T`.
  ⚠️ **IDs**: los ID `i64` se mapean a `bigint`. Como los ID de SQLite del TPV no superan 2^53, en los DTOs se
  anota `#[ts(type = "number")]` en los campos ID/contadores para mantener compatibilidad con el frontend (que usa `number`).

### 4.4 Frontend Local-First (TPV) y capa de sync (Handy/online)
- **Eliminado** el patrón `dualCall.ts` y sus auxiliares antiguos (`net/cloudSync`, `net/outboxSync`,
  `net/realtimeSocket`, `net/healthCheck`, stores `useNet`/`useSync`).
- **`packages/client/src/invokeClient.ts`**: cliente unificado que envuelve `invoke()` de
  `@tauri-apps/api/core`. En modo TPV, el frontend lee/muta directamente contra Tauri (SQLite local).
- Hooks y componentes de `apps/tpv-main/src/features/` consumen `@tpv/client`.
- **Modo online / Handy**: existe una capa de sincronización activa (outbox + WebSocket + DO TenantHub).
  El detalle completo está en **§9**. Los hooks clave son `useMainSocket` (Main) y `useHandySocket` (Handy).

### 4.5 Worker único `tpv-api`
- Los dos Cloudflare Workers se **fusionaron en uno solo**: `apps/cloud-worker-licensing/` (nombre
  desplegado `tpv-api`; la carpeta conserva el nombre `cloud-worker-licensing`). El antiguo
  `cloud-worker-api` (`tpv-server`) se **eliminó**.
- `tpv-api` sirve: API Hono (`src/index.ts` → enrutador + subenrutadores en `src/routes/`), el DO
  **TenantHub** (`src/durableObjects/`), **pairing** (`/v1/pair/*`), revoke, WS (`/ws`) y el
  licensing legacy (`/v1/license/*`, `/v1/webhooks/lemon`) vía `app.all("*")` mientras se migra a Hono.
- El cliente Rust (`tpv-infra-licensing`) apunta a `https://tpv-api.altarialights.workers.dev`
  (constantes `LICENSE_API_BASE` y `TPV_SERVER_BASE`, ambas al mismo host).

---

## 5. Decisiones tomadas (acordadas con el responsable)

1. **Git de los repos antiguos:** los `.git` originales de `tpv`, `tpv-server` y `tpv-licensing`
   se **respaldaron fuera del monorepo** (`../tpv-git-backup-pre-monorepo/`) y se eliminaron de las
   carpetas. El monorepo arranca con **git nuevo y limpio** en la raíz. No se hacen commits en los repos antiguos.
2. **Sync / Handy / Pairing:**
   - **ELIMINADO** ✅ el patrón `dualCall` antiguo y sus auxiliares: `cloud_sync.rs`,
     `sync_manager.rs`, `fallback_local.rs`, los comandos `*_after_remote_ok`, y en frontend `net/*`
     (`dualCall.ts`, `cloudSync.ts`, `outboxSync.ts`, `realtimeSocket.ts`, `healthCheck.ts`) +
     stores `useNet` / `useSync`.
   - **IMPLEMENTADO** ✅ el sistema de sync nuevo (outbox + WebSocket + TenantHub) que sustituye al
     anterior. Ver §9 para la arquitectura completa.
   - **MANTENIDO**: selección de **modo Handy**, **emparejamiento** (`pairing.rs`), el enum
     `DeviceMode` y el store `useMode`.
3. **Licensing:** la cripto de bajo nivel (ed25519) y las llamadas HTTP se mueven a
   `tpv-infra-licensing`; sus interfaces (traits) se definen en `tpv-application`; y
   `apps/tpv-main/src-tauri/src/commands/licensing.rs` deja únicamente comandos Tauri finos que
   invocan ese servicio vía `AppState`.
4. **Ritmo:** **big-bang** (migrar todo sin pausas de revisión entre módulos) pero **respetando el
   orden de dependencias del Cargo workspace** (domain → application → infra → contracts → app) para
   que compile en cada paso.

---

## 6. Comandos

> ⚠️ Tras clonar o tras esta migración hay que ejecutar **`pnpm install`** en la raíz (se purgaron
> todos los `node_modules` durante la reestructuración para evitar problemas de rutas largas de pnpm
> en Windows). El Cargo workspace regenera su `target/` y `Cargo.lock` en el primer build.

```bash
pnpm install                       # instala todo el workspace (raíz)

pnpm dev                           # turbo run dev
pnpm build                         # turbo run build (genera tipos antes del frontend)
pnpm generate-types                # regenera packages/contracts/src/generated/bindings.ts desde Rust
pnpm tauri dev                     # arranca la app de escritorio (== pnpm --filter @tpv/main tauri dev)
pnpm tauri build                   # empaqueta la app

cargo build                        # compila todo el Cargo workspace (crates + src-tauri)
cargo check -p tpv-domain          # comprueba una crate concreta
cargo test  -p tpv-contracts       # dispara la exportación ts-rs de los DTOs
```

---

## 7. Estado de la migración

Leyenda: ✅ hecho · 🟡 en curso · ⬜ pendiente

- ✅ Respaldo de los `.git` antiguos fuera del monorepo.
- ✅ Reubicación de los 3 proyectos a `apps/` (+ borrado de `.git` anidados).
- ✅ Configs raíz: `package.json`, `pnpm-workspace.yaml`, `Cargo.toml` (workspace), `turbo.json`, `.gitignore`.
- ✅ Las 5 crates hexagonales (`tpv-domain`, `tpv-application`, `tpv-infra-sqlite`, `tpv-infra-licensing`, `tpv-contracts`). (El esqueleto `tpv-infra-backup` se eliminó por no aplicar: los backups dependían de la sync antigua, ya retirada.)
- ✅ Esqueleto de los 3 packages (`@tpv/database`, `@tpv/contracts`, `@tpv/client` con `invokeClient.ts`).
- ✅ `git init` en la raíz (+ commit base `757f0b9`).
- ✅ `ts-rs` verificado y cableado (fichero único `bindings.ts`, ruta `../../../packages/...`, `cargo test -p tpv-contracts`). Ver §4.3.
- ✅ Patrón hexagonal compartido establecido: `tpv-infra-sqlite::mapping`, `tpv-application::{ports,use_cases}`, `AppError`→`String`.
- ✅ **Módulo `clientes` migrado (PILOTO/REFERENCIA)** end-to-end: domain → ports → repo sqlite → use cases → contracts (DTOs ts-rs) → comando Tauri fino + **rewire frontend a `@tpv/client`** (sin dualCall). Verificado: `cargo check -p tpv` ✅, `cargo test -p tpv-contracts` ✅, `tsc` frontend ✅.
- ✅ `pnpm install` ejecutado (workspace enlazado). Frontend pasa `tsc` (la antigua duda de `lucide-react` en `Carousel.tsx` ya no bloquea: el componente quedó sin uso y el type-check es verde).
- ✅ **Todos los dominios migrados** siguiendo el patrón de `clientes` (monolito estrangulado por completo): `clientes`, `stats`, `tareas`, `trabajadores`, `venta_rapida`, `mesas`, `inventario`, `cuentas`, `reservas`, `proveedores`, `configuracion`, `login`; y `licensing`/`pairing` (a `tpv-infra-licensing`). `apps/tpv-main/src-tauri/src/` ya sólo contiene `main.rs` (shell), `lib.rs` y `commands/` (capa fina). Alta/edición local de trabajador añadida (`trabajadores_create`/`trabajadores_update`).
- ✅ Auditoría de fidelidad multi-agente de `licensing`/`pairing`; bug detectado y corregido (`AppError::Raw` para propagar verbatim los códigos de negocio del worker, p. ej. `not_approved` del pairing Handy).
- ✅ Eliminada la capa `dualCall` antigua + auxiliares: frontend `net/*` (`dualCall`, `cloudSync`, `outboxSync`, `realtimeSocket`, `healthCheck`) y stores `useNet`/`useSync`; Rust `cloud_sync`/`sync_manager`/`fallback_local` + wiring y comandos `*_after_remote_ok`. Reemplazada por el sistema outbox + WebSocket + TenantHub (§9). Pairing Handy se conserva activo.
- ✅ Conexión/seed de la BD movidos a `tpv-infra-sqlite::connection` (`init_main_db(app_data_dir, schema)`); el shell `main.rs` sólo aporta ruta AppData + `schema.sql`.
- ✅ Reestructuración del frontend a `app/ · features/ · shared/` (+ `assets/`). `pages/` y `layoutComponent` viven bajo `app/`; los dominios bajo `features/`; stores/ui/toast/ticket/lib bajo `shared/`. Entry `index.html` → `/src/app/main.tsx`.
- ✅ Verificación final: `cargo build` (workspace completo) + `cargo test -p tpv-contracts` (176 ok) + `tsc` frontend + `pnpm generate-types` (turbo) OK. Reparado el pipeline turbo (claves `"//"` inline y `packageManager` ausente).

### Patrón de referencia para migrar un módulo (seguir `clientes`)
1. `tpv-domain/src/<m>.rs`: entidades + validación pura. Registrar en `domain/src/lib.rs`.
2. `tpv-contracts/src/<m>.rs`: DTOs con `#[derive(TS)]` + `#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]`. IDs `i64` con `#[ts(type = "number")]`. **Campos snake_case idénticos al struct antiguo** (compat frontend). Registrar en `contracts/src/lib.rs`.
3. `tpv-application/src/ports/<m>.rs`: trait `…Repository` (async). Registrar en `ports/mod.rs`.
4. `tpv-application/src/use_cases/<m>.rs`: orquestación + validación de dominio. Registrar en `use_cases/mod.rs`.
5. `tpv-infra-sqlite/src/<m>.rs`: `Sqlite…Repository` con el SQL (sin outbox/Applied_Operations — Local-First). Usa `crate::mapping`. Registrar en `infra-sqlite/src/lib.rs`.
6. `apps/tpv-main/src-tauri/src/commands/<m>.rs`: comandos finos (mismos nombres). Registrar en `commands/mod.rs` y reapuntar `main.rs` (quitar `mod <m>;` viejo + registrar `commands::<m>::…`). Borrar el `<m>.rs` monolítico.
7. Frontend `…Apis.ts`: cambiar `dualCall` por `invokeClient` de `@tpv/client`, tipos de `@tpv/contracts`, sin `op_id`/outbox.

### Backend monolítico de origen (desmontado ✅)
El backend monolítico previo (`mesas.rs`, `cloud_sync.rs`, `venta_rapida.rs`, `stats.rs`, …) se ha
vaciado por completo hacia las crates hexagonales. `apps/tpv-main/src-tauri/src/` ya sólo contiene
`main.rs` (shell: modo device, AppData, registro de comandos, `run()`), `lib.rs` (boilerplate Tauri)
y `commands/` (un fichero fino por dominio). Toda la lógica/SQL vive en `crates/*`.

---

## 8. Convenciones

- Comentarios y nombres de dominio en **español** (coherente con el código existente).
- Errores de caso de uso: `tpv_application::error::AppError` → se mapea a `String` en la frontera Tauri.
- Un comando Tauri NO contiene SQL ni reglas de negocio: sólo adapta entrada/salida e invoca un caso de uso.
- El frontend en **modo TPV** no hace `fetch` a la nube para datos de negocio: sólo `invokeClient(...)`. En **modo Handy**, las lecturas van por REST al worker y las escrituras también (no hay BD local).

### Capa de datos del frontend (TanStack Query)

- `QueryClient` único en `shared/lib/queryClient.ts` (staleTime 30s, sin `refetchOnWindowFocus`,
  pensado para Local-First: el dato sólo cambia por mutaciones de esta app que invalidan la clave).
  Provider en `app/main.tsx`.
- **Patrón**: cada feature expone hooks co-locados en `features/<x>/<x>Queries.ts` —
  `useQuery` para lecturas (con `queryKey` prefijada por el nombre de la feature; rangos/ids van en
  la clave) y `useMutation` para escrituras (en `onSuccess` invalidan la clave de la feature para
  recachear las listas). Los hooks envuelven las funciones de `*Apis.ts` sin cambiar su firma.
  Referencia: `features/ClientsComponents/clientesQueries.ts`.
- **Migradas a React Query**: clientes, proveedores, cuentas, reservas, tareas, trabajadores,
  estadísticas, inventario y el **catálogo de salones de mesas** (layout/meta de solo-lectura).
- **A propósito NO migradas** (siguen con `invokeClient` directo): la lógica **transaccional del POS**
  (comanda/cobro/cocina de `mesas` y todo `venta_rapida`, cuyo `vrBootstrap` entrelaza el catálogo con
  el estado de la comanda), `configuracion` (se carga una vez en stores Zustand) y `login` (flujo de
  arranque/auth). Cachearlas aportaba poco y arriesgaba el núcleo de ventas.

---

## 9. Arquitectura de sincronización (Main ↔ Nube ↔ Handy)

> **Contexto:** la refactorización eliminó el `dualCall` antiguo e implementó a continuación el
> sistema descrito aquí. Los dos modos coexisten: **TPV/offline** opera 100 % Local-First;
> **TPV/online** y **Handy** añaden la capa de replicación.

```
┌─────────────────────────┐      WebSocket (/ws)       ┌──────────────────────────────────┐
│  MAIN (Tauri + Rust)    │──── apply (outbox) ───────►│                                  │
│  SQLite local (libsql)  │◄─── change (live) ─────────│   Durable Object TenantHub       │
│  _Sync_Outbox           │                             │   (Cloudflare DO)                │
│  _Sync_Applied_Ops      │   REST /v1/sync/changes     │   · applyInternalCommand         │
│  _Sync_State (Last_Seq) │◄─── catch-up ──────────────│   · idempotente (Applied_Ops)    │
└─────────────────────────┘                             │   · broadcast a dispositivos     │
                                                        └──────────────┬───────────────────┘
┌─────────────────────────┐   REST /v1/<dominio>                      │
│  HANDY (sin BD local)   │──── escrituras ────────────────►          │
│  lee por REST, refetch  │◄─── change (WS) ────────────              │
└─────────────────────────┘                                            ▼
                                                            ┌──────────────────────┐
                                                            │  Turso (BD tenant)   │
                                                            └──────────────────────┘
```

### Archivos clave

| Pieza | Archivo | Rol |
|---|---|---|
| Captura del outbox | `crates/tpv-infra-sqlite/src/db.rs` | Cada escritura local (Main) se serializa a JSON en `_Sync_Outbox` |
| Determinismo temporal | `db.rs:114-122` + `tenantHub.ts:212-268` | `datetime('now','localtime')` → literal antes de capturar/replicar |
| WS Main | `shared/lib/useMainSocket.ts` | Drena outbox, aplica cambios remotos, hace catch-up al reconectar |
| WS Handy | `shared/lib/useHandySocket.ts` | Solo recibe `change` y dispara refetch (sin BD local) |
| Comandos Rust | `commands/sync.rs` + `use_cases/sync.rs` + `infra-sqlite/src/sync.rs` | Interfaz Tauri para marcar outbox y aplicar cambios remotos |
| Motor DO | `durableObjects/tenantHub.ts` | Aplica escrituras idempotente, guarda `Sync_Changes`, hace broadcast |
| Escrituras Handy | `lib/hub.ts` → `/internal/apply` | Cada dominio construye un comando y lo aplica vía DO |
| Constructores de comandos | `domains/*/*.commands.ts` | Construyen la transacción SQL replicable con UUIDs deterministas |
| Catch-up | `domains/sync/sync.routes.ts` | La Main pide lo perdido desde su `Last_Seq` al autenticarse |

### Reglas del sistema

- **Escritor único (Main):** todas las escrituras locales pasan por `db.rs` (no por `raw()`), que captura en `_Sync_Outbox`.
- **Idempotencia:** `Op_Id` en la nube (`Applied_Operations`) + `_Sync_Applied_Ops` en la Main evitan duplicados en catch-up/live y ecos de las propias escrituras.
- **IDs deterministas:** los `*.commands.ts` generan el UUID en un paso `kind:"value"` (`crypto.randomUUID()`) **antes** del INSERT, para que nube y Main tengan la misma fila. **Toda columna `TEXT PRIMARY KEY` debe seguir este patrón** (sin DEFAULT ni trigger en el esquema).
- **Freeze:** si no hay una Main conectada al DO, las Handy reciben `main_offline` y bloquean su UI. El modo por defecto de la Main es `offline` (se activa en Configuración → Conectividad).
- **Modo offline puro:** la Main sigue funcionando; el outbox y `_Sync_Applied_Ops` crecen pero la idempotencia los tolera. Se drenan al volver a online.
