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

1. Subir `version` en `apps/tpv-main/src-tauri/tauri.conf.json`,
   `apps/tpv-main/src-tauri/Cargo.toml`, `apps/tpv-main/package.json` y
   `apps/cloud-worker-licensing/package.json` (SemVer). Las cuatro deben coincidir.
2. Commit y tag:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

`release.yml` corre antes el CI entero (`ci.yml`, como workflow reutilizable): un tag cuyo commit no lo
pasa no se publica. Después se ejecutan jobs con credenciales separadas (RI-25):

- **Build**: comprueba versiones y contratos, compila NSIS sin la clave del updater y guarda el
  instalador junto a su versión, nombre y SHA-256 en un artefacto inmutable del mismo workflow.
- **Firma**: descarga ese artefacto e instala sólo un firmante Tauri con versión e integridades
  bloqueadas en `.github/tools/updater-signer/`, sin scripts de instalación ni caché del build.
  Sólo el paso de firma recibe la clave. Verifica el hash y la firma contra la clave pública de
  `tauri.conf.json` antes de entregar el instalador firmado.
- **Publicación**: vuelve a verificar hash y firma, sube el instalador a R2 y publica el feed **beta**.
  Sólo este job recibe las credenciales de R2 y del feed.

Las acciones externas de los workflows están fijadas por SHA completo; Dependabot mantiene esas
referencias. La separación evita que código que se haya ejecutado al compilar pueda permanecer en
el runner que recibe la clave. No elimina la necesidad de revisar las dependencias y los cambios
al workflow o al firmante.

### Versiones y mapas de Sentry

El workflow exige versiones coherentes con el tag y valida el token y el DSN activo de
`altaria-lights/tpv-desktop`. Vite y Rust comparten `tpv-desktop@<versión>`. Windows 7 usa
`tpv-desktop-win7@<versión>` y el tag `win7-v<versión>` en su rama.

El worker se compila en otro job con `tpv-api@<versión>`, inyecta Debug IDs, sube sus mapas y
comprueba un evento real con traza TypeScript. Una vez listos ambos builds y la firma del
escritorio, otro runner despliega ese mismo artefacto del worker. El instalador sólo se publica
cuando ese despliegue termina correctamente. El tag de Windows 7 no despliega el worker.

Vite sube los mapas por release/ruta, sin Debug IDs incompatibles con el puente actual de Tauri.
Tras compilar, CI comprueba que cada JS tiene su mapa en Sentry y que no quedan `.map` en el bundle.
**Cualquier fallo bloquea la firma y la publicación**, también cuando el destino sea staging. Detalles en
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
| `TAURI_SIGNING_PRIVATE_KEY` (contenido de `updater.key`), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `RELEASE_ADMIN_TOKEN`, `TPV_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `CLOUDFLARE_API_TOKEN` | `R2_BUCKET`, `R2_PUBLIC_BASE_URL`, `TPV_API_BASE` (`https://tpv-api.altarialights.workers.dev`), `SENTRY_ORG` (`altaria-lights`), `SENTRY_PROJECT` (`tpv-desktop`), `SENTRY_WORKER_PROJECT` (`node-cloudflare-workers`), `CLOUDFLARE_ACCOUNT_ID` |

El token de Cloudflare necesita Workers Editor en la cuenta que contiene `tpv-api`. El DSN del
worker sigue siendo el secreto `SENTRY_DSN` de Cloudflare; el token de Sentry sólo entra en el build.
Las migraciones de la base central siguen siendo manuales y deben estar aplicadas antes de tagear.

Crear el token en Sentry → Settings de la organización → Developer Settings → Internal Integrations:
**Release → Admin**, **Organization → Read**, **Project → Read**. No fijar `SENTRY_RELEASE` en GitHub:
el workflow lo calcula desde el tag.

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

El job `deploy-worker` del tag hace ese despliegue antes de publicar el instalador; no se vuelve
a compilar ni se publica con un `wrangler deploy` manual que omita las comprobaciones de Sentry.

## Qué corre en CI

| Workflow | Cuándo | Qué |
|---|---|---|
| `ci.yml` | push y PR | Tests de todo el workspace Rust con `cargo nextest --workspace --profile ci --locked` y clippy en Windows (incluidos guardianes y anti-drift del esquema); exportación real de contratos IPC con `generate-types.mjs --check`; ESLint; typecheck y tests del frontend; typecheck y tests del worker, `check-migration-registry.mjs` y la cobertura de los arneses de contrato (informativa) |
| `release.yml` | tag `v*` | CI completo, mapas de escritorio/worker y evento real de Sentry; firma aislada; despliegue del worker y publicación del instalador |
| `verify-sentry.yml` | manual | Verifica ambos proyectos y mapas; prueba el envío del worker y, opcionalmente, sube una versión sin activarla |
| `audit.yml` | PR y los lunes | `cargo audit` y `pnpm audit --prod --audit-level moderate` |

## Lista

- [ ] E2E en verde
- [ ] Worker desplegado si cambió el esquema o la base central
- [ ] `version` subida en `tauri.conf.json`, `Cargo.toml` y los dos `package.json`
- [ ] Tag pusheado y `release.yml` en verde
- [ ] Probado en un equipo piloto
