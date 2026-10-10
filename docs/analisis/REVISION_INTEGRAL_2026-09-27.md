# Revisión integral del proyecto (2026-09-27)

> **Qué es.** Un repaso de punta a punta del monorepo —esquema, crates de Rust, shell de Tauri,
> frontend, worker de Cloudflare, CI y documentación— agrupado por funcionalidad, buscando bugs,
> cuellos de rendimiento, riesgos de seguridad, código muerto, deuda de arquitectura y
> tecnologías que convenga cambiar o añadir. Se hizo en dos pasadas: la del 27/09 y una segunda
> el 28/09 sobre lo que la primera sólo había muestreado (ver
> [Alcance](#alcance-y-límites-de-esta-revisión)).
>
> **Qué no es.** No es una lista de sospechas: cada punto se ha comprobado leyendo el camino
> completo y, donde se dice, **midiendo o reproduciendo** (ver [Anexo A](#anexo-a--mediciones)).
> Los que dependen de algo que no se puede comprobar desde el repo (el comportamiento de Turso en
> producción, un dato que sólo tiene la AEAT) lo dicen expresamente y explican cómo verificarlo.
> Lo legal va con su fuente oficial o marcado como pendiente de verificar.
>
> **La revisión original fue de sólo lectura.** Este documento conserva los hallazgos pendientes;
> los arreglos posteriores quedan en sus commits. Está enlazado desde el
> [índice de documentación](../README.md).
>
> **Cómo usarlo.** Cada hallazgo lleva un ID `RI-NN` estable. Siguiendo la convención del
> [índice de documentación](../README.md), al corregir uno se deja el ID en un comentario junto
> al arreglo y se **borra de aquí**; lo que se decida no hacer, también se borra. Si un ID no aparece,
> está resuelto o descartado. Lo aplazado y lo ya registrado en [pendientes.md](../pendientes.md)
> (LEGAL-01, FABLE-B/E, INFRA-01, DB-14, LOGIN-04…) no se repite: se cita.
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja/mejora.
> Tipo: `bug` · `rendimiento` · `seguridad` · `arquitectura` · `deuda` · `docs` · `tecnología`.

---

## Índice

- [Resumen ejecutivo](#resumen-ejecutivo)
- [Tabla de hallazgos](#tabla-de-hallazgos)
- [Orden sugerido](#orden-sugerido)
- Por grupos:
  19. [Tecnologías y librerías](#19-tecnologías-y-librerías)
  20. [Plataformas: Android (Handy) y Windows 7](#20-plataformas-android-handy-y-windows-7)
  21. [Paridad Main ↔ worker](#21-paridad-main--worker)
- [Lo que está bien y conviene no tocar](#lo-que-está-bien-y-conviene-no-tocar)
- [Alcance y límites de esta revisión](#alcance-y-límites-de-esta-revisión)
- [Anexo A · Mediciones y reproducciones](#anexo-a--mediciones)

---

## Resumen ejecutivo

El proyecto está muy por encima de la media en lo que más cuesta: el razonamiento de cada decisión
está escrito junto al código, los caminos del dinero y de la factura están pensados para no parar
la caja, y hay redes (contrato Main↔worker, anti-drift de migraciones, tablas golden compartidas
entre lenguajes) que casi ningún producto de este tamaño tiene.

Lo que queda de esta revisión se concentra en las plataformas y la paridad Main ↔ worker.

La rama de Windows 7 es anterior a ARQ-01 y su canal del feed no está desplegado (RI-74).
El harness de contrato compara efectos pero no la validación, donde hay cuatro divergencias
entre la Main y la Handy (RI-78).

---

## Tabla de hallazgos

| ID | Sev | Tipo | Hallazgo |
|----|-----|------|----------|
| [RI-74](#ri-74) | 🟡 | deuda | Windows 7: la rama es anterior a ARQ-01 y su canal del feed no está desplegado |
| [RI-75](#ri-75) | 🔵 | deuda | Android: el `Context` sale de una API no pública |
| [RI-76](#ri-76) | 🔵 | deuda | Android: restos de la plantilla, márgenes seguros y release sin firmar |
| [RI-77](#ri-77) | 🔵 | bug | La Handy enseña pantallas que en ella no funcionan (pedidos, caja, ticket, licencia) |
| [RI-78](#ri-78) | 🟡 | bug/arquitectura | El harness no ve la validación de entrada, y ahí hay cuatro divergencias |
| [RI-79](#ri-79) | 🔵 | deuda | Cobertura del harness: falta contrastar el horario predeterminado |

---

## Orden sugerido

**Antes de publicar:** lanzar el E2E sobre la aplicación compilada. Las correcciones del
frontend tienen regresiones automatizadas; el recorrido completo y la comprobación táctil en el
TPV real siguen siendo validaciones de la release.

**Migraciones:** `0001_inicial.sql` ya está congelada. Las mejoras pendientes se añaden mediante
una migración nueva, registrada en los dos runners.

**Antes de cobrar por el producto:**

- La primera mitad de RI-78 (igualar las cuatro validaciones).

**Antes de repartir la Handy de Android:** RI-75 y RI-76 (firma, márgenes), y
RI-77 para que no enseñe lo que no puede hacer.

**Antes de compilar otra versión de Windows 7:** RI-74. Integrar `main` en la rama, y pasar la ruta
del canal a `main`.

**Después, sin prisa:** el resto.

---

## 19. Tecnologías y librerías

Propuestas de cambio o de incorporación, con el porqué. Ninguna es urgente; están ordenadas por
relación beneficio/esfuerzo.

| Propuesta | Para qué | Esfuerzo |
|---|---|---|
| **`zod` 4** | Validación bastante más rápida y más ligera en el worker (CPU facturable). `@hono/zod-validator` ya la soporta. Revisar la API de `z.coerce` y los mensajes | Medio |
| **`rusqlite`** en lugar de **`libsql`** (evaluar) | En la Main sólo se usa SQLite local (`features = ["core"]`). `rusqlite` es la opción madura: transacciones RAII (`conn.transaction()` hace rollback al soltarse), caché de sentencias preparadas (`prepare_cached`; hoy cada consulta se prepara de nuevo), API de backup en caliente, y ninguna de las rarezas documentadas (el crash nativo al crear muchas bases, la API async que bloquea). Todas las conexiones locales ya se ejecutan en hilos propios; el cambio conservaría esa separación. Coste: reescribir `db.rs`/`mapping.rs` y adaptar los repositorios (los `Reader`/`Writer` ya aíslan buena parte). Merece una prueba de concepto sobre un repositorio antes de decidir | Alto |
| **Mantenimiento**: `keyring` 3, `@vitejs/plugin-react` 5, TypeScript alineado entre app (`~5.8`) y worker (`^5.9`) | Mantenerse dentro de las versiones soportadas; Dependabot ya abre los PR menores | Bajo |
| **`pdf-lib`** | No publica versión desde 2021. Si da problemas, `@cantoo/pdf-lib` es un fork mantenido con la misma API | Bajo, si hace falta |

---

## 20. Plataformas: Android (Handy) y Windows 7

<a id="ri-75"></a>
### RI-75 🔵 · Android: el `Context` sale de una API no pública

**Dónde:** el almacén de secretos de Android,
[`secret_store.rs:174-191`](../../crates/tpv-infra-licensing/src/secret_store.rs#L174-L191)
(`contexto`).

`ActivityThread.currentApplication()`
([`:176-190`](../../crates/tpv-infra-licensing/src/secret_store.rs#L176-L190)) es una **API no
pública**. Hoy funciona dejando un aviso en logcat, pero Android restringe estas llamadas de una
versión a otra. `ndk-context` no sirve porque Tauri no lo inicializa (lo documenta
`COMPILAR_ANDROID.md`). La vía soportada es un plugin de Android propio en Kotlin, que recibe la
`Activity` (Tauri 2 lo admite con `register_android_plugin`), o que el Kotlin de `MainActivity`
entregue el `Context` a Rust una vez al arrancar.

<a id="ri-76"></a>
### RI-76 🔵 · Android: restos de la plantilla y ajustes por defecto

**Dónde:** [`AndroidManifest.xml`](../../apps/tpv-main/src-tauri/gen/android/app/src/main/AndroidManifest.xml),
[`build.gradle.kts`](../../apps/tpv-main/src-tauri/gen/android/app/build.gradle.kts),
[`MainActivity.kt`](../../apps/tpv-main/src-tauri/gen/android/app/src/main/java/com/altarialights/tpv/MainActivity.kt),
[`index.html`](../../apps/tpv-main/index.html).

- **Soporte de Android TV** (`leanback` y `LEANBACK_LAUNCHER`) y un **`FileProvider`** que no usa
  nada: son de la plantilla de Tauri. La app aparecería en el lanzador de una tele. Quitarlos.
- **Pantalla completa sin márgenes seguros.** `MainActivity.kt` llama a `enableEdgeToEdge()`, y con
  `targetSdk = 36` Android 15+ lo impone de todas formas. Pero el `viewport` de `index.html` no
  lleva `viewport-fit=cover` y ningún CSS usa `env(safe-area-inset-*)`. **A verificar en el
  emulador** con barra de gestos y con muesca: lo esperable es que la cabecera y la barra inferior
  de la app queden debajo de las del sistema.
- **La versión de release no se firma**: `build.gradle.kts` no tiene `signingConfig`, así que
  `tauri android build` sale sin firma. O unas `signingConfigs` que lean el almacén de claves de
  variables de entorno, o dejarlo escrito en `COMPILAR_ANDROID.md`.

<a id="ri-77"></a>
### RI-77 🔵 · La Handy enseña pantallas que en ella no funcionan

**Dónde:** [`NavBar.tsx:53-88`](../../apps/tpv-main/src/app/layoutComponent/NavBar.tsx#L53-L88)
y [`Configuracion.tsx:154-178`](../../apps/tpv-main/src/app/pages/Configuracion.tsx#L154-L178).

El menú se construye **sólo por rol**, sin mirar el modo. Un administrador con una Handy ve:

- **«Proveedores y Pedidos»**: los pedidos sólo existen en la Main. El worker no tiene rutas de
  pedidos, y `pedidos_proveedor_repo` contesta «DB no inicializada (pedidos requieren modo Main)»
  ([`lib.rs:781-794`](../../apps/tpv-main/src-tauri/src/lib.rs#L781-L794)), que es lo que acaba
  saliendo en pantalla.
- **Cuentas** con todos sus botones de escritura (gasto, cierre, anular, editar). El worker las
  rechaza (`soloLaMainEscribeCaja`), y está bien que lo haga, pero la pantalla ofrece acciones que
  van a fallar.
- En **Configuración**, además de lo propio de la Handy (Dispositivo), siguen **Ticket** (la Handy
  no imprime), **Licencia** (la Handy no tiene licencia propia) y **Actualizaciones** (el updater
  sólo se compila en escritorio: `#[cfg(desktop)]`).

**Propuesta.** Un `soloMain: true` en los elementos del menú y en las secciones de configuración,
filtrado con `useMode`, igual que ya se hace para Conectividad y Vincular Handy.

<a id="ri-74"></a>
### RI-74 🟡 · Windows 7: la rama no se puede compilar tal cual contra la nube de hoy

**Dónde:** el *worktree* `tpv-win7` (rama en `bac10e2`, 14/09; se separó de `main` en `52b4d71`).
Sirve para decidir cuándo y cómo reintegrarla; con la variante sin publicar no hay nada roto
todavía.

1. **Su esquema es anterior a ARQ-01.** Desde que se separó la rama, `0001_inicial.sql` ha cambiado
   una vez: `343c113` (20/09), el dinero en céntimos enteros. Un `.exe` de Windows 7 compilado hoy
   desde la rama guarda y sube los precios como euros `REAL` a una nube cuyo esquema, cuyo worker
   (`zDinero`) y cuya Handy trabajan en céntimos. La Handy enseñaría 2,50 € como 0,03 €, y el
   volcado de recuperación traería céntimos a un binario que espera euros. La prueba en la máquina
   virtual valida que la aplicación arranca, no que sus datos sean compatibles.
2. **El canal `win7` del feed sólo existe en la rama.** La rama cambia `updates.routes.ts` (una
   ruta `/:canal/:target/:arch/:current` con una lista cerrada `CANALES`) y añade
   `test/updateCanal.test.ts`, pero el worker se despliega desde `main`, que no la tiene. Así que
   `/v1/update/win7/windows/x86_64/<versión>` contesta 404 en producción y **un Windows 7
   instalado no se actualiza nunca**. Falla del lado seguro: los cuatro segmentos no casan con
   `/:target/:arch/:current`, así que no puede recibir el instalador de Windows 10. El `publish` de
   `main` ya acepta `channel: "win7"`, de modo que `release-win7.yml` puede publicar… pero nadie
   puede leerlo. Además, la versión de la rama es anterior a REV-23 (el `arch` en la clave,
   `compararVersiones`) y todavía llama a `ensureReleasesSchema`, un `CREATE` contra el
   control-plane que §4.5 ya prohíbe: al integrarla, el conflicto es seguro. **Propuesta:** pasar la
   ruta del canal a `main` ahora, encima de REV-23 (es código del worker y no afecta al canal
   `stable`), y dejar en la rama sólo lo que es de verdad de Windows 7.
3. **95 commits por detrás de `main`.** Hay conflictos previsibles en `lib.rs` (el `cfg` del
   minidump), `vite.config.ts`, `transporte.rs` (los arreglos de WinHTTP de la rama frente a los
   cambios de `main`), `CLAUDE.md` y los dos *lockfiles*. **Propuesta:** integrar `main` en la rama
   antes de cada versión, y que `build-win7.ps1` **se niegue a compilar** si su `0001_inicial.sql`
   no es idéntico al de `main`, porque eso es exactamente lo que hace un binario incompatible con
   la nube. Un job de CI que haga la integración y un `cargo check` del *target* de Windows 7
   avisaría del desfase sin esperar a la siguiente versión.
4. **El *nightly* sólo está fijado en CI.** `release-win7.yml` usa `nightly-2026-09-01`, pero
   `build-win7.ps1` usa por defecto `nightly` a secas salvo que se defina `TPV_WIN7_TOOLCHAIN`
   (línea 27 del script). Un build local puede salir con otro compilador que el de CI. Conviene el
   mismo valor fijo por defecto.
5. **Por verificar en la VM: el TLS con la AEAT.** WinHTTP usa SChannel, y en Windows 7 los
   cifrados de TLS 1.2 de SChannel no incluyen ECDHE-RSA con AES-GCM. Si los servidores de la AEAT
   sólo ofrecen esos, el *handshake* fallaría aunque KB3140245 esté instalada. El paso 6.7 de
   `COMPATIBILIDAD_WINDOWS_7.md` (probar contra la AEAT) es justo esa comprobación, y en la VM
   todavía no se ha hecho.

**Lo que está bien en la variante**, y no hay que perderlo al integrarla: todo el HTTP de Rust va
por **rustls con las raíces de `webpki-roots`**, así que no depende ni del almacén de certificados
ni del SChannel de Windows 7 (sólo la AEAT, que va por WinHTTP, depende de él). WinHTTP **pide TLS
1.2 de forma explícita**, con un error que nombra KB3140245 en vez de un 12175 genérico. Los canales
del feed se separan **por ruta y con una lista cerrada**. WebView2 109 va empotrado, el minidump se
desactiva con la *feature* `win7`, y el *nightly* está fijado en CI.

---

## 21. Paridad Main ↔ worker

Se ha revisado el harness de contrato (escritura y lectura) y, a mano, la validación de entrada de
cada dominio en los dos lados. El harness hace bien lo que dice: compara el **efecto** de cada
comando sobre las filas, con los dos lados leyendo el mismo *golden*, y
`check-contract-coverage.mjs` da 63/66 comandos y 64/64 lecturas, sin pendientes. Lo que no mira es
lo que viene a continuación.

<a id="ri-78"></a>
### RI-78 🟡 · El harness no ve la validación de entrada, y ahí hay cuatro divergencias

**Dónde:** el lado Rust
([`contract_tests.rs:36-47`](../../crates/tpv-infra-sqlite/src/contract_tests.rs#L36-L47)) llama a
los repositorios, y el lado del worker
([`contract.test.ts:19-105`](../../apps/cloud-worker-licensing/test/contract.test.ts#L19-L105)) a los
constructores de `*.commands.ts`. Los dos entran **por debajo** de la validación: el `validar` del
dominio y los casos de uso en Rust, y `cuerpo(schema)` (zod) en el worker. Así que «hacen lo mismo»
está comprobado sólo con una entrada válida. Lo que cada lado acepta o rechaza no lo compara nadie,
y a mano sale esto:

| Dato | Main (Rust) | Handy (worker) | Consecuencia |
|---|---|---|---|
| Fecha de una reserva | Formato y fecha real (`NaiveDate`, [`reservas.rs:9-21`](../../crates/tpv-domain/src/reservas.rs#L9-L21)) | Sólo `^\d{4}-\d{2}-\d{2}$` ([`reservas.schemas.ts:34`](../../apps/cloud-worker-licensing/src/domains/reservas/reservas.schemas.ts#L34)) | Desde la Handy entra una reserva para el 31 de febrero, que ningún día del calendario enseña |
| Fechas de un lote (INV-03) | ISO, y caducidad ≥ entrada ([`inventario.rs:230-253`](../../crates/tpv-domain/src/inventario.rs#L230-L253)) | Cualquier texto (`optStr`, [`inventario.schemas.ts:63-65`](../../apps/cloud-worker-licensing/src/domains/inventario/inventario.schemas.ts#L63-L65) y [`:75-77`](../../apps/cloud-worker-licensing/src/domains/inventario/inventario.schemas.ts#L75-L77)) | Con una caducidad «31/12/2026», `date(Caducidad)` es `NULL`, y en un `ORDER BY … ASC` el `NULL` va primero: el FEFO pone ese lote por delante de todos |
| IVA del negocio | 0–100 ([`validate_iva_percent`](../../crates/tpv-domain/src/configuracion.rs#L13), aplicado en el caso de uso) | Sólo `Number.isFinite` ([`configuracion.commands.ts:110-113`](../../apps/cloud-worker-licensing/src/domains/configuracion/configuracion.commands.ts#L110-L113)) | Desde la Handy se puede guardar un IVA del 210 % o negativo, que se aplica a todo lo que no tenga tipo propio |
| IVA de un producto | Fuera de 0–100 pasa **en silencio** a `None`, o sea al del negocio ([`inventario.rs:126`](../../crates/tpv-domain/src/inventario.rs#L126)) | Cualquier finito (`optNum`, [`inventario.schemas.ts:51`](../../apps/cloud-worker-licensing/src/domains/inventario/inventario.schemas.ts#L51)) | La Handy guarda un 150 %. La Main convierte un «210» tecleado en lugar de «21» en el IVA del negocio sin decir nada. Ninguno de los dos lo rechaza |

**Propuesta.**

1. Igualar los cuatro al criterio de Rust, que es el más estricto. En el IVA del producto, además,
   **rechazar** en vez de sustituir en silencio: un tipo impositivo es un dato fiscal.
2. Una tabla de casos compartida, `validacion_casos.json` (`dominio`, `campo`, `valor`, `acepta`),
   con el mismo patrón que `dinero_casos.json` y `scrub_casos.json`: la leen un test de Rust contra
   los validadores del dominio y otro del worker contra los schemas (`safeParse`). Es la vertiente
   que le falta al harness, y es donde se han encontrado estas cuatro.

<a id="ri-79"></a>
### RI-79 🔵 · Cobertura del harness: falta contrastar el horario predeterminado

**Dónde:** [`tests/contract/cobertura.json`](../../tests/contract/cobertura.json) y
[`tests/contract/README.md`](../../tests/contract/README.md).

- `trabajadores.setPredeterminadoDesdeSemana` se excluye con «mismo motivo que copySemana: los ID
  nuevos son asimétricos». Pero `copySemana` **sí** tiene caso (`casos/horarios/copiar_semana.json`),
  con la técnica de «snapshot con JOIN» que el README documenta precisamente para los ID que genera
  cada lado. Esa misma técnica sirve para este.

**El E2E**, por completar: se ha añadido el recorrido «añadir, anotar, recargar, quitar con −,
recargar». Sigue pendiente ejecutarlo sobre la aplicación compilada.

---

## Lo que está bien y conviene no tocar

Para equilibrar: estas piezas se han revisado y no tienen nada que objetar, o sólo detalles.

- **El dinero en céntimos** (ARQ-01) en el backend, con tablas de casos compartidas entre tres
  lenguajes: bien pensado y bien protegido. Lo que falló fue la última milla (los formularios), no
  el diseño.
- **Determinismo temporal** (`rewrite_now_literals`, CFG-04): cubre las formas raras de `'now'`, y
  la sentencia que se ejecuta en local es la misma que sube.
- **El outbox atómico con la escritura de negocio** (SYNC-02) y el cerrojo de escrituras durante la
  recuperación.
- **La cola durable del DO, la cuarentena en los dos sentidos y la reparación por estado** (SYNC-18,
  20, 22-26): el razonamiento de «fallar hacia transitorio» y «reparar por estado, nunca
  reintentando la sentencia» es correcto, y evitar `INSERT OR REPLACE` por las cascadas, también
  (comprobado: sólo queda en tests y en tablas sin hijas).
- **El contraste diario excluye bien el andamiaje** (`esTablaDeNegocio` deja fuera `Intentos_Login`
  y las tablas de replicación).
- **Stripe**: verificación manual del HMAC con tolerancia y varias `v1`, relectura de la sesión en
  vez de fiarse del webhook, y *fail-closed* si el precio no trae plazo.
- **Sesiones del worker**: una sola implementación (`jose`), algoritmo pinado, secreto
  *fail-closed*, errores traducidos por `code` y no por texto.
- **El correo**: destinatario acotado a proveedores del tenant, tope diario que sólo cuenta lo
  entregado, HTML escapado.
- **La emisión fiscal dentro de la transacción del cobro**, la clasificación por rango de códigos
  de la AEAT, el control de flujo como función pura con tests, y el TLS de WinHTTP sin ningún
  `SECURITY_FLAG_IGNORE_*`.
- **La exportación fiscal** (art. 8): `cadena.txt` verificable sin nuestro código, CSV con BOM y
  `;` para Excel en español.
- **El runner de jobs**: vencimiento contra `Last_Ok_Ms`, jitter, backoff, pánicos aislados y
  política pura testeable.
- **El cifrado de la PII** (construcción tipo SIV bien razonada; RI-13, en `docs/pendientes.md`, es de
  normalización, no de criptografía) y el almacén de secretos de Android (clave AES-GCM no exportable en el Keystore).
- **La restauración** (una transacción, la guardia del outbox dentro, `defer_foreign_keys`,
  identificadores filtrados antes de interpolar) y el backfill reanudable por `rowid`.
- **El frontend limpia lo que abre**: todos los `listen()` de Tauri y los `setInterval` tienen su
  desuscripción, incluida la carrera de «el componente se desmontó antes de que `listen` resolviera».
- El filtro de `/ws` por ticket de un solo uso consumido con `DELETE … RETURNING`, y los mensajes del
  DO que comprueban el rol del `helloSigned`, nunca una cabecera del cliente.
- **El harness de contrato**: compara el efecto y no el texto SQL, las lecturas como multiconjunto,
  y el comprobador de cobertura convierte «no cubierto» en «decidido no cubrir». RI-78 es la
  vertiente que le falta, no un fallo de lo que ya hace.
- **La variante de Windows 7** va bien encaminada en lo difícil: TLS por rustls, TLS 1.2 explícito
  en WinHTTP y canales del feed separados por ruta (RI-74 tiene el detalle). Lo pendiente es
  mantenerla al día, no rehacerla.

---

## Alcance y límites de esta revisión

**Leído de principio a fin**:

- *Esquema y persistencia*: `0001_inicial.sql`, `db.rs`, `connection.rs`, `migrations.rs`,
  `mapping.rs`, `util.rs`, `mesas.rs`, `caja_movimientos.rs`, las partes transaccionales de
  `venta_rapida.rs` y `sync.rs`, `verifactu.rs`, `verifactu_export.rs`, `cuentas.rs`,
  `cierre_caja.rs`, `recovery.rs`, `login.rs`, `auth.rs`, `notificaciones.rs`, `trabajadores.rs`,
  `inventario.rs`, `clientes.rs`, `reservas.rs`, `proveedores.rs`, `pedidos_proveedor.rs`,
  `tareas.rs`, `configuracion.rs`, `reconciliacion.rs`, `stock_alertas.rs`.
- *Dominio y casos de uso*: el dominio completo; los casos de uso de verifactu, sync, licencias,
  tareas, mesas, trabajadores, inventario y cierre de caja.
- *Shell*: `lib.rs` (setup, imágenes, impresión, updater), `jobs/`, impresión, y el mapa de gates de
  **todos** los `#[tauri::command]`; en detalle los de trabajadores, sync, licencias, cierre de caja
  y verifactu.
- *Resto de Rust*: la telemetría completa, el transporte y la lectura de respuestas de la AEAT, el
  cliente HTTP de la Handy, el cliente de licencias, el almacén de secretos (escritorio y Android).
- *Frontend*: `socketMain.ts`, el flujo del dinero en todos los formularios que envían importes, la
  gestión de `listen`/`setInterval`/`localStorage`, y los formularios de producto, lote, pedido,
  gasto y trabajador. En la segunda pasada, **enteros y línea a línea**, los ficheros grandes:
  `VentaRapida.tsx`, `TicketPanel.tsx`, `MesaComandaModal.tsx`, `Cuentas.tsx`, `EditTables.tsx`,
  `Login.tsx`, `Reservas.tsx`, `Proveedores.tsx`, `Trabajadores.tsx` y `Tareas.tsx` (este último
  sin nada que añadir), además de `NavBar.tsx` y la navegación de `Configuracion.tsx`.
- *Android*: el manifiesto, `build.gradle.kts`, `MainActivity.kt`, el almacén de secretos por JNI,
  la identidad del equipo, la CSP y el `viewport`, qué secciones ve la Handy, y
  `COMPILAR_ANDROID.md`.
- *Windows 7* (worktree `tpv-win7`): el diff completo de la rama frente a su punto de partida, las
  capacidades de Tauri que cambian (`.cargo/config.toml`, `vendor/ctor`, `tauri.windows7.conf.json`,
  el `cfg` del minidump, `vite.config.ts`, WinHTTP), `release-win7.yml`, `build-win7.ps1` y
  `COMPATIBILIDAD_WINDOWS_7.md`, cruzados con lo que ha cambiado en `main` desde entonces.
- *Paridad*: los dos harness de contrato (escritura y lectura), `cobertura.json` y el comprobador, y
  a mano la validación de entrada de todos los dominios en los dos lados.
- *Worker*: la entrada, el middleware de autenticación, `sesion.ts`, `tenantClient.ts`, el núcleo
  del DO y los controles de rol de sus mensajes, Stripe, actualizaciones, el catch-up, imágenes,
  correo, activación y cambio de equipo, y la administración.
- Toda la configuración de CI, build, Tauri y wrangler.

**Revisado por muestreo y búsquedas dirigidas** (patrones de rendimiento, seguridad, código muerto,
errores tragados, unidades del dinero, orden por id): el resto de páginas y componentes del
frontend, las consultas del worker de estadísticas, mesas y venta rápida (cuya paridad con Rust ya
vigila el harness de contrato), `sync_reparacion.rs`, el emparejamiento y los scripts.

**No revisado**: las suites de test en sí, salvo el harness de contrato (sólo su alcance en CI y los
casos que tocan cada hallazgo); los recorridos E2E, que se han mirado por encima (RI-79); y el
contenido de los documentos de plan (`PLAN_*.md`), salvo donde el código los cita. Tampoco se ha
**ejecutado** la interfaz en Android ni en Windows 7: lo marcado «a verificar» en RI-74 y RI-76
hay que comprobarlo en el emulador o en la máquina virtual. Los nuevos contratos y el backend
compilan para Android; el editor de mesas queda pendiente de prueba en una pantalla táctil.

---

<a id="anexo-a--mediciones"></a>
## Anexo A · Mediciones

**Método.** Esquema real (`packages/database/migrations/0001_inicial.sql`) cargado en SQLite 3.49.1
(módulo `sqlite3` de Python 3.13.5) con `PRAGMA foreign_keys = ON`. Ningún script ni dato se ha
guardado en el repositorio.

**Reproducciones de la segunda pasada.** Las de SQL, sobre el mismo esquema y con `foreign_keys = ON`; las de RI-71 y RI-82, en Node:

| Hallazgo | Qué se hizo | Resultado |
|---|---|---|
| RI-71 | `Number("0199a3f2-7c1e-7d3a-9f00-1a2b3c4d5e6f") > 0` y `Number("")` en Node | `false` (el primero es `NaN`) y `0`: una línea guardada y una sin guardar dan lo mismo |
| RI-82 | `StandardFonts.Helvetica.encodeText()` de pdf-lib con «Año 2027 · 12,50 € · ¿Señor? ¡Olé! Nº 3ª» | Lo codifica sin error. Sólo fallan «→» y los emojis («WinAnsi cannot encode») |
