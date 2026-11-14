# TPV — instrucciones para trabajar en este repositorio

TPV de escritorio para hostelería: **Tauri 2 + React 19 + TypeScript** con backend **Rust** sobre
**SQLite local (rusqlite)**, y un **Cloudflare Worker** (`tpv-api`) con un Durable Object por negocio,
que guarda la base del negocio en su SQLite, y Turso para la base central. La Main (Windows) vende
contra su base local y replica cuando hay red; la Handy (Android) trabaja contra la nube. Qué es cada pieza: [README.md](README.md). Cómo funciona por dentro: [docs/](docs/README.md).

**Ramas.** `main` es Windows 10 y 11 **sin Veri\*factu**, y es donde se desarrolla;
`compilacion-windows-7` es la variante de Windows 7 de `main` y recibe `main` por merge. Veri\*factu
entero vive en `con-verifactu` y `con-verifactu-windows-7`, tal como estaba el 25-10-2026. Cómo
volver a ponerlo: [pendientes.md](docs/pendientes.md#vf-vuelta--volver-a-poner-verifactu).

Este fichero dice **qué reglas seguir** y **dónde mirar antes de tocar cada cosa**. El porqué largo está
en los documentos enlazados; léelos antes de cambiar el subsistema.

---

## Mapa

```
apps/tpv-main/                   app de escritorio y Android (@tpv/main)
  src/app · features · shared    frontend (React)
  src-tauri/src/lib.rs           crate tpv_lib: AppState, sesión, comandos de shell, run() (entrada
                                 compartida escritorio y móvil); main.rs es el shim del escritorio
  src-tauri/src/commands/        comandos Tauri finos, uno por dominio
  src-tauri/src/jobs/            runner de tareas de fondo (registro.rs = el catálogo)
  src-tauri/src/printing.rs      generador ESC/POS
  src-tauri/src/interruptores.rs estado de los interruptores remotos
  e2e/                           recorridos E2E sobre la app compilada
apps/cloud-worker-licensing/     worker tpv-api (Hono + TenantHub + licencias + sync + pairing…)
crates/
  tpv-domain                     entidades y reglas puras
  tpv-application                puertos (ports/) y casos de uso (use_cases/)
  tpv-infra-sqlite               persistencia SQLite (rusqlite), outbox, migraciones
  tpv-infra-http                 los mismos puertos contra el worker (modo Handy)
  tpv-infra-licensing            licencia, identidad del dispositivo, secretos, hora de la nube
  tpv-telemetry                  Sentry, spool a Axiom, filtro de datos personales
  tpv-contracts                  DTOs con Specta → packages/contracts
packages/
  database                       migrations/*.sql (esquema único) + schema.snapshot.sql
  contracts                      @tpv/contracts (bindings.ts generado)
  client                         @tpv/client (commands generados + errores)
  reservas-web-sdk               SDK de las reservas web (@altarialights/reservas-web-tpv, en npm): lo
                                 usan el widget y las webs con formulario propio
docs/                            arquitectura, decisiones, guías, estudios, pendientes
tests/contract/                  arneses de contrato Rust ↔ worker
scripts/                         generate-types, check-migration-registry, check-contract-coverage,
                                 check-dead-code,
                                 tpv-license (CLI de administración), generate-license-keypair
```

## Antes de tocar…

| Si vas a tocar… | Lee |
|---|---|
| Cualquier escritura, el outbox, el WebSocket, el `TenantHub`, una consulta de la Handy | [sincronizacion.md](docs/arquitectura/sincronizacion.md) |
| La recuperación, las copias, el bootstrap, el traslado de licencia | [recuperacion.md](docs/arquitectura/recuperacion.md) |
| El esquema o una migración | [esquema.md](docs/arquitectura/esquema.md) |
| Un cobro, el registro fiscal | [verifactu.md](docs/arquitectura/verifactu.md) |
| Cuentas, el cierre de caja, anular un cobro | [caja.md](docs/arquitectura/caja.md) |
| El ticket o la impresora | [tickets.md](docs/arquitectura/tickets.md) |
| La licencia, Stripe, la administración | [licencias.md](docs/arquitectura/licencias.md) |
| Emparejar una Handy o su token | [emparejamiento.md](docs/arquitectura/emparejamiento.md) |
| Un gate de permisos, la sesión, el PIN, la CSP, el `fs` de la webview | [permisos.md](docs/arquitectura/permisos.md) |
| Una ruta del worker, la base central, el cron | [worker.md](docs/arquitectura/worker.md) |
| Un job o un interruptor remoto | [jobs-e-interruptores.md](docs/arquitectura/jobs-e-interruptores.md) |
| El frontend, React Query, el dinero en pantalla | [frontend.md](docs/arquitectura/frontend.md) |
| Sentry, Axiom, `/health` | [observabilidad.md](docs/arquitectura/observabilidad.md) |
| Publicar una versión | [publicar-version.md](docs/guias/publicar-version.md) |
| Android | [compilar-android.md](docs/guias/compilar-android.md) |

Lo pendiente y lo detectado sin decidir está en [docs/pendientes.md](docs/pendientes.md).

---

## Comandos

```bash
pnpm install                  # tras clonar (raíz)
pnpm tauri dev                # la app de escritorio
pnpm tauri build              # empaquetar
pnpm generate-types           # regenerar DTOs y funciones de comandos desde Rust
pnpm generate-types:check     # comprobar que los tres ficheros generados están al día
pnpm lint                     # ESLint;   pnpm lint:rust → clippy del workspace
pnpm check:dead-code          # Knip + cargo-machete: informe, sin borrar ni bloquear

cargo build
cargo nextest run             # los tests de Rust van SIEMPRE por nextest
cargo nextest run -p tpv-infra-sqlite <filtro>
pnpm --filter @tpv/main test         # vitest del frontend;  pnpm --filter tpv-api test → worker
pnpm --filter @tpv/main typecheck    # pnpm --filter tpv-api typecheck

pnpm --filter @tpv/main build:e2e && pnpm --filter @tpv/main test:e2e   # E2E, antes de cada versión
```

- **Los tests de Rust se corren con `cargo nextest`**, nunca con `cargo test`: nextest corre cada test en
  su propio proceso, y hay tests que fijan estado global (`static`, `OnceLock`) y se pisan si comparten uno.
  Los dos reintentos marcan los fallos transitorios como `FLAKY`; para verificar estabilidad, `--retries
  0`. El porqué está en `.config/nextest.toml`. Los tests de contratos también van por nextest;
  la generación usa el ejecutable Tauri con `--export-bindings`, sin arrancar la aplicación.
- **Windows: `Failed("Are you sure you have RC.EXE in your $PATH…")`** no es el código: `embed-resource`
  busca `rc.exe` por una clave de registro que puede apuntar mal. Se arregla con
  `setx RC "C:\Program Files (x86)\Windows Kits\10\bin\<versión>\x64\rc.exe"` y una terminal nueva. Sólo
  salta cuando se re-ejecuta el build script (al tocar `tauri.conf.json` o las capabilities).

---

## Convenciones del repositorio

- **PROHIBIDO `npm` y `npx`: el gestor es `pnpm`**, para todo y también en la documentación. `pnpm
  install`, `pnpm add <pkg>` (`-D`, `-w`), `pnpm exec <bin>` (p. ej. `pnpm exec wrangler deploy`), `pnpm
  <script>` / `pnpm --filter <paquete> <script>`. Mezclar npm crea un `package-lock.json` paralelo y aplana
  `node_modules`.
- **PROHIBIDO el trailer `Co-Authored-By`** y cualquier atribución a Claude o Anthropic en commits y PR
  (también en `.claude/settings.json`).
- **Comentarios, nombres de dominio y documentación en español.**
- **La documentación describe lo que hay.** El relato de cómo se llegó a algo va en el commit. Un hallazgo
  resuelto se borra de `docs/pendientes.md`; su ID queda en un comentario junto al arreglo
  (`git grep -n "SYNC-20"`).

---

## Reglas al escribir código

### Capas y tipos ([0001](docs/decisiones/0001-monorepo-y-arquitectura-hexagonal.md))

- `tpv-domain`: reglas puras, sin BD, red ni Tauri. `tpv-application`: puertos y casos de uso.
  `tpv-infra-*`: el SQL y lo que sale fuera. **Un comando Tauri no lleva SQL ni reglas**: adapta, llama al
  caso de uso y devuelve.
- Un DTO que cruza a la interfaz vive en `tpv-contracts` con `#[derive(specta::Type)]` y serde.
  Cada comando lleva `#[specta::specta]` y se registra en `command_builder()` de `lib.rs`.
  Tras cambiar una firma o DTO, `pnpm generate-types`: tipos en `@tpv/contracts`, funciones en
  `@tpv/client` y metadatos sin runtime Tauri para E2E. `Dinero` conserva su marca de céntimos.
- **Errores**: `AppError` → `AppErrorDto { code, message }` con `code` del catálogo `ErrorCode`
  (`tpv-contracts/src/errors.rs`). **Se ramifica sólo por `code`**; un código nuevo sólo si alguien tiene que
  hacer algo distinto. Lo que se enseña es `message`, nunca un identificador. Un dato que no vale
  dice qué hacer en español («Escribe el nombre del producto.», «Falta la mesa.»), sin nombres de
  campo ni inglés, y con el mismo texto en la Main y en el worker. En el frontend,
  `toAppError(e)` / `esError(e, "…")`.
- **Nombre, argumentos y respuesta están tipados**: usar `commands.*` de `@tpv/client`, nunca
  `invoke`/`invokeClient` ni elegir `{ args }` a mano. TanStack Query llama al comando generado;
  sólo conservar helpers de orquestación o estado de presentación. CI comprueba la exportación real.
  Un comando que nadie invoca no se registra.

### Dinero ([0005](docs/decisiones/0005-dinero-en-centimos.md))

- **Entero de céntimos de la base a la pantalla**: `Dinero` en Rust, en el worker y en el frontend (marcado:
  un `number` no se le asigna). Las cantidades y los tipos de IVA son `REAL`; **una cantidad de stock se
  escribe redondeada a milésimas** (`ROUND(…, 3)`, `redondear_cantidad`), igual en la Main y en el worker.
- La aritmética compartida tiene su tabla de casos, `crates/tpv-domain/src/dinero_casos.json`: **un criterio
  nuevo es un caso nuevo ahí**, no tres funciones.
- En SQL: `SUM(CAST(ROUND(Cantidad * Precio_Unitario) AS INTEGER))`. **Nunca `ROUND(x, 2)` sobre dinero.**
  Toda columna de dinero lleva su `CHECK (typeof(col) IN ('integer','null'))`.
- Dividir con `Dinero::entre`, no multiplicando por el recíproco.
- Frontend: un formateador por salida (`eur` en pantalla, el de `ticketMath.ts` en el papel), sin alias ni
  como *prop*; todo campo de dinero es un `<CampoDinero>` con `useImporte()`; un `*Apis.ts` devuelve el DTO
  generado tal cual.
- Por la API llegan céntimos enteros (`zDinero`); un decimal se rechaza.

### Escrituras y replicación ([sincronizacion.md](docs/arquitectura/sincronizacion.md))

- **Toda escritura de negocio de la Main pasa por `WriteGuard::execute`**, que la captura en el outbox. Lo
  que es estado local del equipo (`_Jobs_State`, `_Sync_*`, `_Verifactu_*`, `_Recovery_State`,
  `_Backfill_Historico`, el backfill) va por `raw()`. `is_write_sql` no reconoce un `WITH … INSERT`.
- **Una sentencia por `query`/`execute`**: un texto con varias falla; varias seguidas van por
  `execute_batch`.
- **IDs deterministas**: toda `TEXT PRIMARY KEY` recibe su UUID antes del `INSERT`; en el worker, un paso
  `kind:"value"` con `nuevoId()` (`lib/ids.ts`, UUIDv7 como el `new_id()` de Rust). Nada de
  `randomblob()`/`random()` en una sentencia replicada. «Lo más reciente» se ordena por la columna de
  fecha; la clave sólo desempata.
- **La hora la pone quien escribe** ([0004](docs/decisiones/0004-la-hora-la-pone-quien-escribe.md)): ningún
  `DEFAULT` de hora en el esquema; en la Handy, `X-Client-Now` fija «ahora» en escrituras **y lecturas**.
- **Los agregados (`Total_Comanda`…) se re-derivan en el SQL**, nunca se escriben como literal. El
  resumen diario de las estadísticas (`_Estad_*`) no es uno de ellos: es una caché local de cada lado,
  que no se replica y cuyos triggers sólo apuntan días ([esquema.md](docs/arquitectura/esquema.md#el-resumen-diario-de-las-estadísticas-17-de-0001)).
- **Una divergencia se repara por estado** con `ON CONFLICT(pk) DO UPDATE`. ⚠️ **Nunca `INSERT OR
  REPLACE`**: borra y reinserta, y dispara las cascadas.
- **En el `TenantHub` no hay estado en campos de instancia** (se pierde al hibernar) **ni variables de
  módulo con estado** (se comparten entre tenants): lo que hay que recordar va en el *attachment* del socket
  o en el SQL del DO. Nada de `setInterval`; todo cierre iniciado por el DO llama a `sessionGone`.
- **Quien clasifica un fallo de subida es el DO**; el cliente no compara textos de error. El transporte no
  cuenta como intento.
- **Mientras se recupera, ninguna escritura de negocio entra** (cerrojo de `Db`). Si una escritura choca con
  él, lo que hay que revisar es por qué corre durante una recuperación.

### Esquema ([esquema.md](docs/arquitectura/esquema.md))

- Las migraciones aplicadas quedan congeladas. Los cambios que conserven las bases de trabajo van en
  una migración nueva; consolidar el esquema de desarrollo y resetear sus datos requiere decidirlo expresamente.
- En los dos casos: registrarla en `tenantMigrations.ts` **y** en `test/helpers/esquemaTenant.ts`,
  regenerar la foto con
  `BLESS_SCHEMA_SNAPSHOT=1 cargo nextest run -p tpv-infra-sqlite schema_snapshot`, y **redesplegar el worker
  antes** de que una Main escriba la columna nueva.
- `tpv-infra-sqlite/build.rs` vigila la carpeta de migraciones: Cargo reembebe los SQL automáticamente.
- ⚠️ El hash de la migración incluye sus comentarios: tocar un comentario de `0001_inicial.sql` es cambiar la
  migración.
- **La base central del worker no se migra desde el código**: se cambia a mano en Turso antes de desplegar y
  se refleja en `docs/sql/control-plane/esquema-actual.sql`.

### Worker ([worker.md](docs/arquitectura/worker.md))

- **Una ruta no lee su propio cuerpo**: `cuerpo(schema)` / `consulta(schema)` de `lib/validacion.ts`, y el
  handler usa `c.req.valid("json")`. Los cuerpos tolerantes de `sync` (la recuperación y el
  contraste: [worker.md](docs/arquitectura/worker.md)) se quedan con `cuerpoTolerante`.
- **Lo que decide antes de leer el cuerpo es middleware y va delante** (veto de rol, tope de tamaño, token de
  administración, filtro por IP). **Un `*.routes.ts` no resuelve roles.**
- **Toda ruta autenticada pasa por `tenantAuth`** (que comprueba también la licencia). Tenant y dispositivo
  salen del token.
- Un schema zod con contrapartida en Rust lleva su drift-guard (`Assert<SameKeys<…>>`), y **lo que
  acepta o rechaza es lo mismo que la Main**: un criterio de validación nuevo es un caso nuevo en
  `crates/tpv-domain/src/validacion_casos.json`, que leen los dos lados, con el `mensaje` que se enseña
  si se rechaza.
- Una fecha que llega como texto se valida con `lib/fechas.ts` (en Rust, `tpv_domain::fechas`), nunca
  con una expresión regular suelta.
- Un texto que llega se recorta con `recortar` (`lib/texto.ts`), que quita lo mismo que `str::trim`;
  nunca con `.trim()`, que quita además U+FEFF y deja U+0085 (en un schema, `.overwrite(recortar)`).
- Lo que teclea el usuario se busca sin acentos ni mayúsculas con `instr(${normalizada(col)}, ?) > 0`
  y el texto pasado por `textoABuscar` (`lib/busqueda.ts`; en la Main, `busqueda.rs`), nunca con
  `LIKE`: el SQLite del DO no admite un patrón de más de 50 bytes y el `%` y el `_` serían comodines.
  Las dos expresiones salen de la misma tabla (`busqueda_casos.json`), para que las dos devuelvan las
  mismas filas.
- Una ruta que devuelve listas pone **el techo en la respuesta**, no en cada pieza.
- Un identificador de error nuevo va a `MENSAJES` o a `SIN_MENSAJE_PROPIO` (`lib/errorCodes.ts`).
- Toda ruta que verifique un PIN lleva el freno de LOGIN-01 (`test/pinSiempreConFreno.test.ts`).
- Una puerta nueva que dé de alta un dispositivo llama a `exigirClaveSiEsDeOtroNegocio` antes de tocar nada.

### Permisos ([permisos.md](docs/arquitectura/permisos.md))

- **El rol y el usuario salen de la sesión del backend, nunca de los argumentos.** Lo que se firma en una
  fila (quién cobra, cierra, anula, abre el cajón) también.
- **La lista de gates es corta a propósito**: antes de añadir uno, «¿lo hace alguien a mitad de servicio?».
- ⚠️ **`commands/recovery.rs` y la recuperación del PIN no pueden exigir sesión, nunca** (y lo de recovery
  tolera `state.db == None`). Lo alcanzable antes del login no exige sesión; para lo alcanzable por los dos
  caminos, `exigir_rol_si_hay_sesion`.
- Al gatear un comando, su pantalla necesita también el candado de ruta.
- Un fichero propio nuevo en AppData va al `deny` de `fs` en las capabilities.

### Fiscal y caja ([verifactu.md](docs/arquitectura/verifactu.md), [caja.md](docs/arquitectura/caja.md))

- **El registro de facturación se emite dentro de la transacción del cobro** y `Registros_Facturacion` es
  *append-only*: no se modifica ni se purga.
- **Nada de lo que rodea al ticket puede impedir cobrar**: ni la impresora, ni el logo, ni un aviso. Los
  avisos van después del cobro.
- **Ningún interruptor remoto toca el camino del cobro.**
- El arqueo deriva de `Pagos` con `Estado = 'ACTIVO'`; `Movimientos_Caja` es para investigar, nunca para
  sumar. Toda lectura de «línea cobrada» va por `v_lineas_cobradas`.

### Frontend ([frontend.md](docs/arquitectura/frontend.md))

- En la Main los datos de negocio van por `commands` (`@tpv/client`), nunca por `fetch`.
- React Query con hooks en `features/<x>/<x>Queries.ts` (referencia: `clientesQueries.ts`). La parte
  transaccional del POS, la configuración y el login van sin él.
- **Prohibido inyectar `<style>` en tiempo de ejecución** (`style-src 'self'`): todo CSS por el bundle. Un
  origen externo nuevo va en `csp` **y** `devCsp`. Una gráfica de ApexCharts nueva esparce
  `APEX_CHART_BASE`. Esto no se ve en `pnpm tauri dev`: se comprueba empaquetado o en Android.
- `void` es «fuego y olvido» a sabiendas; si el fallo debe verse, `conAviso(fn)`.
- **Un aviso de error dice qué falló y por qué**: `toast.error("No se pudo guardar el cliente",
  toAppError(e).message)`, nunca un genérico que esconda el motivo. Una carga que falla se avisa. Un
  `catch` sólo si la pantalla hace algo distinto con el error; si sólo avisa, `conAviso`. Sin
  `console.error`: en la versión instalada no lo ve nadie.

### Telemetría ([observabilidad.md](docs/arquitectura/observabilidad.md))

- Lo que sale a Sentry o Axiom pasa por el filtro de datos personales, que tiene **tres copias**. Una regla
  nueva lleva su caso en `crates/tpv-telemetry/src/scrub_casos.json`.
- Un mensaje de error no se compone con nombres ni direcciones.
- `/health` tiene que seguir tocando la base central.
- **El fallo de un comando lo registra `invocar`** (`fallosDeComandos.ts`), con su gravedad según el
  código: una pantalla no lo manda a Sentry. Lo que falla en la pantalla sin comando de por medio, por
  `captureException`. Un código nuevo necesita su gravedad en `GRAVEDAD`, y lo que no es un fallo del
  programa (la impresora, la red) se devuelve como `external`, no `internal`.

### Jobs ([jobs-e-interruptores.md](docs/arquitectura/jobs-e-interruptores.md))

- Lo periódico va en `jobs/registro.rs` y en ningún otro sitio: un `async fn` y su entrada en `catalogo()`.
  Devolver `Err` es fallar. El cuerpo es idempotente.

---

## Linters

`pnpm lint` y `pnpm lint:rust` analizan, no formatean: **no hay formateador y no debe haberlo**. ESLint tiene
cuatro reglas:

| Regla | Qué caza | Nivel |
|---|---|---|
| `react-hooks/rules-of-hooks` | Un hook dentro de un `if` | error |
| `react-hooks/exhaustive-deps` | Efectos sobre un valor caducado | aviso (CI no pasa `--max-warnings 0`) |
| `@typescript-eslint/no-floating-promises` | Una promesa rechazada sin `catch` | error |
| `@typescript-eslint/no-misused-promises` | Una promesa entregada a quien no la espera (`onClick={guardar}`) | error |

Antes de añadir una quinta: «¿habría cazado un bug que hemos tenido?». Lo apagado lleva su motivo en
`eslint.config.mjs`. Los `packages/*` quedan fuera del análisis con tipos porque no tienen `tsconfig.json`.

`pnpm check:dead-code` (RI-22) informa sobre ficheros, exportaciones y dependencias TS con Knip,
y sobre dependencias Rust con cargo-machete. Necesita Node >=22.12, `pnpm install` y
`cargo install cargo-machete --version 0.9.2 --locked` (CI instala esa versión). Se puede limitar
con `pnpm check:dead-code --ts` o `--rust`. No borra ni bloquea: cada candidato se confirma buscando
consumidores, carga por configuración, macros y contratos antes de retirarlo. Un fallo del analizador
se muestra como error de análisis, nunca como cero hallazgos. `knip.jsonc` declara las entradas reales,
los tests de tipos y las excepciones justificadas; no excluyas carpetas de negocio ni todos los tests.

## Tests que vigilan reglas

Varias reglas de este fichero tienen un test que **lee el fuente** y falla si alguien las rompe; si uno salta,
lo que hay que revisar es el cambio, no el test:

- `lib.rs::tests_exenciones_del_gate` (recuperación sin sesión, cobrador de la sesión, comandos retirados,
  `fs` de la webview, ningún interruptor en el cobro).
- `migrations.rs::todas_las_columnas_de_dinero_llevan_su_check`, `db.rs::ninguna_columna_del_esquema_elige_su_hora`
  y el snapshot del esquema.
- `estadisticas_diarias.rs::los_triggers_solo_apuntan_dias`: los triggers del resumen diario de las
  estadísticas no calculan ni pueden hacer fallar el cobro que los dispara.
- `error.rs::tests_mensajes_en_espanol` (tpv-application): ningún mensaje del dominio ni de los casos de
  uso es un nombre de campo o está en inglés.
- En el worker: `vetoAntesDelCuerpo`, `anularSoloMain`, `fiscalSoloMain`, `cobroSoloMain`,
  `pinSiempreConFreno`, `mensajesDeError`, `salud`, `lecturasEnHoraLocal`, `recortarComoLaMain`,
  `mensajesEnEspanol`, `busquedaDeTexto`, `busquedaSinAcentos`.
- Los arneses de contrato ([tests/contract/README.md](tests/contract/README.md)) y
  `scripts/check-contract-coverage.mjs`.
- Las tablas de casos que comparten Rust y TypeScript: `dinero_casos.json`, `scrub_casos.json`,
  `horarios_casos.json`, `plano_reservas_casos.json` (la reserva de cada mesa, que depende de la
  hora), `busqueda_casos.json` (qué letras se pliegan al buscar) y `validacion_casos.json` (la validación de entrada y lo que dice al rechazar, que los arneses de
  contrato no ven).
