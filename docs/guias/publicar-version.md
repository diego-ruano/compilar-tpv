# Publicar una versión

Cómo sacar una versión de la aplicación de escritorio para que llegue sola a los equipos —primero a los
bares piloto, después a todos—, y cómo retirarla si sale mal sin tocar ningún PC.

```
git tag v1.2.0 ─► GitHub Actions (release.yml) ─► CI completo ─► compila y firma ─► sube el .exe a R2
                                                                                 └► POST /v1/update/publish (canal beta)
pnpm release:promocionar -- --version 1.2.0 ─► la copia al canal stable
TPV (al arrancar y cada 6 h) ─► GET /v1/update/{target}/{arch}/{versión} + X-Tpv-Device ─► tpv-api
        └─ bar piloto: beta y stable; los demás: stable
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

`release.yml` corre antes el CI entero (`ci.yml`, como workflow reutilizable): un tag cuyo commit no lo
pasa no se publica. Después, en `windows-latest`: instala, genera los tipos (`pnpm generate-types`),
comprueba que el tag coincide con las dos versiones, comprueba que existe la clave de firma, compila y
firma (`pnpm --filter @tpv/main tauri build`, con `TPV_SENTRY_DSN` si está), busca el instalador NSIS en
`<raíz>/target/release/bundle/nsis/` (el workspace es virtual), sube el `.exe` a R2 y publica en el feed
**en el canal `beta`**, con el contenido del `.sig`.

### Versiones y mapas de Sentry

El workflow comprueba las dos versiones del paso 1 frente al tag; no comprueba
`apps/tpv-main/package.json`. Esa versión se usa como release de los mapas de Vite cuando falta
`SENTRY_RELEASE`, mientras que los eventos usan `CARGO_PKG_VERSION` de la crate `tpv`.
Si se habilita la subida de mapas, su release debe coincidir con la de los eventos: el valor de
`SENTRY_RELEASE` sólo afecta al plugin de Vite.

Actualmente `release.yml` no pasa `SENTRY_AUTH_TOKEN` ni `SENTRY_RELEASE`, por lo que no genera ni
sube source maps. Es una limitación pendiente de RI-24; el paso que compila con `TPV_SENTRY_DSN`
no habilita esa subida. Detalles en
[observabilidad.md](../arquitectura/observabilidad.md#release-de-sentry-y-source-maps).

## Bares piloto y promoción (RI-30)

Una versión recién publicada sólo la ven los equipos de los negocios marcados como piloto
(`tenants.piloto` en la base central). Cuando lleva unos días sin problemas en ellos, se promociona y la
ven todos:

```bash
pnpm piloto:lista -- --todos                    # los negocios con su id
pnpm piloto:poner -- --tenant <tenantId>        # o piloto:quitar
pnpm release:lista                              # qué versión está en qué canal
pnpm release:promocionar -- --version 1.2.0     # de beta a estable, con la misma firma y URL
```

Conviene elegir pilotos variados (con Handy, con varias impresoras, con mucho volumen) y que sepan que lo
son. El TPV de staging, cuando exista (INFRA-01), será un piloto más. Marcar o quitar un piloto también se
puede hacer con un `UPDATE tenants SET piloto = 1 WHERE tenant_id = '…'` en Turso: se nota en la
siguiente comprobación de ese equipo.

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

`target` (`windows`), `arch` (`x86_64`) y `channel` (`stable`) tienen esos valores por defecto: a mano se
publica directamente para todos. Para pasar antes por los pilotos, `"channel": "beta"`.

## El feed

`apps/cloud-worker-licensing/src/domains/updates/updates.routes.ts`, tabla `app_releases` de la base
central, clave `(version, target, arch, channel)`.

- `GET /v1/update/:target/:arch/:current` sirve la versión **más alta** activa de ese `target` y `arch`,
  comparada con `compararVersiones` (numérica por tramos; una preliberación pierde contra su versión
  final), no la última insertada. A un equipo de un negocio piloto (lo dice la cabecera `X-Tpv-Device`)
  le sirve la más alta de `beta` y `stable`; a los demás, sólo de `stable`. Sin cabecera, con un equipo
  desconocido o revocado, o si falla la consulta, `stable`. Sin nada que ofrecer, 204.
- `POST /v1/update/publish` y `POST /v1/update/deactivate` exigen `RELEASE_ADMIN_TOKEN`. Volver a
  publicar una versión retoca su fila (`ON CONFLICT … DO UPDATE`) y la reactiva.
- La lista de versiones, la promoción y los pilotos van por `/v1/admin/*` (`ADMIN_API_TOKEN`, el CLI).

## Retirar una versión

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/deactivate \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{ "version": "1.2.0" }'
```

Pone `is_active = 0` (sin `arch`, en todas las arquitecturas; sin `channel`, en `beta` y en `stable`) y
el feed vuelve a ofrecer la anterior activa. Quien ya instaló la mala necesita una versión nueva con el arreglo: el updater no baja de
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
