# Publicar actualizaciones en producción

Esta guía explica cómo lanzar una nueva versión de la app de escritorio para que **llegue sola a
todos los clientes** (sin pasar un `.exe` a mano) y cómo **revertir** o **intervenir** si algo sale
mal, sin tocar el equipo de nadie.

La pieza que lo hace posible: el **updater de Tauri** apunta a un feed que servimos nosotros desde
`tpv-api` (`GET /v1/update/...`). Como el feed lo controlamos en el servidor, decidimos qué versión
recibe cada cliente y podemos hacer rollback al instante.

```
App (al arrancar) ──GET /v1/update/{target}/{arch}/{version}──► tpv-api ──► tabla app_releases (Turso)
        ▲                                                                         │
        └──────── descarga instalador + verifica firma ◄── URL del instalador (R2/host público)
```

---

## 0. Preparación (una sola vez)

1. **Secreto admin del feed** (para poder publicar/retirar versiones):
   ```bash
   cd apps/cloud-worker-licensing
   wrangler secret put RELEASE_ADMIN_TOKEN     # inventa un token largo y guárdalo
   ```
   Sin este secreto, `POST /v1/update/publish` queda **deshabilitado** (fail-safe).

2. **Clave de firma del updater** — ya generada en
   `apps/tpv-main/src-tauri/.tauri/updater.key` (privada, **gitignored**) y su `.pub`.
   La **pública** ya está embebida en `tauri.conf.json` (`plugins.updater.pubkey`).
   - ⚠️ **La privada es un secreto crítico.** Si se pierde, NO podrás volver a firmar y los clientes
     dejarán de poder actualizar. Cópiala a un gestor de secretos / secreto de CI.
   - Para regenerarla (si prefieres tu propia clave):
     `pnpm --filter @tpv/main exec tauri signer generate -w src-tauri/.tauri/updater.key -f`
     y pega la nueva `.pub` en `tauri.conf.json`.

3. **Dependencias / build inicial**: el primer `cargo build` descargará `tauri-plugin-updater`.
   ```bash
   pnpm install
   cargo build
   ```

4. **Desplegar el worker** con el feed nuevo:
   ```bash
   cd apps/cloud-worker-licensing && wrangler deploy
   ```

5. **Secretos y variables de CI/CD** (GitHub → Settings → Secrets and variables → Actions):
   - Secrets: `TAURI_SIGNING_PRIVATE_KEY` (contenido de `updater.key`),
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_ACCOUNT_ID`, `RELEASE_ADMIN_TOKEN`.
   - Variables: `R2_BUCKET` (p. ej. `tpv-releases`), `R2_PUBLIC_BASE_URL` (dominio público del
     bucket), `TPV_API_BASE` (`https://tpv-api.altarialights.workers.dev`).

---

## 0-bis. Antes de tagear: pasar los E2E (TEST-01)

CI corre los tests de Rust, del worker y el anti-drift del esquema, pero **ninguno arranca la
aplicación**. Los cinco recorridos que sí la arrancan van a mano, porque emiten una licencia real
con el token de administración y eso no se mete en CI.

```bash
pnpm --filter @tpv/main build:e2e     # compila el binario aislado (identificador propio)
pnpm --filter @tpv/main test:e2e      # 31 pasos en cinco recorridos, sobre un mismo equipo
```

Qué cubren: el **camino del dinero** (estreno, carta, venta, cobro, su factura con el QR y arqueo
con descuadre 0), las **copias de seguridad** (copia → se machaca la `data.db` → se rechaza una copia
inservible → recuperación → reconciliación → login), **volver sólo con la nube** (el volcado de
SYNC-19, sin copia local) y **la licencia** (anulada, desanulada, caducada, renovada).

Requisitos, una sola vez por máquina: `cargo install tauri-driver --locked` y `ADMIN_API_TOKEN` en
el `.env` de la raíz. La licencia la emite y la revoca la propia tanda.

⚠️ **Cada tanda crea una base Turso** (la de su licencia) que no se borra sola. Conviene pasar la
escoba de vez en cuando por las licencias `E2E …` que salen en `pnpm license:list`.

⚠️ **Redespliega el worker antes si ha cambiado el esquema.** La tanda activa contra el `tpv-api`
desplegado, que lleva el esquema compilado dentro: con uno por detrás, la nube rechaza las
escrituras con columnas nuevas y lo que falla son las copias, no la venta.

**Si sale rojo, no tagees.** Un fallo deja una captura en `apps/tpv-main/e2e/fallos/`. Ojo a la
excepción legítima: la activación sale a internet contra `tpv-api`, así que un fallo ahí puede ser
la red y no el código — el mensaje del test distingue una cosa de la otra.

Detalle del montaje y sus trampas en [CLAUDE.md §16](CLAUDE.md).

---

## 1. Release automática (CI/CD) — recomendada

Hay dos workflows en `.github/workflows/`:

- **`ci.yml`** (en cada push/PR): corre el **test anti-drift** del esquema (`cargo test -p
  tpv-infra-sqlite`, que incluye el snapshot), el typecheck del worker y el chequeo del registro de
  migraciones. Es la red que impide que un cambio de esquema entre roto.
- **`release.yml`** (al pushear un tag `v*`): compila + **firma** el instalador, lo **sube a R2** y
  llama a **`POST /v1/update/publish`** automáticamente.

Para lanzar una versión:

```bash
# 1) sube la versión en tauri.conf.json y Cargo.toml (deben coincidir con el tag)
# 2) commitea y tagea:
git tag v1.0.0
git push origin v1.0.0
```

El pipeline hace el resto. El rollback sigue siendo `POST /v1/update/deactivate` (§2). Lo de abajo
(§1-bis) es el **procedimiento manual** equivalente, como respaldo o para entender qué hace el CI.

---

## 1-bis. Release manual (respaldo)

### a) Subir la versión

Sube el número en **los dos** sitios (deben coincidir):
- `apps/tpv-main/src-tauri/tauri.conf.json` → `version`
- `apps/tpv-main/src-tauri/Cargo.toml` → `version`

Usa SemVer (`0.1.0` → `0.1.1` para bugfix, `0.2.0` para features). El updater compara este número.

### b) Compilar y FIRMAR el instalador

El build necesita la clave privada en el entorno (si no, falla porque `createUpdaterArtifacts`
está activo). En PowerShell:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "apps/tpv-main/src-tauri/.tauri/updater.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""   # vacía si no le pusiste contraseña
pnpm tauri build
```

Salida en `apps/tpv-main/src-tauri/target/release/bundle/`:
- `nsis/tpv_<version>_x64-setup.exe`  ← instalador
- `nsis/tpv_<version>_x64-setup.exe.sig`  ← **firma** (su contenido es texto corto)

> En Windows el updater usa por defecto el instalador **NSIS**. (También se genera el `.msi`.)

### c) Hospedar el instalador

Sube el `.exe` a un **host público** (R2 con acceso público, o cualquier CDN) y copia su URL.
Ejemplo de URL: `https://releases.altarialights.com/tpv_0.2.0_x64-setup.exe`.

### d) Publicar en el feed

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/publish \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "0.2.0",
    "url": "https://releases.altarialights.com/tpv_0.2.0_x64-setup.exe",
    "signature": "<pega aquí el CONTENIDO del .exe.sig>",
    "notes": "Arreglado X. Añadido Y."
  }'
```

Listo. A partir de ahora, cada app que arranque verá la actualización y mostrará el aviso
"Nueva versión disponible". El usuario pulsa **Actualizar y reiniciar** cuando le convenga
(deliberadamente NO se auto-reinicia, para no cortar un servicio en caja).

### e) Canary (opcional, recomendado)

Publica primero en un `channel` distinto (`"channel":"beta"`) y prueba con un cliente piloto antes
de publicar en `stable`. *(El cliente lee `stable`; un canal beta requiere apuntar ese equipo a
`beta` — pendiente de exponer como ajuste; de momento sirve para guardar la release sin activarla en
stable.)*

---

## 2. Rollback / intervención en caliente

Si una versión sale mala, **no hay que tocar ningún PC**. Desactívala en el feed: el feed vuelve a
servir automáticamente la anterior activa.

```bash
curl -X POST https://tpv-api.altarialights.workers.dev/v1/update/deactivate \
  -H "Authorization: Bearer $RELEASE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "version": "0.2.0" }'
```

Los clientes que aún no se actualizaron dejarán de ver la 0.2.0. (Los que ya se actualizaron
necesitan que publiques una 0.2.1 con el arreglo — por eso conviene el canary del paso 1e.)

---

## 3. Cambios de esquema (migraciones de BD)

**No existe `schema.sql`.** El esquema completo se construye ejecutando en orden los ficheros
`.sql` de **`packages/database/migrations/`** (`0001_inicial.sql`, `0002_…`, …). Es la **fuente
única de verdad**, compartida por los dos lados:

- **Escritorio (cada cliente, automático)**: `crates/tpv-infra-sqlite/src/migrations.rs` embebe la
  carpeta con `include_dir!` y aplica lo pendiente en cada arranque.
- **Turso (por-tenant)**: `apps/cloud-worker-licensing/src/server/tenantMigrations.ts` consume los
  mismos ficheros.

Cada BD lleva una tabla **`_migrations (name, hash, applied_at)`** con lo ya aplicado. Una BD nueva
nace vacía y se construye desde `0001`; una existente solo aplica las migraciones que le falten.
Cada migración se ejecuta **dentro de una transacción** junto con su registro (atómico), y al
arrancar se verifica que el **hash** de cada migración ya aplicada no haya cambiado (si editas una
migración publicada, el arranque falla a propósito).

### Cómo hacer un cambio de esquema

1. Crea `packages/database/migrations/000N_descripcion.sql` con el cambio (numeración correlativa,
   con ceros a la izquierda para que ordene bien).
2. **Escritorio**: nada más. `include_dir!` recoge el fichero automáticamente.
3. **Worker**: añade una línea en `tenantMigrations.ts` (importar el `.sql` + entrada en
   `MIGRATIONS`, en orden). Es la única edición manual (esbuild no soporta glob dinámico):
   ```ts
   import m0002 from "../../../../packages/database/migrations/0002_codigo_barras.sql";
   const MIGRATIONS = [
       { name: "0001_inicial.sql", sql: m0001 },
       { name: "0002_codigo_barras.sql", sql: m0002 },
   ];
   ```
4. **Regenera el snapshot anti-drift** (si no, CI falla):
   ```bash
   BLESS_SCHEMA_SNAPSHOT=1 cargo test -p tpv-infra-sqlite schema_snapshot
   ```
   Revisa el diff de `packages/database/schema.snapshot.sql` (debe reflejar exactamente tu cambio)
   y commitéalo.
5. Verifica en local: `cargo test -p tpv-infra-sqlite` y `node scripts/check-migration-registry.mjs`.

> El esquema generado por las migraciones se compara contra `schema.snapshot.sql` en CI. Es un
> fichero **generado** (no se edita a mano): atrapa cualquier desviación silenciosa.

### Reglas (para no romper nada)

- **Solo aditivo y compatible hacia atrás**: `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`,
  `CREATE INDEX`. Evita renombrar/eliminar columnas mientras haya apps viejas en producción (una
  Main vieja sigue enviando el esquema antiguo por el outbox).
- **Nunca edites una migración ya publicada** (cambiaría su hash → el arranque falla). Crea una nueva.
- Usa `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE` en las migraciones (las hace re-ejecutables
  sin daño).
- Prueba la migración sobre una **copia de una `data.db` real con datos** antes de publicar.

### Seguridad

- **Escritorio**: antes de migrar, la app hace **copia automática** de `data.db` →
  `data.db.bak.<timestamp>` en AppData (red de seguridad; migrar es irreversible). Se conservan
  las dos últimas: el job `backup_local` purga el resto.
- **Turso**: las migraciones de tenant se aplican automáticamente por dos vías:
  1. Al **provisionar** (activación de licencia, `applyTenantSchemaOnce`).
  2. Por el **guard de migración** (`ensureTenantMigrated` en `server/db/tenantDb.ts`), que se
     ejecuta en el primer acceso de cada tenant tras arrancar un isolate del Worker: en las
     **lecturas** (`lib/tenantClient.ts`) y en las **escrituras** (DO `tenantHub.ts`). Así un
     tenant ya activo recibe un cambio de esquema **sin re-provisionar ni intervención manual**.
     El guard cachea por isolate (single-flight), así que solo verifica `_migrations` una vez por
     ciclo de vida del isolate.
- Aun así, antes de un cambio de esquema grande conviene una copia del tenant
  (`turso db shell ... .dump`).

---

## 4. Plan de recuperación (peor caso)

El updater es muy difícil de romper porque la **detección corre en Rust** (independiente de la UI) y
el feed lo controlas tú. Aun así, ten esto a mano:

- **Si el feed estuviera caído**: la app simplemente no ve actualizaciones y **sigue funcionando**.
  Cuando `tpv-api` vuelva, se retoma solo en el siguiente arranque.
- **Si quisieras un segundo canal de respaldo**: `plugins.updater.endpoints` admite **varias URLs**;
  añade una estática (p. ej. un `latest.json` en R2) como fallback del worker.
- **Reinstalación manual (último recurso)**: mantén siempre publicada y accesible la URL del último
  instalador estable. Reinstalar por encima conserva los datos (`data.db` vive en AppData, no se
  toca).
- ⚠️ **Nunca pierdas `updater.key`**: sin ella no puedes firmar y los clientes se quedan sin poder
  actualizar (tendrías que distribuir una build nueva con otra pubkey a mano). Haz copia de seguridad.

---

## 5. Checklist rápido

- [ ] **E2E en verde** (`pnpm --filter @tpv/main build:e2e && pnpm --filter @tpv/main test:e2e`) — §0-bis
- [ ] `version` subida en `tauri.conf.json` **y** `Cargo.toml`
- [ ] `pnpm tauri build` con `TAURI_SIGNING_PRIVATE_KEY` en el entorno
- [ ] Instalador `.exe` subido a host público
- [ ] `POST /v1/update/publish` con la URL + contenido del `.sig`
- [ ] Probado en un equipo piloto antes de dar por buena la release
```
