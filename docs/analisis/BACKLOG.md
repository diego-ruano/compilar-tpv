# Backlog de hallazgos aplazados (resolver más adelante)

> Dos cosas distintas en un mismo fichero:
>
> 1. **[Auditoría previa al piloto (2026-09-02)](#auditoría-previa-al-piloto-2026-09-02)** — hallazgos
>    **nuevos y sin decidir**, de un repaso completo hecho justo antes de probar en un bar real. No
>    están pospuestos: están esperando decisión.
> 2. **El resto del fichero** — hallazgos analizados y **conscientemente pospuestos**, cada uno con su
>    porqué y su fecha. Esos ya tienen decisión tomada.

---

## Auditoría previa al piloto (2026-09-02)

> **Contexto:** repaso completo del repo (crates, frontend, worker, esquema, CI, docs) con una
> pregunta concreta: *¿qué falta para meter esto en un bar de verdad?* Lo que salió **no** es
> deuda de ingeniería —esa parte está bien cubierta: 491 tests de Rust, 174 del worker, harness de
> contrato al 100 % en lecturas, anti-drift de migraciones, scrubbing de PII en telemetría—. Es
> cumplimiento legal, control interno del dinero, y el salto de "funciona" a "se instala y alguien
> lo mantiene".
>
> Severidad: 🔴 bloqueante · 🟠 alta · 🟡 media · 🔵 baja
>
> **Orden sugerido.** Antes de entrar en un bar: CUENTA-07, SEC-01, SYNC-19. Antes de cobrar por
> ello: FISCAL-01, FISCAL-02, LEGAL-01, VENTA-01, INFRA-02. En paralelo y barato: TEST-01, OPS-02.

| ID | Sev | Hallazgo | Estado |
|----|-----|----------|--------|
| FISCAL-01 | 🔴 | **No hay nada de Veri*factu / RD 1007/2023.** | Sin empezar |
| FISCAL-02 | 🟠 | **No se puede emitir factura completa con el NIF del cliente.** | Sin empezar |
| CUENTA-07 | 🔴 | **Anular un cobro borra la fila, y eso deja ciego al arqueo.** | Sin empezar |
| SEC-01 | 🟠 | **Los permisos por rol son sólo de UI: ningún comando los comprueba.** | Sin empezar |
| SYNC-19 | 🟠 | **El rescate desde la nube caduca por número de filas (~3 meses de uso).** | Sin empezar |
| DB-14 | 🟡 | **No hay retención ni archivado de datos de negocio.** | Sin empezar |
| VENTA-01 | 🟠 | **No existen descuentos, invitaciones, propinas ni devoluciones.** | Sin empezar |
| LEGAL-01 | 🟠 | **RGPD: falta el papeleo de encargado del tratamiento.** | Sin empezar |
| INFRA-02 | 🟡 | **El instalador no va firmado (Authenticode).** | Aceptado a sabiendas |
| INFRA-03 | 🟡 | **Las imágenes del Handy salen por una URL `r2.dev`.** | Decidido: dominio propio |
| OPS-01 | 🟠 | **Cero documentación de usuario y cero onboarding.** | Sin empezar |
| OPS-02 | 🟡 | **«Contacta con soporte» sin canal ni forma de exportar un diagnóstico.** | Sin empezar |
| TEST-01 | 🟡 | **43k líneas de frontend sin un solo test de componente ni E2E.** | Sin empezar |
| SEC-02 | 🔵 | **`LICENSE_STORE_KEY` es un secreto global sin rotación ni custodia.** | Sin empezar |
| INFRA-04 | 🔵 | **No hay linter en ningún lenguaje** (ni ESLint, ni clippy, ni fmt). | Baja prioridad |

### FISCAL-01 🔴 · Veri*factu / RD 1007/2023

Grep en todo el repo: cero referencias a Verifactu, TicketBAI o AEAT. Y
[`0001_inicial.sql:541`](../../packages/database/migrations/0001_inicial.sql#L541) dice que la tabla
`Facturas` se retiró por no usarse.

Un TPV que emite facturas simplificadas en España es un **SIF** (Sistema Informático de Facturación).
Del lado del software eso implica registros de facturación **encadenados por huella/hash**,
**inalterables**, con **QR** y la mención correspondiente, más una **declaración responsable del
productor**. ⚠️ **Los plazos concretos hay que confirmarlos con un asesor** — pero el fondo no
depende de la fecha.

**Por qué va el primero pese a ser el más caro:** es estructural. Registros inmutables y encadenados
se diseñan al principio. Montarlos encima de un esquema donde los cobros se borran (CUENTA-07) es
rehacer el módulo de ventas, y hacerlo con clientes dentro cuesta otro orden de magnitud.

### FISCAL-02 🟠 · Factura completa con NIF del cliente

`Business_Settings` guarda el CIF **del negocio** y nada más. No hay forma de emitir una factura con
los datos fiscales del **cliente**, que es lo que pide cualquier comida de empresa. Encaja con
FISCAL-01 y conviene diseñarlos juntos, no uno detrás de otro.

### CUENTA-07 🔴 · Anular un cobro borra la fila

[`cuentas.rs:491`](../../crates/tpv-infra-sqlite/src/cuentas.rs#L491) hace `DELETE`. El propio test lo
dice: *"la fila desaparece"*. `Comandas.Estado` sólo admite `'Abierta'|'Pagada'` — no existe
`'ANULADA'`. No hay tabla de auditoría de dinero (de stock sí: `Movimientos_Stock`).

**El agujero:** el cierre de caja calcula `esperado = fondo + cobros en efectivo`
([`cierre_caja.rs:78`](../../crates/tpv-domain/src/cierre_caja.rs#L78)). Si alguien cobra 40 € en
efectivo, se los queda y anula el cobro, **el esperado baja 40 € y el arqueo cuadra perfecto**. El
único control de caja que tiene el diseño es ciego justo ante la forma más común de sisa en un bar.

**Arreglo:** soft-delete (`Estado='ANULADA'` + quién, cuándo y motivo), `esperado` sobre cobros no
anulados, y las anulaciones como línea aparte del arqueo. Es además exactamente lo que FISCAL-01 va
a exigir, así que se hace **una vez** y sirve para las dos cosas.

### SEC-01 🟠 · Los permisos son sólo de UI

[`App.tsx:107`](../../apps/tpv-main/src/app/App.tsx#L107) bloquea la ruta `/cuentas` a los no
Administrador y la NavBar esconde entradas. Pero **ningún comando Tauri comprueba el rol** —
verificado sobre todo `src-tauri/src/commands/`. La regla vive donde el usuario está sentado.

Es el multiplicador de CUENTA-07: no basta con dejar rastro de una anulación si cualquiera puede
provocarla. El gate debe estar en el caso de uso, no en el router.

### SYNC-19 🟠 · El bootstrap caduca por filas

[`sync.routes.ts:139`](../../apps/cloud-worker-licensing/src/domains/sync/sync.routes.ts#L139):
`BOOTSTRAP_MAX_FILAS = 300_000`. Un bar con ~200 tickets/día genera del orden de 3-4k filas/día
sumando `Detalle_Comanda`, `Pagos`, `Pago_Detalles`, `Lote_Consumos` y `Movimientos_Stock`. Eso son
**unos 3 meses** hasta cruzar el tope.

**Lo que lo hace grave es cuándo falla:** un 413 justo en el momento en que el cliente ha perdido su
`data.db`, y CLAUDE.md define la nube como *"la única forma de volver a operar"*. Encima
`BootstrapTooLarge` existe en [`errors.rs:125`](../../crates/tpv-contracts/src/errors.rs#L125) pero
**no se usa en ninguna parte del frontend**: el usuario vería un error genérico.

**Pendiente de decidir:** paginar el volcado (rompe la foto coherente en una transacción, que es lo
que hoy garantiza el `Seq` exacto — hay que pensarlo), o volcar sólo a partir de una fecha de corte,
o atacar la causa por DB-14. Como mínimo, mientras tanto: mensaje explícito en la pantalla de
recuperación y un aviso proactivo al acercarse al tope.

### DB-14 🟡 · Sin retención ni archivado

Nada purga `Comandas`, `Detalle_Comanda`, `Pagos`, `Movimientos_Stock` ni `Notificaciones` (las
notificaciones sólo se borran de una en una). `purga_sync` limpia el andamiaje de replicación, no los
datos de negocio. Esto es lo que alimenta SYNC-19, y además engorda las 7 copias diarias de
`VACUUM INTO`, que son copias **completas**.

Ojo al resolverlo: archivar ventas choca de frente con FISCAL-01 (los registros de facturación no se
pueden borrar). Lo que se archive tiene que ser lo que **no** sea registro fiscal.

### VENTA-01 🟠 · Faltan descuentos, invitaciones, propinas y devoluciones

Verificado por grep: cero apariciones en sentido de venta. Los precios salen del catálogo y no son
editables por línea. Hoy la única forma de invitar una ronda es **borrar líneas**, que destruye el
registro — y volverá a chocar con FISCAL-01.

Un bar pide descuento e invitación la primera semana. La devolución/abono, en cuanto alguien pague
de más.

### LEGAL-01 🟠 · RGPD

Guardas datos de clientes (nombre, teléfono, email, notas) y PII de personal, y los replicas a tu
nube: eres **encargado del tratamiento**. Falta el contrato de encargado, la política de privacidad,
el ejercicio de derechos (exportar/borrar un cliente) y la política de retención.

Y ojo al matiz que se aclaró el 2026-09-02 (ver TRAB-03 en CLAUDE.md): el cifrado de la PII del
personal **no** la pone fuera de tu alcance. El texto cifrado está en Turso y la DEK en el
control-plane; tienes las dos mitades. Eso hay que declararlo, no esconderlo.

### INFRA-02 🟡 · Instalador sin firmar — *aceptado a sabiendas*

[`tauri.conf.json`](../../apps/tpv-main/src-tauri/tauri.conf.json) empaqueta NSIS sin certificado
Authenticode. La firma ed25519 del updater protege las **actualizaciones**, no la primera
instalación.

**Decisión (2026-09-02): se acepta de momento** — cuesta dinero y en las pruebas reales SmartScreen
avisa pero deja instalar por «Más información → Ejecutar de todas formas», y la app funciona.
Pendiente de comprar cuando haya ingresos. Azure Trusted Signing (~10 $/mes) evita el token hardware
de un certificado EV.

### INFRA-03 🟡 · Imágenes por `r2.dev` — *decidido: dominio propio*

El Handy carga cada imagen de `pub-6814….r2.dev`
([`imageUrl.ts:31`](../../apps/tpv-main/src/shared/lib/imageUrl.ts#L31)). Cloudflare documenta esas
URLs como limitadas y no destinadas a producción. **Decisión (2026-09-02): pasar a un subdominio
propio.** Al hacerlo hay que tocar **tres** sitios, no uno:

1. `CDN_IMAGES_BASE` en `imageUrl.ts`.
2. `csp` **y** `devCsp` en `tauri.conf.json` (`img-src`) — si sólo se toca una, funciona en dev y
   falla en el build.
3. `docs/android/COMPILAR_ANDROID.md`, que documenta ese host.

De paso: `R2_PUBLIC_BASE_URL` en
[`wrangler.json:60`](../../apps/cloud-worker-licensing/wrangler.json#L60) apunta a un bucket
**distinto** y **no la lee nadie** en todo `src/`. Config muerta: borrarla o cablearla.

### OPS-01 🟠 · Sin documentación de usuario

Sin manual, sin onboarding, sin ayuda en la app, sin README en la raíz del repo. Instalas en un bar y
la formación eres tú, por teléfono, cada vez.

### OPS-02 🟡 · Soporte sin canal ni diagnóstico exportable

[`Conectividad.tsx:244`](../../apps/tpv-main/src/features/configuracion/sections/Conectividad.tsx#L244)
dice *"contacta con soporte"* sin definir cuál. Y hay telemetría muy buena (Sentry + Axiom +
scrubbing + fichero local rotado) pero **ningún botón** para sacar un paquete de diagnóstico — que es
justo lo que hace falta cuando el bar no tiene internet y la telemetría no ha salido.

### TEST-01 🟡 · Sin E2E ni tests de componente

Rust 491, worker 174, frontend 83 — pero los 83 son **lógica pura**, y el razonamiento de
[`vitest.config.ts`](../../apps/tpv-main/vitest.config.ts) para no montar React es defendible. El
problema es lo que queda fuera: los tres ficheros más grandes del repo son el flujo de venta
(`Cuentas.tsx` 2127, `VentaRapida.tsx` 2019, `MesaComandaModal.tsx` 1591) y no los toca ningún test.

**No hace falta cubrirlos.** Hace falta **uno** que recorra la app real: abrir mesa → añadir líneas →
cobrar → imprimir → cerrar caja. Hoy la única garantía de ese camino es haberlo probado a mano.

### SEC-02 🔵 · `LICENSE_STORE_KEY` es global

Cifra en reposo las DEK de **todos** los tenants (`tenants.field_dek`). Perderla deja la PII de
todo el mundo irrecuperable; filtrarla la expone toda. No hay rotación ni custodia documentadas.
Riesgo bajo hoy (un tenant), crece con cada cliente.

### INFRA-04 🔵 · Sin linter — *baja prioridad*

No hay ESLint/Biome/Prettier, ni `cargo clippy`, ni `cargo fmt --check` en CI. `pnpm lint` es
`tsc --noEmit` en tres packages y **la app ni siquiera entra**.

**Decisión (2026-09-02): no es prioridad.** Anotado el matiz por si se retoma: de estos, el único que
aporta señal *nueva* es **clippy**, que no es un formateador — avisa de cosas que compilan y están
mal (un `await` dentro de un lock, un `clone()` en un bucle caliente, un `match` que se traga un
`Err`). ESLint y fmt, con `tsc` estricto ya en verde, son sobre todo estética.

---

## Hallazgos conscientemente pospuestos

> Estos ya tienen decisión tomada: se analizaron, se entendió el riesgo y se decidió esperar. Cada
> uno lleva su fecha y su porqué. **Revalidados el 2026-09-02** contra el código: los cuatro siguen
> vigentes (FABLE-B: `serverError` sigue serializando `details`; FABLE-E: el device-proof sigue sin
> nonce, sólo la ventana de ±2 min).

| ID | Sev | Motivo del aplazamiento | Ficha |
|----|-----|-------------------------|-------|
| LOGIN-04 | 🔵 | **PBKDF2 a 600k (OWASP): BLOQUEADO por el runtime, no por el plan.** ⚠️ Corregido 2026-08-09: el tope de 100k **no** viene del plan Free sino de `crypto.subtle` de Cloudflare Workers, que **rechaza** PBKDF2 con más de 100.000 iteraciones (ver la nota en `crates/tpv-domain/src/login.rs:11-15`). Como el worker **verifica** el hash en cada login/fichaje de Handy, 100k es el techo común de ambos runtimes; tener el plan de pago **no lo desbloquea**. Además, con un PIN de 4 dígitos (10⁴) pasar de 100k a 600k solo multiplica por 6 el coste del crackeo offline: irrelevante frente al tamaño del espacio de claves. **Lo que sí movería la aguja** (por orden): un **pepper** fuera de la BD (hace inútil el hash replicado), ampliar el espacio de PIN, o dejar de replicar `Password_Hash` (descartado: la Handy necesita que el worker verifique). El anti-brute-force online ya está resuelto por el lockout escalado de LOGIN-01. **Decisión (2026-08-09): aplazado a cambios futuros.** Riesgo bajo: para explotarlo hay que tener antes acceso de lectura a la BD del tenant en Turso, que es un escenario raro. Se retoma si algún día hay volumen de clientes que lo justifique. | [login.md](dominios/login.md) |
| INFRA-01 | 🟡 | **No hay entorno de staging: se prueba contra producción.** Hoy existe un único worker (`tpv-api`) con una sola BD de control y los binarios apuntan a él por constante. No hay dónde validar un cambio de worker, de esquema o de licencias antes de que lo vea un cliente real. Ver §[Entorno de staging](#entorno-de-staging-infra-01--pendiente-completo). **Aplazado a cuando el SaaS esté más asentado** (decisión 2026-08-09): es un montaje completo, no un ajuste. | §Entorno de staging |
| FABLE-E | 🔵 | **Nonce anti-repetición en el device-proof.** La firma ya cubre el cuerpo (hecho el 2026-08-15), pero no lleva número de serie: dentro de la ventana de 2 min una petición firmada podría **reproducirse tal cual**. **Decisión: aplazado.** Para reproducirla hay que haber capturado el tráfico (va por TLS) y las escrituras son idempotentes por `Op_Id`, así que repetir una no duplica nada. **Lo que hace falta cuando se retome:** un almacén de nonces vistos, compartido — los isolates del worker no comparten memoria, así que un `Set` en RAM no vale. Opciones: **KV** (barato, pero eventualmente consistente: un replay en otro colo podría no ver el nonce todavía → mal encaje), **Durable Object** (consistente de verdad, ya existe `TenantHub`, pero mete un salto por petición) o una **tabla en Turso** con TTL (un INSERT por petición). Yo iría al DO si algún día pesa. | [auditoria-fable.md](../../auditoria-fable.md) |
| FABLE-B | 🟠 | **Fuga de stack traces al cliente.** `serverError(req, code, details)` serializa `details` en el cuerpo JSON, y varios handlers de pairing le pasan `{ message, name, stack }` del `Error` ([response.ts:48-63](../../apps/cloud-worker-licensing/src/server/utils/response.ts#L48-L63)). Cualquiera que llame a la API recibe la traza y el texto crudo del motor de Turso. **Decisión (2026-08-14): aplazado**, no hay clientes en producción todavía. **Cuando se haga, el cambio es en tres partes y hay que hacer las tres:** (1) `serverError` deja de serializar `details` y devuelve `{ ok, error, trace_id }`; (2) en cada `catch`, `console.error(trace_id, e?.stack)` + `Sentry.captureException` — hoy solo 9 ficheros loguean, así que sin esto **sí** se perdería información al quitar el `details`; (3) opcional pero recomendable, seguir devolviendo `details` cuando `env.ENVIRONMENT !== "prod"` (requiere añadir `ENVIRONMENT` a los `vars` de `wrangler.json`, hoy ausente). El stack se sigue viendo en `wrangler tail`, Sentry y Axiom. La forma de la respuesta ya la fijó el catálogo de códigos (`{ ok, code, error }`): lo que queda aquí es **dejar de serializar `details`**. | [auditoria-fable.md](../../auditoria-fable.md) |

> **Los dos harness de contrato están terminados y sin pendientes** (escritura y lectura, esta al
> 100 % sin exclusiones). Cerraron CLI-05 y los `-parity`, y al ejecutarse sacaron trece divergencias
> reales, todas corregidas. El detalle vive donde toca —
> [tests/contract/README.md](../../tests/contract/README.md) y
> [00-indice.md](00-indice.md#nota-importante-sobre-el-recuento)— y no en este backlog, que es de
> cosas **pendientes**.

---

## Unificación de la doble implementación Main↔worker

> **Problema (transversal):** la lógica de hablar con la base de datos vive dos veces — Rust (Main) y
> TS (worker)— y tiene que ser **idéntica en comportamiento**, pero se desincroniza a mano. Las
> **escrituras** las sujeta el harness de contrato y las **lecturas** su hermano (punto 1); lo que
> sigue expuesto es lo que aún no tiene caso, que el script de cobertura lista en CI.
> Opciones, de menos a más ambiciosas:

1. **Tests de contrato (golden) — barato, primer paso. ✅ HECHO (escrituras y lecturas).** Con el mismo
   estado sembrado, comprobar que la implementación de Rust y la del worker se comportan igual. No
   elimina la duplicación, pero convierte cada divergencia futura en un **test rojo**. Máximo retorno
   por esfuerzo; sin cambio de arquitectura.

   > **Terminado (2026-08-24), los dos.** 66 casos sobre 63 comandos y 65 sobre las 61 lecturas, CI
   > corre las cuatro suites, y `scripts/check-contract-coverage.mjs` avisa de lo que se quede sin
   > caso. Cómo funciona y por qué cada uno compara lo que compara (efecto vs. valor+orden), en
   > [tests/contract/README.md](../../tests/contract/README.md).
2. **SQL en una única fuente compartida — medio.** Extraer los **textos SQL** a un activo neutro
   (ficheros `.sql` con nombres, o un JSON de sentencias con placeholders) consumido por Rust
   (`include_str!`) y TS (`import`). La mayoría de divergencias reales son en el texto del SQL y las
   listas de columnas; esto las elimina. La orquestación (qué sentencias, orden, valores calculados)
   seguiría duplicada.
3. **Un solo cerebro vía WASM — caro, arreglo definitivo. ⏳ FUTURO (post-lanzamiento).** Compilar la
   construcción de comandos (parte de `tpv-application` / los command builders) a **WebAssembly** e
   importarla en el Worker (Cloudflare soporta WASM). Main y Handy ejecutarían **el mismo código**;
   las lecturas (planes, FEFO) se inyectan como *host functions*. Encaja con el diseño hexagonal (los
   puertos ya abstraen el IO). Proyecto grande, pero elimina la duplicación en la raíz.

   > **Se puede hacer más tarde, incluso con clientes en producción.** Es un refactor **solo del
   > worker** (lado servidor): no toca el esquema, no migra datos, no obliga a actualizar las apps (la
   > Main ya corre el Rust nativo). Es un deploy de worker con rollback como cualquier otro. Y el
   > harness (opción 1) es **la red que lo hace seguro**: los tests de contrato demuestran, antes de
   > desplegar, que el WASM deja el mismo efecto que los builders de TS. Por eso el orden correcto es
   > **harness ahora → WASM después** si la duplicación sigue doliendo; el harness no es trabajo tirado.
4. **La Handy siempre delega en una Main — decisión de producto.** La Handy no construye SQL: manda
   una **intención** y la Main (única escritora) genera las sentencias. Elimina la necesidad de que
   el worker construya SQL, pero **acopla la Handy a que haya una Main viva** (el mecanismo de
   *freeze* / `main_offline` ya lo asume en parte). Cambia la historia offline de la Handy.
5. **Codegen desde una spec — medio/alto.** Definir cada comando **una vez** en un DSL/spec (macro
   Rust o esquema neutro) y **generar** ambos builders. Añadir un comando pasa a ser una entrada de
   spec. Riesgo: el generador se vuelve su propia carga de mantenimiento y tiene límites de
   expresividad.

**Recomendación (fase de desarrollo):** **(1) en marcha** como red de seguridad barata (ver arriba) →
**(2)** para matar la clase de divergencia más frecuente → **(3) WASM** como objetivo a largo plazo
(post-lanzamiento) si la duplicación sigue doliendo; se puede hacer con clientes en producción y el
harness lo blinda. **(4)** es más decisión de producto (¿puede el negocio operar Handy sin Main?) que
refactor.

---

## Entorno de staging (INFRA-01) — pendiente completo

> **Decisión (2026-08-09): se deja para cuando el SaaS esté más asentado.** No es "añadir una
> variable": es duplicar la infraestructura de la nube y hacer configurable en compilación algo que
> hoy está clavado en el binario. Se documenta ahora para no volver a investigarlo desde cero.

**El problema:** hoy hay **un** worker (`tpv-api`), **una** BD de control y **un** conjunto de
secretos. Los clientes apuntan ahí por constante compilada. Cualquier prueba de un cambio del
worker, del esquema de la nube o del flujo de licencias se hace **contra producción**, con datos de
clientes reales delante. También significa que un error de un desarrollador probando entra en Sentry
etiquetado como `prod` y es indistinguible de uno de un bar.

**Lo que hay que montar, por orden de dependencia:**

1. **Worker aparte.** Un bloque `env.staging` en `wrangler.json` con su propio `name`
   (p. ej. `tpv-api-staging`) y sus `vars` (`ENVIRONMENT: "staging"` + los `TURSO_*`, `EMAIL_*` y
   `R2_PUBLIC_BASE_URL` propios). Se despliega con `wrangler deploy --env staging`. Al ser otro
   worker, su **Durable Object `TenantHub` es otro namespace**: no comparte estado con producción.
2. **Secretos propios.** Los secretos son **por entorno**: hay que repetir `wrangler secret put X
   --env staging` para todos (`SENTRY_DSN`, `AXIOM_TOKEN`, `LICENSE_JWT_SECRET`,
   `LICENSE_STORE_KEY`, `LICENSE_SIGNING_PRIVATE_KEY`, `ADMIN_API_TOKEN`, `PAIR_PEPPER`,
   `STRIPE_*`, `RELEASE_ADMIN_TOKEN`, `TURSO_*`).
3. **Turso aparte.** Otra BD de control (licencias, tenants) y otras BDs de tenant. **Es el punto
   crítico:** si staging comparte Turso con producción, escribe sobre datos de clientes reales y no
   sirve de nada.
4. **R2 aparte.** Otro bucket de imágenes (o al menos otro prefijo) con su `R2_PUBLIC_BASE_URL`.
5. **Stripe en modo test.** Claves `sk_test_`, un endpoint de webhook apuntando al worker de
   staging con su propio `whsec_`, y Prices de prueba con su `metadata.term_months`.
6. **Cliente compilable contra staging.** Esto es lo que hoy **no se puede hacer sin tocar código**:
   - `CLOUD_API_BASE` (`crates/tpv-infra-licensing/src/lib.rs:52`) y `CLOUD_WS_URL`
     (`apps/tpv-main/src/shared/lib/cloudApi.ts:20`) están **clavados** al host de producción. Hay
     que hacerlos configurables en compilación (patrón `option_env!`, como ya se hace con
     `TPV_SENTRY_DSN`) o por *feature* de Cargo.
   - `LICENSE_SIGNING_PUBLIC_KEY_B64` (misma `lib.rs`) es la clave pública **pineada**: un build de
     staging necesita la del par de staging, así que también tiene que ser configurable. Sin esto,
     un cliente de staging **no puede validar** licencias emitidas por el worker de staging.
7. **Etiqueta de entorno en el escritorio.** `tpv_telemetry::Environment` solo tiene `Dev` y `Prod`
   (`config.rs:21`, por `debug_assertions`). Añadir `Staging` y una forma de fijarlo en el build.
8. **Separación en observabilidad.** Con `ENVIRONMENT` bien puesto basta con **filtrar por el tag**
   en Sentry (mismo proyecto) y por campo en Axiom; o datasets separados si molesta el ruido.
9. **Canal de actualizaciones.** `app_releases` ya tiene columna `channel` (hoy siempre `stable`):
   un build de staging debería pedir su propio canal para no auto-actualizarse a producción.
10. **Correo contenido.** Staging **no puede** mandar pedidos a proveedores reales: o remitente y
    destinatarios de prueba, o un modo que no envíe.
11. **CI.** Un workflow que despliegue a staging al mergear en una rama, para que el entorno no
    dependa de que alguien lo despliegue a mano.

**Atajo intermedio, si algún día urge y no da tiempo a todo:** los puntos 1-4 (worker + secretos +
Turso + R2) ya permiten probar **el backend** de forma segura llamando a la API con `curl` o desde
el CLI de licencias, sin cliente de escritorio. Lo caro es el punto 6, que es lo que hace falta para
probar la **app** completa contra staging.

---

## Deuda de arquitectura transversal (T5) — refactor gradual post-lanzamiento

> **Decisión (responsable):** de momento se deja **como está**. Aunque no sea la forma óptima, el
> producto funciona y converge (la lógica duplicada se igualó a mano y está verificada). Se irá
> cambiando **poco a poco, sin prisa**, una vez el producto esté lanzado y estable. Fichas:
> [arquitectura-general.md](transversal/arquitectura-general.md) y §[Unificación de la doble
> implementación](#unificación-de-la-doble-implementación-mainworker) (arriba).

| ID | Sev | Qué falta | Cuándo |
|----|-----|-----------|--------|
| ARCH-01 | 🟠 | **Doble implementación** Main(Rust)/Handy(worker). Ya hay red por los dos lados y **sin huecos**: el harness de **escritura** (66 casos) más el guard de SQL replicable determinista, y el de **lectura** (65 casos, **61/61 lecturas, sin exclusiones**), montado el 2026-08-24, que al ejecutarse sacó **trece divergencias reales**, todas corregidas. Queda lo que sigue **excluido con motivo** del lado de escritura (`complete_initial_setup` y la ficha con PII) y, de fondo, una única fuente de generación de sentencias (WASM). Ver §Unificación. | Refactor gradual post-lanzamiento |

---

## Licenciamiento (T3) — revisar al fijar el modelo de precios

> **Decisión (responsable):** de momento se deja **como está**. El endurecimiento del licenciamiento
> se abordará **más adelante, cuando se decida el modelo de precios** (planes, activación, etc.), ya
> que el diseño concreto depende de eso. Ficha: [licensing-pairing.md](transversal/licensing-pairing.md).

| ID | Sev | Qué falta | Notas |
|----|-----|-----------|-------|
| LIC-02 | 🔵 | Sin **certificate pinning** del host de la API. | Prácticamente *moot* con LIC-01 resuelto: la firma pineada es más robusta que el pinning de transporte. Un MITM ya no puede falsificar el estado de licencia. |
| LIC-04 | 🔵 | Documentar el **modelo de amenaza** del gate (corre en cliente → evadible en última instancia). | Tarea de documentación. |

> **LIC-03** verificado como **no explotable** en pairing (todos los caminos firmados validan `ts` a
> 2 min; `fetch-token` con nonce de un solo uso). **LIC-05** (SMTP al keyring) quedó **moot**: DB-04
> eliminó el SMTP propio (correo por worker). **LIC-04** es documentar el modelo de amenaza del gate.

