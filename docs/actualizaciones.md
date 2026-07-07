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

Cliente (arranque de la app)
  ├─ Rust: spawn(updater.check())  →  consulta el feed del worker
  ├─ Si hay update → emit("update:available", UpdateInfo)
  └─ UpdateBanner.tsx lo recibe, muestra banner
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
| Comandos Tauri | `updater_check` / `updater_install` en `src-tauri/src/main.rs`:973-1014 | ✅ |
| Chequeo automático al arrancar | `main.rs`:1034-1054 — spawn en background + `emit("update:available")` | ✅ |
| Componente frontend | `apps/tpv-main/src/shared/ui/UpdateBanner.tsx` — banner sticky bottom-right | ✅ |
| Montaje | `apps/tpv-main/src/app/AppBoot.tsx`:656 — una sola instancia | ✅ |
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

### 2. Backend Rust (`src-tauri/src/main.rs`)

**Struct de datos (líneas 960-968):**
```rust
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}
```

**`updater_check()` (líneas 973-988):** consulta el feed, devuelve `Option<UpdateInfo>`. Tolera errores (offline/feed caído falla en silencio).

**`updater_install()` (líneas 994-1014):** descarga, verifica firma e instala. Llama a `app.restart()` automáticamente.

**Chequeo automático al arrancar (líneas 1034-1054):** corre en segundo plano tras el setup, emite `update:available` si hay actualización.

### 3. Frontend (`UpdateBanner.tsx`)

- Al montarse: `invoke("updater_check")` (cubre race condition con el evento de arranque)
- Escucha: `listen("update:available", ...)` para recibir el evento del backend
- Botón "Actualizar y reiniciar": llama a `invoke("updater_install")`, muestra "Actualizando…", la app se reinicia sola si va bien
- Botón "Más tarde": oculta el banner (`dismissed`)
- Posición: sticky bottom-right, z-index 1000

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

### Secretos en GitHub Actions (Settings → Secrets)
- [ ] `TAURI_SIGNING_PRIVATE_KEY` = contenido de `updater.key`
- [ ] `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = contraseña (vacía si no tiene)
- [ ] `R2_ACCESS_KEY_ID`
- [ ] `R2_SECRET_ACCESS_KEY`
- [ ] `R2_ACCOUNT_ID`
- [ ] `RELEASE_ADMIN_TOKEN`

### Variables en GitHub Actions (Settings → Variables)
- [ ] `R2_BUCKET` (ej. `tpv-releases`)
- [ ] `R2_PUBLIC_BASE_URL` (URL pública del bucket R2)
- [ ] `TPV_API_BASE` = `https://tpv-api.altarialights.workers.dev`

### Secret en Cloudflare Worker
- [ ] `wrangler secret put RELEASE_ADMIN_TOKEN` (mismo valor que el de GitHub)

### Verificación end-to-end
- [ ] `git tag v0.1.0 && git push origin v0.1.0`
- [ ] Verificar que `release.yml` se ejecute sin errores
- [ ] Verificar que el feed devuelva 200 + manifest (`GET /v1/update/windows/x86_64/0.0.0`)
- [ ] Verificar que el cliente muestre el banner de actualización

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
