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
    │                          #   0001_inicial.sql consolidó las incrementales previas al lanzamiento;
    │                          #   a partir de ahí todo cambio va en una migración NUEVA (0002…): el
    │                          #   runner rechaza una migración ya aplicada cuyo hash cambie. Al añadir
    │                          #   una, regístrala TAMBIÉN en el worker (tenantMigrations.ts) y en
    │                          #   test/helpers/esquemaTenant.ts, y toca migrations.rs para que
    │                          #   include_dir! no sirva la copia vieja.
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
  sentencia, así que el outbox replica ya el texto cifrado y el sync no se entera. La clave (DEK)
  la genera el worker al aprovisionar, viaja en la respuesta de `/v1/license/activate` y vive en
  el `secret_store` de la Main — **nunca en la BD que protege**. Consecuencia de diseño: la Handy
  no tiene la clave, así que el worker **ni escribe ni devuelve** esas tres columnas y su UI las
  oculta; se rellenan desde la Main. Detalle en `crates/tpv-infra-licensing/src/field_crypto.rs`.
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
| Reimpresión | `src/app/pages/Cuentas.tsx` | Copia marcada (`es_copia`), no genera número nuevo |

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
  hay que poder investigar.
- **El logo es de un bit.** `rasterizar_logo` reduce al ancho del papel (múltiplo de 8 dots),
  difumina con Floyd–Steinberg y emite `GS v 0`. Si la imagen no se puede leer devuelve `None` y el
  ticket sale sin logo: **nada de lo que rodea al ticket puede impedir cobrar.**
- **Cobrar es cosa de la Main.** El worker rechaza el cobro desde una Handy (`cobro_solo_en_main`),
  porque el número correlativo y el cajón viven en la Main.
