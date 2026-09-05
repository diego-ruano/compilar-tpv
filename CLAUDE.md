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
    │                          #   rebendice el snapshot (BLESS_SCHEMA_SNAPSHOT=1).
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
```

### Los tests de Rust se corren con `cargo nextest`

`cargo test` mete los 224 tests en **un solo proceso**, y libsql tiene un crash nativo
(`STATUS_ACCESS_VIOLATION`) al crear bases de datos. En un proceso compartido eso mata la tanda
entera: no dice en qué test fue ni deja veredicto de los otros 223. Con la suite completa pasaba
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
- ✅ Verificación final: `cargo build` (workspace completo) + `cargo test -p tpv-contracts` (176 ok) + `tsc` frontend + `pnpm generate-types` (turbo) OK. Reparado el pipeline turbo (claves `"//"` inline y `packageManager` ausente).
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
| Determinismo temporal | `db.rs:114-122` + `durableObjects/tenantHub.tiempo.ts` | `datetime('now','localtime')` → literal antes de capturar/replicar. Con tests (`test/tenantHubTiempo.test.ts`) |
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
  - **Palanca de emergencia sin UI:** `connectivity: "auto" | "off"` en `device_config.json`
    (comandos `get/set_connection_mode`). Sirve para una red patológica o un cliente que no quiera
    nube. La captura del outbox NO depende de ella: al volver a `auto` se drena lo acumulado.
  - **Socket medio-muerto:** el latido verifica el `pong` (el DO lo contesta en el edge) y cierra
    tras dos latidos sin respuesta; además se reconecta al instante ante `online`/`focus`/
    `visibilitychange`. Sin ambos, un TCP medio-abierto se quedaba mudo para siempre.
- **Sin conexión:** la Main sigue funcionando; el outbox y `_Sync_Applied_Ops` crecen pero la idempotencia los tolera. Se drenan al recuperarla.
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
| Volcado | `domains/sync/sync.routes.ts` → `/v1/sync/bootstrap` | Estado actual + `Seq` de la foto |
| Restauración | `infra-sqlite/src/sync.rs::bootstrap_restaurar` | Reemplaza en una transacción |
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
- **El IVA es por producto** (`Productos.IVA_Percent`, migración 0004). Un mismo ticket puede llevar
  varios tipos, así que el pie lleva **una línea de base+cuota por tipo**. El `iva_percent` global
  del payload es sólo el defecto para lo que no lo traiga.
- **El número de ticket es correlativo y lo asigna la BD** (migración 0005, `siguiente_numero_ticket`
  con un `UPDATE … Ultimo + 1` relativo, no un `SELECT MAX`). Una reimpresión reusa el número: si
  saliera uno nuevo, la copia parecería una venta más.
- **El cajón se abre con la impresora.** El pulso va dentro del propio flujo del ticket (`ESC p`) o
  suelto (`DLE DC4`, que la impresora atiende aunque tenga cola). Toda apertura fuera de un cobro se
  registra en `Aperturas_Cajon` (migración 0006) — un cajón que se abre sin venta es el descuadre que
  hay que poder investigar. Abrirlo no pide rol (el camarero lo necesita para dar cambio) pero sí
  **estar identificado**, y el nombre que se anota lo pone la sesión: con SEC-01, `printer_open_drawer`
  ya no acepta un `id_usuario` de la entrada.
- **El logo es de un bit.** `rasterizar_logo` reduce al ancho del papel (múltiplo de 8 dots),
  difumina con Floyd–Steinberg y emite `GS v 0`. La transparencia se compone sobre blanco antes de
  nada (un PNG de fondo transparente salía como un rectángulo negro). Si la imagen no se puede leer
  devuelve `None` y el ticket sale sin logo: **nada de lo que rodea al ticket puede impedir cobrar.**
- **El logo cierra el ticket, centrado.** Va lo último: después del mensaje de despedida y antes
  del corte. Arriba obligaba a centrar debajo de él los datos del negocio para que no quedaran
  descolgados, y lo primero que se lee de un recibo tiene que ser de quién es y cuánto se ha
  pagado. La cabecera son esos datos **alineados a la izquierda**.
- **El ancho del logo sale del papel, no del texto.** `ancho_logo_dots` parte del cabezal del
  formato y descuenta los márgenes; `chars_per_line` no entra. Esa opción es la densidad de las
  LETRAS: quien la baja a 20 quiere el texto más grande, no un logo del tercio del papel.
- **Cobrar es cosa de la Main.** El worker rechaza el cobro desde una Handy (`cobro_solo_en_main`),
  porque el número correlativo y el cajón viven en la Main.
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

## 12. Cierre de caja (arqueo)

El corte del periodo de caja. **CUENTA-06**; diseño y porqués en
[docs/PLAN_CIERRE_CAJA.md](docs/PLAN_CIERRE_CAJA.md).

| Pieza | Archivo | Rol |
|---|---|---|
| Aritmética | `crates/tpv-domain/src/cierre_caja.rs` | Recuento, esperado, descuadre, umbral del motivo. Sin BD ni reloj: aquí están los tests |
| Persistencia | `crates/tpv-infra-sqlite/src/cierre_caja.rs` | `Cierres_Caja` + `Cierre_Denominaciones` |
| Casos de uso | `tpv-application/src/use_cases/cierre_caja.rs` | Preparar, confirmar, reabrir, el gate y el aviso |
| Pantalla | `src/features/cuentas/CierreCajaModal.tsx` | El modal y el contador; el histórico vive en `pages/Cuentas.tsx` |
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
  noche. Si mañana se reabre el periodo y se corrige un cobro, el arqueo de ayer no puede cambiar
  solo: dejaría de explicar por qué faltaban 20 €.
- **Sólo se cuadra el efectivo, y sólo con ventas.** De esta caja no se paga a proveedores ni a
  nómina, así que `esperado = fondo + cobros **activos** en efectivo` (CUENTA-07, §13). El hueco que
  eso deja —sacar dinero para otra cosa sale como que falta— **se tapa diciéndolo en la pantalla**,
  no con código. Y las anulaciones del periodo se enseñan al lado, sin entrar en el cálculo.
- **Cerrar bloquea el periodo; reabrir deja rastro.** El bloqueo no tiene columna: se deduce
  comparando la fecha del apunte con el último cierre no reabierto, que es un estado menos que
  mantener sincronizado. El gate vive en los comandos, no en la UI, y la fecha se lee de la BD y no
  de la entrada: en un borrado sólo llega el id. **Y el rastro tampoco se acepta de la entrada**
  (SEC-01): quién cierra y quién reabre sale de la sesión del backend, así que `ConfirmarCierreInput`
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
| Comando | `commands/cuentas.rs::cuentas_anular_pago` | Administrador + gate de periodo; firma con la sesión |
| Pantalla | `src/app/pages/Cuentas.tsx` | Lista los anulados marcados; pide el motivo |
| Worker | `domains/cuentas/cuentas.commands.ts::anularPago` | Paridad; vetado a la Handy |

### Reglas

- **El agujero que esto cierra.** El arqueo calcula `esperado = fondo + cobros en efectivo`, así que
  borrar la fila de una venta en efectivo bajaba el esperado **exactamente lo mismo** que faltaba en
  el cajón: el descuadre salía cero. Los números eran correctos; lo que no había era nada con lo que
  compararlos. Consecuencia: **`ventas_efectivo_desde` filtra por `Estado='ACTIVO'`, y ese filtro es
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
- **La reconciliación cuenta un consumo salvo que TODOS los pagos de su línea estén anulados.** No
  «si tiene un pago activo»: un consumo que nunca llegó a ligarse a un cobro sigue habiendo salido
  del lote, y una línea anulada y vuelta a cobrar también. Y de las tres consultas,
  `recalcular_gasto` **escribe** (por `execute`, así que sale por el outbox): sin el filtro, el aviso
  falso de descuadre inducía a pulsar «recalcular» y grabar un total que incluye el cobro anulado,
  en local y en la nube.
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
