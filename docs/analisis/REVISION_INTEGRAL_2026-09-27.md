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
  13. [Worker de Cloudflare](#13-worker-de-cloudflare)
  14. [Frontend](#14-frontend)
  15. [Rust: idioma, runtime y estructura](#15-rust-idioma-runtime-y-estructura)
  16. [CI, build y herramientas](#16-ci-build-y-herramientas)
  17. [Código muerto](#17-código-muerto)
  18. [Documentación desfasada](#18-documentación-desfasada)
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

Lo que sale de esta revisión se concentra en cuatro frentes:

1. **Bugs funcionales concretos**: el correo de pedido no dice qué bar pide (RI-60). En venta rápida, **el «−» de un producto sólo lo quita de la
   pantalla** y no se pueden poner notas de línea desde junio, porque se pregunta si un UUID es
   mayor que cero (RI-71).
2. **CI**: no ejecuta 249 tests
   —entre ellos todos los guardianes que CLAUDE.md cita como red— (RI-08).
3. **Código muerto**: casos de uso y ficheros sin ningún llamante (RI-22).
4. **Plataformas** (segunda pasada). La rama de Windows 7 es anterior a ARQ-01 y su canal
   del feed no está desplegado (RI-74). Y el harness de contrato compara efectos pero no la
   validación, donde hay cuatro divergencias entre la Main y la Handy (RI-78).

---

## Tabla de hallazgos

| ID | Sev | Tipo | Hallazgo |
|----|-----|------|----------|
| [RI-08](#ri-08) | 🟠 | deuda | La CI no ejecuta 249 tests, entre ellos todos los guardianes |
| [RI-15](#ri-15) | 🟡 | rendimiento | Se construye un `reqwest::Client` por petición (sin reutilizar conexiones) |
| [RI-16](#ri-16) | 🟡 | rendimiento | libsql local bloquea hilos del runtime async (restauración, estadísticas) |
| [RI-22](#ri-22) | 🟡 | deuda | Caminos enteros sin ningún llamante |
| [RI-23](#ri-23) | 🟡 | rendimiento | Bundle de 2,5 MB sin división por rutas, logo de 940 KB e imágenes sin uso |
| [RI-24](#ri-24) | 🟡 | deuda | Los source maps del frontend no llegan a Sentry (y la versión no cuadra) |
| [RI-25](#ri-25) | 🟡 | seguridad | Acciones de GitHub sin fijar por SHA en un job con la clave de firma del updater |
| [RI-32](#ri-32) | 🔵 | deuda | Transacciones escritas a mano (`"BEGIN;"`) y helpers duplicados por repositorio |
| [RI-38](#ri-38) | 🔵 | bug | Errores que se tragan en silencio (estadísticas, outbox, compatibilidad de columnas) |
| [RI-39](#ri-39) | 🔵 | bug | Guardas de estado fuera de la transacción (`actualizar_pago`) |
| [RI-40](#ri-40) | 🔵 | bug | Pánicos por cortar cadenas por bytes (reservas) |
| [RI-44](#ri-44) | 🔵 | rendimiento | El worker gasta CPU re-serializando el catch-up y verificando Ed25519 en JS |
| [RI-45](#ri-45) | 🔵 | tecnología | El Durable Object es «clásico»: Workers RPC quitaría el HMAC interno frágil |
| [RI-46](#ri-46) | 🔵 | deuda | Configuración de wrangler: bindings duplicados, `remote: true`, fecha de compatibilidad |
| [RI-47](#ri-47) | 🔵 | deuda | Frontend: componentes gigantes y adaptadores de la época `dualCall` |
| [RI-48](#ri-48) | 🔵 | deuda | Dominio: duplicación, tipos como cadenas y constructores de trece argumentos |
| [RI-49](#ri-49) | 🔵 | deuda | Build: `include_dir!` sin `rerun-if-changed`, `Cargo.lock` anidado y dependencias sin uso |
| [RI-60](#ri-60) | 🟡 | bug | El correo de pedido no dice qué negocio pide ni a quién responder |
| [RI-67](#ri-67) | 🔵 | bug/rendimiento | Imágenes: un fallo permanente atasca la cola y la query fragmenta la caché pública |
| [RI-71](#ri-71) | 🟠 | bug | Venta rápida: el «−» de un producto sólo lo quita de la pantalla, y no se pueden poner notas |
| [RI-74](#ri-74) | 🟡 | deuda | Windows 7: la rama es anterior a ARQ-01 y su canal del feed no está desplegado |
| [RI-75](#ri-75) | 🔵 | deuda | Android: el `Context` sale de una API no pública |
| [RI-76](#ri-76) | 🔵 | deuda | Android: restos de la plantilla, márgenes seguros y release sin firmar |
| [RI-77](#ri-77) | 🔵 | bug | La Handy enseña pantallas que en ella no funcionan (pedidos, caja, ticket, licencia) |
| [RI-78](#ri-78) | 🟡 | bug/arquitectura | El harness no ve la validación de entrada, y ahí hay cuatro divergencias |
| [RI-79](#ri-79) | 🔵 | deuda | Cobertura del harness: exclusión obsoleta, un motivo que no se sostiene y cifras viejas |
| [RI-80](#ri-80) | 🟡 | bug | Editor de mesas: componentes recreados en cada render y sólo eventos de ratón |
| [RI-81](#ri-81) | 🔵 | bug/rendimiento | Modal de comanda: memo anulado, respuestas fuera de orden y doble pulsación |
| [RI-82](#ri-82) | 🔵 | bug | Cuentas: botón sin acción, «Deshacer» sin confirmar y PDF sin eñes ni euros |
| [RI-83](#ri-83) | 🔵 | seguridad | Login: con el PIN bueno pero sin fichar, la sesión del backend se queda abierta |
| [RI-85](#ri-85) | 🔵 | bug | Turno partido: dos escrituras sueltas y sin comprobar solapes |
| [RI-86](#ri-86) | 🔵 | rendimiento | Proveedores resuelve las imágenes de una en una |
| [RI-87](#ri-87) | 🟡 | arquitectura | La frontera webview → Rust no está tipada: adoptar `tauri-specta` |

---

## Orden sugerido

**Ya, antes que nada:** RI-71: son cinco comparaciones y un helper, y hoy deja líneas «quitadas»
dentro de la comanda. Y **lanzar el E2E**, que no se ha lanzado desde que el dinero pasó a céntimos
(21/09). Después, RI-87 (`tauri-specta`): cierra para todos los comandos el hueco por el que se
colaron euros en campos de céntimos, y hace desaparecer los `*Apis.ts` que quedan con tipos propios.

**Antes de congelar `0001_inicial.sql`** (mientras editarlo sólo obliga a resetear las bases de
desarrollo; después cada cosa será una migración nueva que hay que mantener en dos runners):

- Los comentarios desfasados de dentro del propio `0001` ([§18](#18-documentación-desfasada)).
- Si se decide, los `CHECK` de RI-48 (`Metodo_Pago`, estados).

**Antes de cobrar por el producto:**

- RI-08.
- RI-60: un bug que un bar real vería.
- La primera mitad de RI-78 (igualar las cuatro validaciones) y RI-80 si los TPV son táctiles.

**Antes de repartir la Handy de Android:** RI-75 y RI-76 (firma, márgenes), y
RI-77 para que no enseñe lo que no puede hacer.

**Antes de compilar otra versión de Windows 7:** RI-74. Integrar `main` en la rama, y pasar la ruta
del canal a `main`.

**Después, sin prisa:** el resto, empezando por el código muerto (RI-22), y siguiendo por las mejoras de
coste (RI-15, RI-16, RI-44). Los detalles de pantalla (RI-81 a RI-86) conviene hacerlos
cuando se toque cada una, a la vez que se trocean los componentes grandes de RI-47.

## 13. Worker de Cloudflare

<a id="ri-60"></a>
### RI-60 🟡 · El correo de pedido no dice qué negocio pide ni a quién responder

**Dónde:** [`email.routes.ts:85-110`](../../apps/cloud-worker-licensing/src/domains/email/email.routes.ts#L85-L110)
(`EMAIL.send` con `from` genérico y sin `replyTo`) y `buildHtml`/`buildText`.

**Qué pasa.** El asunto es «Pedido a {proveedor}» y el cuerpo lleva las líneas y las notas. No lleva
el nombre del bar, ni su dirección, ni su teléfono, ni su correo, y el remitente es nuestra
dirección genérica. El proveedor recibe un pedido sin saber de quién es y, si responde, la
respuesta va a nuestro buzón y no al del bar.

**Propuesta.** Incluir `Business_Name` y el contacto (`Contact_Settings`) en el asunto («Pedido de
{bar}») y en el cuerpo, y poner `Reply-To` al correo de contacto del bar (a verificar que el binding
de Cloudflare Email Service lo admite). El worker ya consulta la base del tenant para autorizar el
destinatario, así que puede leer esos datos él mismo en vez de fiarse de lo que mande el cliente.

<a id="ri-67"></a>
### RI-67 🔵 · Imágenes: un fallo permanente atasca la cola y la query fragmenta la caché pública

- **La cola se para en el primer fallo** ([`lib.rs:1170-1202`](../../apps/tpv-main/src-tauri/src/lib.rs#L1170-L1202),
  `drenar_imagenes`): al fallar una imagen, el resto se queda para la próxima vuelta, que vuelve a
  empezar por la misma. Una imagen que el worker rechaza siempre (413, 400) bloquea todas las de
  detrás para siempre, en silencio. Es el mismo patrón que SYNC-20 arregló en el outbox, y se
  arregla igual: distinguir rechazo permanente de transitorio y apartar el permanente.
- **La caché del GET público usa la URL con la query**: una query distinta en cada petición fuerza
  lecturas de R2. Normalizar la clave de caché sin parámetros que no afectan a la imagen.

<a id="ri-44"></a>
### RI-44 🔵 · El worker gasta CPU re-serializando y verificando en JS

- **Catch-up** ([`sync.routes.ts:64-120`](../../apps/cloud-worker-licensing/src/domains/sync/sync.routes.ts#L64-L120)):
  cada `Statements_Json` se parsea (`safeJsonParse`, línea 91) para volver a serializarse en
  `c.json`. Con páginas de 500 operaciones es trabajo puro de CPU (que Workers factura). Se puede
  construir la respuesta pegando el texto guardado (`"statements":` + `Statements_Json`) sin
  parsearlo.
- **Ed25519 con `@noble/ed25519`** en cada petición autenticada. El runtime de Workers implementa
  Ed25519 nativo en WebCrypto (`crypto.subtle.verify("Ed25519", …)`): más rápido, en tiempo
  constante, y una dependencia menos. `LICENSE_SIGNING_PRIVATE_KEY` también podría firmar por
  WebCrypto importándola como PKCS#8.
- Cada petición de tenant hace varios viajes seguidos a la base central en `aws-eu-west-1`
  (JWT, dispositivo, licencia —con cachés de 60 s por isolate— y credenciales). Evaluar **Smart
  Placement** (`"placement": { "mode": "smart" }`), que ejecuta el worker cerca del backend cuando
  hace varios viajes por petición. Medir antes y después con los tiempos que ya mandáis a Axiom.

<a id="ri-45"></a>
### RI-45 🔵 · El Durable Object es «clásico»: Workers RPC quitaría el HMAC interno

**Dónde:** [`index.ts`](../../apps/cloud-worker-licensing/src/index.ts) (`TenantHubClass as any`),
[`tenantHub.rutas.ts`](../../apps/cloud-worker-licensing/src/durableObjects/tenantHub.rutas.ts),
[`lib/hub.ts`](../../apps/cloud-worker-licensing/src/lib/hub.ts).

`TenantHub` es una clase con `fetch` y rutas internas (`/internal/apply`, `/internal/revoke`,
`/internal/pair-request`) firmadas con HMAC. CLAUDE.md dedica un párrafo a lo frágil que es esa
firma («desalinear cualquiera de los tres da un 401 en el DO en silencio»). Con `extends
DurableObject` y **RPC** (llamadas a métodos del stub, tipadas), esas rutas pasan a ser métodos: sin
serializar a mano, sin HMAC (sólo el propio worker puede obtener un stub), con tipos de extremo a
extremo, y el SDK de Sentry deja de necesitar el `as any`. El WebSocket sigue entrando por `fetch`.
Es un cambio sólo del worker, desplegable con rollback, y los tests existentes lo cubren.

<a id="ri-46"></a>
### RI-46 🔵 · Configuración de wrangler

**Dónde:** [`wrangler.json`](../../apps/cloud-worker-licensing/wrangler.json).

- **Bindings duplicados sin uso**: `tpv_images` y `tpv_copias_control` apuntan a los mismos
  buckets que `IMAGES` y `COPIAS` y no los usa ningún código (comprobado). El segundo está sólo en
  el cambio sin commitear de `wrangler.json`, pero **ya está desplegado**: los dos despliegues del
  28/09 se hicieron desde esa copia de trabajo. Tienen pinta de los que añade `wrangler r2 bucket create` al preguntar.
  Además llevan `remote: true`, que en `wrangler dev` significa **tocar los buckets de producción**.
  Borrarlos.
- `send_email` con `remote: true`: `wrangler dev` envía correo real.
- `compatibility_date: 2025-10-08`: casi un año atrás. Subirla (y alinear la de
  `vitest-pool-workers`) para no ir acumulando diferencias de runtime.

### Otros del worker

- Las rutas de licencia (`/activate`, `/device-change/request`) leen su cuerpo a mano
  (`c.req.json()`), cuando ARQ-03 dice que ninguna ruta lee su propio cuerpo. Son anteriores a esa
  regla; migrarlas a `cuerpo(schema)` las deja validadas igual que el resto.
- El token de administración (`ADMIN_API_TOKEN`) es un único secreto de larga vida que emite y
  anula licencias y, desde PROD-06, apaga interruptores remotos. Merece la misma nota que SEC-02:
  rotación documentada, y quizá Cloudflare Access delante de `/v1/admin`.

---

## 14. Frontend

<a id="ri-23"></a>
### RI-23 🟡 · Bundle de 2,5 MB sin división por rutas y activos pesados

**Dónde:** [`Router.tsx`](../../apps/tpv-main/src/app/Router.tsx), `dist/assets`,
[`public/`](../../apps/tpv-main/public), [`src/assets/img`](../../apps/tpv-main/src/assets/img).

- **Un único `index-*.js` de 2,55 MB** (medido en `dist/`). Todas las páginas se importan de forma
  estática, así que el arranque parsea ApexCharts (Estadísticas), Konva (editor de mesas), pdf-lib
  (Cuentas) y el resto aunque se abra la venta rápida. En un TPV con un Celeron se nota en el
  arranque y en cada recarga de la webview. React Router 7 admite `lazy` por ruta; con dividir
  Estadísticas, EditTables, Cuentas y Configuración basta para la mayor parte.
- **El logo que se usa pesa 940 KB** (`logo-altaria-azul-transparente.png`): un logo en SVG o WebP
  a su tamaño de pantalla son pocos KB.
- **Activos sin ninguna referencia** (comprobado): `public/comidas.png`, `public/bebidas.webp`, las
  dos fotos `.avif` de `public/`, `src/assets/img/logo-azul-cuadrado.png` (896 KB),
  `logo-altaria-azul.jpeg`, `logo-morado-cuadrado.png`, `img/logo.png`. Los de `public/` se copian
  al instalador. Las dos `.avif` tienen nombre de banco de imágenes (`…_632498-25445.avif`): si
  se quedaran, conviene comprobar su licencia.
- En la copia de trabajo hay `public/Adobe Express - file (2).png` (6,9 MB) sin versionar: un build
  local lo mete en el instalador.

<a id="ri-47"></a>
### RI-47 🔵 · Frontend: componentes gigantes y adaptadores de la época `dualCall`

- **Componentes de miles de líneas**: [`Cuentas.tsx`](../../apps/tpv-main/src/app/pages/Cuentas.tsx)
  (2.559 líneas, 50 `useState`), [`VentaRapida.tsx`](../../apps/tpv-main/src/app/pages/VentaRapida.tsx)
  (2.212, 34), `EditTables.tsx` (1.844), `MesaComandaModal.tsx` (1.714). Cada cambio de estado
  vuelve a renderizar la página entera, y son los más difíciles de modificar sin romper algo.
  Extraer secciones y agrupar el estado relacionado en `useReducer` (o stores de Zustand, que ya
  usáis) antes de que crezcan más.
- **Adaptadores de forma heredados**: quedan en los `*Apis.ts` que no llevan dinero (la lista está en
  [RI-87](#ri-87)): `pick(row, [...])` con varios nombres por campo, `r?.a ?? r?.A`, mappers a
  camelCase. Con los tipos generados por ts-rs cada comando devuelve una forma fija; ese código ya
  sólo puede esconder un error de contrato. Se resuelve con RI-87.
- **Cola de cobros pendientes en `localStorage`**, con nombre y NIF del cliente cuando pide factura
  (el propio comentario lo asume como coste). Está bien protegida (`try` en lectura y escritura),
  pero la fuente de verdad del cobro ya es local e idempotente por `ID_Pago`; si la cola hace
  falta, su sitio es SQLite (un `_Cobros_Pendientes` por `raw()`), no el almacenamiento de la
  webview.
- `features/` mezcla convenciones (`ClientsComponents`, `InventaryComponents`, `mesasComponents`,
  `ventaRapida`, `cuentas`). Uniformar el día que se toquen.
- `main.tsx` importa `React` y `StrictMode` y no los usa.

<a id="ri-87"></a>
### RI-87 🟡 · La frontera webview → Rust no está tipada: adoptar `tauri-specta`

**Dónde:** [`invokeClient.ts`](../../packages/client/src/invokeClient.ts)
(`invokeClient<T>(command: string, args?: Record<string, unknown>)`), los `*Apis.ts` de cada
feature, unos 20 ficheros que llaman a `invoke` de `@tauri-apps/api/core` directamente, los **218**
`#[tauri::command]` de `src-tauri/src/commands/` y
[`check-comandos-tauri.mjs`](../../scripts/check-comandos-tauri.mjs).

**Qué pasa.** ts-rs genera los **tipos** que cruzan la frontera, pero no los **comandos**. Cada
llamada es una cadena más un objeto sin tipo, así que nadie comprueba tres cosas:

- **El nombre.** Renombrar o retirar un comando compila en los dos lados y revienta en el equipo
  del cliente con *command not found*. Hoy lo cubre a medias `check-comandos-tauri.mjs`, que no ve
  los nombres que viajan en una variable.
- **La forma de los argumentos.** Conviven comandos con los argumentos planos y otros envueltos en
  `{ args: {…} }`, y equivocarse no da error: un `Option` llega como `None` y el comando sigue con
  su valor por defecto (la trampa que CLAUDE.md apunta en §11-bis).
- **Los tipos que entran y salen.** Como `invokeClient` acepta cualquier objeto, los `*Apis.ts`
  redeclaran sus propios tipos a mano —19 ficheros los tienen, con el dinero en `number`— y
  normalizan lo que vuelve con alias heredados de `dualCall` (`pick(row, [...])`, `r?.a ?? r?.A`).
  Por ese hueco se colaron euros en campos de céntimos en todos los formularios de dinero (un café
  dado de alta a «3» se guardaba a 3 céntimos). Todos los comandos devuelven ya tipos concretos (el
  único `serde_json::Value` es el proxy de emparejamiento, a propósito), así que esa normalización
  sólo puede esconder un error de contrato.

**Propuesta.** Adoptar [`tauri-specta`](https://github.com/specta-rs/tauri-specta): lee las firmas
de los comandos y genera una función TypeScript tipada por cada uno
(`commands.inventarioUpsertProducto(args: UpsertProductoInput)`), con su tipo de retorno y su error.

1. **Comprobar antes el estado de la versión para Tauri 2** (estuvo mucho tiempo como *release
   candidate*; no es un plugin oficial de Tauri) y que soporta lo que ya se usa: el tipo marcado de
   `Dinero` (`number & { __centimos }`), `chrono`, `Result<T, AppErrorDto>` y los comandos `async`
   con `State`.
2. **Decidir un solo generador de tipos.** Puede convivir con ts-rs (derivar `specta::Type` junto a
   `TS`), pero eso son dos generadores para los mismos DTO. Si specta cubre lo que hace ts-rs
   (`#[ts(type = "number")]` en los ID, `optional`, el fichero único), pasar a specta sólo es lo más
   limpio. Se decide con el punto 1 delante.
3. **Rust:** `#[specta::specta]` en cada comando, `tauri_specta::Builder` en `lib.rs` en lugar de
   `generate_handler!`, y la exportación de `bindings.ts` dentro de `pnpm generate-types`, con una
   comprobación en CI de que el fichero generado está al día (como el snapshot del esquema).
4. **Frontend:** sustituir `invokeClient`/`invoke` por las funciones generadas. Los `*Apis.ts` que
   sólo envuelven un comando **desaparecen**; los hooks de TanStack Query (`*Queries.ts`) llaman
   directamente a `commands.*`. Los componentes consumen los DTO generados, sin tipos propios ni
   normalizadores. Conservar el contrato de errores: que la función lance el `AppErrorDto` y
   `toAppError`/`esError` sigan valiendo tal cual (tauri-specta puede generar las funciones
   devolviendo `Result` o lanzando; elegir lanzar evita tocar cada `catch`).
5. **Retirar `check-comandos-tauri.mjs`**, salvo para lo que siga invocando por nombre: el E2E llama
   por IPC con una cadena (`leerDeLaApp`, en `e2e/helpers/ui.ts`). Decidir si el E2E importa también
   los nombres generados o si el script se queda sólo para él.
6. **Documentación:** CLAUDE.md §4.3 (generación de tipos), §8 («el NOMBRE de un comando no lo
   comprueba nadie») y la nota de §11-bis sobre los argumentos planos dejan de ser ciertas y hay que
   reescribirlas; el patrón de §7 (paso 7, `*Apis.ts`) también.

Absorbe la viñeta de «adaptadores de forma heredados» de RI-47.

**Lo que ya está hecho, y lo que queda.** Los `*Apis.ts` que llevan dinero ya usan los tipos
generados, sin normalizadores ni mappers a camelCase: inventario, venta rápida, proveedores,
pedidos, cuentas, cierre de caja, mesas (salvo el plano), clientes, impresión y correo. Los
*payloads* de impresión se movieron a `tpv-contracts` (`impresion.rs`), que era lo que faltaba para
que tuvieran tipo en TypeScript. **Quedan por convertir**, y hay que hacerlo aquí:

- `features/login/loginApi.ts`
- `features/reservas/reservasApis.ts`
- `features/tareas/tareasApis.ts`
- `features/trabajadores/trabajadoresApis.ts`
- `features/configuracion/api/verifactuApis.ts`
- `features/estadisticas/statsApis.ts` (ya usa los DTO de respuesta; revisar el resto)
- `app/arranque/emparejamiento.ts`
- `features/configuracion/api/configApis.ts`: la entrada ya es el DTO generado, pero los stores de
  Zustand (`useBusinessSettings`, `useTicketSettings`) guardan la configuración con nombres en
  camelCase propios. Es estado de la aplicación, no un contrato; pasar los stores a los nombres
  del DTO toca todas las pantallas que los leen.
- `features/mesasComponents/types.ts`: `Salon`/`Table`, la geometría del plano que usa el editor
  de mesas, frente a los generados `SalonOut`/`TableOut`/`SalonInput`.
- Las llamadas directas a `invoke` de `@tauri-apps/api/core` que quedan (unos 20 ficheros, entre
  ellos `save_image` en los formularios de producto y `printer_ticket_cols` en la vista previa).

<a id="ri-71"></a>
### RI-71 🟠 · Venta rápida: el «−» de un producto sólo lo quita de la pantalla, y no se pueden poner notas

**Dónde:** [`VentaRapida.tsx:1239`](../../apps/tpv-main/src/app/pages/VentaRapida.tsx#L1239)
(`onGuardarNota`), [`:1480`](../../apps/tpv-main/src/app/pages/VentaRapida.tsx#L1480)
(`removeProductoFromTicket`), [`TicketPanel.tsx:133`](../../apps/tpv-main/src/features/ventaRapida/ui/TicketPanel.tsx#L133)
(`openNotaModal`), [`:151`](../../apps/tpv-main/src/features/ventaRapida/ui/TicketPanel.tsx#L151)
(`saveNota`) y [`:309`](../../apps/tpv-main/src/features/ventaRapida/ui/TicketPanel.tsx#L309) →
[`:395`](../../apps/tpv-main/src/features/ventaRapida/ui/TicketPanel.tsx#L395) (botón de nota).

Las cinco comprobaciones deciden si una línea ya está guardada con `Number(detalleId) > 0`, que era
lo correcto cuando los ID eran enteros. Desde `08ed9c6` (13/06, «frontend a UUIDv7») un `ID_Detalle`
es un UUID, `Number(uuid)` es `NaN` y `NaN > 0` es `false` (comprobado). O sea que **ninguna línea
cuenta nunca como guardada**:

- **Notas.** El botón sale deshabilitado en todas las líneas. En venta rápida no se puede anotar
  «sin hielo» o «sin gluten» desde hace tres meses. En mesas sí se puede, porque usa otra comprobación.
- **«−» en la tarjeta del producto.** Entra por la rama de «la línea todavía se está insertando»:
  la quita de la pantalla, apunta su id en `cancelledAddTempIdsRef` (donde nadie la buscará, porque
  no hay ninguna inserción en curso con ese id) y **no llama al backend**. La línea sigue en la
  comanda y vuelve a aparecer en cuanto el ticket se recarga (al cambiar de ticket, al reabrirlo o
  en el listado de tickets, que escucha `vr:changed`). Hasta entonces, la pantalla y la comanda no
  suman lo mismo. Quitarla desde el propio ticket (`eliminarLineaTicket`,
  [`:1518`](../../apps/tpv-main/src/app/pages/VentaRapida.tsx#L1518)) sí funciona, porque pregunta
  `!idDetalle`.

**Propuesta.** Un helper `lineaGuardada(t)` en `features/ventaRapida/` que devuelva
`Boolean(t.detalleId)` (una línea sin guardar lleva `detalleId: ""`,
[`:1364`](../../apps/tpv-main/src/app/pages/VentaRapida.tsx#L1364)), usado en los cinco sitios. Un
paso de E2E del tipo «añadir, quitar con −, recargar» lo habría cazado.

<a id="ri-80"></a>
### RI-80 🟡 · Editor de mesas: componentes que se recrean en cada render, y sólo eventos de ratón

**Dónde:** [`EditTables.tsx`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx).

- **`TableNode` ([`:1006`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1006)) y
  `RoomEditor` ([`:1123`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1123)) se
  definen dentro del componente** y se usan como `<TableNode/>` y `<RoomEditor/>`
  ([`:1640-1642`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1640-L1642)). Cada
  render crea un tipo de componente nuevo, y React desmonta y vuelve a montar todos los nodos de
  Konva. Si durante un arrastre cambia cualquier estado (`setDirty`, el historial), el nodo que se
  está arrastrando se recrea. Sacarlos fuera, pasándoles lo que necesiten por props, o llamarlos
  como funciones (`{TableNode({table})}`) lo arregla.
- **Sólo escucha eventos de ratón**: `onMouseDown` de la mesa en modo borrar
  ([`:1016`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1016)), el paneo del
  lienzo ([`:1590-1592`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1590-L1592))
  y el añadir vértices ([`:1619`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1619)).
  El plano de servicio sí escucha los toques: `onTap` en
  [`features/mesasComponents/TableNode.tsx:115`](../../apps/tpv-main/src/features/mesasComponents/TableNode.tsx#L115).
  Konva manda los toques como `touchstart`/`tap`, no como `mousedown`, y sobre una figura cancela
  por defecto los eventos de ratón que el navegador emularía. **A verificar en una pantalla
  táctil**: lo esperable es que arrastrar funcione (Konva lo gestiona internamente) y que borrar
  tocando una mesa no. El paneo y los vértices, que caen sobre el fondo, dependerán de la emulación
  del navegador. Con eventos `onPointer*` basta un solo juego de manejadores para ratón y dedo.
- `alert()` para los errores
  ([`:1477`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1477),
  [`:1505`](../../apps/tpv-main/src/app/pages/mesasPages/EditTables.tsx#L1505)) en lugar del
  `toast` del resto de la aplicación. En la webview bloquea y sale con otro aspecto.

<a id="ri-81"></a>
### RI-81 🔵 · Modal de comanda: memoización anulada, respuestas fuera de orden y doble pulsación

**Dónde:** [`MesaComandaModal.tsx`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx).

- **`React.memo` de `ProductCard` no sirve.** El comentario de
  [`:496-498`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L496-L498)
  estabiliza `notifyChanged` justo para eso, pero las tarjetas reciben
  `onAdd={conAviso(addProductoToTicket)}` y `onRemove={conAviso(…)}` creados en cada render
  ([`:1384-1385`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L1384-L1385),
  [`:1429-1430`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L1429-L1430)).
  Con memorizar los dos envoltorios con `useMemo` se consigue lo que el comentario pretende.
- **Respuestas fuera de orden.** Cargar productos de una categoría y buscar por nombre
  ([`:640-700`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L640-L700))
  no descartan una respuesta que llega tarde: el `clearTimeout` cancela la búsqueda que aún no ha
  empezado, no la que ya está en curso. Pulsando dos categorías seguidas, o escribiendo con la red
  lenta, puede quedarse en pantalla lo de la anterior. Hace falta una bandera `cancelado` en el
  `cleanup` del efecto.
- **Añadir deprisa.** El id optimista es `opt-${Date.now()}`
  ([`:709`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L709)), que se
  repite con dos toques en el mismo milisegundo. Y la mezcla `[...t, ...enVuelo]`
  ([`:734-737`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L734-L737))
  da por hecho que las respuestas llegan en orden: si la segunda adición contesta antes que la
  primera, la última respuesta en llegar es la más vieja, y la línea nueva desaparece hasta la
  siguiente recarga. `crypto.randomUUID()` para el id, y quedarse con la respuesta más reciente
  (o recargar al terminar la última petición en curso).
- **Confirmar cobro dos veces.** `cobrar`
  ([`:864`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L864)) no tiene
  guardia mientras hay un cobro en curso, y el botón sólo se deshabilita si falta dinero
  ([`:1292`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L1292)). No
  cobra dos veces, porque el backend rechaza líneas ya cobradas
  ([`mesas.rs:1980-1984`](../../crates/tpv-infra-sqlite/src/mesas.rs#L1980-L1984)), pero el
  segundo toque enseña «No se pudo cobrar… ya están pagados» justo después de un cobro bueno.
- `console.log` con el operador y el ticket en el camino del cobro
  ([`:886`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L886),
  [`:913`](../../apps/tpv-main/src/features/mesasComponents/MesaComandaModal.tsx#L913)).

<a id="ri-82"></a>
### RI-82 🔵 · Cuentas: un botón que no hace nada, «Deshacer» sin confirmar y el PDF sin eñes

**Dónde:** [`Cuentas.tsx`](../../apps/tpv-main/src/app/pages/Cuentas.tsx).

- **«Enviar a gestoría»**
  ([`:1740-1746`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L1740-L1746)) no tiene `onClick`.
  O se quita, o se conecta al correo (con el tope y el destinatario acotado de REV-14).
- **«Deshacer» un cierre de caja** actúa al primer clic
  ([`:1864`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L1864) →
  [`deshacerCierre`, `:436`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L436)). No se pierde
  nada, porque el cierre queda marcado como reabierto, pero un clic equivocado obliga a volver a
  contar el cajón. Un diálogo de confirmación, como el de anular un cobro.
- **`asciiSafe`** ([`:87-96`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L87-L96)) quita todo lo
  que no es ASCII porque «jsPDF sólo lleva WinAnsi». Los PDF los hace **pdf-lib**, y WinAnsi
  (cp1252) sí incluye `ñ`, las tildes, `€`, `¿`, `¡`, `º` y `ª`: comprobado con la Helvetica de
  pdf-lib (Anexo A). Hoy «Año» sale «Ano», «Señor» sale «Senor» y el signo del euro desaparece. Lo
  único que de verdad no cabe son flechas, emojis y similares: basta con sustituir por `?` lo que
  quede fuera de cp1252.
- **Dos generadores de PDF casi iguales**: `guardarPdf`
  ([`:846-1098`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L846-L1098)) y `sacarCuentaDelDia`
  ([`:1100-1351`](../../apps/tpv-main/src/app/pages/Cuentas.tsx#L1100-L1351)), unas 250 líneas
  cada uno, con la misma maquetación y distinto rango. Un `generarPdfCuentas(rango, datos)` fuera
  del componente, que además se puede probar sin React (como `ticketMath.ts`).

<a id="ri-83"></a>
### RI-83 🔵 · Login: con el PIN bueno pero sin fichar, la sesión del backend se queda abierta

**Dónde:** [`Login.tsx:376-412`](../../apps/tpv-main/src/app/pages/Login.tsx#L376-L412).

`loginUser` abre la sesión del backend (`AppState::sesion`) en cuanto el PIN es correcto. Si la
persona no ha fichado, la pantalla la frena («Debes fichar entrada antes de entrar») pero no cierra
esa sesión. Queda abierta, con su rol, detrás de una pantalla que pide PIN: exactamente lo que
[`AppBoot.tsx:77-88`](../../apps/tpv-main/src/app/AppBoot.tsx#L77-L88) dice que no puede pasar
(SEC-01). Mientras tanto, por ejemplo, `device_reset_mode` pasa a exigir el rol de esa persona
(`exigir_rol_si_hay_sesion`). La solución es comprobar el fichaje **antes** de `loginUser`, o
llamar a `logout` en esa rama.

<a id="ri-85"></a>
### RI-85 🔵 · Turno partido: dos escrituras sueltas y sin comprobar que los tramos no se pisen

**Dónde:** [`Trabajadores.tsx:571-614`](../../apps/tpv-main/src/app/pages/Trabajadores.tsx#L571-L614).

Un turno partido se guarda como **dos** `createAsignacion` seguidas. Si la segunda falla, el primer
tramo ya está guardado, la pantalla dice «No se pudo guardar la asignación» y el modal sigue
abierto, así que el reintento **duplica el primer tramo**. Además `validateRange` mira cada tramo
por separado: 10:00–16:00 y 12:00–18:00 se aceptan juntos. Lo arreglan un comando que reciba los
dos tramos en una sola transacción y una comprobación de solape en el dominio (que es donde ya vive
la validación de horarios).

<a id="ri-86"></a>
### RI-86 🔵 · Proveedores resuelve las imágenes de una en una

**Dónde:** [`Proveedores.tsx:145-154`](../../apps/tpv-main/src/app/pages/Proveedores.tsx#L145-L154).

`mapProveedoresUI` espera cada `resolveImageUrl` antes de la siguiente, y en la Main cada una puede
suponer bajar el fichero de R2 (`images_ensure_local`). Con la red lenta, la lista tarda la suma de
todas. La función de al lado, `mapProductosUI`, ya lo hace con `Promise.all`: es copiar ese patrón.

---

## 15. Rust: idioma, runtime y estructura

<a id="ri-16"></a>
### RI-16 🟡 · libsql local bloquea hilos del runtime async

**Dónde:** [`db.rs`](../../crates/tpv-infra-sqlite/src/db.rs) y todos los repositorios.

La API de `libsql` para ficheros locales es `async` en la firma pero **síncrona por dentro**: cada
`query`/`execute`/`next()` ejecuta SQLite en el hilo que lo llama. Los repositorios se llaman desde
comandos Tauri que corren en el runtime multihilo de tokio, así que una consulta larga **bloquea un
hilo del runtime** (no cede). Para lo corriente da igual; para lo largo no:

- La restauración desde la nube y las páginas del backfill.
- Estadísticas de un año, y la verificación diaria contra la nube.

Con pocos núcleos (un TPV de gama baja tiene 2–4), dos de estas a la vez dejan al IPC sin hilos y
la interfaz se congela. Sabéis hacerlo —impresión, imágenes, AEAT y las copias locales
(`recovery::en_hilo_aparte`) ya van por `spawn_blocking`—: aplicar lo mismo a esas operaciones, o
dedicar un hilo propio al escritor (que además encaja con el escritor único).

<a id="ri-15"></a>
### RI-15 🟡 · Se construye un cliente HTTP por petición

**Dónde:** [`tpv-infra-licensing/src/lib.rs:134-139`](../../crates/tpv-infra-licensing/src/lib.rs#L134-L139)
(`http_client()`, llamado en cada petición) y [`lib.rs:735-739`](../../crates/tpv-infra-licensing/src/lib.rs#L735-L739)
(`enviar_post`).

`reqwest::Client` mantiene el pool de conexiones; su documentación pide crear uno y reutilizarlo.
Aquí se crea uno **en cada petición**, así que cada página de catch-up, de backfill, cada ticket de
WebSocket, cada comprobación de licencia y cada subida de imagen paga un handshake TLS completo con
Cloudflare (uno o dos viajes de ida y vuelta y CPU) y carga los certificados raíz. Un `static
CLIENTE: LazyLock<Client>` lo resuelve. (`tpv-infra-http` sí lo hace bien: crea el suyo una vez.)

<a id="ri-32"></a>
### RI-32 🔵 · Transacciones escritas a mano y helpers duplicados

- **Cada método transaccional repite** `execute_batch("BEGIN;")` + `async {}` + `match res { Ok →
  COMMIT, Err → ROLLBACK }`. Son decenas de copias, y un `?` entre medias deja la transacción
  abierta hasta que otro `write()` la limpie. Con Rust 1.91 hay cierres asíncronos: un
  `db.transaccion(async |tx| { … }).await` que haga `BEGIN`/`COMMIT`/`ROLLBACK` en un sitio elimina
  el patrón y el riesgo. Y deja a la vista las escrituras multi-sentencia que hoy van **sin**
  transacción.
- **Helpers copiados por repositorio**: `db_err`, `select_one_i64/string/f64/dinero`, `try_exec`,
  `exists_by_id`, `trabajador_id_from_usuario`, `resolve_trabajador_id_input`, `now_ms`,
  `update_total_comanda_sql`. Un módulo
  `consultas.rs` común.
- **Compatibilidad con esquemas que ya no existen**: `try_exec` traga «no such column/table» (cobro,
  [`mesas.rs:2032-2062`](../../crates/tpv-infra-sqlite/src/mesas.rs#L2032-L2062), y cocina,
  [`mesas.rs:2269-2303`](../../crates/tpv-infra-sqlite/src/mesas.rs#L2269-L2303)), y
  `list_categorias_vendibles` ([`mesas.rs:1779-1786`](../../crates/tpv-infra-sqlite/src/mesas.rs#L1779-L1786))
  y `productos_query` ([`mesas.rs:2317-2325`](../../crates/tpv-infra-sqlite/src/mesas.rs#L2317-L2325))
  reintentan con otra consulta si la primera falla **por cualquier motivo**. Con un esquema único
  eso sólo puede ocultar un bug. En el cobro, además, el `if !ok` que reintenta el `INSERT INTO
  Pagos` sin cobrador dice cubrir «FK inexistente», pero `try_exec` sólo devuelve `false` con «no
  such column»: ante una FK rota devuelve `Err`. Es código inalcanzable con un comentario que
  describe otra cosa.
- `WriteGuard::tx_buf` es un `tokio::sync::Mutex` para un estado que sólo toca un guard a la vez;
  basta un `std::sync::Mutex`.
- `mapping::v_i64` trunca un `Real` (`n as i64`) mientras que `v_dinero` redondea: dos criterios en
  el mismo módulo.

<a id="ri-38"></a>
### RI-38 🔵 · Errores que se tragan en silencio

- **Estadísticas**: 19 bucles `while let Ok(Some(r)) = rows.next().await` en
  [`stats.rs`](../../crates/tpv-infra-sqlite/src/stats.rs#L270). Un error de lectura a mitad corta el
  bucle y la pantalla enseña una estadística **parcial como si fuera completa**. Debe ser
  `while let Some(r) = rows.next().await.map_err(…)?`.
- **`write_op`** ([`db.rs:333`](../../crates/tpv-infra-sqlite/src/db.rs#L333)): si serializar las
  sentencias fallara, guarda `"[]"` en el outbox y la escritura de negocio se confirma igual: una
  operación que **no replica nada** sin avisar. Hoy no puede fallar en la práctica, pero en el
  camino más crítico del producto lo correcto es devolver el error y abortar la transacción.
- `value_to_json(Value::Blob) → Null`: hoy no hay columnas BLOB; un `debug_assert!` evitaría que
  una futura se replicara vacía sin que nadie lo viera.
- **Pool de lectura**: si su `std::Mutex` se envenenara, `ReadGuard::drop` deja de devolver la
  conexión y la siguiente `acquire` hace `expect("invariante del pool…")`: pánico en cadena en todas
  las lecturas. `lock().unwrap_or_else(|p| p.into_inner())`, como ya hace la telemetría.

<a id="ri-39"></a>
### RI-39 🔵 · Guardas de estado fuera de la transacción

`cuentas::actualizar_pago` comprueba que el cobro no esté anulado leyendo por el pool de lectura y
**luego** hace el `UPDATE` en otra toma del escritor, cuyo `WHERE` no mira el estado
([`cuentas.rs:459-484`](../../crates/tpv-infra-sqlite/src/cuentas.rs#L459-L484)). El propio
`anular_pago` explica por qué la comprobación que cuenta es la que está dentro de la transacción.
Añadir `AND COALESCE(Estado,'ACTIVO') = 'ACTIVO'` al `UPDATE` (en los dos lados) lo deja cerrado.
Lo mismo, en pequeño, en `delete_producto` (la comprobación de «comanda abierta» va por el pool de
lectura antes de coger el escritor).

<a id="ri-40"></a>
### RI-40 🔵 · Pánicos por cortar cadenas por bytes

[`reservas.rs:27,34,47`](../../crates/tpv-domain/src/reservas.rs#L27) hacen `&s[..10]` y `&s[..5]`
sobre texto del formulario. Si antes de esa posición hay un carácter de varios bytes (`2026-01-0é`),
Rust **entra en pánico** en vez de devolver un error de validación, y el comando no responde. Usar
`s.get(..10)`. (Revisados los demás cortes por bytes del backend: están protegidos por una
comprobación ASCII previa.)

<a id="ri-48"></a>
### RI-48 🔵 · Dominio: duplicación, tipos como cadenas y constructores de trece argumentos

- **`normalize_metodo` sigue duplicado**: [`pago.rs:9`](../../crates/tpv-domain/src/pago.rs#L9) se
  declara «única fuente de verdad» (CUENTA-03), pero
  [`venta_rapida.rs:6`](../../crates/tpv-domain/src/venta_rapida.rs#L6) tiene su propia copia y es la
  que usa el caso de uso de venta rápida.
- **El método de pago es una cadena** y todo lo que no sea exactamente `"tarjeta"` es efectivo (un
  test lo fija con `"bizum" → "Efectivo"`). El día que se añada Bizum, contará como efectivo en el
  arqueo sin que nada falle. Un `enum MetodoPago` en el dominio + `CHECK (Metodo_Pago IN
  ('Efectivo','Tarjeta'))` en el esquema convierte ese día en un error de compilación. Lo mismo para
  `Estado_Cocina`, `Reservas.Estado`, `Tareas.Estado`, `Fichajes.Estado`, que no tienen `CHECK`.
- **Constructores `validar(…)` con 9–13 argumentos posicionales** del mismo tipo
  (`Option<String>`), con `#[allow(clippy::too_many_arguments)]`: intercambiar `telefono` y `email`
  compila. Recibir el DTO de entrada (o un struct) en vez de la lista.
- `requerido` (5 copias), `limpiar_opcional` (≥ 9), `normalizar_ids` (3): un `texto.rs` común.
- `ErrorCode::TODOS` y `wire()` escritos a mano (con un test que los vigila): `strum`
  (`EnumIter`, `IntoStaticStr` con `serialize_all = "snake_case"`) los genera.

---

## 16. CI, build y herramientas

<a id="ri-08"></a>
### RI-08 🟠 · La CI no ejecuta 249 tests, entre ellos todos los guardianes

**Dónde:** [`ci.yml`](../../.github/workflows/ci.yml) (paso «Tests de dominio, casos de uso y
persistencia»).

Sólo se ejecutan `tpv-domain`, `tpv-application` y `tpv-infra-sqlite`. Contados en el repo, quedan
fuera:

| Crate | Tests | Qué vigilan |
|---|---|---|
| `apps/tpv-main/src-tauri` | 180 | `tests_exenciones_del_gate` (REV-17 cobrador de la sesión, REV-24 `deny` de escritura, REV-26 comandos retirados, «ningún interruptor toca el cobro», `recovery` sin sesión), tablas golden del ticket ESC/POS |
| `tpv-infra-licensing` | 37 | formato del device-proof, reloj (PROD-04), cifrado de campo |
| `tpv-infra-aeat` | 26 | construcción del XML y lectura de la respuesta de la AEAT |
| `tpv-telemetry` | 5 | la mitad Rust de `scrub_casos.json` y el filtro de Sentry |
| `tpv-infra-http` | 1 | — |

CLAUDE.md presenta varios de ellos como la red de una regla («lo vigila `tests_exenciones_del_gate`
…»), pero esa red sólo existe cuando alguien los lanza a mano. La paridad de `scrub_casos.json` y de
las tablas golden del ticket se comprueba en CI por el lado TypeScript y no por el de Rust.

**Propuesta.** Un job `windows-latest` con `cargo nextest run --workspace` (en Windows compilan
`src-tauri` y `tpv-infra-aeat`, y es la única plataforma que se distribuye). Si el coste de minutos
de Windows preocupa, al menos añadir `tpv-telemetry`, `tpv-infra-licensing` y `tpv-infra-http` al
job de Ubuntu (el `keyring` de Linux puede necesitar `libdbus-1-dev`) y ampliar clippy a ellos.

El E2E no va a CI por buenas razones (§16 de CLAUDE.md), pero eso lo deja sin red entre releases.
Para el dinero ya hay otra: los `*Apis.ts` que lo llevan reciben los `Input` generados, así que un
`number` en un campo `Dinero` no compila, y el `typecheck` sí corre en CI. RI-87 lo extiende a todos
los comandos.

**`pnpm lint:rust` está rojo hoy**, con independencia de todo lo anterior: `select_one_f64`
([`mesas.rs:129`](../../crates/tpv-infra-sqlite/src/mesas.rs#L129)) no tiene uso y `-D warnings` lo
convierte en error. Es una línea, pero mientras esté así el clippy de CI no protege nada.

<a id="ri-25"></a>
### RI-25 🟡 · Acciones de GitHub sin fijar por SHA con acceso a la clave del updater

**Dónde:** [`release.yml`](../../.github/workflows/release.yml).

El job de release tiene en el entorno `TAURI_SIGNING_PRIVATE_KEY` —la clave con la que **todos**
los equipos aceptan una actualización— y ejecuta acciones de terceros por etiqueta mutable
(`dtolnay/rust-toolchain@1.91.1`, `Swatinem/rust-cache@v2`, `pnpm/action-setup@v4`, …). Si una de
esas etiquetas se reescribe (ha pasado: `tj-actions/changed-files`, marzo de 2025), el código
inyectado puede leer la clave y firmar una actualización maliciosa para todos los bares. Fijar cada
acción por SHA completo (Dependabot las mantiene igual, ya tenéis el ecosistema `github-actions`
configurado) y, si es posible, mover la firma a un paso que no ejecute nada de terceros después de
cargar el secreto.

<a id="ri-24"></a>
### RI-24 🟡 · Los source maps del frontend no llegan a Sentry

**Dónde:** [`vite.config.ts`](../../apps/tpv-main/vite.config.ts), [`release.yml`](../../.github/workflows/release.yml).

- El plugin sólo sube source maps si hay `SENTRY_AUTH_TOKEN`, y `release.yml` no la pasa: en
  producción las trazas de la webview llegan **minificadas**.
- El `release` del plugin es la versión de `apps/tpv-main/package.json` (`0.1.0`), mientras que
  los eventos llevan la de Cargo/`tauri.conf.json`. `release.yml` comprueba que el tag coincida con
  `tauri.conf.json` y `Cargo.toml`, pero no con `package.json`: en cuanto suban las primeras, los
  mapas se subirían a otra release y Sentry no simbolizaría. Pasar `SENTRY_RELEASE` desde el tag en
  el workflow (o leer la versión de `tauri.conf.json` en `vite.config.ts`).

<a id="ri-49"></a>
### RI-49 🔵 · Build: `include_dir!` sin `rerun-if-changed`, `Cargo.lock` anidado y dependencias sin uso

- **`include_dir!` no vigila la carpeta de migraciones**, y por eso CLAUDE.md pide «tocar
  `migrations.rs`» tras editar un `.sql`. Un `build.rs` en `tpv-infra-sqlite` con
  `println!("cargo:rerun-if-changed=../../packages/database/migrations")` hace que Cargo recompile
  solo y quita esa regla manual.
- **`apps/tpv-main/src-tauri/Cargo.lock` está versionado y muerto**: en un workspace sólo cuenta el
  de la raíz. El anidado es de junio (commit inicial) y todavía fija `libsql 0.3.5`. Confunde a
  herramientas de auditoría y a quien lo lea. Borrarlo.
- **Dependencias declaradas sin uso** (buscado cada nombre de crate en el código de cada crate):
  - `apps/tpv-main/src-tauri`: `libsql`, `uuid`, `pbkdf2`, `password-hash`, `ed25519-dalek`,
    `sha2`, `reqwest`, `keyring` (sólo aparece en comentarios; y además no está limitado a
    escritorio, al contrario que en `tpv-infra-licensing`).
  - `thiserror` en `tpv-domain`, `tpv-infra-licensing` y `tpv-infra-sqlite`; `chrono` en
    `tpv-contracts`; `serde` y `tracing` en `tpv-infra-aeat`.
  - En `[workspace.dependencies]`: `anyhow` y `password-hash` no los usa ninguna crate.
  - `src-tauri` no usa `{ workspace = true }` para `tokio`, `serde`, `chrono`, `rand`, `base64`…:
    dos fuentes de versión para lo mismo.
  - `tokio = { features = ["full"] }` para todo el workspace; las crates de dominio/aplicación sólo
    lo usan en tests.
  - `cargo-machete` (rápido, sin nightly) en CI lo mantiene a raya.
- `src-tauri/Cargo.toml` conserva la plantilla: `description = "A Tauri App"`, `authors = ["you"]`.
  Según la versión de `tauri-build`, la descripción puede acabar en los metadatos del `.exe`.
- `packages/contracts/package.json` tiene un comentario «Provisional… tras la verificación empírica»
  que ya no lo es.

---

## 17. Código muerto

Comprobado con dos análisis de sólo lectura (exportaciones sin ningún uso en otro fichero y
ficheros que nadie importa) más búsquedas de llamantes en Rust. Borrar código muerto no es estética
aquí: varios de estos caminos tocan dinero o autenticación, y el harness de contrato obliga a
mantenerlos iguales en dos lenguajes aunque nadie los use.

<a id="ri-22"></a>
### RI-22 🟡 · Caminos enteros sin ningún llamante

1. **La barra del módulo de mesas.** `use_cases::mesas::{get_or_create_comanda_barra,
   create_comanda_barra, list_comandas_barra, delete_comanda_barra_if_safe, cerrar_comanda}` no los
   llama ningún comando registrado, y su implementación SQLite sigue viva. La implementación HTTP ya
   devuelve «endpoint_no_disponible_en_handy», y en el worker `PUT /v1/mesas/comandas/cerrar` no
   tiene cliente.
2. **`get_alergenos_producto`/`set_alergenos_producto`** de inventario: sin comando, pero con su
   caso de uso.
3. **`next_table_id`** ([`util.rs:14-26`](../../crates/tpv-infra-sqlite/src/util.rs#L14-L26)): el
   generador de ids `MAX+1` de antes de UUIDv7, sin ningún uso.
4. **Frontend, ficheros que nadie importa**: `app/layoutComponent/Account.tsx`,
   `features/ClientsComponents/{ClientesCard,ItemListClients,ListClients}.tsx`,
   `features/InventaryComponents/ui/ConfirmDialog.tsx`,
   `features/proveedores/{CategoriesColumn,Foto}.tsx`, `shared/ui/Carousel.tsx` (~700 líneas).
5. **Frontend, exportaciones sin uso**: `statsApis.ts` (seis funciones, sustituidas por
   `statsQueries`), `useAjustarLote`, `useHistoricoIncompleto`, `makePairCode`, `LicenseInfo`.
6. **Worker**: `rangoSchema`, `deleteDetalleSchema`,
   `productoPasaCocina`, y los tipos `ActivateRequest`/`StatusResponse` de `shared.ts`.
7. **`@tpv/database/src/index.ts`**: exporta `{}` con un comentario que ya no es cierto («el TPV…
   no usa la nube para datos»). El paquete sólo existe por la carpeta de migraciones.
8. **`#[allow(dead_code)]` que ya no aplican**: `Sesion::id_trabajador` («hoy nadie lo lee») se lee
   desde REV-17; `exists_by_id` en `venta_rapida.rs` sí es muerto.
9. Listas de módulos comentadas en `tpv-domain/src/lib.rs` y `tpv-contracts/src/lib.rs`
   («se irán añadiendo… // pub mod mesas;»): la migración terminó.

Para que no vuelva a acumularse: `knip` para el monorepo TS (detecta ficheros, exportaciones y
dependencias sin uso, entiende workspaces de pnpm) y `cargo-machete` para Rust, los dos en CI en
modo informativo como `check-contract-coverage.mjs`.

---

## 18. Documentación desfasada

Comentarios y docs que dicen algo que el código ya no hace. Los dos primeros están **dentro de
`0001_inicial.sql`**: corregirlos después del lanzamiento cambiaría el hash de una migración
congelada, así que es ahora o nunca.

| Dónde | Qué dice | Qué pasa de verdad |
|---|---|---|
| `0001_inicial.sql` §10 (línea ~970) | `_Sync_Applied_Ops` «creada por `init_sync_tables` en `db.rs`, fuera de las migraciones» | Está en §16 del propio `0001` |
| CLAUDE.md §10 (tabla) | `_Jobs_State` «tabla creada en `db.rs`» | En `0001` §16 |
| CLAUDE.md §9 (tabla de bootstrap) | `_Backfill_Historico` «creada en `infra-sqlite/src/db.rs`» | En `0001` §16 |
| `recovery.rs:365-369` | La PII del personal no vuelve con el volcado | Sí vuelve (CLAUDE.md §9, corregido el 02/09) |
| `reconciliacion.rs` (`SQL_CLIENTES`) | «Redondeado a 2 decimales, como los incrementos» | El dinero es entero desde ARQ-01 |
| `tpv-infra-sqlite/src/lib.rs:39` | Migraciones con `PRAGMA user_version` | Tabla `_migrations` con hash |
| `mesas.rs:1-4` | «las creaciones usan autoincrement local (`last_insert_rowid`)» | UUIDv7 |
| `reservas.rs` (`ReservaValidada`), `clientes.rs` (`NuevoCliente`), `proveedores.rs` | «id = None ⇒ autoincrement / siguiente ID libre» | UUIDv7 |
| `inventario.rs` (`LoteNuevo::validar`) | «Fecha_Entrada… la BD la fija a `now` por defecto» | El esquema no tiene `DEFAULT` de hora (CFG-04) |
| `verifactu.rs:3236` | «La fila la crea `init_sync_tables`» | La siembra el `0001` |
| `mesas.rs:2032-2041` | El reintento del `INSERT INTO Pagos` cubre «FK inexistente» | `try_exec` sólo devuelve `false` con «no such column» (RI-32) |
| `vite.config.ts` | El `release` debe coincidir con el de `main.rs` | Se toma de `package.json`, que no se sube de versión (RI-24) |
| `packages/database/src/index.ts` | «Esquema Drizzle… cuando se reactive la capa cloud» | La nube está activa y el esquema son los `.sql` |
| `lib.rs` (`Sesion`) | `id_trabajador`: «hoy nadie lo lee» | Lo lee el cobro de venta rápida (REV-17) |
| `secret_store.rs:12` | El `Context` de Android sale de `ndk_context` | Sale de `ActivityThread.currentApplication()`; el propio fichero lo explica en la línea 78 (RI-75) |
| `docs/android/COMPILAR_ANDROID.md:359-363` | La Main sólo abre el WebSocket «en modo online», y arranca en `offline` | No hay ese ajuste desde SYNC-17 |
| `tests/contract/README.md` | «63/67 comandos y 61/61 lecturas» | 63/66 y 64/64 (RI-79) |
| `Cuentas.tsx:93` | «jsPDF sólo lleva WinAnsi» | Los PDF los hace pdf-lib, y WinAnsi incluye `ñ` y `€` (RI-82) |

---

## 19. Tecnologías y librerías

Propuestas de cambio o de incorporación, con el porqué. Ninguna es urgente; están ordenadas por
relación beneficio/esfuerzo.

| Propuesta | Para qué | Esfuerzo |
|---|---|---|
| **`strum`** | Genera `TODOS`, `wire()` y `from_code` de `ErrorCode` y los enums de estado (RI-48) | Bajo |
| **WebCrypto Ed25519** en el worker | Sustituye `@noble/ed25519`: nativo, más rápido, una dependencia menos (RI-44) | Bajo |
| **`knip`** (TS) y **`cargo-machete`** (Rust) en CI | Código y dependencias sin uso (RI-22, RI-49) | Bajo |
| **React Router `lazy`** | División del bundle por rutas (RI-23) | Bajo |
| **`tauri-specta`** ([RI-87](#ri-87), decidido adoptarlo) | Genera funciones TS **tipadas por comando** (nombre, argumentos y retorno) desde las firmas de Rust. Es lo que habría impedido que se colaran euros en los campos de céntimos, cierra de raíz el hueco que hoy cubre `check-comandos-tauri.mjs` y la trampa documentada en §11-bis («argumentos planos vs `{ args }`… un `Option` llega como `None`»), y sustituye los `*Apis.ts` escritos a mano. Convive con los DTO actuales si se deriva `specta::Type` junto a `TS` | Medio |
| **Workers RPC** (DO moderno) | Quita el HMAC interno y tipa las llamadas al DO (RI-45) | Medio |
| **`zod` 4** | Validación bastante más rápida y más ligera en el worker (CPU facturable). `@hono/zod-validator` ya la soporta. Revisar la API de `z.coerce` y los mensajes | Medio |
| **`rusqlite`** en lugar de **`libsql`** (evaluar) | En la Main sólo se usa SQLite local (`features = ["core"]`). `rusqlite` es la opción madura: transacciones RAII (`conn.transaction()` hace rollback al soltarse, RI-32), caché de sentencias preparadas (`prepare_cached`; hoy cada consulta se prepara de nuevo), API de backup en caliente, y ninguna de las rarezas documentadas (el crash nativo al crear muchas bases, la API async que bloquea, RI-16). Con un hilo propio para el escritor encaja con el diseño de escritor único. Coste: reescribir `db.rs`/`mapping.rs` y adaptar los repositorios (los `Reader`/`Writer` ya aíslan buena parte). Merece una prueba de concepto sobre un repositorio antes de decidir | Alto |
| **Mantenimiento**: `thiserror` 2, `rand` 0.9, `keyring` 3, `@vitejs/plugin-react` 5, TypeScript alineado entre app (`~5.8`) y worker (`^5.9`) | Mantenerse dentro de las versiones soportadas; Dependabot ya abre los PR menores | Bajo |
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
- **Documentación desfasada.** En `COMPILAR_ANDROID.md`, el «gotcha» de la bitácora del 26/07
  (líneas 359-363) dice que la Main sólo abre el WebSocket «en modo online» y que arranca en
  `offline`. Desde SYNC-17 no hay ese ajuste. Y la cabecera de `secret_store.rs`
  ([`:12`](../../crates/tpv-infra-licensing/src/secret_store.rs#L12)) sigue diciendo que el
  `Context` sale de `ndk_context`, cuando el propio fichero explica más abajo
  ([`:78`](../../crates/tpv-infra-licensing/src/secret_store.rs#L78)) que no.

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
### RI-79 🔵 · Cobertura del harness: una exclusión obsoleta, un motivo que no se sostiene y cifras viejas

**Dónde:** [`tests/contract/cobertura.json`](../../tests/contract/cobertura.json) y
[`tests/contract/README.md`](../../tests/contract/README.md).

- `node scripts/check-contract-coverage.mjs` avisa de **«Exclusiones obsoletas:
  login.completeInitialSetup»**: el comando se retiró con REV-06. Hay que quitar la entrada.
- `trabajadores.setPredeterminadoDesdeSemana` se excluye con «mismo motivo que copySemana: los ID
  nuevos son asimétricos». Pero `copySemana` **sí** tiene caso (`casos/horarios/copiar_semana.json`),
  con la técnica de «snapshot con JOIN» que el README documenta precisamente para los ID que genera
  cada lado. Esa misma técnica sirve para este.
- El README dice «63/67 comandos y 61/61 lecturas». El script dice hoy 63/66 y 64/64.

**El E2E**, por completar: se ha mirado por encima (es un test, no código de producto). Lo que
afecta a esta revisión está en RI-71, donde un paso de «añadir, quitar con −, recargar» habría
cazado el fallo.

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
**ejecutado** nada en Android ni en Windows 7: lo marcado «a verificar» en RI-74, RI-76 y RI-80 hay
que comprobarlo en el emulador, en la máquina virtual o en una pantalla táctil.

**Lo que no se ha podido comprobar desde el repo**, y está marcado como tal: si el binding de correo
admite `Reply-To` (RI-60).

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
