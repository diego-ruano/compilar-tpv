# TPV — Monorepo (⚠️ REFACTORIZACIÓN ESTRUCTURAL EN CURSO)

> **Estado:** este repositorio está **en mitad de una refactorización profunda**. Se está
> migrando un TPV (Terminal Punto de Venta) de tres repos sueltos a un **monorepo híbrido
> JS/Rust** con **arquitectura hexagonal** en Rust, **generación automática de tipos** a
> TypeScript con `ts-rs`, y un frontend **Local-First puro de un solo dispositivo**.
>
> No todo está migrado todavía. Antes de tocar un módulo, mira la sección
> [**Estado de la migración**](#estado-de-la-migración) para saber qué capa ya existe y cuál no.

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
4. **Local-First puro de un solo dispositivo**: se elimina el patrón síncrono dual
   (`dualCall.ts`). El frontend invoca **directamente** comandos Tauri, asumiendo latencia cero
   y éxito instantáneo contra el SQLite local.

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
│   │       ├── tauri.conf.json · Cargo.toml · build.rs · schema.sql
│   │       └── src/
│   │           ├── main.rs    # entrada Tauri
│   │           ├── lib.rs     # registro de comandos + estado (AppState)
│   │           └── commands/  # mapeadores finos → llaman a tpv-application (objetivo)
│   │
│   ├── cloud-worker-api/         # Worker API actual (antes tpv-server) — INTACTO
│   └── cloud-worker-licensing/   # Worker licencias actual (antes tpv-licensing) — INTACTO
│
├── crates/                    # CEREBRO RUST (multi-crate hexagonal)
│   ├── tpv-domain/            # Entidades puras + validaciones (no sabe de DB ni Tauri)
│   ├── tpv-application/       # Puertos (traits) en ports/ + casos de uso en use_cases/
│   ├── tpv-infra-sqlite/      # Adaptador de persistencia (implementa puertos con libsql)
│   ├── tpv-infra-backup/      # Adaptador de FS + red para Backups
│   ├── tpv-infra-licensing/   # Adaptador cripto ed25519 + HTTP del worker de licencias
│   └── tpv-contracts/         # DTOs con #[derive(TS)] → exportan a packages/contracts
│
└── packages/                  # CÓDIGO JS COMPARTIDO
    ├── database/              # Esquema cloud (Turso/Drizzle) — reservado para el futuro
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
- **`tpv-infra-backup`** ← FS + red para backups (sustituye a la antigua sync en tiempo real).
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

### 4.4 Frontend Local-First y limpieza
- **Eliminado** el patrón `dualCall.ts` (y toda la capa de red/sync que lo acompañaba).
- **`packages/client/src/invokeClient.ts`**: cliente unificado que envuelve `invoke()` de
  `@tauri-apps/api/core`. Sin red, sin outbox, sin fallback. El frontend lee/muta directamente contra Tauri.
- Hooks y componentes de `apps/tpv-main/src/features/` consumen `@tpv/client`.

### 4.5 Restricción absoluta de los Workers
- Los dos Cloudflare Workers se han movido a `apps/cloud-worker-api/` y `apps/cloud-worker-licensing/`.
- **PROHIBIDO alterar su código interno, su `wrangler.json` ni la lógica de endpoints.** Sólo se han
  reubicado para unificarlos bajo pnpm. (Mantienen sus nombres internos `tpv-server` / `tpv-licensing`
  en su `package.json`.)

---

## 5. Decisiones tomadas (acordadas con el responsable)

1. **Git de los repos antiguos:** los `.git` originales de `tpv`, `tpv-server` y `tpv-licensing`
   se **respaldaron fuera del monorepo** (`../tpv-git-backup-pre-monorepo/`) y se eliminaron de las
   carpetas. El monorepo arranca con **git nuevo y limpio** en la raíz. No se hacen commits en los repos antiguos.
2. **Sync / Handy / Pairing:**
   - **ELIMINAR** todo lo atado a `dualCall` y a la sincronización en tiempo real (que en el futuro
     será WebSockets): `cloud_sync.rs`, `sync_manager.rs`, `fallback_local.rs`, los comandos
     `*_after_remote_ok`, y en frontend `net/*` (`dualCall.ts`, `cloudSync.ts`, `outboxSync.ts`,
     `realtimeSocket.ts`, `healthCheck.ts`) + stores `useNet` / `useSync`.
   - **MANTENER** (adaptado a hexagonal, latente para el futuro): selección de **modo Handy**,
     **emparejamiento** (`pairing.rs`), el enum `DeviceMode` y el store `useMode`. No se vuelve a
     implementar desde cero más adelante; se deja preparado.
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
- ✅ Esqueleto de las 6 crates (`tpv-domain`, `tpv-application`, `tpv-infra-sqlite`, `tpv-infra-backup`, `tpv-infra-licensing`, `tpv-contracts`).
- ✅ Esqueleto de los 3 packages (`@tpv/database`, `@tpv/contracts`, `@tpv/client` con `invokeClient.ts`).
- 🟡 `git init` en la raíz.
- ⬜ Cableado definitivo de `ts-rs` (verificación empírica single-file vs barrel) y tarea `generate-types`.
- ⬜ Migración de infra compartida Rust (`AppState`, conexión/seed de la BD, mapeos, scaffolding de puertos).
- ⬜ Migración hexagonal por dominio (domain → ports → repos sqlite → use cases).
- ⬜ DTOs `#[derive(TS)]` en `tpv-contracts` + comandos Tauri finos en `apps/tpv-main/src-tauri/src/commands/`.
- ⬜ Eliminación de la capa `dualCall` + sync (frontend `net/*`, `useNet`/`useSync`; Rust `cloud_sync`/`sync_manager`/`fallback_local` + comandos `*_after_remote_ok`).
- ⬜ Reestructuración del frontend a `app/ · features/ · shared/` consumiendo `@tpv/client` y `@tpv/contracts`.
- ⬜ Verificación final: `cargo build` + `tsc` + generación de tipos OK.

### Backend monolítico de origen (a desmontar)
`apps/tpv-main/src-tauri/src/` contiene aún el backend monolítico previo (`mesas.rs` ~136 KB,
`cloud_sync.rs` ~99 KB, `venta_rapida.rs`, `stats.rs`, etc.) y `main.rs` con TODO el registro de
comandos. Es la fuente de la migración; se irá vaciando hacia las crates. `lib.rs` actual es
boilerplate de Tauri (`greet`) — el `run()` real está en `main.rs`.

---

## 8. Convenciones

- Comentarios y nombres de dominio en **español** (coherente con el código existente).
- Errores de caso de uso: `tpv_application::error::AppError` → se mapea a `String` en la frontera Tauri.
- Un comando Tauri NO contiene SQL ni reglas de negocio: sólo adapta entrada/salida e invoca un caso de uso.
- El frontend NUNCA hace `fetch` a la nube para datos de negocio: sólo `invokeClient(...)`.
