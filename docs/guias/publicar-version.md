# Publicar una versión

Cómo sacar una versión de la aplicación de escritorio para que llegue sola a todos los equipos, y cómo
retirarla si sale mal sin tocar ningún PC.

```
git tag v1.2.0 ─► GitHub Actions (release.yml) ─► compila y firma ─► sube el .exe a R2
                                                                  └► POST /v1/update/publish ─► app_releases
TPV (al arrancar y cada 6 h) ─► GET /v1/update/{target}/{arch}/{versión} ─► tpv-api
        └─ si hay una más alta: banner + notificación ─► el usuario pulsa ─► descarga, verifica firma, instala, reinicia
```

## Antes de tagear: los E2E

CI no arranca la aplicación. Los recorridos que sí lo hacen van a mano, porque emiten una licencia real
([apps/tpv-main/e2e/README.md](../../apps/tpv-main/e2e/README.md)):

```bash
pnpm --filter @tpv/main build:e2e
pnpm --filter @tpv/main test:e2e
```

- Requisitos por máquina: `cargo install tauri-driver --locked` y `ADMIN_API_TOKEN` en el `.env` de la
  raíz.
- **Redespliega el worker antes si ha cambiado el esquema**: la tanda activa contra el `tpv-api`
  desplegado.
- Cada tanda crea una base en Turso que no se borra sola: de vez en cuando, limpiar las licencias
  `E2E …` de `pnpm license:list`.
- **Si sale rojo, no se tagea.** Un fallo deja una captura en `apps/tpv-main/e2e/fallos/`. Un fallo al
  activar puede ser la red: el mensaje lo distingue.

## Sacar la versión (CI)

1. Subir `version` en `apps/tpv-main/src-tauri/tauri.conf.json` **y** en
   `apps/tpv-main/src-tauri/Cargo.toml` (SemVer; el updater compara este número).
2. Commit y tag:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

`release.yml` (en `windows-latest`): instala, genera los tipos (`pnpm generate-types`), comprueba que el
tag coincide con las dos versiones, comprueba que existe la clave de firma, compila y firma
(`pnpm --filter @tpv/main tauri build`, con `TPV_SENTRY_DSN` si está), busca el instalador NSIS en
`<raíz>/target/release/bundle/nsis/` (el workspace es virtual), sube el `.exe` a R2 y publica en el feed
con el contenido del `.sig`.

### Secretos y variables de GitHub (Settings → Secrets and variables → Actions)

| Secretos | Variables |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` (contenido de `updater.key`), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `RELEASE_ADMIN_TOKEN`, `TPV_SENTRY_DSN` (opcional) | `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `TPV_API_BASE` (`https://tpv-api.altarialights.workers.dev`) |

En el worker, `RELEASE_ADMIN_TOKEN` con el mismo valor (`pnpm exec wrangler secret put
RELEASE_ADMIN_TOKEN`); sin él, publicar y retirar están deshabilitados.

### La clave de firma del updater

La privada vive en `apps/tpv-main/src-tauri/.tauri/updater.key` (fuera de git) y en el secreto de CI; la
pública está en `tauri.conf.json` (`plugins.updater.pubkey`). ⚠️ **Sin la privada no se puede firmar y
los equipos instalados no pueden actualizar nunca más**: tiene que haber copia fuera del equipo. Para
generar otra: `pnpm --filter @tpv/main exec tauri signer generate -w src-tauri/.tauri/updater.key -f`, y
pegar la `.pub` nueva en `tauri.conf.json` (los equipos con la anterior ya no aceptarían las firmas
nuevas).

## Sacar la versión a mano (respaldo)

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "apps/tpv-main/src-tauri/.tauri/updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
pnpm tauri build
```

Salida en `target/release/bundle/nsis/`: `tpv_<versión>_x64-setup.exe` y su `.exe.sig` (sólo NSIS:
`bundle.targets` es `["nsis"]`). Subir el `.exe` a un sitio público y publicar:

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/publish \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{ "version": "1.2.0", "url": "https://…/tpv_1.2.0_x64-setup.exe",
        "signature": "<contenido del .exe.sig>", "notes": "…" }'
```

`target` (`windows`), `arch` (`x86_64`) y `channel` (`stable`) tienen esos valores por defecto.

## El feed

`apps/cloud-worker-licensing/src/domains/updates/updates.routes.ts`, tabla `app_releases` de la base
central, clave `(version, target, arch, channel)`.

- `GET /v1/update/:target/:arch/:current` sirve la versión **más alta** activa de ese `target` y `arch`
  en `stable`, comparada con `compararVersiones` (numérica por tramos; una preliberación pierde contra su
  versión final), no la última insertada: `publish` es un `INSERT OR REPLACE` y retocar una versión vieja
  le pone la fecha de hoy. Sin nada que ofrecer, 204.
- `POST /v1/update/publish` y `POST /v1/update/deactivate` exigen `RELEASE_ADMIN_TOKEN`.
- El cliente sólo lee `stable`. Publicar en otro canal guarda la versión sin ofrecerla a nadie.

## Retirar una versión

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/deactivate \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{ "version": "1.2.0" }'
```

Pone `is_active = 0` (sin `arch`, en todas las arquitecturas) y el feed vuelve a ofrecer la anterior
activa. Quien ya instaló la mala necesita una versión nueva con el arreglo: el updater no baja de
versión.

## En el TPV

| Pieza | Archivo |
|---|---|
| Configuración | `tauri.conf.json` (`plugins.updater`: `pubkey`, `endpoints`, `windows.installMode: "passive"`; `bundle.createUpdaterArtifacts`) |
| Comandos | `lib.rs`: `updater_check`, `updater_status`, `updater_install` |
| Comprobación | job `updater` (sólo escritorio): a los 30 s del arranque y cada 6 h → `check_and_announce` |
| Aviso | evento `update:available` (banner `src/shared/ui/UpdateBanner.tsx`) y notificación a los administradores con dedupe `actualizacion:<versión>` |
| Pantalla | Configuración → Actualizaciones (`features/configuracion/sections/Actualizaciones.tsx`) |

La instalación no reinicia sola: la lanza el usuario («Actualizar y reiniciar») para no cortar un
servicio. Si el feed está caído, la aplicación sigue funcionando y lo vuelve a intentar con el backoff del
runner. Reinstalar el `.exe` por encima conserva los datos (`data.db` está en AppData). Antes de migrar
el esquema, la aplicación copia `data.db` a `data.db.bak.<ms>` (se conservan las dos últimas).

## Cambios de esquema y de la base central

- **Esquema del tenant**: ver [esquema.md](../arquitectura/esquema.md#cambiar-el-esquema). Se
  **despliega el worker antes** de publicar la versión que escribe la columna nueva.
- **Base central**: las tablas y columnas nuevas se crean **a mano en Turso antes** de desplegar el
  worker que las usa, y se reflejan en `docs/sql/control-plane/esquema-actual.sql`.

```bash
cd apps/cloud-worker-licensing
pnpm exec wrangler deploy
```

## Qué corre en CI

| Workflow | Cuándo | Qué |
|---|---|---|
| `ci.yml` | push y PR | Tests de Rust con `cargo nextest` (`tpv-domain`, `tpv-application`, `tpv-infra-sqlite`, con el anti-drift del esquema) y clippy; ESLint; typecheck y tests del frontend y `check-comandos-tauri.mjs`; typecheck y tests del worker, `check-migration-registry.mjs` y la cobertura de los arneses de contrato (informativa) |
| `release.yml` | tag `v*` | Lo de arriba |
| `audit.yml` | PR y los lunes | `cargo audit` y `pnpm audit --prod --audit-level moderate` |

## Lista

- [ ] E2E en verde
- [ ] Worker desplegado si cambió el esquema o la base central
- [ ] `version` subida en `tauri.conf.json` y `Cargo.toml`
- [ ] Tag pusheado y `release.yml` en verde
- [ ] Probado en un equipo piloto
