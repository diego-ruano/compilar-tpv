# Sistema de Auto-Actualizaciones — Estado completo

## Arquitectura (end-to-end)

```
git tag v0.2.0
      │
      ▼
GitHub Actions (release.yml)
  ├─ Valida: tag == tauri.conf.json.version == Cargo.toml.version
  ├─ pnpm tauri build  →  firma el .exe con la clave privada
  ├─ Sube .exe + .sig a R2
  └─ POST /v1/update/publish al worker  →  INSERT en app_releases

Cliente (arranque + cada 6 h mientras está abierta)
  ├─ Rust: tick → check_and_announce()  →  consulta el feed del worker
  ├─ Si hay update:
  │     ├─ emit("update:available", UpdateInfo)      → UpdateBanner.tsx muestra el banner
  │     └─ Notifier.emitir(actualizacion_disponible) → campana + toast a los administradores
  │                                                     (dedupe por versión → un aviso por release)
  └─ Configuración → Actualizaciones: estado, novedades y botón de instalar
        └─ Usuario pulsa "Actualizar"  →  descarga, verifica firma, instala, reinicia

Rollback (sin tocar el cliente)
  └─ POST /v1/update/deactivate  →  is_active=0  →  feed vuelve a la versión anterior
```

---

## Piezas implementadas

| Pieza | Archivo | Estado |
|---|---|---|
| Config updater | `apps/tpv-main/src-tauri/tauri.conf.json` líneas 44-52 | ✅ |
| Plugin Rust | `tauri-plugin-updater = "2"` en `apps/tpv-main/src-tauri/Cargo.toml` | ✅ |
| Comandos Tauri | `updater_check` / `updater_status` / `updater_install` en `src-tauri/src/lib.rs` | ✅ |
| Chequeo automático (arranque + cada 6 h) | `lib.rs` — tick en background tras `app.manage` → `check_and_announce` | ✅ |
| Aviso in-app | `notify_update_available` (`lib.rs`) → notificación a `ADMIN_ROL_ID`, dedupe `actualizacion:<version>` | ✅ |
| Componente frontend | `apps/tpv-main/src/shared/ui/UpdateBanner.tsx` — banner sticky bottom-right | ✅ |
| Pantalla de Configuración | `apps/tpv-main/src/features/configuracion/sections/Actualizaciones.tsx` | ✅ |
| Montaje del banner | `apps/tpv-main/src/app/AppBoot.tsx` — una sola instancia | ✅ |
| Feed público (worker) | `GET /v1/update/:target/:arch/:current` → 204 ó manifest JSON | ✅ |
| Publicación admin | `POST /v1/update/publish` — protegido con `RELEASE_ADMIN_TOKEN` | ✅ |
| Rollback | `POST /v1/update/deactivate` — pone `is_active=0` en la BD | ✅ |
| Workflow CI | `.github/workflows/release.yml` — compila, firma, sube a R2, publica feed | ✅ |

---

## Detalle por capa

### 1. Configuración Tauri (`tauri.conf.json` líneas 44-52)

- `pubkey`: clave pública base64 para verificar firmas (embebida en la app)
- `endpoints`: `https://tpv-api.altarialights.workers.dev/v1/update/{{target}}/{{arch}}/{{current_version}}`
- `windows.installMode`: `"passive"` (sin interacción del usuario)
- `createUpdaterArtifacts`: `true`

### 2. Backend Rust (`src-tauri/src/lib.rs`)

**Structs de datos:**
```rust
struct UpdateInfo { version, current_version, notes: Option<String> }

// Para la pantalla de Configuración. NUNCA falla: el fallo de feed viaja en `error`,
// para poder pintar la versión instalada aunque no haya internet.
struct UpdateStatus { current_version, supported: bool, update: Option<UpdateInfo>, error: Option<String> }
```

**`check_and_announce()`** — punto único de detección + aviso. Consulta el feed y, si hay versión
nueva, emite `update:available` (banner) **y** `notify_update_available` (notificación in-app a
`ADMIN_ROL_ID`, con `clave_dedupe = actualizacion:<version>` → un solo aviso por release, aunque el
chequeo se repita). Lo usan por igual el tick automático, `updater_check` y `updater_status`.

**`updater_check()`** — devuelve `Option<UpdateInfo>`; lo llama el banner al montarse.

**`updater_status()`** — versión instalada + resultado real de consultar el feed; lo llama la
pantalla de Configuración. Comprueba de verdad (nada cacheado), así que "Buscar actualizaciones"
también deja puesto el aviso.

**`updater_install()`** — descarga, verifica firma e instala. Llama a `app.restart()`.

**Tick automático:** es el job `updater` del runner de tareas de fondo
(`src-tauri/src/jobs/registro.rs`), no un `spawn` suelto. Arranca 30 s después del setup
(`UPDATE_CHECK_DELAY_SECS`) y vence cada 6 h (`UPDATE_CHECK_INTERVAL_SECS`), ambas constantes
declaradas en ese catálogo. Un TPV puede estar semanas encendido, así que sin este tick una release
nueva no se vería hasta el siguiente arranque.

Del resto se encarga el motor del runner (ver §10 de `CLAUDE.md`): si el feed está caído reintenta
con backoff en vez de esperar las 6 h enteras, el vencimiento se mide contra la última comprobación
correcta persistida (así que también se dispara tras días apagado), y el último error queda visible
en Configuración → Conectividad → "Tareas en segundo plano".

### 3. Frontend

**Pantalla `Configuración → Actualizaciones`** (`features/configuracion/sections/Actualizaciones.tsx`):
versión instalada, estado ("Estás al día" / "Actualización disponible" / "No se pudo comprobar"),
hora de la última comprobación, novedades de la versión y botones "Buscar actualizaciones" /
"Actualizar y reiniciar" (con confirmación, porque reinicia la app). En plataformas sin updater
(Handy Android, `supported: false`) solo muestra la versión instalada.

**Banner (`UpdateBanner.tsx`)**

- Al montarse: `invoke("updater_check")` (cubre race condition con el evento de arranque)
- Escucha: `listen("update:available", ...)` para recibir el evento del backend
- Botón "Actualizar y reiniciar": llama a `invoke("updater_install")`, muestra "Actualizando…", la app se reinicia sola si va bien
- Botón "Más tarde": oculta el banner (`dismissed`) y recuerda que la actualización sigue en
  Configuración → Actualizaciones
- Posición: sticky bottom-right, z-index 1000

**Notificación in-app:** la emite el backend (no la UI), tipo `actualizacion_disponible`, severidad
`info`, destino rol admin. Aparece en la campana y dispara el toast de notificaciones. Al ir por el
`Notifier` mode-switched, se replica por el outbox → DO → broadcast, así que también llega a las
Handy emparejadas.

### 4. Worker (`apps/cloud-worker-licensing/`)

**Tabla `app_releases`:**
```sql
CREATE TABLE IF NOT EXISTS app_releases (
  version       TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT 'windows',
  channel       TEXT NOT NULL DEFAULT 'stable',
  notes         TEXT,
  pub_date      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  url           TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  PRIMARY KEY (version, target, channel)
);
```

**Rutas (`src/domains/updates/updates.routes.ts`):**

- `GET /:target/:arch/:current` — feed público, devuelve 204 si no hay update o manifest Tauri:
  ```json
  {
    "version": "0.2.0",
    "notes": "...",
    "pub_date": "2026-06-29T...",
    "platforms": {
      "windows-x86_64": { "signature": "...", "url": "https://..." }
    }
  }
  ```
- `POST /publish` — protegido con `RELEASE_ADMIN_TOKEN`, INSERT en `app_releases`
- `POST /deactivate` — protegido con `RELEASE_ADMIN_TOKEN`, SET `is_active=0` (rollback)

Registro en el router: `app.route("/v1/update", updatesRoutes)` en `src/index.ts`:163

### 5. Workflow CI (`.github/workflows/release.yml`)

**Trigger:** push de tags `v*`

**Steps:**
1. Valida coherencia de versiones (tag == `tauri.conf.json` == `Cargo.toml`)
2. Verifica que `TAURI_SIGNING_PRIVATE_KEY` esté configurado
3. `pnpm --filter @tpv/main tauri build` con las env vars de firma
4. Localiza `.exe` y `.sig` en `target/release/bundle/nsis/`
5. Sube a R2 con AWS CLI
6. `POST /v1/update/publish` al worker con `{ version, url, signature, notes }`

---

## Checklist para activar el sistema

### Clave de firma
- [x] `apps/tpv-main/src-tauri/.tauri/updater.key` existe (348 bytes) ✅

### Secretos y variables (GitHub Actions + Worker)
Configurados y **verificados en producción**: la release `v0.1.0` se publicó con el workflow y el
feed la sirve (`GET /v1/update/windows/x86_64/0.0.1` → 200 + manifest firmado, 2026-08-07).

- Secretos (Settings → Secrets): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `RELEASE_ADMIN_TOKEN`
- Variables (Settings → Variables): `R2_BUCKET`, `R2_PUBLIC_BASE_URL`,
  `TPV_API_BASE` = `https://tpv-api.altarialights.workers.dev`
- Worker: `wrangler secret put RELEASE_ADMIN_TOKEN` (mismo valor que el de GitHub)

### Verificación end-to-end
- [x] `release.yml` se ejecuta sin errores al pushear el tag
- [x] El feed devuelve 200 + manifest
- [ ] Publicar una versión nueva y comprobar en un cliente con la anterior: banner + notificación +
      Configuración → Actualizaciones + instalar y reiniciar

---

## Flujo de publicación de un release

```bash
# 1. Actualizar versión en los tres sitios (deben coincidir):
#    - apps/tpv-main/src-tauri/tauri.conf.json  →  "version": "0.2.0"
#    - apps/tpv-main/src-tauri/Cargo.toml       →  version = "0.2.0"

# 2. Commit + tag
git add -p
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin main --tags

# 3. GitHub Actions se encarga del resto automáticamente
```

## Rollback de un release

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/deactivate \
  -H "Authorization: Bearer <RELEASE_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "version": "0.2.0", "target": "windows", "channel": "stable" }'

# Resultado: los clientes ya no ven esa versión en el feed
```
