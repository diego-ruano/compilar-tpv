# TPV — Monorepo (✅ REFACTORIZACIÓN ESTRUCTURAL COMPLETADA)

> **Estado:** la refactorización profunda está **completada**. El TPV (Terminal Punto de Venta) es
> ahora un **monorepo híbrido JS/Rust** con **arquitectura hexagonal** en Rust, **generación
> automática de tipos** a TypeScript con `ts-rs`, y un frontend **Local-First** (modo TPV) con
> **sincronización WebSocket** (automática cuando hay conexión, y siempre para la Handy)
> reestructurado en `app/ · features/ · shared/`.
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
│   │           ├── lib.rs     # crate `tpv_lib`: TODA la app (AppState, comandos, run()). Punto de
│   │           │              #   entrada COMPARTIDO escritorio+móvil (run() con #[cfg_attr(mobile, mobile_entry_point)])
│   │           ├── main.rs    # shim del binario de escritorio: fn main() { tpv_lib::run() }
│   │           └── commands/  # mapeadores finos → llaman a tpv-application
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
    ├── database/              # migrations/*.sql (esquema ÚNICO; runner Rust include_dir! + worker tenantMigrations.ts)
    │                          #   §16 del 0001 = andamiaje LOCAL del dispositivo (_Sync_*, _Jobs_State,
    │                          #   _Verifactu_*, _Recovery_State, _Backfill_Historico). Antes lo creaban a
    │                          #   mano dos funciones de db.rs: eran un segundo esquema sin versión, sin
    │                          #   hash y fuera del snapshot anti-drift. Que esas tablas se creen también
    │                          #   en el tenant de Turso es deliberado — quedan vacías, y el volcado de
    │                          #   recuperación descarta todo lo que empieza por `_`.
    │                          #   Hoy SOLO 0001_inicial.sql: mientras no haya clientes en producción,
    │                          #   un cambio de esquema se edita ahí y se resetean TANTO data.db
    │                          #   COMO los tenants Turso de desarrollo que ya tengan su hash —
    │                          #   un esquema se lee de arriba abajo y una cadena de ALTERs hay que
    │                          #   ejecutarla mentalmente. Desde el lanzamiento, todo cambio va en una
    │                          #   migración NUEVA (0002…): 0001 queda congelada y el runner rechaza
    │                          #   cualquier migración ya aplicada cuyo hash
    │                          #   cambie. Al tocar o añadir una, regístrala TAMBIÉN en el worker
    │                          #   (tenantMigrations.ts) y en test/helpers/esquemaTenant.ts, toca
    │                          #   migrations.rs para que include_dir! no sirva la copia vieja, y
    │                          #   rebendice el snapshot (BLESS_SCHEMA_SNAPSHOT=1). Y redespliega el
    │                          #   worker: lleva el esquema compilado dentro, y uno desplegado por
    │                          #   detrás rechaza la primera escritura con una columna nueva (SYNC-20).
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

### 4.4 Frontend Local-First (TPV) y capa de sync (nube/Handy)
- **Eliminado** el patrón `dualCall.ts` y sus auxiliares antiguos (`net/cloudSync`, `net/outboxSync`,
  `net/realtimeSocket`, `net/healthCheck`, stores `useNet`/`useSync`).
- **`packages/client/src/invokeClient.ts`**: cliente unificado que envuelve `invoke()` de
  `@tauri-apps/api/core`. En modo TPV, el frontend lee/muta directamente contra Tauri (SQLite local).
- Hooks y componentes de `apps/tpv-main/src/features/` consumen `@tpv/client`.
- **Capa de sync**: outbox + WebSocket + DO TenantHub, **activa siempre que haya conexión** (no hay
  ajuste que encender: SYNC-17). El detalle completo está en **§9**. Los hooks clave son
  `useMainSocket` (Main, y única fuente del estado de conexión) y `useHandySocket` (Handy).

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
>
> ⚠️ **Windows — `Failed("Are you sure you have RC.EXE in your $PATH…")`.** Si un build de escritorio
> revienta con eso, no es el código: es que `embed-resource` (vía `tauri-build`) busca `rc.exe` del
> SDK de Windows leyendo `HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots\KitsRoot10`, y en
> algunas máquinas esa clave apunta a `C:\Program Files\Windows Kits\10\` mientras el SDK real está
> en `C:\Program Files (x86)\Windows Kits\10\`. Solución: apuntar la variable de entorno **`RC`** al
> ejecutable real, p. ej.
> `setx RC "C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\rc.exe"` (abre una terminal
> nueva después). Solo salta cuando el build script se re-ejecuta, o sea al tocar `tauri.conf.json`
> o las capabilities — por eso puede aparecer "de repente" en un repo que compilaba.

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

cargo nextest run                  # ⬅ los tests de Rust van POR AQUÍ (ver abajo)
cargo install cargo-nextest --locked   # si no lo tienes

pnpm --filter @tpv/main build:e2e  # compila el binario aislado del E2E (§16)
pnpm --filter @tpv/main test:e2e   # el recorrido del camino del dinero (TEST-01)
```

### Los tests de Rust se corren con `cargo nextest`

`cargo test` mete todos los tests en **un solo proceso**, y libsql tiene un crash nativo
(`STATUS_ACCESS_VIOLATION`) al crear bases de datos. En un proceso compartido eso mata la tanda
entera: no dice en qué test fue ni deja veredicto del resto. Con la suite completa pasaba
**una de cada tres ejecuciones**, que es lo mismo que no tener suite.

`cargo nextest run` corre cada test en su propio proceso, así que ese fallo aborta un test y los
demás siguen. La configuración (`.config/nextest.toml`) añade **dos reintentos**, que es lo que
convierte ese 1 % en un `FLAKY` visible en vez de un rojo. Los reintentos no tapan nada nuestro:
una aserción que falla, falla igual las tres veces.

**Subir la versión no lo arregla**: se comprobó pasando de 0.3.5 a 0.9.30 y el fallo sigue igual
(el `Connection` de libsql, con su cierre por `Arc::get_mut`, es idéntico en las dos). Lo que lo
dispara es crear **muchas** bases en un proceso —200 seguidas revientan la mitad de las veces—,
que es lo que hace un suite y no lo que hace el TPV: una sola creación aguantó 100 de 100, y una
base con 6.000 sentencias encima, 10 de 10. Los directorios temporales de los tests cuelgan todos de
`%TEMP%/tpv_tests` y se purgan al empezar la tanda siguiente (ver `test_temp.rs`): antes se
quedaban en `%TEMP%` para siempre y se habían acumulado 18.000 carpetas y 4 GB.

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
- ✅ Patrón hexagonal compartido establecido: `tpv-infra-sqlite::mapping`, `tpv-application::{ports,use_cases}`, `AppError`→`AppErrorDto`.
- ✅ **Módulo `clientes` migrado (PILOTO/REFERENCIA)** end-to-end: domain → ports → repo sqlite → use cases → contracts (DTOs ts-rs) → comando Tauri fino + **rewire frontend a `@tpv/client`** (sin dualCall). Verificado: `cargo check -p tpv` ✅, `cargo test -p tpv-contracts` ✅, `tsc` frontend ✅.
- ✅ `pnpm install` ejecutado (workspace enlazado). Frontend pasa `tsc` (la antigua duda de `lucide-react` en `Carousel.tsx` ya no bloquea: el componente quedó sin uso y el type-check es verde).
- ✅ **Todos los dominios migrados** siguiendo el patrón de `clientes` (monolito estrangulado por completo): `clientes`, `stats`, `tareas`, `trabajadores`, `venta_rapida`, `mesas`, `inventario`, `cuentas`, `reservas`, `proveedores`, `configuracion`, `login`; y `licensing`/`pairing` (a `tpv-infra-licensing`). `apps/tpv-main/src-tauri/src/` ya sólo contiene `lib.rs` (toda la app), `main.rs` (shim) y `commands/` (capa fina). Alta/edición local de trabajador añadida (`trabajadores_create`/`trabajadores_update`).
- ✅ Auditoría de fidelidad multi-agente de `licensing`/`pairing`; bug detectado y corregido (`AppError::Raw` para propagar verbatim los códigos de negocio del worker, p. ej. `not_approved` del pairing Handy).
- ✅ Eliminada la capa `dualCall` antigua + auxiliares: frontend `net/*` (`dualCall`, `cloudSync`, `outboxSync`, `realtimeSocket`, `healthCheck`) y stores `useNet`/`useSync`; Rust `cloud_sync`/`sync_manager`/`fallback_local` + wiring y comandos `*_after_remote_ok`. Reemplazada por el sistema outbox + WebSocket + TenantHub (§9). Pairing Handy se conserva activo.
- ✅ Conexión/seed de la BD movidos a `tpv-infra-sqlite::connection` (`init_main_db(app_data_dir)`); el esquema lo construyen las migraciones embebidas (`packages/database/migrations/`, ver `migrations.rs`), el shell (`lib.rs::run`) sólo aporta la ruta AppData.
- ✅ Reestructuración del frontend a `app/ · features/ · shared/` (+ `assets/`). `pages/` y `layoutComponent` viven bajo `app/`; los dominios bajo `features/`; stores/ui/toast/ticket/lib bajo `shared/`. Entry `index.html` → `/src/app/main.tsx`.
- ✅ Verificación final: `cargo build` (workspace completo) + `cargo test -p tpv-contracts` + `tsc` frontend + `pnpm generate-types` (turbo) OK. Reparado el pipeline turbo (claves `"//"` inline y `packageManager` ausente).
- ✅ **Compilación a Android** (modo Handy) operativa. La app se movió a la crate de librería `tpv_lib`
  (`lib.rs`) como **entry compartido escritorio+móvil**; el cdylib `libtpv_lib.so` arranca por
  `#[tauri::mobile_entry_point]`, y `main.rs` es un shim. Almacén de secretos por plataforma
  (`tpv-infra-licensing::secret_store`: `keyring` en escritorio, **Android Keystore AES-GCM vía JNI**
  en Android — la `JavaVM` se captura en `JNI_OnLoad`); `tauri-plugin-updater` y `tauri-plugin-sentry`
  (+minidump) gateados a `#[cfg(desktop)]`; `sentry` a **rustls** (evita openssl); permiso `wss:` en el
  CSP. Validado en emulador (identidad persiste tras reinicio, pairing + sync Handy OK). **Toolchain,
  bugs resueltos y bitácora completa en [docs/android/COMPILAR_ANDROID.md](docs/android/COMPILAR_ANDROID.md).**

### Patrón de referencia para migrar un módulo (seguir `clientes`)
1. `tpv-domain/src/<m>.rs`: entidades + validación pura. Registrar en `domain/src/lib.rs`.
2. `tpv-contracts/src/<m>.rs`: DTOs con `#[derive(TS)]` + `#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]`. IDs `i64` con `#[ts(type = "number")]`. **Campos snake_case idénticos al struct antiguo** (compat frontend). Registrar en `contracts/src/lib.rs`.
3. `tpv-application/src/ports/<m>.rs`: trait `…Repository` (async). Registrar en `ports/mod.rs`.
4. `tpv-application/src/use_cases/<m>.rs`: orquestación + validación de dominio. Registrar en `use_cases/mod.rs`.
5. `tpv-infra-sqlite/src/<m>.rs`: `Sqlite…Repository` con el SQL (sin outbox/Applied_Operations — Local-First). Usa `crate::mapping`. Registrar en `infra-sqlite/src/lib.rs`.
6. `apps/tpv-main/src-tauri/src/commands/<m>.rs`: comandos finos (mismos nombres). Registrar en `commands/mod.rs` y reapuntar `lib.rs` (quitar `mod <m>;` viejo + registrar `commands::<m>::…`). Borrar el `<m>.rs` monolítico.
7. Frontend `…Apis.ts`: cambiar `dualCall` por `invokeClient` de `@tpv/client`, tipos de `@tpv/contracts`, sin `op_id`/outbox.

### Backend monolítico de origen (desmontado ✅)
El backend monolítico previo (`mesas.rs`, `cloud_sync.rs`, `venta_rapida.rs`, `stats.rs`, …) se ha
vaciado por completo hacia las crates hexagonales. `apps/tpv-main/src-tauri/src/` ya sólo contiene
`lib.rs` (crate `tpv_lib`: modo device, AppData, registro de comandos, `run()` con
`#[cfg_attr(mobile, tauri::mobile_entry_point)]` — entry compartido escritorio+móvil), `main.rs`
(shim del binario: `fn main() { tpv_lib::run() }`) y `commands/` (un fichero fino por dominio). Toda
la lógica/SQL vive en `crates/*`.

---

## 8. Convenciones

- **PROHIBIDO `npm` y `npx` en este repo — el gestor es `pnpm`, siempre y para todo.** Aplica a
  cualquiera que trabaje aquí, **incluido Claude**: ni en comandos, ni en scripts, ni en la
  documentación. Equivalencias:

  | ❌ Nunca | ✅ Siempre |
  |---|---|
  | `npm install` / `npm i` | `pnpm install` |
  | `npm install <pkg>` | `pnpm add <pkg>` (`-D` para dev, `-w` para la raíz) |
  | `npx <bin>` | `pnpm exec <bin>` (p. ej. `pnpm exec wrangler deploy`) |
  | `npm run <script>` | `pnpm <script>` / `pnpm --filter <paquete> <script>` |

  Mezclar npm rompe el workspace: genera un `package-lock.json` paralelo al `pnpm-lock.yaml`, aplana
  `node_modules` (se pierde el aislamiento estricto de pnpm) y reaparecen los problemas de rutas
  largas en Windows que motivaron la purga de `node_modules` (§6).
- **PROHIBIDO el trailer `Co-Authored-By` (y cualquier atribución a Claude/Anthropic) en los mensajes
  de commit y en las descripciones de PR.** Ningún commit puede llevar la línea `Co-Authored-By:`. La
  prohibición está aplicada también en `.claude/settings.json` (`includeCoAuthoredBy: false` +
  `attribution.commit/pr: ""`).
- Comentarios y nombres de dominio en **español** (coherente con el código existente).
- **PII del personal cifrada (TRAB-03).** `DNI`, `IBAN` y `Numero_Seguridad_Social` se guardan
  cifrados (AES-256-GCM **determinista**, para que el `UNIQUE` del esquema siga detectando
  duplicados). El cifrado ocurre en `tpv-infra-sqlite::trabajadores` **antes** de construir la
  sentencia, así que el outbox replica ya el texto cifrado y el sync no se entera. Consecuencia de
  diseño: la Handy no tiene la clave, así que los comandos del worker **ni escriben ni devuelven**
  esas tres columnas y su UI las oculta; se rellenan desde la Main. Detalle en
  `crates/tpv-infra-licensing/src/field_crypto.rs`.
  - **Qué protege exactamente, y qué no.** El cifrado saca la PII del alcance de quien lea la BD
    del tenant en Turso —que es el escenario realista— pero **no** la pone fuera del alcance del
    proveedor. La DEK la genera el worker al aprovisionar y **persiste en el control-plane**
    (`tenants.field_dek`, cifrada en reposo con `LICENSE_STORE_KEY`); `/v1/license/activate` la
    reentrega en cada activación (`getOrCreateTenantFieldDek` devuelve la existente, no una nueva).
    O sea que el proveedor tiene a la vez el texto cifrado (Turso) y la clave (control-plane).
    Decirlo importa para el papeleo de RGPD: eres encargado del tratamiento **con** acceso efectivo
    a esos datos, no un mero custodio de bytes opacos.
  - **Que la DEK persista arriba es lo que hace recuperable la PII**, incluso en un equipo nuevo.
    El precio es que `LICENSE_STORE_KEY` es un secreto **global**: perderlo deja las DEK de todos
    los tenants indescifrables y la PII irrecuperable en todas partes.
- **El NOMBRE de un comando Tauri no lo comprueba nadie.** Los tipos que cruzan la frontera sí están
  cerrados (ts-rs genera `bindings.ts` desde los DTO), pero el nombre es una cadena: renombrar un
  `#[tauri::command]` compila en Rust, compila en TypeScript y revienta en tiempo de ejecución con
  *command not found*, en el equipo del cliente. Lo cubre `scripts/check-comandos-tauri.mjs`, que en
  CI **rompe** si el frontend (o el E2E) invoca por nombre algo que no esté en el `generate_handler!`.
  Su punto ciego son las invocaciones cuyo nombre es una variable: las enumera para que se vean.
- **Al tocar un `*.schemas.ts` del worker**: cada schema con contrapartida en Rust lleva al final un
  drift-guard (`Assert<SameKeys<z.infer<typeof xSchema>, XInput>>`, ver `src/lib/typeGuards.ts`). Si
  añades un campo al zod, añádelo también al DTO de Rust (o al revés): el guard compara las claves en
  **las dos direcciones** y el worker no compila hasta que coincidan. Los tipos de los valores ya los
  cubre el paso de `p.data` al command builder, así que entre ambos el contrato queda cerrado.
- Errores de caso de uso: `tpv_application::error::AppError` → se mapea a **`AppErrorDto { code, message }`**
  en la frontera Tauri (ARCH-02/05). El `code` sale del catálogo cerrado `ErrorCode`
  (`crates/tpv-contracts/src/errors.rs`, exportado a TS por ts-rs y consumido también por el worker),
  y es **lo único por lo que se ramifica**: el `message` es texto diagnóstico y nunca se compara.
  Un código nuevo se añade sólo si alguien necesita **hacer algo distinto** con ese caso; si sólo se
  muestra, es un `message` con el código genérico que corresponda. En el frontend, `toAppError(e)` /
  `esError(e, "…")` de `@tpv/client` normalizan lo capturado.
- Un comando Tauri NO contiene SQL ni reglas de negocio: sólo adapta entrada/salida e invoca un caso de uso.
- El frontend en **modo TPV** no hace `fetch` a la nube para datos de negocio: sólo `invokeClient(...)`. En **modo Handy**, las lecturas van por REST al worker y las escrituras también (no hay BD local).

### Linters: análisis, no formato (INFRA-04)

`pnpm lint` (ESLint, todo el monorepo) y `pnpm lint:rust` (clippy, el workspace entero). Los dos
corren en CI — clippy dentro del job de tests de Rust, para no pagar el build dos veces.

**No hay formateador y no debe haberlo.** No hay reglas de comillas, ni de punto y coma, ni de
sangría: el código ya está escrito y reescribirlo entero en un commit sólo enterraría el historial.
Las reglas que hay son de **análisis** — cazan lo que `tsc` no puede ver — y son **cuatro**:

| Regla | Qué caza | Nivel |
|---|---|---|
| `react-hooks/rules-of-hooks` | un hook dentro de un `if`: corrompe el estado del componente | error |
| `react-hooks/exhaustive-deps` | *stale closures*: un efecto que actúa sobre un valor caducado | aviso |
| `@typescript-eslint/no-floating-promises` | una promesa rechazada sin `catch`, o sea un fallo **mudo** | error |
| `@typescript-eslint/no-misused-promises` | la misma promesa entregada a quien no la espera (`onClick={guardar}`, `setTimeout(async …)`): React la tira | error |

**Antes de añadir la quinta**, la pregunta no es «¿esto es mejor estilo?» sino «¿esta regla habría
cazado un bug que hemos tenido?». Es la misma razón por la que la lista de comandos gateados de
SEC-01 es corta: un linter que grita se desactiva a la semana, y entonces no queda ni el linter ni
la costumbre. Lo que se apaga está apagado **con su motivo escrito** en `eslint.config.mjs`; si vas
a encender algo, lee esos motivos primero.

- `exhaustive-deps` va en **aviso** y no en error a propósito: a veces la dependencia se omite a
  sabiendas. Lo que importa es que cada omisión sea una decisión visible, no que no exista. Por eso
  CI **no** pasa `--max-warnings 0`.
- **Los `packages/*` quedan fuera del análisis con tipos** porque no tienen `tsconfig.json`, y sin
  proyecto no hay tipos que consultar. Si algún día lo ganan, muévelos al primer bloque de la
  configuración y heredarán la regla de las promesas.
- **`void` no es decoración.** Marca «esto es fuego y olvido, a sabiendas». Si lo que va detrás
  puede fallar de una forma que el usuario deba ver, `void` es la respuesta equivocada: lo correcto
  es un `.catch` que lo cuente. Si lo que se entrega es un manejador (`onClick`, `onSubmit`, un
  `setTimeout`), ese `.catch` ya existe: `conAviso(fn)` (`shared/lib/conAviso.ts`) reporta a Sentry
  y lo dice en pantalla.

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

### CSP: política estricta (qué puede cargar la webview)

`tauri.conf.json` (`app.security`) declara una CSP **cerrada** y su `devCsp` gemela:

| Directiva | Valor | Por qué |
|---|---|---|
| `script-src` | `'self'` | Solo el bundle. Un XSS **no** puede ejecutar código inyectado ni traerlo de fuera. En `devCsp` lleva `'unsafe-inline'` porque el preámbulo de react-refresh lo necesita |
| `connect-src` | `'self' ipc: http://ipc.localhost wss://tpv-api…` | El IPC de Tauri y **solo** el WebSocket de la nube. El REST no va por aquí: lo hace Rust. En `devCsp` se añade `ws:` para el HMR |
| `img-src` | `'self' asset: …asset.localhost <bucket R2> blob: data:` | `asset:` = imágenes locales de la Main; el bucket = imágenes de la **Handy** |
| `style-src` | `'self'` | Ver abajo |
| `object-src` `frame-src` | `'none'` | La app no usa plugins ni iframes |

**Regla al añadir cualquier origen externo** (un CDN de imágenes propio, otro host de API, una
fuente): hay que meterlo en **las dos**, `csp` y `devCsp`, o funcionará en dev y fallará en el
build. El `<script>` inline de `index.html` (anti-FOUC) sigue funcionando con `script-src 'self'`
porque Tauri le calcula el **sha256 al empaquetar** y lo añade a la directiva; eso vale solo para
HTML embebido, de ahí el `'unsafe-inline'` de la `devCsp`.

**Cómo se verifica** (no hace falta recorrer pantallas): arranca un build **empaquetado**, abre su
DevTools remoto y pregunta a la CSP directamente —
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` en escritorio, o
`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` en Android — y desde CDP evalúa
la carga del recurso escuchando `securitypolicyviolation`, que te dice la directiva culpable. En
`docs/android/COMPILAR_ANDROID.md` está la receta completa con los comandos.

#### Prohibido inyectar `<style>` en runtime

`style-src 'self'` no lleva `'unsafe-inline'`. Por tanto **todo CSS debe pasar por el bundle de
Vite** y llegar como `<link rel="stylesheet">`. Quedan prohibidos:

- `<style>{`…`}</style>` renderizado por React,
- `document.createElement("style")` en tiempo de ejecución,
- librerías que se auto-inyecten su CSS (ver más abajo).

⚠️ **Esta clase de bug no se ve en `pnpm tauri dev` (escritorio).** La CSP sólo se aplica a los
assets que sirve el protocolo `tauri://`, o sea al **build empaquetado**. En escritorio-dev
`PROXY_DEV_SERVER` es `false` (`tauri/src/manager/webview.rs`), así que el webview carga el
servidor de Vite (`http://localhost:1420`) tal cual, **sin ninguna cabecera CSP**. Un `<style>`
inline se ve perfecto en dev y roto en el `.exe` instalado. La `devCsp` no lo replica: en
escritorio Tauri no puede inyectar la cabecera en un `devUrl` externo, y además el servidor de Vite
en dev *necesita* estilos inline para el HMR del CSS. **En Android sí aplica** (el Chromium de la
webview además es más estricto que WebView2), así que el emulador es el mejor sitio para cazarlo.

**Caso real (ApexCharts):** v5 lleva su CSS embebido como string dentro del JS y lo inyecta al
montar la primera gráfica. Al bloquearse, las gráficas se quedaban sin ninguna regla (tooltips
estáticos siempre visibles, leyenda sin flex, sensores de resize sin ocultar) y Estadísticas se
descuadraba entera. Solución: `injectStyleSheet: false` vía `APEX_CHART_BASE`
(`features/estadisticas/apexBase.ts`, que **toda gráfica nueva debe esparcir en su `chart: {}`**)
+ `@import` de las dos hojas de ApexCharts al principio de `Global.css`.

**Al meter una librería con estilos, compruébalo:** si trae un `.css` en `dist/`, impórtalo; si
se lo auto-inyecta, busca su opción para desactivarlo. Y verifica siempre en un build empaquetado,
no sólo en dev.

---

## 9. Arquitectura de sincronización (Main ↔ Nube ↔ Handy)

> **Contexto:** la refactorización eliminó el `dualCall` antiguo e implementó a continuación el
> sistema descrito aquí. La Main es **siempre** Local-First (vende contra su SQLite haya red o no);
> la capa de replicación se añade **cuando hay conexión**, que ya no es una elección del usuario
> (SYNC-17, ver *Conectividad* abajo). La **Handy** no tiene BD local: sin nube no opera.

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
| Cuarentena de subida | `tenantHub.errores.ts` + `infra-sqlite/src/sync.rs::outbox_mark_failed` | SYNC-20: un rechazo definitivo aparta la operación en vez de detener la cola |
| Reparación por estado | `infra-sqlite/src/sync_reparacion.rs` | SYNC-22: reencola la fila APARTADA tal como está ahora, no la sentencia que fue rechazada |
| Contraste con la nube | `sync.routes.ts::/verificar` + `sync.rs::contrastar_con_la_nube` + job `verificar_nube` | SYNC-24: comprueba a diario que las dos bases dicen lo mismo, repara e informa a Axiom |
| Determinismo temporal | `db.rs::rewrite_now_literals` + `durableObjects/tenantHub.tiempo.ts` | CFG-04: toda forma de «ahora» se fija a literal antes de ejecutar (la Main ejecuta en local la misma sentencia que sube) o de aplicar (el DO, con la hora del emisor). Con tests (`test/tenantHubTiempo.test.ts`) |
| WS Main | `shared/lib/useMainSocket.ts` | Drena outbox (o lo **vuelca** si hay atraso, SYNC-18), aplica cambios remotos, hace catch-up al reconectar. **Única fuente del estado de conexión** (`useEstadoSync`) |
| Cola del DO | `durableObjects/tenantHub.ts` (`_Cola_Entrada`) | SYNC-18: guarda el atraso volcado por la Main y lo aplica por `alarm`, en lotes, sin el cliente delante |
| WS Handy | `shared/lib/useHandySocket.ts` | Solo recibe `change` y dispara refetch (sin BD local) |
| Comandos Rust | `commands/sync.rs` + `use_cases/sync.rs` + `infra-sqlite/src/sync.rs` | Interfaz Tauri para marcar outbox y aplicar cambios remotos |
| Motor DO | `durableObjects/tenantHub.ts` | Aplica escrituras idempotente, guarda `Sync_Changes`, hace broadcast. **Usa la WebSocket Hibernation API** (ver regla abajo) |
| Escrituras Handy | `lib/hub.ts` → `/internal/apply` | Cada dominio construye un comando y lo aplica vía DO |
| Constructores de comandos | `domains/*/*.commands.ts` | Construyen la transacción SQL replicable con UUIDs deterministas |
| Catch-up | `domains/sync/sync.routes.ts` | La Main pide lo perdido desde su `Last_Seq` al autenticarse |
| Bootstrap | `domains/sync/sync.routes.ts` + `infra-sqlite/src/sync.rs` | Reconstruye una Main que ha perdido su `data.db` (ver abajo) |

### Reglas del sistema

- **Escritor único (Main):** todas las escrituras locales pasan por `db.rs` (no por `raw()`), que captura en `_Sync_Outbox`.
- **Idempotencia:** `Op_Id` en la nube (`Applied_Operations`) + `_Sync_Applied_Ops` en la Main evitan duplicados en catch-up/live y ecos de las propias escrituras.
- **IDs deterministas:** los `*.commands.ts` generan el UUID en un paso `kind:"value"` (`crypto.randomUUID()`) **antes** del INSERT, para que nube y Main tengan la misma fila. **Toda columna `TEXT PRIMARY KEY` debe seguir este patrón** (sin DEFAULT ni trigger en el esquema).
- **La hora la pone quien escribe, nunca una base (CFG-04).** Una sentencia que viajara con su
  `datetime('now')` la evaluaría la nube al aplicarla —segundos después, o días si el TPV estuvo sin
  conexión— y en UTC. Reglas al tocar esto:
  - **Una operación, un instante.** La Main fija la hora al abrir la transacción (o al ejecutar una
    escritura suelta) y resuelve con ella todas sus sentencias: `'now'` con `'localtime'`, con o sin
    modificadores, pasa a la hora local fija; `'now'` sin él y `CURRENT_*`, a la UTC fija.
  - **En local se ejecuta la misma sentencia que sube.** Si el TPV ejecutara la original y subiera
    la reescrita, las dos horas podrían caer en segundos distintos.
  - **El esquema no tiene `DEFAULT` de hora**, y lo vigila un test. Un `INSERT` que omitía la
    columna dejaba la hora en manos de cada base, y Turso la rellenaba con su reloj y en UTC. Quien
    inserta, la informa.
  - **La nube sólo sabe fijar la hora local del emisor** (`X-Client-Now`). Un `'now'` en UTC o un
    `CURRENT_*` en una escritura de la Handy no tienen con qué resolverse, y el DO los rechaza
    (`hora_no_determinista`) en vez de dejar que Turso elija.
  - **Lo que no puede fijar nadie es un `'localtime'` aplicado a un valor**
    (`datetime(Fecha,'localtime')`): depende de la zona de quien lo ejecuta. En desarrollo revienta;
    en el equipo del cliente no se bloquea la escritura —puede ser un cobro— pero queda anotado.
- **Canal de la comanda:** una `Comandas` es un ticket y su origen lo marca `Canal` (`'MESA'` con
  `ID_Mesa`, `'BARRA'` = venta rápida **sin** mesa). El índice único `idx_comandas_una_abierta_por_mesa`
  garantiza una comanda abierta por mesa real; los tickets de barra no compiten entre sí porque en
  SQLite los `NULL` son distintos en un índice UNIQUE. Un `CHECK` impide mezclar canal y mesa. Si
  añades un canal nuevo ('LLEVAR', 'DELIVERY'…), basta ampliar el `CHECK`: no se tocan índices ni seeds.
- **Freeze:** si no hay una Main conectada al DO, las Handy reciben `main_offline` y bloquean su UI.
- **Conectividad automática (SYNC-17):** **no existe un ajuste online/offline.** La Main abre el WS
  siempre que sea el dispositivo `tpv`; el estado real (`conectado` · `reintentando` ·
  `sin_identidad` · `rechazado` · `pausada`) lo publica `useMainSocket` en el store
  **`useEstadoSync`** y lo pinta Configuración → Conectividad. Reglas al tocar esto:
  - **La autoridad es el worker.** `/v1/ws/ticket` exige JWT + device-proof y además comprueba la
    licencia (`computeLicenseState`/`stateAllowsUse`, los mismos que firman `/v1/license/status`) y
    que un rol `tpv` siga siendo el `main_device_id`. El cliente no decide si "puede" conectarse:
    lo intenta y obedece. Un 403 se traduce a `rechazado` y espacia los reintentos.
  - **La gracia por caducidad sincroniza.** `expiry_grace` pasa el filtro a propósito: durante esos
    días el TPV sigue vendiendo, y vender sin replicar es la peor combinación.
  - **Anular una licencia empuja; caducar, no.** `POST /v1/admin/licenses/:id/revoke` le pide al
    `TenantHub` del tenant que cierre el socket de la Main (`lib/hub.ts::cerrarSocketsDelDispositivo`
    → `/internal/revoke`). No hace falta ningún mensaje nuevo del DO: **basta con cerrar**, porque el
    cliente reconecta a los 3 s, se lleva un 403 y `useMainSocket` traduce ese rechazo en un
    `license_check_now` que emite `license:changed` y tapa la aplicación. Sin eso, el único pulso era
    el job `licencia` —**cada 6 horas**— y un equipo anulado seguía vendiendo medio día. Reglas:
    - **Es best-effort, dentro de un `try`/`catch`, y tiene que serlo.** Lo que manda es el
      control-plane; esto sólo adelanta el momento en que el equipo se entera. Que un DO caído
      pudiera impedir anular una licencia sería cambiar un retraso por una operación imposible.
    - **Las Handy no se cierran a mano.** El DO las congela (`main_offline`) en cuanto la Main se va,
      y al reconectar su ticket también se rechaza.
    - **Lo frágil es la firma, no el cierre.** El payload HMAC incluye método, `pathname` y cuerpo:
      desalinear cualquiera de los tres da un 401 en el DO **en silencio**, porque es best-effort. Lo
      fija `adminLicenciaReversible.test.ts`, que pasa la request capturada por el mismo verificador.
    - Lo que queda fuera y no tiene arreglo: un equipo **sin socket** (apagado, sin red) sigue
      dependiendo del job. Tampoco importa: sin nube no está replicando de todos modos.
  - **Palanca de emergencia sin UI:** `connectivity: "auto" | "off"` en `device_config.json`
    (comandos `get/set_connection_mode`). Sirve para una red patológica o un cliente que no quiera
    nube. La captura del outbox NO depende de ella: al volver a `auto` se drena lo acumulado.
  - **Socket medio-muerto:** el latido verifica el `pong` (el DO lo contesta en el edge) y cierra
    tras dos latidos sin respuesta; además se reconecta al instante ante `online`/`focus`/
    `visibilitychange`. Sin ambos, un TCP medio-abierto se quedaba mudo para siempre.
- **Sin conexión:** la Main sigue funcionando; el outbox y `_Sync_Applied_Ops` crecen pero la idempotencia los tolera. Se drenan al recuperarla.
- **Un rechazo de subida no puede parar la cola (SYNC-20).** El outbox está ordenado, así que el
  drenado sube una operación y no pasa a la siguiente hasta que la nube confirma. Mientras el
  `apply_ack` sólo llevaba un texto de error, el cliente no podía distinguir «no ha salido» de «no
  va a salir» y hacía lo único prudente: parar y reintentar — **para siempre, con un día de ventas
  detenido detrás y sin decírselo a nadie**. Reglas al tocarlo:
  - **Quien clasifica es el DO**, que tiene la excepción delante (`tenantHub.errores.ts`), y el
    veredicto viaja en el ack (`permanente`). El cliente **no** compara textos de error: los
    mensajes de libsql cambian de redacción entre versiones y esa comparación se pudre sin que nada
    falle de forma visible.
  - **Se falla hacia TRANSITORIO.** Apartar deja a la nube divergente en esa fila; reintentar de más
    sólo cuesta tiempo, y un error desconocido se apartará igual al agotar `MAX_SUBIDA_ATTEMPTS`.
  - **Una apartada no se borra ni se reintenta luego.** Es lo único que queda de un dato que la nube
    no tiene, y reaplicar más tarde un `UPDATE` viejo por encima de uno nuevo no repara el dato: lo
    corrompe. Por eso `asegurar_reemplazo_seguro` **sí** la sigue contando (restaurar la borraría).
  - **Se cuenta aparte de lo pendiente.** `outbox_pending` es lo que todavía puede subir; sumarle
    las apartadas dejaría ese número clavado para siempre, que es el síntoma mudo que esto arregla.
  - **Es la misma política que el DO ya aplicaba a su cola de entrada** (`_Cola_Muerta`, SYNC-18).
    Lo que faltaba era el camino **en vivo**, que es por donde va un TPV al día.
  - **El aviso va a dos sitios distintos a propósito.** A Sentry, el diagnóstico (op_id, comando y
    error de la nube — nunca las sentencias: llevan datos de negocio y PII); al cliente, sólo la
    consecuencia, porque un `op_id` no lo puede usar quien está delante del TPV.
- **Volcado del atraso (SYNC-18):** cuando la Main conecta con **más de 100 operaciones**
  acumuladas, no las sube de una en una: las manda por trozos (`bulk_apply`) a una **cola durable
  en el SQLite del propio DO** y termina en cuanto sube la última, sin esperar a que se apliquen.
  A partir de ahí el TPV puede quedarse otra vez sin internet sin perder nada. Reglas al tocarlo:
  - **El umbral se mira solo al conectar.** Una ráfaga a mitad de servicio (importar un catálogo)
    sigue por el camino en vivo, que es el que hace que el Handy vea el cambio al instante.
  - **Encolada ≠ aplicada.** Entre medias hay un estado (`_Sync_Encoladas` en la Main): la fila
    sigue en el outbox y lo que la da por buena es **verla volver por el catch-up**, que es la
    única prueba de que se aplicó. Una encolada sin confirmar en 1 h vuelve a ofrecerse (reenviar
    es inocuo: la nube es idempotente por `Op_Id`).
  - **Se aplica en Turso primero y se borra de la cola después.** Si el DO muere entre las dos, la
    operación se reaplica y el filtro por `Op_Id` la reconoce: se pierde una lectura, nunca un dato.
  - **Con cola pendiente, todo va a la cola** — también un `apply` en vivo. El outbox está ordenado
    y sus operaciones se apoyan unas en otras: colarse por delante sería aplicar el futuro antes
    que el pasado.
  - **Agrupar exige filtrar antes las ya aplicadas** (`applyBatchIdempotent`): el gate por `Op_Id`
    está hecho para que un duplicado tire la transacción, y agrupado se llevaría por delante a las
    buenas, atascándose para siempre.
  - **Las Handy esperan** mientras haya cola (`main_volcando`): la nube está a medio construir. El
    estado *es* que la cola no esté vacía — no hay flag, que se evaporaría al hibernar.
  - **El `alarm` captura sus excepciones y se reprograma a mano**: el reintento automático se rinde
    a los 6 intentos y la cola se quedaría muerta en silencio. Y para si una vuelta no la reduce,
    para no girar en caliente (que además se factura).
- **Una divergencia se repara por ESTADO, nunca reintentando la sentencia (SYNC-22/24).** Apartar
  una operación evita el atasco pero deja la nube distinta, y la Handy —que no tiene BD local— pasa
  entonces a enseñar otra cosa que la Main. Reglas:
  - **Se manda cómo está la fila AHORA**, como `INSERT OR REPLACE`. Reaplicar la sentencia vieja no
    repara el dato: lo devuelve a un valor que ya no es cierto. Lo de ahora es idempotente, no
    depende del orden y converge.
  - **Una reparación es una escritura más**: se encola en el outbox y sube por el camino de siempre.
    No hay transporte nuevo que mantener. Pero **una reparación no se repara** (`Command_Name`
    propio), o una fila que la nube rechaza generaría una por cada intento.
  - **«La nube tiene una fila que aquí no está» sólo se borra arriba si esta Main está al día
    (SYNC-25).** Hasta entonces es indistinguible de una fila que la Handy acaba de crear y todavía
    no ha llegado. Las separa el reloj de la replicación: si el checkpoint local alcanza el `Seq` de
    la foto —leído **después** de las filas—, lo que falte aquí es un borrado que no subió. Con una
    lista de claves truncada no se borra nada: media lista se leería como «sobra todo».
  - ⚠️ **NUNCA `INSERT OR REPLACE`** para reparar. En SQLite eso BORRA la fila y la reinserta, así
    que dispara los `ON DELETE CASCADE` que la apuntan — y este esquema tiene **dieciocho**.
    Reparar una `Zona` se llevaba por delante todas sus `Mesas`. Va `ON CONFLICT(pk) DO UPDATE`.
  - **Nada se toca si esta Main no puede afirmar que está al día** (checkpoint por detrás de la
    foto, o cuarentena de bajada). Vale para borrar **y para actualizar**: si va atrasada, una fila
    «distinta» puede serlo porque la Handy acaba de escribirla, y repararla mandaría lo viejo
    encima de lo nuevo. El job va por REST, así que corre con el WebSocket caído — justo cuando más
    atrasada está.
  - **El aviso se apaga solo.** Al subir una reparación se retira la operación apartada que la
    motivó (`Repara_Op_Id`), en la misma transacción. Un aviso que hay que descartar a mano cuando
    el problema ya está resuelto enseña a descartar avisos.
  - **La comparación es tolerante con los números** (`2.5` vs `"2.50"`): dos drivers escriben la
    misma cifra de dos maneras, y sin esa tolerancia cada pasada daría por descuadrada toda tabla
    con una columna numérica. Un panel que siempre grita es un panel apagado.
  - **El informe va a Axiom, no al usuario.** Un descuadre no lo puede atender quien está delante
    del TPV. Él sólo ve la consecuencia, en Conectividad.
- **Hibernación del DO (SYNC-16):** `TenantHub` usa la **WebSocket Hibernation API**: el DO se evacúa
  de memoria (deja de facturar duración) mientras las conexiones están ociosas —sin cerrarlas— y
  despierta al llegar un mensaje. El latido `{"type":"ping"}` lo contesta el **auto-response** en el
  edge sin despertarlo. **Consecuencia al tocar `tenantHub.ts`: prohibido guardar estado de sesión en
  campos de la instancia** (al despertar está vacía): va en el *attachment* de cada socket
  (`ws.serializeAttachment`, re-serializar tras cada cambio) y el censo se saca de
  `state.getWebSockets()`. Tampoco puede haber `setInterval`/`alarm` periódicos: mantendrían el DO
  despierto. Detalle completo y reglas en
  [docs/analisis/transversal/sync-tenanthub.md](docs/analisis/transversal/sync-tenanthub.md) §SYNC-16.

### Perder la BD local: aprovisionamiento y bootstrap

El catch-up sirve para volver de un **corte**; no sirve para volver de perder la **base de datos**,
y son cosas distintas. El estado de una tabla no es la suma de sus cambios recientes, es la suma de
**todos**, y `Sync_Changes` se purga a los 7 días. Una Main que arranca con `data.db` vacía y
`Last_Seq = 0` pediría un catch-up que no puede reconstruir nada: los usuarios, los roles y el
catálogo se crearon el primer día.

| Pieza | Archivo | Rol |
|---|---|---|
| Guardia del seed | `infra-sqlite/src/connection.rs::seed_admin_if_empty` | Con licencia activada, NO siembra el admin |
| Señal de aprovisionado | `lib.rs::dispositivo_aprovisionado` | `license_state.json` con `tenant_id` |
| Tercer estado del arranque | `infra-sqlite/src/login.rs::setup_pendiente` | `requiere_recuperacion` = cero usuarios |
| Volcado (fase 1) | `domains/sync/sync.routes.ts` → `/v1/sync/bootstrap` | Estado **acotado** + `Seq` de la foto |
| Qué entra en la fase 1 | `domains/sync/bootstrap.ventana.ts` | La clasificación maestro/transaccional y la ventana |
| Histórico (fase 2) | `sync.routes.ts` → `/v1/sync/historico` | Paginado por `rowid`, sin transacción |
| Cola del backfill | `_Backfill_Historico` (creada en `infra-sqlite/src/db.rs`) | Progreso reanudable, tabla local |
| Motor del backfill | `jobs/registro.rs::backfill_historico` + `use_cases/sync.rs::backfill_paso` | Unas páginas cada 5 min |
| Restauración | `infra-sqlite/src/sync.rs::bootstrap_restaurar` | Reemplaza en una transacción y siembra la cola |
| Copias locales | `infra-sqlite/src/recovery.rs` + job `backup_local` | `VACUUM INTO` diario, se guardan las 7 últimas |
| Copia manual y fuera del equipo | `commands/recovery.rs::recovery_create_backup` · `…_export_backup` · `…_import_backup` | Una copia ahora, sacarla a un USB, traerla de vuelta |
| Panel de copias | `features/configuracion/sections/Conectividad.tsx` | Verlas y sacarlas **antes** de necesitarlas (ahí no se restaura) |
| Base que no abre | `lib.rs::run` (arranque sin `Db`) + `commands/recovery.rs::asegurar_base_para_recuperar` | Arrancar igual y apartar el fichero ilegible para reconstruir |
| Bloqueo del login | `_Recovery_State.Reconciliation_Pending` (en la propia `data.db`) | Restaurado ≠ utilizable |
| Reconciliación | `shared/lib/recoverySync.ts` + `useMainSocket` | catch-up → outbox → catch-up, hasta converger |
| Desbloqueo | `commands/recovery.rs::recovery_complete` | Última barrera: outbox 0, checkpoint ≥ high-water |
| Pantalla | `src/app/pages/RecuperarDatos.tsx` | Único sitio desde el que se dispara |

- **"BD vacía" no es "instalación nueva", y confundirlas corrompe la nube.** El seed crea un admin
  con el PIN público `1234` y `Requiere_Setup = 1`; al completar esa pantalla, el `UPDATE Usuarios`
  sale por el outbox y **pisa en la nube la credencial del admin de verdad**, dejando fuera también
  a las Handy. La señal que las distingue tiene que vivir **fuera de `data.db`** — es justo lo que
  se ha perdido —: `license_state.json` y la clave del keyring sobreviven al borrado.
- **Sin admin, la app no cae al login: entra en recuperación.** Cero usuarios es inalcanzable en una
  instalación nueva, así que la propia BD lleva el estado y no hace falta ni una tabla ni un fichero
  más. `requiere_recuperacion` gana a `pendiente`.
- **Mientras falten los datos, el socket no se abre** (`datosPerdidos` en `useEstadoSync` →
  `pausada`). Un catch-up desde `Last_Seq = 0` reproduciría días de operaciones sobre tablas sin las
  filas a las que se refieren: cada una fallaría cinco veces y acabaría en cuarentena, llenando el
  panel de salud de errores que no explican nada — y sin reconstruir nada igualmente.
- **El `Seq` se lee en la misma transacción que el volcado.** Leerlo aparte deja una ventana en la
  que una escritura entra en la foto **y** vuelve luego por el catch-up, que la reaplicaría contra
  una fila que ya está (PK duplicada → cuarentena). Por eso el endpoint no pagina: una foto a trozos
  no es una foto.
- **Restaurar reemplaza, y por eso se niega si el outbox no está vacío.** Vaciar las tablas se
  llevaría por delante una venta que aún no ha llegado a la nube. La comprobación va **dentro** de
  la transacción: hacerla antes dejaría una ventana entre el permiso y el borrado. La hacen los dos
  caminos (`bootstrap_restaurar` y `recovery::asegurar_reemplazo_seguro`), con una excepción: una BD
  que **ya** está bloqueada en reconciliación no está vendiendo, y negarle la única alternativa que
  le queda sería devolverla al callejón sin salida que esta pantalla existe para evitar.
- **La nube no es la única salida, pero sí la única forma de volver a operar.** Hay copias locales
  diarias para reconstruir el fichero sin red; el login, en cambio, no se abre hasta reconciliar.
  Trabajar sobre una copia antigua crearía dos historiales divergentes, y resolverlos es un modo
  degradado que no existe. Consecuencia asumida: **sin internet, una Main que perdió su `data.db`
  no vende.** Y las copias diarias viven en el mismo disco que protegen: cubren un borrado o una
  corrupción, no una máquina muerta. Para eso hay que **sacar una fuera** (Configuración →
  Conectividad → «Guardar fuera…»).
- **Una `data.db` ilegible no puede impedir el arranque.** Si `init_main_db` falla, el `setup()` de
  Tauri **no** puede reventar: sin ventana no hay pantalla de recuperación, y entonces las copias
  quedan inalcanzables justo en el caso para el que se guardan. Se arranca **sin base**: los
  comandos del arranque fallan, el frontend lo lee como datos perdidos y entra en recuperación, que
  funciona sin `Db` porque listar, importar y restaurar sólo tocan ficheros. Consecuencia al tocar
  `commands/recovery.rs`: **todo lo que hay en ese camino tiene que tolerar `state.db == None`** —
  y `recovery_status` desempata por modo, porque no tener base es "normal" en una Handy y es
  "faltan los datos" en una Main.
- **Mientras la base no está operativa, ninguna escritura de negocio puede entrar.** El cerrojo
  vive en `db.rs` (`Db::bloquear_escrituras_de_negocio`, que `WriteGuard::execute` consulta y
  `raw()` ignora) y lo pone `connection::init_main_db` al abrir, según el estado de recuperación.
  Existe porque la regla ya estaba escrita pero sólo la aplicaba el gating de los jobs
  (`Requiere::MainOperativa`), y **cualquier comando se la saltaba**: bastó el aviso de
  "actualización disponible" —que emite una notificación, o sea una escritura replicable— para
  dejar un equipo sin poder restaurar. El razonamiento es circular y no tiene salida: la escritura
  entra en `_Sync_Outbox`, el outbox bloquea la restauración, y el socket que lo drenaría está
  parado justo porque faltan los datos. Consecuencia al añadir cualquier escritura que pueda correr
  sin sesión iniciada: no hace falta acordarse de nada, pero si te devuelve "este equipo está
  recuperando sus datos", **eso es el cerrojo y está bien**; lo que hay que revisar es por qué esa
  escritura corre durante una recuperación.
- **Una base sin usuarios no puede quedar bloqueada por su propio outbox.** La guardia que se niega
  a restaurar con operaciones sin subir hace dos excepciones, y por el mismo motivo: ni una BD en
  reconciliación ni una BD sin usuarios están vendiendo —en la segunda no se puede ni iniciar
  sesión—, así que lo que tengan en el outbox no es una venta. Cerrarles la única salida cambia un
  dato que no existe por un equipo inservible. Es además lo que rescata a los equipos que ya se
  atascaron antes de existir el cerrojo.
- **El volcado de la nube sí necesita dónde escribir, y por eso aparta el fichero ilegible.**
  `asegurar_base_para_recuperar` mueve la `data.db` que no se pudo abrir a `backups/ilegible-*` y
  crea una vacía en su sitio. **Sólo actúa si no hay `Db`**: con una base abierta esto sería un
  borrado disfrazado, y quién puede reemplazar datos utilizables lo decide `bootstrap_restaurar`
  dentro de su transacción y con su guardia de outbox. No se borra —aunque SQLite no la abra, es lo
  único que queda de lo que no llegó a subir— y no se lista como copia restaurable, porque ofrecer
  una base que no abre es ofrecer el problema.
- **Una copia importada no caduca.** La retención de siete es la de las **diarias**; la que alguien
  ha traído de un USB tras perder el equipo no puede desaparecer porque hayan pasado siete días, así
  que lleva prefijo propio (`import-`) y la purga no la mira. Lo que la validación **no** comprueba
  es que sea de este mismo negocio: la BD no lleva ninguna marca del tenant con la que distinguirlo.
  La pantalla lo advierte, el daño queda en local (restaurar no llena el outbox, así que nada de eso
  se replica) y se deshace recuperando de la nube.
- **La copia se toma por el pool de LECTURA.** `VACUUM INTO` abre su propia transacción de lectura,
  así que en WAL la instantánea es coherente sin excluir al escritor. Tomando el `WriteGuard` se
  bloquearían los cobros durante toda la copia — y el job vence por reloj de pared, o sea que puede
  caer en plena cena.
- **Una copia se restaura limpia de `_Sync_Failed`.** Una cuarentena no se borra en ningún sitio, y
  `recovery_complete` exige que no haya ninguna: si viajara dentro de la copia, ninguna restauración
  de ese equipo podría completarse jamás. Lo que esa tabla registra son intentos contra un estado de
  la BD que se está reemplazando, así que allí no dice nada (el volcado la vacía por lo mismo).
- **Los restos de una restauración se recogen.** `pre-restore-*`, `failed-restore-*` y los
  temporales no llevan el prefijo de las copias diarias, así que la retención de siete no los ve.
  Se conservan los dos más recientes de cada familia (la marcha atrás manual) y el job diario purga
  el resto. Las copias previas a una migración (`data.db.bak.*`, en la raíz de AppData) van por la
  misma regla y por el mismo motivo: son la marcha atrás de la **última** actualización, no de todas
  las versiones por las que ha pasado el equipo.
- **Reintentar sin límite sólo vale si la causa es la red.** Tras cinco ciclos seguidos fallidos la
  reconciliación se declara `bloqueada`: se deja de reconectar sola y la pantalla vuelve a ofrecer
  las alternativas. Sin eso, una nube que rechaza siempre la misma operación local deja el TPV
  girando para siempre bajo un mensaje que habla de la conexión.
- **El high-water ausente no es cero.** Si `/v1/sync/changes` no informa del final del log (worker
  antiguo), la verificación se degradaría a "el outbox está vacío" y desbloquearía el login sin
  haber comprobado nada. Se falla cerrado.
- **La PII del personal SÍ vuelve, y conviene saber por qué.** `DNI`, `IBAN` y
  `Numero_Seguridad_Social` se cifran antes de construir la sentencia, así que lo que sale por el
  outbox —y lo que acaba en Turso— es el **texto cifrado**, no un hueco (lo fija el test
  `el_outbox_replica_texto_cifrado_no_el_dni_en_claro`). `/v1/sync/bootstrap` hace `SELECT *` de
  cada tabla de negocio y `bootstrap_restaurar` reinserta las columnas que traiga el volcado tal
  cual: ninguno de los dos filtra nada. Y la DEK sobrevive por partida doble (`secret_store` local
  y `tenants.field_dek` en el control-plane, reentregada al activar), así que la Main que restaura
  puede descifrar. Lo que **no** vuelve es cualquier fila que nunca llegara a subir.
  > Esto estuvo documentado al revés hasta 2026-09-02 (CLAUDE.md, la pantalla de recuperación y
  > `loginApi.ts` decían que esas tres columnas se perdían). Si algún día se quiere que sea verdad
  > —que el volcado no pueda devolverlas— **no basta con avisar en la pantalla**: hay que dejar de
  > replicar esas columnas, y eso exige decidir antes qué pasa con la unicidad y con la Handy.
- **Una tabla que esta versión no conoce se informa, no revienta.** Un TPV con una versión por
  detrás debe poder recuperarse igual; lo que no entra sale en `tablas_desconocidas`.
- **Los nombres de tabla y columna del volcado se interpolan en el SQL** (no se pueden enlazar con
  `?`), así que se filtran contra `sqlite_master` y contra `[A-Za-z0-9_]` antes de construir nada.

#### La recuperación va en dos fases, y sólo la primera hace esperar (SYNC-19)

El volcado se construye entero en memoria y un isolate de Workers tiene 128 MB, así que traerlo
todo de golpe tenía un tope: pasadas 300.000 filas —unos tres meses de uso— el endpoint respondía
413 y el equipo **no podía recuperarse**, que es lo único que este producto ofrece como salida. El
arreglo no fue subir el tope, fue partir el problema:

- **Fase 1** (`/v1/sync/bootstrap`): lo imprescindible para volver a vender. Una petición, una
  transacción de lectura, `Seq` exacto. Al terminar, la reconciliación desbloquea el login.
- **Fase 2** (`/v1/sync/historico`): el resto del histórico, paginado y en segundo plano, con el bar
  ya vendiendo. Son datos que ya no cambian, así que no necesitan foto coherente: ni transacción, ni
  baton, ni snapshot a R2. Y la reanudabilidad sale gratis de la paginación.

Reglas al tocarlo:

- **La clasificación vive en un solo sitio**, `bootstrap.ventana.ts`, y el worker le dice a la Main
  qué tablas vienen recortadas (`parcial`) y **en qué orden** rellenarlas. Duplicar esa lista en
  Rust sería tener dos fuentes para la misma decisión.
- **Los maestros van enteros; los transaccionales, 30 días** (`VENTANA_DIAS`). La ventana es un
  parámetro: cambiarla es cambiar ese número. Se eligió corta porque el resto llega solo y no tiene
  sentido hacer esperar al bar por datos que no necesita para abrir la persiana.
- **La ventana se estira hasta cubrir el periodo de caja abierto.** El arqueo suma los cobros en
  efectivo y los gastos pagados con caja *desde el último cierre* (§12), así que un bar que lleve 40 días sin cerrar caja —pasa:
  el aviso es una notificación, no una acción— perdería diez días de cobros y su primer arqueo tras
  recuperar saldría descuadrado por un dinero que sí está en el cajón.
- **Lo que sigue vivo entra entero, caiga donde caiga.** Es la misma regla del último cierre,
  generalizada: una comanda abierta, una notificación **activa**, un pedido en borrador, un fichaje
  sin cerrar. El caso silencioso es la notificación: si la Main no la ve, el índice único de dedupe
  tampoco, así que la vuelve a emitir y el duplicado acaba en cuarentena al replicar.
- **La unidad es la comanda, no la fila.** Filtrar cada tabla por su propia fecha metería un pago de
  hace cinco días sin la comanda de hace cuarenta a la que pertenece, y `Pagos.ID_Comanda` es una FK
  que se comprueba al COMMIT: eso no pierde una fila, **aborta la restauración entera**. Una comanda
  entra con todo lo suyo —líneas, pagos, detalles del pago, consumos— o no entra.
- **Una tabla de negocio sin clasificar se trata como maestra** y viaja entera. Es fallar del lado
  bueno: traer de más se nota en un volcado un poco más gordo, perderla en silencio se descubre el
  día de la avería. Hay un test que compara la clasificación contra el esquema real de todos modos.
- **La fase 2 pagina por `rowid`, no por clave primaria.** Era lo intuitivo y no vale: seis de esas
  tablas tienen PK compuesta, y paginar por tuplas obligaría a mantener a mano un mapa
  tabla→columnas. El `rowid` es una sola columna, existe en todas y es total.
- **`INSERT OR IGNORE`, siempre.** La fase 2 nunca pisa una fila que ya esté: lo que está en local
  llegó por el catch-up y es más nuevo que esta foto del histórico. Y como la fase 2 re-descarga a
  propósito la ventana que ya trajo la fase 1 —para no tener que empezar por donde acabó la otra—,
  sin `IGNORE` la primera página de cada tabla reventaría por clave duplicada.
- ⚠️ **Las escrituras del backfill van por `WriteGuard::raw()`.** Por `execute()` se capturarían en
  `_Sync_Outbox` y el equipo devolvería a la nube, fila a fila y facturado como escrituras en Turso,
  el histórico entero que acaba de bajarse de ella. Para no cambiar nada.
- **El cursor avanza en la misma transacción que inserta.** Una página que falla se repite entera, y
  apagar el TPV a media descarga no pierde nada.
- **La reconciliación (§10) se calla mientras el backfill esté incompleto.** Compara columnas de
  tablas *maestras* —que vienen completas y correctas— contra sumas de tablas *transaccionales* que
  están a medias, así que sacaría descuadrados prácticamente todos los lotes y todos los clientes
  con historial. No corrompe nada (el job sólo lee), pero un aluvión de avisos falsos justo después
  de una avería enseña al usuario a ignorar precisamente la alarma que no debe ignorar.
- **El backfill no compite con el desbloqueo del login**: su job es `Requiere::MainOperativa`, que
  ya excluye una reconciliación en curso.
- **Y se dice que está pasando.** Conectividad enseña el progreso mientras lo haya, y Estadísticas
  avisa de que un total de rango largo todavía puede crecer: un número que sube solo sin explicación
  se lee como que el programa suma mal.

---

## 10. Tareas periódicas de fondo (runner de jobs)

Todo lo que la app hace "cada X tiempo" **por su cuenta** vive en un único runner
(`apps/tpv-main/src-tauri/src/jobs/`), no en `spawn`s sueltos repartidos por `lib.rs` ni en
`setInterval` del frontend.

| Pieza | Archivo | Rol |
|---|---|---|
| Motor | `jobs/mod.rs` | Bucle común: vencimiento, jitter, backoff, gating, panics, registro |
| **Catálogo** | `jobs/registro.rs` | **El único fichero a tocar para añadir un job** |
| Estado persistido | `_Jobs_State` (`infra-sqlite/src/jobs.rs`, tabla creada en `db.rs`) | `Last_Ok_Ms` por job |
| Diagnóstico | `commands/jobs.rs` → `jobs_status` | Panel en Configuración → Conectividad |

### Añadir un job

1. Escribe `async fn <nombre>(app: AppHandle) -> Result<(), String>` en `jobs/registro.rs`.
   Devolver `Err` **es** la forma de decir "ha fallado" (activa el backoff y sale en el panel):
   no captures el error para devolver `Ok`.
2. Añade su `Job` a `catalogo()` con `cada`, `retardo_inicial` y `requiere`.
3. Nada más: ni bucles, ni tocar `lib.rs`.

El cuerpo debe ser **idempotente** (el motor puede adelantarlo si el job quedó vencido, o repetirlo
tras un fallo parcial).

### Qué garantiza el motor

- **Vencimiento en reloj de pared**: el ciclo se mide contra `Last_Ok_Ms` persistido, no contra el
  tiempo de proceso. Un job de 6 h se ejecuta igual en un equipo que se apaga cada noche.
- **Jitter** (≤10 % del intervalo, tope 5 min), **backoff** exponencial acotado (60 s → 30 min),
  **gating** por modo reevaluado en cada vencimiento (un cambio de modo no reinicia nada), y el
  cuerpo en su propia task para que un panic sea un fallo registrado y no un job muerto.
- La política de planificación (`proxima_espera`) es una función **pura** con tests.

### Qué NO va aquí (a propósito)

- **Ciclo de vida del WebSocket** (ping, drenado del outbox, reconexión): es una máquina de estados
  de la conexión, no un pulso periódico. Vive en `useMainSocket` (§9).
- **Ciclo de vida de una pantalla** (polling de un panel abierto, cuentas atrás, debounces): ahí el
  montaje/desmontaje del componente ya es la política correcta.
- **Telemetría**: mantiene su hilo propio y su spool con backoff; su drenado (1 s) es una cola
  caliente fuera del camino de emisión, no una comprobación periódica.

⚠️ Las escrituras a `_Jobs_State` van por `WriteGuard::raw()`: por `execute()` se capturarían en
`_Sync_Outbox` y cada tick de cada job se replicaría a la nube.

---

## 11. Tickets e impresión (ESC/POS)

El ticket se genera **en Rust** (`apps/tpv-main/src-tauri/src/printing.rs`) y se envía en crudo a la
impresora. La vista previa del frontend (`shared/ticket/TicketPaper.tsx`) es un **espejo** de ese
generador: no imprime, sólo enseña lo que va a salir. Cuando cambies el layout hay que cambiar los
dos, y el frontend pregunta el ancho a Rust (`printer_ticket_cols`) para no calcularlo por su cuenta.

| Pieza | Archivo | Rol |
|---|---|---|
| Generador ESC/POS | `src-tauri/src/printing.rs` | Ancho, columnas, desglose de IVA, logo, corte, cajón |
| Comandos Tauri | `src-tauri/src/lib.rs` | `printer_print_ticket`, `printer_ticket_cols`, `printer_open_drawer` |
| Vista previa | `src/shared/ticket/TicketPaper.tsx` | Espejo del generador (mismo truncado, mismo desglose) |
| Payload | `src/features/configuracion/api/printerApis.ts` | `buildTicketPayload` agrupa líneas por `nombre__precio__iva` |
| Reimpresión | `src/app/pages/Cuentas.tsx` | Copia marcada (`es_copia`, y `es_anulado` si el cobro lo está), no genera número nuevo |

### Reglas

- **El ancho manda.** `cols_efectivas()` sale del papel (58/80/112 mm), los márgenes y el
  `chars_per_line` configurado. Nada se maqueta con anchos fijos: un nombre largo se trunca contra
  ese ancho, no contra un 42 hardcodeado.
- **El IVA es por producto** (`Productos.IVA_Percent`). Un mismo ticket puede llevar varios tipos,
  así que el pie lleva **una línea de base+cuota por tipo**. El `iva_percent` global del payload es
  sólo el defecto para lo que no lo traiga.
- **El desglose vive en `tpv-domain::ticket`, no en `printing.rs`** (FISCAL-01). Tiene tres
  consumidores —el papel, la vista previa y el `Desglose` del registro que se remite a la AEAT— y
  tres copias de esa aritmética es la divergencia que no se ve hasta que la AEAT devuelve un
  «aceptado con errores» meses después. Un tramo es un **enum**: las líneas *sujetas* llevan tipo y
  cuota; las *exentas* van por causa (`E1`…`E6`) y **sin** ninguno de los dos — informarlos es el
  error 1238. Un producto al **0 %** es *sujeto*, no exento: son dos afirmaciones legales distintas
  y el XSD las pone en un `<choice>`.
- **El número de ticket ES el número de la factura** (FISCAL-01). `Pagos.Numero_Ticket` guarda el
  `Num_Serie_Factura` del registro (`2027/000001`, serie por ejercicio), y lo reserva
  `Serie_Facturacion` con un `UPDATE … Ultimo + 1` relativo, no un `SELECT MAX`. Dos numeraciones
  paralelas serían dos cosas que pueden divergir, y la que importa a efectos legales es la fiscal:
  la que va en el QR y en el `IDFactura` que la AEAT usa como clave única. Una reimpresión reusa el
  número: si saliera uno nuevo, la copia parecería una venta más — y ahora, además, sería una
  factura duplicada que la AEAT rechaza.
- **El cajón se abre con la impresora.** El pulso va dentro del propio flujo del ticket (`ESC p`) o
  suelto (`DLE DC4`, que la impresora atiende aunque tenga cola). Toda apertura fuera de un cobro se
  registra en `Aperturas_Cajon` — un cajón que se abre sin venta es el descuadre que
  hay que poder investigar. Abrirlo no pide rol (el camarero lo necesita para dar cambio) pero sí
  **estar identificado**, y el nombre que se anota lo pone la sesión: con SEC-01, `printer_open_drawer`
  ya no acepta un `id_usuario` de la entrada.
- **El logo es de un bit.** `rasterizar_logo` reduce al ancho del papel (múltiplo de 8 dots),
  difumina con Floyd–Steinberg y emite `GS v 0`. La transparencia se compone sobre blanco antes de
  nada (un PNG de fondo transparente salía como un rectángulo negro). Si la imagen no se puede leer
  devuelve `None` y el ticket sale sin logo: **nada de lo que rodea al ticket puede impedir cobrar.**
- **El QR tributario abre la factura** (FISCAL-01, art. 21 de la Orden HAC/1177/2024). Va lo
  primero, *«antes de que empiece el contenido de ésta generado por el sistema informático de
  facturación»*, centrado, precedido siempre del texto **«QR tributario:»** y seguido de la leyenda
  **«VERI\*FACTU»**. Mide entre **30 y 40 mm** con al menos 2 mm de zona de silencio, y se
  rasteriza por el camino del logo (`GS v 0`), que es más portable que el `GS ( k` nativo de QR.
  La URL **no se compone al imprimir**: sale de `Registros_Facturacion.QR_Url`, que es la que se
  guardó al emitir — una reimpresión tiene que sacar exactamente la misma.
  El orden queda: **QR → leyenda → datos del negocio → líneas → totales → desglose de IVA →
  mensaje → logo → corte.**
- **El logo cierra el ticket, centrado.** Va lo último: después del mensaje de despedida y antes
  del corte. Arriba obligaba a centrar debajo de él los datos del negocio para que no quedaran
  descolgados, y lo primero que se lee de un recibo tiene que ser de quién es y cuánto se ha
  pagado. La cabecera son esos datos **alineados a la izquierda**. (El QR sí va arriba, y no
  contradice esto: no es contenido que compita por la atención, es una etiqueta.)
- **El ancho del logo sale del papel, no del texto.** `ancho_logo_dots` parte del cabezal del
  formato y descuenta los márgenes; `chars_per_line` no entra. Esa opción es la densidad de las
  LETRAS: quien la baja a 20 quiere el texto más grande, no un logo del tercio del papel.
- **Cobrar es cosa de la Main.** El worker rechaza el cobro desde una Handy (`cobro_solo_en_main`),
  porque el número correlativo y el cajón viven en la Main.
- **Base + IVA tienen que dar el total, y NADIE MÁS LO VIGILA.** Se comprobó contra la AEAT
  mandando un `CuotaTotal` descuadrado a propósito: **lo acepta sin decir nada** (el `ImporteTotal`
  descuadrado sí salta, error 2005; el de la cuota no salta ninguno). Así que la regla de que la
  cuota es *lo que falta* para llegar al total, y sus tablas de golden en el dominio, son la única
  red que hay contra esa clase de error. Ver el banco adversario en
  [docs/PRUEBAS_AEAT.md](docs/PRUEBAS_AEAT.md).
- **Base + IVA tienen que dar el total.** Se redondea la base y la cuota es **lo que falta**: si se
  redondean por separado, a veces suben las dos y el papel dice `0,38 + 0,02 = 0,39` (0,39 € al 4 %
  es el primer caso). Un ticket cuya base más su IVA no dan el total es un documento mal emitido.
- **Un carácter, un byte.** El maquetado cuenta columnas, así que `encode_cp858` mapea uno a uno y
  lo que no está en la tabla cae a `?`. Los bytes de control se convierten en espacio: el nombre de
  un producto lo escribe el usuario, y un `ESC` ahí lo leería la impresora como un comando.
- **La vista previa es un espejo, y se prueba como tal.** Todo lo que la previa comparte con el
  papel —agrupación, desglose de IVA, formato del dinero y recorte del nombre— vive en
  `shared/ticket/ticketMath.ts`, fuera del componente, para poder probarlo sin React. Hay tablas de
  golden duplicadas a propósito en los dos lados (`printing/tests.rs` y `test/ticketMath.test.ts`):
  si uno cambia de criterio, el otro falla. Dos trampas ya pisadas: `Intl.NumberFormat` mete el
  punto de los miles y un espacio duro que el papel no lleva, y `String.slice` cuenta unidades
  UTF-16, así que parte un emoji por la mitad donde Rust cuenta caracteres.

---

## 11-bis. Veri\*factu: el registro de facturación (FISCAL-01 / FISCAL-02)

Cada cobro expide una **factura** y produce un **registro de facturación** encadenado que se remite a
la AEAT. Es obligatorio desde el **1 de enero de 2027** para contribuyentes del Impuesto sobre
Sociedades (RD 1007/2023 — RRSIF — y Orden HAC/1177/2024). El diseño y los porqués largos están en
[docs/PLAN_VERIFACTU.md](docs/PLAN_VERIFACTU.md); esta sección es lo que hay que saber para no
romperlo.

Operamos en modalidad **VERI\*FACTU** (remitimos todos los registros) y no como SIF no verificable.
Esa elección quita de encima la firma XAdES, el libro sellado y las obligaciones de conservación
reforzada — el precio es que **hay que remitir**, y por eso la mitad de las reglas de abajo son sobre
no dejar de hacerlo.

| Pieza | Archivo | Rol |
|---|---|---|
| La aritmética fiscal | `crates/tpv-domain/src/verifactu.rs` | Cadena de huella, SHA-256, URL del QR, validación de NIF, `F1`/`F2`, saneado de texto. **Sin BD ni reloj: aquí están los tests** (y los 3 vectores oficiales de la AEAT como golden) |
| El desglose de IVA | `crates/tpv-domain/src/ticket.rs` | Un tramo es un enum: *sujeta* (tipo + cuota) o *exenta* (causa, sin tipo ni cuota). Tres consumidores, una sola aritmética (§11) |
| Puerto de la AEAT | `tpv-application/src/ports/aeat.rs` | `AeatClient`, los 4 endpoints, certificados disponibles |
| Puerto del registro | `tpv-application/src/ports/verifactu.rs` | `VerifactuRepository` |
| Clasificación y control de flujo | `tpv-application/src/use_cases/verifactu.rs` | `clasificar`, `puede_enviar`, `remitir_ciclo`, `avisar_de_atraso` |
| Persistencia y emisión | `crates/tpv-infra-sqlite/src/verifactu.rs` | `emitir_cobro` / `emitir_anulacion` / `emitir_sustitutiva`, reserva de número, reencolado tras restaurar |
| Exportación (art. 8) | `crates/tpv-infra-sqlite/src/verifactu_export.rs` | El ZIP con `registros.xml`, `registros.csv`, **`cadena.txt`** y `manifiesto.json` |
| SOAP, XSD y TLS | `crates/tpv-infra-aeat/` | `xml.rs` (construir/parsear), `certificados.rs` (almacén de Windows), `transporte.rs` (WinHTTP con TLS mutuo), `esquemas/` (XSD y WSDL oficiales vendorizados) |
| El envío | `src-tauri/src/jobs/registro.rs::verifactu_remitir` | Cada 60 s, `MainOperativa` |
| Comandos | `src-tauri/src/commands/verifactu.rs` | Estado, listado, certificados, probar, exportar, declaración responsable, `F3` |
| Pantalla | `src/features/configuracion/sections/Fiscal.tsx` | Obligado, certificado, cola, exportación, declaración responsable |
| Factura completa | `src/shared/ticket/DatosFiscalesModal.tsx` | El formulario de `F1`, cableado en los dos caminos del cobro |
| Escalera de avisos | `src/shared/ticket/AvisoFiscalModal.tsx` + `shared/stores/useEstadoFiscal.ts` | Los dos peldaños altos |
| Validación del XML | `scripts/verifactu-validar-xml.py` | Genera 13 muestras y las valida contra los XSD oficiales |

### Las reglas

- **El registro se emite DENTRO de la transacción del cobro**, entre el `INSERT INTO Pagos` y el
  `COMMIT`. Es lo que exige el art. 9 RRSIF (*«de forma simultánea o inmediatamente anterior a la
  expedición»*) y lo único que no puede dejar **facturas huérfanas** — una factura expedida cuyo
  registro no existe, que es la única forma de romper esto de verdad. Si el cobro hace `ROLLBACK` no
  queda registro ni se gasta número; si la **impresión** falla después, el registro ya es correcto y
  el papel se reimprime.
- **Remitir es un job, y no puede ser otra cosa.** El art. 16.2 de la Orden impone un **control de
  flujo** entre envíos (`TiempoEsperaEnvio`, 60 s al principio, o 1000 registros, lo que ocurra
  primero), así que el envío no puede ser síncrono con la venta aunque se quisiera. Y por producto:
  nada de lo que rodea al envío puede impedir cobrar.
- ⚠️ **El job de remisión NO cuelga del interruptor de la sincronización.** `connectivity: "off"`
  (SYNC-17, §9) apaga el WebSocket de *nuestra* nube, que es una comodidad —«este cliente no quiere
  nube»—; remitir a la AEAT es una obligación tributaria. Si compartieran interruptor, el atajo para
  una red patológica convertiría en silencio un TPV conforme en uno que no lo es, y no se notaría:
  la aplicación se vería perfectamente sana. Cumplir la regla consiste en **no añadir nada** a ese
  job; se escribe porque la forma de romperla es que a alguien le parezca razonable «respetar el
  modo de conexión» dentro de seis meses.
- **Los errores se clasifican por RANGO, no por lista.** `2000–2999` = **admisible** (el registro se
  acepta y hay que **subsanarlo**); `3000` = **duplicado**, que se trata como aceptado y es la
  idempotencia de todo el sistema; cualquier otro = rechazado. Una lista cerrada de códigos se queda
  vieja en la primera nota técnica de la AEAT, y el fallo sería tratar un aceptado como rechazado
  —reenviarlo para siempre— o al revés.
- **Que el duplicado sea «aceptado» es lo que hace recuperable todo lo demás.** Un corte de luz entre
  el envío y el guardado del resultado, una restauración, un reintento: todo converge porque reenviar
  algo que la AEAT ya tiene devuelve 3000. Por eso **tras restaurar se reencola todo** lo que no tenga
  estado de envío (`resembrar_cola_de_envio`) en vez de preguntar a la AEAT qué tiene:
  `Registros_Facturacion` se replica y vuelve, pero `_Verifactu_Envios` es estado **local** y no, así
  que sin esto el panel diría «0 pendientes» y el job no mandaría nada.
- **Las rectificativas van en SERIE PROPIA** (`R2027/000001`), y no es una elección: el art. 6.1.a)
  del RD 1619/2012 la impone «en todo caso». La **`F3` no**, y eso sale del art. 15.6 del mismo
  reglamento: *«las facturas que se expidan en sustitución o canje de facturas simplificadas […] no
  tendrán la condición de rectificativas»*. La serie sale del **tipo de factura**, no del camino que
  llamó, que es lo único que no se puede olvidar al añadir un camino nuevo.
- **Un rechazo se subsana a mano, y sólo a mano.** `pendientes()` coge únicamente los `PENDIENTE`, así
  que un registro rechazado no se reintenta solo — y no debe: repetir lo mismo daría el mismo rechazo
  cada minuto. `subsanar_rechazados` emite un registro nuevo con **el mismo `IDFactura`**,
  `Subsanacion='S'` y `RechazoPrevio='X'`, que **no gasta número** pero sí ocupa su propio eslabón de
  la cadena. Lo dispara el botón de Configuración → Fiscal, normalmente después de que una versión
  nueva arregle lo que causó el rechazo. Probado contra la AEAT: acepta la subsanación.
- **Las tres subsanaciones son tres operativas distintas**, no una. `Subsanacion='S'` (corregir un
  registro que la AEAT aceptó), `RechazoPrevio` (reenviar tras un rechazo) y `SinRegistroPrevio`
  (alta de algo que nunca llegó a registrarse) se informan según el anexo oficial, y un `IDFactura`
  de subsanación **es el mismo** que el del original — de ahí que el índice único de la terna excluya
  las filas de subsanación.
- **Las tablas `_Verifactu_*` van por `WriteGuard::raw()`.** Son estado local del dispositivo (como
  `_Jobs_State` y `_Sync_*`): por `execute()` se capturarían en `_Sync_Outbox` y cada tick del job
  replicaría a la nube, facturado, el estado de una cola que allí no significa nada.
  `Registros_Facturacion` y `Serie_Facturacion` sí van por `execute()`: son esquema compartido y
  tienen que volver de la nube.
- **`Registros_Facturacion` es append-only y no se purga nunca** (art. 7 RRSIF; ver DB-14 en
  `docs/analisis/BACKLOG.md` para qué sí se podrá archivar y por qué).
- **El certificado lo usa Windows, no nosotros.** El TLS mutuo va por **WinHTTP** (schannel), al que
  sólo se le pasa la **huella** del certificado elegido; la clave privada no sale del almacén, no hay
  `.p12` que leer ni contraseña que guardar. Es a propósito y no un detalle: `rustls-cng` —la opción
  obvia— habla **NCrypt**, que sólo ve claves en un *Key Storage Provider*, y un `.p12` importado con
  doble clic aterriza en un **CSP legacy**. Con NCrypt, el certificado del bar simplemente no
  aparecería en la lista. WinHTTP sirve KSP, CSP legacy y tarjetas criptográficas igual, que es lo
  que hacen el navegador y Autofirma.
- **Un certificado que pide PIN no sirve para esto**, y hay que decirlo antes. La pantalla marca los
  que no tienen *uso silencioso*: el diálogo espera a nadie hasta que el envío agota su timeout, el
  job lo anota como intento fallido y lo repite en el ciclo siguiente, indefinidamente. No se pierde
  ninguna factura (siguen `PENDIENTE`) pero **no se remite ninguna**, y el único síntoma es que la
  cola crece. El botón «Probar» abre una conexión real **sin enviar ninguna factura** justo para que
  eso salga con alguien delante. El flag de silencio además **no es infalible**: Microsoft documenta
  que con lectores con *pinpad* y drivers propios se ignora.
- **El estado del certificado lo pone el SHELL, no la capa de datos.** El almacén de Windows no está
  en la base de datos, así que `estado_fiscal` no puede saberlo: lo completa `verifactu_estado` con
  `completar_con_el_certificado`. De ahí salen `certificado_ok`, los días que le quedan y cuatro
  causas de `motivo_no_remite` (`sin_certificado`, `certificado_no_encontrado`,
  `certificado_caducado`, `certificado_pide_pin`), que **no pisan** las que ya trae la capa de datos.
  El aviso de caducidad va **a 30 días y a 7**, y es distinto del aviso por atraso a propósito: aquel
  mide horas de cola y por tanto llega cuando ya se ha dejado de remitir; éste llega mientras renovar
  todavía es un trámite. Con el certificado ausente o caducado el job **ni lo intenta**; con el que
  pide PIN sí, porque puede haber alguien delante.
- **El modo prueba es TEMPORAL: se quita antes de que Veri\*factu sea obligatorio** (etiqueta
  `MODO-PRUEBA`, apuntado en `docs/VERIFACTU_PENDIENTES.md` §9). Existe para probar el programa sin
  NIF ni certificado: con él los cobros numeran en la serie **`PRUEBA`**, **no emiten registro** —ni
  QR, ni envío, ni datos del obligado—, el job no remite ni avisa y el papel sale marcado «SIN VALOR
  FISCAL». Reglas mientras exista:
  - **Lo decide el número, no el interruptor.** La serie se fija **antes de reservar**
    (`serie_del_cobro`), porque `Pagos.Numero_Ticket` guarda ese mismo número: decidirlo después
    obligaría a descartar el reservado y dejaría un hueco en la serie real. A partir de ahí la
    emisión y la impresión preguntan al número (`es_numero_de_prueba`), así que una reimpresión de
    mañana sigue diciendo lo que fue aunque el modo ya esté apagado.
  - **Las ventas de prueba cuentan como cualquier otra** en la caja y en las estadísticas. Filtrarlas
    sería código que funciona de dos formas para algo que se va a borrar.
  - **Un interruptor que deja de declarar ventas no puede existir en un TPV que se venda.** Sustituye
    al antiguo modo formación (serie `PRU` que se anulaba y remitía al terminar), retirado por
    decisión del responsable.
- **El entorno es una decisión explícita** (`Business_Settings.Verifactu_Entorno`). Los endpoints de
  producción y pruebas se distinguen en tres caracteres, y un ticket de pruebas que parece real es
  peor que uno que no sale: en pruebas el panel lo dice en amarillo y el QR apunta al portal de
  pruebas. Si el valor guardado no se reconoce, **se cae a producción** — fallar hacia el lado que
  cumple.
- **La escalera de avisos tiene cinco peldaños y cada uno vive donde corresponde**: `<1 h` nada (es
  funcionamiento normal, la espera la impone la norma), `1–6 h` el panel, `6–24 h` una notificación
  al Administrador, `24–72 h` un aviso al iniciar sesión, `>72 h` un aviso tras cada cobro. La clave
  de dedupe es **una sola** para todos: con una por peldaño, subir de escalón dejaría el anterior
  abierto. Y el aviso **se cierra solo** cuando la cola baja — uno que hay que descartar a mano
  después de que el problema se arregle enseña a descartar avisos.
- **El aviso de cobro va DESPUÉS del cobro.** El plan decía «modal en cada cobro»; se hace al
  terminar, por la regla más firme del producto: nada de lo que rodea al ticket puede impedir cobrar.
  Un diálogo *delante* del cobro es una pulsación más en la ruta más caliente, cableada en dos
  pantallas, que un bug convierte en «el TPV no cobra» en hora punta.
- **Los importes se guardan como TEXTO.** `ImporteTotal` y `CuotaTotal` entran en la cadena que se
  hashea, y `REAL → texto` no es una operación única: `123.1`, `123.10` y `123.100000000000001` son
  tres cadenas distintas y tres huellas distintas. Se formatean **una vez** (`fmt_importe`) y el XML,
  el QR y la exportación se construyen desde el texto guardado. Nadie recomputa nada al leer.
- **`Cadena_Huella` se guarda aunque sea redundante**, y es lo que hace auditable la exportación: con
  `cadena.txt` cualquiera recalcula las huellas con un SHA-256 y comprueba que la cadena no se ha
  tocado, **sin nuestro código**. Si algún día el formateo cambiara, el fichero enseña qué se hasheó
  de verdad.
- **Antes de generar cada registro se comprueba el anterior** (art. 7.i) de la Orden): que esté bien
  encadenado con el suyo, y que no esté fechado **más de un minuto por delante** del reloj actual —o
  sea, que el reloj no haya ido hacia atrás—. Se lee en la misma consulta que el eslabón anterior
  (`estado_de_la_cadena`, dos filas), así que no cuesta un viaje más en el camino del cobro.
  ⚠️ **Y NUNCA impide facturar.** La FAQ de la AEAT es literal: *«será preciso generar el siguiente
  RF, ya que la facturación por este motivo NUNCA debe interrumpirse»*. Lo que se hace es anotarlo en
  `_Verifactu_Anomalias` (local, por `raw()`), gritarlo en el panel y notificarlo.
- **No llevamos registro de eventos, y es legítimo.** Sólo es obligatorio para los SIF que pueden
  actuar en modalidad **NO** VERI\*FACTU; la NOTA 1 del apartado 15 del FAQ de desarrolladores exime
  expresamente a los «SOLO VERI\*FACTU», que es lo que declaramos con
  `TipoUsoPosibleSoloVerifactu = "S"`. Si algún día se ofreciera el modo no verificable, esa
  exención decae y habría que construirlo entero.
- **`Orden` es explícito, no `rowid`.** El eslabón anterior es `MAX(Orden)`; con `rowid` la cadena
  dependería del orden en que una restauración reinserta las filas, que no está garantizado.
- **`FechaOperacion` se informa sólo si la operación fue otro día.** Los arts. 6.1.i) (factura
  completa) y 7.1.c) (simplificada) del RD 1619/2012 lo escriben igual —*«siempre que se trate de
  una fecha distinta a la de expedición»*—, y que el 7 lo repita es lo que decide el caso: alcanza
  también a los tickets, que son el 99 % de lo que emite un bar. La regla tiene **dos mitades** y las
  dos importan: se informa si difiere, y **no** se informa si coincide (la AEAT ya toma la de
  expedición cuando falta). El filtro vive en `emitir_alta`, no en cada llamante. Los tres casos en
  que no coinciden: una comanda que cruza la medianoche (la fecha sale de su apertura), una
  rectificativa de una venta de otro día y una `F3` que canjea un ticket anterior (las dos heredan la
  del original). No entra en la cadena de huella.
- **Un producto al 0 % es *sujeto*, no *exento*.** Son dos afirmaciones legales distintas y el XSD las
  pone en un `<choice>`: informar tipo o cuota en un tramo exento es el error 1238. La causa de
  exención (`E1`…`E6`) la lleva el producto (`Productos.Exento`, `Causa_Exencion`) y se congela en la
  línea al vender, como el nombre y el tipo.
- **Anular y devolver no son lo mismo** (§13). Un cobro anulado **por error** emite un registro de
  **anulación**; una **devolución** al cliente emite una rectificativa `R5` y no deshace nada. Lo
  decide `ClaseBaja` en `anular_pago`, y de ello depende si las líneas y el stock vuelven.
- **El texto que viaja en el XML se sanea.** `<`, `>`, `"`, `'` y `=` se quitan de los campos libres
  en el dominio (`sanear_texto`), y además el constructor de XML los **escapa**. Es doble red y se
  deja así a propósito, aunque el banco adversario demostró que **la AEAT acepta esos caracteres
  escapados** en `DescripcionOperacion`: el error 1287 existe en el catálogo con un `%s` para el
  nombre del campo, así que puede aplicar a otros, y pasarse de estricto en un campo descriptivo no
  rompe nada.
- **Que una línea exenta no lleve tipo ni cuota no depende de la AEAT.** `escribir_detalle` en
  `xml.rs` **no sabe** construir las dos cosas a la vez: la rama de la exenta escribe `OperacionExenta`
  y la base, y punto. Se intentó forzar el error 1238 manipulando la fila y no llegó a salir del
  equipo. Una invariante que el código no puede violar es mejor que una que alguien vigila.
- **El NIF se valida en los dos lados, y la copia es deliberada.** `tpv_domain::verifactu::nif_valido`
  y `nifValido` en `DatosFiscalesModal.tsx`. El backend lo revalida porque quien puede invocar un
  comando puede mandar lo que quiera; el frontend lo comprueba porque un NIF mal dictado **no** se
  rechaza al enviar: vuelve como «error admisible: NIF no censado» horas después, sin el cliente
  delante y con una subsanación que alguien tiene que disparar a mano.
- **La Handy no factura.** Ya no cobra (`cobro_solo_en_main`), y el worker veta además cualquier
  escritura a las tablas fiscales (`test/fiscalSoloMain.test.ts`): el número correlativo y la cadena
  de huellas viven en la Main y no pueden tener dos escritores.
- **Sin los datos del obligado no se cobra, y la aplicación lo DICE.** `datos_obligado` corta la
  transacción del cobro si faltan el NIF o la razón social, y eso es correcto: cada cobro expide una
  factura. Lo que no puede pasar es que se descubra en la caja con un cliente delante, así que hay
  tres redes y las tres importan: el `catch` del cobro **enseña el mensaje** en las dos pantallas de
  venta (antes mesas se lo tragaba entero y no pasaba *nada* al pulsar «Confirmar cobro»); un aviso
  al entrar lleva a Configuración → Fiscal de un clic; y `Negocio.tsx` ya no llama «Opcional» al CIF,
  que es la misma columna. El aviso va **después del login** porque
  `config_patch_business_settings` exige Administrador, y **manda sobre la escalera de atraso**:
  aquélla dice que hay facturas sin remitir, ésta que el siguiente cobro va a fallar.
- **La declaración responsable se ve desde dentro del programa** (art. 13 RRSIF, *«visible en cada
  una de sus versiones»*), con la versión real de `tauri.conf.json`, no un número escrito a mano.
  Mientras falten los datos definitivos del productor, la pantalla **dice que está incompleta** en
  vez de enseñar una declaración a medias.

### Al tocar esto

- Los **argumentos de los comandos `verifactu_*` van planos** (`{ numeroTicket }`), no envueltos en
  `{ args: {…} }`. En el repo conviven las dos formas según la firma de cada comando, y equivocarse
  no da un error legible: un parámetro `Option<…>` llega como `None` y el comando se queda con su
  valor por defecto. `check-comandos-tauri.mjs` comprueba el **nombre**, no la forma de los
  argumentos.
- **Lo que queda abierto está en una lista, no en la cabeza de nadie**:
  [docs/VERIFACTU_PENDIENTES.md](docs/VERIFACTU_PENDIENTES.md). Son decisiones y datos que no
  dependen del código (identidad del productor, texto de la declaración responsable, serie de las
  rectificativas…). Se resuelven de una en una y se tachan ahí.
- Las **pruebas contra la AEAT** se lanzan a mano y están documentadas en
  [docs/PRUEBAS_AEAT.md](docs/PRUEBAS_AEAT.md): `pnpm verifactu:certificados` para ver qué hay en el
  almacén, `pnpm verifactu:probar-aeat` para el *handshake*, `pnpm verifactu:validar-xml` para
  validar las muestras contra los XSD oficiales.

## 12. Cierre de caja (arqueo)

El corte del periodo de caja. **CUENTA-06**; diseño y porqués en
[docs/PLAN_CIERRE_CAJA.md](docs/PLAN_CIERRE_CAJA.md).

| Pieza | Archivo | Rol |
|---|---|---|
| Aritmética | `crates/tpv-domain/src/cierre_caja.rs` | Recuento, esperado, descuadre, umbral del motivo. Sin BD ni reloj: aquí están los tests |
| Persistencia | `crates/tpv-infra-sqlite/src/cierre_caja.rs` | `Cierres_Caja` + `Cierre_Denominaciones` + `Cierre_Rectificaciones` |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | Preparar, confirmar, deshacer y el aviso |
| Rectificación | `tpv-application/src/use_cases/rectificacion_caja.rs` | Corregir un apunte de un cierre hecho: impacto, motivo y rectificación (CAJA-01) |
| Pantalla | `src/features/cuentas/CierreCajaModal.tsx` · `ImpactoCierreModal.tsx` | El modal y el contador · el aviso antes de tocar un cierre hecho; el histórico vive en `pages/Cuentas.tsx` |
| Papel | `src-tauri/src/printing.rs::build_arqueo` | Documento interno |
| Aviso | `jobs/registro.rs::caja_sin_cerrar` | Notificación si lleva >20 h abierta |

### Reglas

- **El periodo va de un cierre al siguiente, sin fechas de por medio.** El calendario no sabe partir
  la jornada de un bar: una cena de 23:30 a 01:30 es un servicio, no dos días.
- **Lo dispara un botón, nunca un reloj.** Un cierre automático tendría el esperado pero no el
  contado —nadie habría abierto el cajón— y guardaría un arqueo con descuadre 0 que no ha comprobado
  nadie: un dato falso que parece bueno. Y una hora programada no se ejecutaría jamás en un equipo
  que se apaga al cerrar el bar. La red contra el olvido es un **aviso**, no una acción.
- **Lo que se deja en el cajón es el fondo del cierre siguiente.** Así se encadenan los periodos sin
  que nadie declare dos veces el mismo número. El fondo sólo se pregunta en el primer cierre; en los
  demás no se acepta de la entrada, o cualquiera podría reescribir el punto de partida a posteriori y
  hacer desaparecer un descuadre.
- **Los importes se guardan, no se derivan al leer.** Un arqueo es la foto de lo que se vio esa
  noche. Si mañana se corrige un cobro de esa noche, la foto no cambia —dejaría de explicar por qué
  faltaban 20 €—: lo que cambia es el **rectificado** (`Rect_*`), que se guarda al lado.
- **Sólo se cuadra el efectivo.** `esperado = fondo + cobros **activos** en efectivo − gastos
  pagados con caja` (CUENTA-07, §13; CAJA-01). Un gasto sólo resta si lleva `Pagado_Con_Caja`: el
  que se paga por banco no ha tocado el cajón. Y las anulaciones del periodo se enseñan al lado, sin
  entrar en el cálculo.
- **Un gasto no tiene hora, y cae en el periodo a las 12:00 de su día** (`HORA_DE_UN_GASTO`, y la
  misma expresión en el SQL de `totales_desde`). Un bar abre por la mañana y cierra de madrugada: el
  mediodía cae dentro del servicio de ese día, así que el gasto de la tarde va al cierre de esa noche.
  Si cambias la regla, cámbiala en los dos sitios o preparar y rectificar dejarán de coincidir.
- **Cerrar NO bloquea nada; corregir el pasado rectifica** (CAJA-01). Antes un cierre bloqueaba su
  periodo y se decidió lo contrario: cada uno usa el programa como quiera, y lo que hace el programa
  es que tocar el pasado no pase desapercibido. Editar o anular un cobro y crear, editar o borrar un
  gasto que caen en un cierre hecho —por su fecha de **origen** o por la de **destino**— pasan por
  `rectificacion_caja`: la pantalla pregunta antes el impacto (`cuentas_previsualizar_cambio`) y lo
  enseña, el motivo es obligatorio **sólo si cambia un descuadre**, y el cierre guarda lo que marca
  ahora más una fila en `Cierre_Rectificaciones`. Reglas al tocarlo:
  - **Rectificar un cierre no mueve a los siguientes.** Cada cierre arranca con lo que se *dejó*, que
    es dinero contado, no con el esperado del anterior.
  - ⚠️ **Se rectifica sumando el cambio a lo que el cierre ya dice, NUNCA volviendo a sumar su
    periodo desde la BD.** Tras recuperar un equipo el histórico baja por partes (SYNC-19, fase 2) y
    un cierre viejo sumado a mitad de descarga saldría descuadrado por cobros que aún no han llegado
    — y la rectificación lo grabaría para siempre. De paso, lo que se enseña al confirmar es lo que
    se guarda: las dos cosas hacen la misma cuenta.
  - **La fecha de origen se lee de la BD, no de la entrada**: en un borrado sólo llega el id.
  - **Si guardar el cambio va bien y rectificar falla, el cambio se queda** y el error lo dice. El
    apunte es el dato; la rectificación, su explicación.
- **Deshacer, sólo el último cierre.** Deshacer uno antiguo dejaría su dinero sin contar en ningún
  periodo, porque los siguientes ya empezaron desde él. Es lo que queda de «reabrir»: un recuento mal
  hecho, que la rectificación no arregla. **Y el rastro no se acepta de la entrada**
  (SEC-01): quién cierra y quién deshace sale de la sesión del backend, así que `ConfirmarCierreInput`
  y `CierreIdInput` ya no llevan `id_usuario` — un arqueo firmado con el nombre que le pase la
  pantalla es una auditoría que da confianza sin merecerla.
- **El papel es un documento interno.** No gasta número de ticket (dejaría huecos en la serie de
  ventas), no lleva desglose de IVA y no abre el cajón, que ya está abierto.
- **La Handy mira, no toca.** Sus escrituras de caja se rechazan dos veces —adaptador HTTP y worker
  (`soloLaMainEscribeCaja`)—, porque una regla que sólo vive en el cliente es una sugerencia.
- **Cuentas entera es del administrador, lecturas incluidas** (SEC-01, cerrando lo que
  `PLAN_CIERRE_CAJA.md` §8 ya había decidido). El libro de caja dice cuánto se factura y cuánto se
  gasta: esconderlo del menú no es esconderlo.

---

## 13. Anular un cobro (CUENTA-07)

Un cobro anulado **no se borra**. Diseño y porqués abajo; el plan que lo introdujo ya no existe.

| Pieza | Archivo | Rol |
|---|---|---|
| La regla | `crates/tpv-domain/src/cuentas.rs::puede_anularse` | Ya anulado / falta motivo. Sin BD: aquí están los tests |
| Persistencia | `crates/tpv-infra-sqlite/src/cuentas.rs::anular_pago` | Revierte stock y gasto, marca el pago, reabre la comanda |
| «Línea cobrada» | vista `v_lineas_cobradas` (`0001_inicial.sql`) | Fila en `Pago_Detalles` **ligada a un pago ACTIVO** |
| Historial | `crates/tpv-infra-sqlite/src/caja_movimientos.rs` → `Movimientos_Caja` | Una fila por hecho: cobro, anulación, gasto |
| Comando | `commands/cuentas.rs::cuentas_anular_pago` | Administrador; rectifica el cierre si el cobro es de uno hecho (§12); firma con la sesión |
| Pantalla | `src/app/pages/Cuentas.tsx` | Lista los anulados marcados; pide el motivo |
| Worker | `domains/cuentas/cuentas.commands.ts::anularPago` | Paridad; vetado a la Handy |

### Reglas

- **El agujero que esto cierra.** El arqueo calcula `esperado = fondo + cobros en efectivo`, así que
  borrar la fila de una venta en efectivo bajaba el esperado **exactamente lo mismo** que faltaba en
  el cajón: el descuadre salía cero. Los números eran correctos; lo que no había era nada con lo que
  compararlos. Consecuencia: **`totales_desde` filtra por `Estado='ACTIVO'`, y ese filtro es
  el plan entero**. Si alguien lo quita, el producto vuelve a ser ciego y ningún test de aritmética
  se entera.
- **Las líneas vuelven a la comanda, no se esfuman.** Se conservan `Detalle_Comanda` y
  `Pago_Detalles`: son lo que permite reimprimir el ticket anulado tal como se emitió, y si el cobro
  fue un error las consumiciones siguen en la mesa, que es lo que espera el camarero. El precio es
  que **«cobrada» deja de ser «tiene fila en `Pago_Detalles`»**.
- **Ese predicado vive en una vista, no repetido.** `v_lineas_cobradas` es `Pago_Detalles` unida a
  los pagos activos, y **toda lectura que pregunte si una línea está cobrada va por ella** (las
  escrituras siguen yendo contra la tabla). Estaba en ~27 sitios entre Rust y el worker: escrito 27
  veces, la próxima consulta que alguien añada se olvidaría del filtro, y el síntoma sería una mesa
  con líneas congeladas o un pendiente descuadrado, no un error.
- **El guardia anti-doble-abono es el `Estado`, y está dentro de la transacción.** Antes lo
  garantizaba el borrado de `Lote_Consumos`/`Suelto_Consumos`: sin filas que sumar, una segunda
  anulación no abonaba nada. Ahora esas trazas se conservan, así que lo único que impide abonar el
  stock dos veces —y descontar el gasto del cliente dos veces— es que `anular_pago` salga antes si
  el pago ya está `ANULADO`. Es el punto donde más fácil es meter un bug silencioso.
- **Cada consumo de stock sabe qué cobro lo hizo (STOCK-01)**, y lo que lo devuelve o lo cuenta
  mira ESE cobro, nunca la línea. Una línea cobrada, anulada y vuelta a cobrar tiene un consumo por
  cobro —de lotes distintos si el primero se agotó entre medias—, y buscando por la línea, anular el
  segundo cobro devolvía también lo del primero, que ya había vuelto: stock fantasma. Reglas:
  - **Anular devuelve sólo lo de su cobro** (`Lote_Consumos.ID_Pago`, `Suelto_Consumos.ID_Pago`).
  - **La reconciliación cuenta un consumo salvo que su cobro se anulara POR ERROR.** Una devolución
    no devuelve el stock —el cliente se llevó la consumición—, así que su consumo sigue restando.
  - **El consumo se escribe DESPUÉS del pago.** La FK se comprueba sentencia a sentencia, también al
    replicarla en la nube: al revés, el cobro revienta.
  - De las tres consultas de la reconciliación, `recalcular_gasto` **escribe** (por `execute`, así
    que sale por el outbox): un aviso falso de descuadre inducía a pulsar «recalcular» y grabar un
    total malo, en local y en la nube.
- **`Pago_Detalles.ID_Detalle` va con `ON DELETE CASCADE`.** Una línea devuelta a la mesa tiene que
  poder quitarse; si la FK lo impidiera quedaría visible y congelada, que es peor que el
  comportamiento que esto arregla. No se pierde auditoría: lo que prueba la anulación es la fila de
  `Pagos`, y un `Pago_Detalles` cuya línea ya no existe no es una prueba sino un puntero colgante
  (la reimpresión une con `Detalle_Comanda`). Lo que protege a un cobro **activo** no es la FK: son
  las guardias de `delete_detalle` y `remove_one_pending_detalle`.
- **Borrar una comanda se niega si tiene CUALQUIER cobro, activo o anulado.** `Pagos.ID_Comanda` va
  con cascade, así que borrarla se llevaría por delante justo la fila que este cambio conserva.
- **Un cobro anulado queda congelado.** No se edita: cambiarle la fecha movería la anulación de
  periodo de caja a posteriori, que es lo que el rastro existe para impedir. Y no se «desanula»:
  para eso se vuelve a cobrar.
- **El motivo es obligatorio, siempre.** Quién y cuándo los pone el sistema; el porqué sólo puede
  ponerlo quien anula. Sin umbral a propósito: la sisa que esto caza son importes pequeños
  repetidos, justo los que un umbral dejaría pasar sin explicación. Lo valida el caso de uso y no un
  `CHECK`, que convertiría un olvido en un error de base de datos que no se puede explicar.
- **`Movimientos_Caja` es para investigar, no para calcular.** `Pagos` sigue siendo la única fuente
  de verdad del dinero y el arqueo sigue derivando de ahí. En cuanto alguien sume el esperado desde
  esa tabla habrá dos fuentes para la misma cifra y divergirán. Su `ID_Movimiento` se genera **antes**
  del INSERT (§9, «IDs deterministas»), y su `Importe` va siempre en positivo: el signo lo da el
  `Tipo`. Ampliarlo (devoluciones de VENTA-01, Veri*factu) es tocar el `CHECK`.
- **El movimiento es idempotente por (`Tipo`, apunte), y tiene que serlo.** El cobro y el gasto se
  guardan con `ON CONFLICT DO UPDATE` para que un reintento del cliente no duplique la venta; el
  movimiento lleva un `WHERE NOT EXISTS` por el mismo motivo. Sin él, ese mismo reintento dejaría
  dos filas —cada una con su `ID_Movimiento` nuevo, así que ninguna clave las frenaría— y el
  historial contaría dos cobros donde hubo uno. Los dos lados llevan la misma guardia.
- **Los anulados se ven, pero no cuentan.** Salen en la lista de Cuentas y en los PDF —es donde se
  investiga un descuadre, y esconderlos ahí sería devolver el producto al estado que esto arregla—
  pero no suman en los totales, ni en las estadísticas, ni en el pendiente de una comanda. El arqueo
  los enseña como línea informativa: «3 anulaciones por 40 €» junto a un descuadre de 40 € se explica
  solo.
- **La copia de un ticket anulado sale marcada `*** ANULADO ***`**, además de COPIA. Reimprimirlo
  sigue permitido —es la prueba de qué contenía— pero un papel que no lo diga circularía como un
  cobro válido.
- **Anular es de la Main.** El worker lo veta como el resto de escrituras de caja
  (`soloLaMainEscribeCaja`), y la ruta es `POST /v1/cuentas/pagos/:id/anular`: un `DELETE` diría lo
  contrario de lo que hace.

## 14. Permisos y sesión (SEC-01)

Quién puede hacer qué. **SEC-01**; qué está gateado, qué no y hasta dónde llega la garantía en
[docs/analisis/transversal/permisos-y-sesion.md](docs/analisis/transversal/permisos-y-sesion.md),
que cierra también el modelo de amenaza de LIC-04.

| Pieza | Archivo | Rol |
|---|---|---|
| La sesión | `lib.rs` (`Sesion`, `AppState::sesion`) | `Option<Sesion>` en memoria; la pone `login_user`, la quita `logout` |
| El gate | `lib.rs` (`sesion` · `exigir_rol` · `exigir_rol_si_hay_sesion`) | Tres helpers, no una comprobación copiada en cada comando |
| El rol | `lib.rs::ADMIN` y `shared/lib/permisos.ts::ROL_ADMIN` | Un sitio por lado |
| Código de error | `tpv-contracts::errors::ErrorCode::PermisoDenegado` | La UI ramifica por él para decir "no puedes" en vez de "ha fallado" |
| Cierre en el frontend | `shared/stores/useAuth.ts` + `app/AppBoot.tsx` | Las dos sesiones se cierran juntas |
| El guardián | `lib.rs::tests_exenciones_del_gate` | Vigila que nadie gatee lo que no puede gatearse |

### Reglas

- **El rol sale del repositorio, nunca de los args.** Quien puede invocar un comando puede escribir
  lo que quiera en su entrada, así que un rol que llega por ahí no es una comprobación: es una
  sugerencia. Lo mismo vale para el usuario que se **registra** en una fila (quién cerró la caja,
  quién abrió el cajón, quién anuló un cobro): sale de la sesión, y por eso `ConfirmarCierreInput`,
  `CierreIdInput`, `AbrirCajonArgs` y `AnularPagoInput` ya no llevan `id_usuario`. Una auditoría firmada con el nombre que le pasen da
  confianza sin merecerla, que es peor que no tener ninguna.
- **La lista de comandos gateados es corta a propósito.** Gatear "añadir una línea a la comanda"
  convierte el TPV en inservible en hora punta, y un gate que estorba acaba en que todo el mundo
  conoce el PIN del encargado — que es justo el permiso que se quería quitar. Antes de añadir uno,
  la pregunta no es "¿esto es delicado?" sino "¿esto lo hace alguien a mitad de servicio?".
- ⚠️ **`commands/recovery.rs` NO puede exigir sesión, nunca.** Esa pantalla existe para el caso de
  **cero usuarios**: un equipo que perdió su `data.db` no tiene con quién iniciar sesión, y
  ponerle el gate cierra su única salida — en silencio, porque en un equipo sano no se nota. Es la
  hermana de la regla que ya estaba escrita en §9: *todo lo que hay en ese camino tiene que tolerar
  `state.db == None`*. Añádele: **y `sesion == None`**. Lo vigila un test que lee el propio fuente.
- **Lo que se alcanza antes del login no puede exigir sesión, y no todo se ve a simple vista.** Las
  pantallas de arranque (selector de modo, activación de licencia, emparejamiento del Handy) se
  pintan **en lugar** del router, así que ahí no hay login que superar: `license_activate`,
  `set_device_mode` y `license_clear_state` están exentos. Para lo que se alcanza por los **dos**
  caminos está `exigir_rol_si_hay_sesion` (sin sesión pasa, con sesión exige el rol), que es lo que
  usa `device_reset_mode`.
- **El proxy genérico se gatea por ruta y fallando cerrado.** `tpv_server_post_json` firma lo que le
  den: por él viajan el emparejamiento de un Handy (sin sesión) y la administración de dispositivos
  de Configuración. Todo `/v1/pair/…` y `/v1/device/…` exige Administrador salvo `claim` y
  `fetch-token`. Va por **prefijo y no por lista blanca** para que una ruta de administración nueva
  quede cubierta sola.
- **La UI sigue escondiendo lo que no toca.** El gate del backend es la red, no el sustituto de una
  interfaz que no ofrece lo que no corresponde. Al gatear un comando hay que mirar si su pantalla
  tiene candado de ruta: sin él, quien escriba la URL ve una pantalla entera rota a base de "permiso
  denegado" en vez de un "esto no es tuyo".
- **Esto no es una frontera criptográfica y no pretende serlo.** Quien tiene la máquina puede
  invocar comandos por el IPC. Cubre a un camarero con el TPV delante, no a un atacante; lo que de
  verdad importa lo valida además el worker, que corre donde el usuario no manda.

---

## 15. Notas del generador de tickets

Los tests del generador están en `src-tauri/src/printing/tests.rs`, e incluyen un mini-intérprete
ESC/POS: separa texto de comandos y **falla si encuentra un byte que no es ninguna de las dos
cosas**, que es la única forma de comprobar el trabajo de impresión sin una impresora delante.

---

## 16. Los E2E sobre la app compilada (TEST-01)

**Cinco** recorridos sobre la app **compilada**, encadenados sobre un mismo equipo, que prueban la
costura que no mira nadie: React →
IPC de Tauri → comandos Rust → SQLite → y vuelta. No cubre el frontend ni lo pretende (la cobertura de
componentes sigue descartada a propósito, ver `vitest.config.ts`). Vive en `apps/tpv-main/e2e/`,
sobre **WebdriverIO + `@wdio/tauri-service`**, y tarda algo más de un minuto.

```bash
cargo install tauri-driver --locked          # una vez por máquina
pnpm --filter @tpv/main build:e2e            # compila el binario aislado y lo verifica
pnpm --filter @tpv/main test:e2e             # el recorrido
```

**El camino del dinero** (14 pasos): equipo nuevo → modo TPV → **activar una licencia de verdad**
contra `tpv-api` → elegir PIN → fichar entrada y entrar → un equipo recién estrenado **no sabe quién
factura**, la pantalla lo grita y se declara por Configuración → Fiscal → categoría y producto con
precio, IVA y lote → zona y mesa → dos líneas → **cobro en efectivo exacto** → el registro de
facturación existe, es `F2`, y **su número ES el número del ticket** → el ticket lleva su QR y una
reimpresión saca exactamente el mismo → una segunda venta avanza la cadena sin anomalías → las dos
quedan en la cola diciendo por qué no han salido → **cierre de caja con descuadre 0**. La última
cifra es la que lo justifica entero: si algo se rompe entre la interfaz y SQLite, deja de cuadrar.

El paso de los datos fiscales no es andamiaje del test: desde FISCAL-01 cada cobro expide una
factura, y `emitir_cobro` corta la transacción si faltan el NIF y la razón social. La activación de
la licencia **no** los rellena (su «nombre legal» va a la licencia, no a `Business_Settings`), así
que declararlos es parte del estreno de un equipo real.

Los pasos 9 y 10 son el corazón de la parte fiscal: hay ~100 tests de Rust sobre la huella y la
persistencia, y ninguno recorría React → IPC → cobro → registro → vuelta al papel. Si esa cadena se
parte la aplicación no protesta — el papel sale sin QR y ya está. Hasta TEST-03 fue un recorrido
aparte, que estrenaba un equipo idéntico para vender lo mismo.

**Las copias de seguridad** (4+5+3 pasos, en tres ficheros): sobre el equipo que deja la venta —con
sus cobros, sus facturas y su arqueo dentro— se crea algo más, se espera a que la nube lo tenga todo
y se guarda una copia → **se le machaca la `data.db`** → la app arranca igual y ofrece recuperar →
se restaura la copia → la reconciliación converge y el login se abre. Por el camino se le ofrece
primero una copia **inservible**, que la pantalla tiene que rechazar diciendo por qué y dejando
elegir otra. Va en varios ficheros porque en medio hay que apagar la aplicación: en Windows la base
no se reemplaza con SQLite teniéndola abierta, y reiniciar es además lo que pasa de verdad.

Y un tercer tramo rompe la base **otra vez** para probar el otro botón de esa pantalla:
**«Recuperar el estado actual de la nube»**, que es el que de verdad importa —la copia local sólo
existe si el disco sigue vivo; el día del robo o del disco muerto ese botón es lo único que hay—.
Ahí encontró que el volcado **nunca había funcionado**: el worker mandaba `totalFilas` y Rust
esperaba `total_filas`, así que serde fallaba entero. Once días roto sin que nadie lo supiera,
porque estaba probado por piezas y nunca de punta a punta.

Lo que NO sube a E2E de las copias, y por qué —para no volver a intentarlo—:

- **Las reglas de `recovery.rs`** (retención de siete, copia importada que no caduca, viaje a un
  USB…). Son 18 tests de Rust sobre ficheros y transacciones: no pasan por React ni por el IPC, así
  que aquí costarían cuarenta veces más sin mirar una línea más de código. Lo único que el E2E
  añade sobre ellas es la PANTALLA, y eso es lo que cubre el paso de la copia inservible.
- **La guardia del outbox al restaurar** (`asegurar_reemplazo_seguro`): es **inalcanzable desde la
  interfaz**. A la pantalla de recuperación sólo se llega de tres maneras —reconciliación
  pendiente, cero usuarios, o base ilegible— y las dos primeras están exentas de la guardia
  a propósito, mientras que en la tercera no hay `Db` sobre la que comprobarla. Es defensa en
  profundidad para un caso que la interfaz no sabe producir; su sitio es el test de Rust.
- **La reconciliación bloqueada tras cinco ciclos fallidos**: un ciclo que no converge tarda ~3 min
  **por diseño** (180 vueltas de un segundo), así que provocar cinco son quince minutos. La
  política ya está probada donde es barata y exacta: `test/estadoSync.test.ts` y
  `test/recoverySync.test.ts`, sin React ni DOM.

**La licencia deja de valer** (5 pasos, y va la última porque le rompe la licencia a todo el equipo
de la tanda): se anula → el TPV deja de trabajar y vuelve a pedir la
licencia → se desanula y la misma clave vuelve a activar, sin perder los datos → se caduca → sale la
pantalla de bloqueo → se renueva y el propio botón de reintentar la desbloquea. Los dos estados se
provocan por el API de administración; sin `shorten` no había forma de ensayar una caducidad sin
esperar meses de calendario.

Corre con la **nube encendida**, y eso es parte de lo que prueba: anular empuja (§9), así que el paso
de la anulación **no llama a nada** —espera a que la pantalla se bloquee sola— y su espera es corta
a propósito. El job `licencia` tiene `retardo_inicial` de 2 minutos: con una espera generosa el
bloqueo podría llegar por el job y el test daría verde con el empujón roto. Se verificó quitando el
aviso al `TenantHub` en el worker —sin él ese paso falla— y la caducidad, que **no** empuja, sigue
usando `license_check_now` porque ahí no hay nada que esperar.

| Pieza | Archivo | Rol |
|---|---|---|
| El camino del dinero | `e2e/specs/venta.e2e.ts` | Estreno, datos del obligado, carta, venta, cobro, su factura con el QR y arqueo |
| Copias de seguridad | `e2e/specs/copias-1-copia.e2e.ts` · `copias-2-recuperar.e2e.ts` | Copia, avería, restauración y reconciliación |
| Volver sólo con la nube | `e2e/specs/copias-3-nube.e2e.ts` | El volcado de SYNC-19, sin copia local |
| La licencia deja de valer | `e2e/specs/licencia.e2e.ts` | Anulada, desanulada, caducada y renovada |
| El equipo de la tanda | `e2e/helpers/equipo.ts` | Negocio, PIN y obligado: los comparten todos los recorridos |
| Arranque compartido | `e2e/helpers/arranque.ts` | Modo, activación, PIN y login |
| Vender por mesa | `e2e/helpers/vender.ts` | Carta, plano, líneas y cobro |
| Lo fiscal | `e2e/helpers/fiscal.ts` | Declarar el obligado y leer el registro, el estado y el bloque del ticket |
| Licencias de la tanda | `e2e/helpers/licencias.ts` | Emitir, revocar, desrevocar, acortar |
| Aislamiento del equipo | `e2e/helpers/entorno.ts` | Verifica el binario, prepara el AppData, rompe la base |
| Gestos | `e2e/helpers/ui.ts` | Pulsar, escribir y leer por IPC lo que la pantalla no enseña |
| Esperar a la nube | `e2e/helpers/nube.ts` | Outbox a cero: lo único que el IPC ofrece como prueba de que el socket está abierto |
| Configuración | `e2e/wdio.conf.ts` | Servicio, tiempos y captura de pantalla al fallar |
| Build aislado | `e2e/construir.ts` + `src-tauri/tauri.e2e.conf.json` | Identificador propio, copia verificada |
| Huella del código | `e2e/helpers/huella.ts` | Qué entra en el binario, para saber si está al día |

### Reglas

- **El aislamiento es un identificador, no una variable de entorno.** `app_data_dir()` de Tauri es
  `dirs::data_dir().join(identifier)`, y en Windows eso sale de `SHGetKnownFolderPath`, que **no
  mira `%APPDATA%`**: lanzar el `.exe` con otro `APPDATA` usaría la carpeta real y machacaría los
  datos de trabajo. Por eso hay un build con `identifier` propio (`…tpv.e2e`), que es lo único que
  separa una cosa de la otra.
- **Y por eso el binario se verifica antes de borrar nada.** `tauri build --no-bundle` **no**
  renombra el ejecutable (el rename a `productName` ocurre al empaquetar), así que el build de E2E y
  el de producción escriben los dos en `target/release/tpv.exe`: dejarlo ahí es cuestión de tiempo
  que alguien compile la app de verdad y luego lance el test contra sus propios datos.
  `construir.ts` deja una copia en `target/e2e/tpv-e2e.exe` y `onPrepare` **abre el fichero y
  comprueba el identificador que lleva dentro** antes de tocar la carpeta de datos. La limpieza,
  además, se niega si la ruta no termina en `.e2e`.
- **Un binario viejo no rompe: PASA, que es peor.** La comprobación del identificador dice que el
  `.exe` es el de E2E, no que sea el de **este** código. Sin nada más, alguien toca una pantalla, se
  olvida de `build:e2e`, lanza el test, sale verde y tagea — y lo que ha probado es la versión
  anterior. Por eso `construir.ts` deja junto al binario la huella (sha256 por fichero) de todo lo
  que entra en él, y el arranque la recalcula y se niega en dos segundos diciendo qué cambió. Se
  compara **contenido, no fechas**: cambiar de rama reescribe las fechas de medio repo y obligaría a
  recompilar por nada. Y `e2e/` y `test/` quedan fuera de la huella a propósito: si retocar un
  selector del propio recorrido exigiera recompilar la aplicación, a la tercera vez alguien quitaría
  la comprobación entera.
- **Lo que impide ejecutar no es un test que falla.** Las tres guardias del arranque (identificador,
  huella, licencia) terminan el proceso ahí mismo. WDIO se limita a registrar el error de un hook y
  **continúa**, así que sin eso arrancaba la app igual y el motivo real salía un minuto después
  disfrazado del fallo de un paso.
- **La tanda estrena UN equipo y UNA licencia, y los recorridos se lo van pasando** (TEST-03). La
  venta lo estrena, los tramos de copias le rompen la base y lo recuperan, y el de la licencia se la
  anula al final — por eso va el último. Antes cada recorrido estrenaba el suyo, y eran cuatro bases
  de Turso por tanda que no se borran solas para probar cosas que podían compartir equipo. El precio
  es que un fallo arrastra a los de detrás: en un informe rojo, el que importa es el **primero**.
- **La licencia se emite por tanda, nunca fija.** Se probó con una guardada en el `.env` y no
  aguanta por dos lados. Activar graba en el tenant el hash de `0001_inicial.sql`, así que en cuanto
  esa migración cambia —cosa permitida mientras no haya clientes— el tenant viejo deja de migrar y la
  activación falla con `migration_altered`. Y un tenant con historia no deja un equipo nuevo aunque
  se borre el AppData: al abrir el WebSocket la Main se trae por catch-up lo que dejaron las tandas
  anteriores —se vio como un fichaje que la app rechazaba *"tienes un fichaje abierto"* unas veces sí
  y otras no—. Emitir por tanda deja el `.env` con una sola cosa dentro: `ADMIN_API_TOKEN`.
- **El equipo corre con la nube encendida, de principio a fin**, que es como se vende. Mientras la
  licencia fue fija, la venta tenía que nacer con `connectivity: "off"` para no traerse otras tandas;
  con un tenant nuevo por tanda eso sólo servía para probar un equipo distinto del real. Una
  consecuencia que conviene tener presente: **con el worker desplegado por detrás del esquema, la
  tanda falla** (en las copias, que esperan a que suba todo), así que antes de lanzarla tras un
  cambio de esquema hay que redesplegar.
- **La licencia es real y sale a internet.** Un fallo en la activación puede ser la red y no el
  código: el mensaje del test recoge lo que dijo la pantalla para distinguirlos.
- **Cada recorrido declara qué hay que hacerle al equipo antes de arrancar**, en las recetas de
  `wdio.conf.ts`, y se lo hace `beforeSession`: estrenarlo, dejarlo como está o romperle la base.
  Tiene que ser ahí y no dentro del recorrido, porque con la app abierta SQLite tiene la base cogida;
  y declararlo es obligatorio porque borrar por defecto se llevaría por delante el equipo que dejó el
  recorrido anterior.
- ⚠️ **Un recorrido no importa a otro.** Importar un fichero de recorrido lo EJECUTA: sus `describe`
  se registran en quien lo importa. El segundo tramo de copias acabó corriendo los pasos del primero
  contra un equipo ya estrenado, y el síntoma —"no aparece la pantalla de primer inicio"— no se
  parecía en nada a la causa. Lo que se comparte vive en `helpers/`.
- **No va a CI, y no es pereza.** La licencia se ata al `main_device_id` del primer equipo que la
  activa, y esa identidad vive en el keyring de la máquina. Un runner es una máquina nueva cada vez,
  así que la segunda ejecución chocaría con el flujo de cambio de dispositivo, **que pide un OTP por
  correo**. Automatizarlo sería emitir y revocar una licencia por ejecución con el token de
  administración dentro de CI. Se corre antes de cada release (`RELEASING.md` §0-bis).
- **La mesa se pulsa por coordenadas porque el plano es un `<canvas>`.** Las mesas son figuras de
  Konva, no elementos: no hay nada que seleccionar. El test lee el layout real y calcula el punto con
  la **misma** función que usa la pantalla (`fitTransform`), importada, no copiada — dos versiones de
  esa cuenta se separan al primer retoque del encuadre.
- **El IPC se usa para LEER, nunca para sembrar.** Los datos del recorrido los crea el test por la
  interfaz, que es lo que se está probando. `leerDeLaApp` sólo se asoma a lo que ninguna pantalla
  enseña: dónde cae una mesa, si ha vuelto a libre (`mesas_meta_all` sólo lista comandas **abiertas**,
  así que "no está" *es* libre) y el número de ticket, que viaja al ESC/POS y no se pinta.
- **Un clic se comprueba, no se supone.** El teclado del PIN se lee de vuelta tras cada tecla: una
  pulsación perdida deja el PIN a medias y lo que falla es otra cosa dos pasos más allá. Y `pulsar`
  elige el primer candidato **visible**, porque la app duplica bloques enteros para móvil y
  escritorio y el primero del documento suele ser el que está oculto por CSS.
- ⚠️ **`aria-label="Cerrar"` también es el aspa de la ventana.** Un selector sin acotar cierra el
  TPV en mitad del test. Los selectores de dentro de un modal se anclan a su cabecera.
- **El servicio pregunta por un plugin que la app no lleva, y hay que callarlo.**
  `@wdio/tauri-service` intenta enfocar la ventana activa antes de cada `$`/`click` usando
  `tauri-plugin-wdio`; sin él reintenta 100 veces cada 50 ms **y no recuerda la respuesta**: 6,5 s
  por comando, ocho minutos de recorrido. El hook `beforeSuite` hace que ese puente falle en el acto.
  Instalar el plugin no es la solución: sería meter un servidor de depuración en el binario que se
  distribuye. Por lo mismo, `driverProvider` es `external` y no el `embedded` por defecto.
- **`timeoutMsg` se construye al llamar, no al fallar.** Interpolar ahí una variable que se rellena
  durante la espera imprime siempre su valor inicial. Lo que cuente el último intento va en un
  `throw` **después** de esperar.
- **El E2E SÍ pasa por el typecheck de CI**, aunque no se ejecute allí. `e2e/` vive fuera del
  `include` de la app, igual que `test/`, así que sin su tsconfig propio en el script `typecheck`
  sus errores de tipos no los vería nadie hasta que alguien lanzara la tanda a mano — o sea, justo
  antes de una release. Renombrar un helper y romper un recorrido sale gratis si nada compila esa
  carpeta.
- **Un fallo deja una captura** en `apps/tpv-main/e2e/fallos/` (no se versiona). Es lo que convirtió
  «algo tapa el botón» en «la regla común de modales capa esta modal a 42 rem».
