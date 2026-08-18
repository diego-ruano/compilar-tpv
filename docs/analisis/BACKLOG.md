# Backlog de hallazgos aplazados (resolver más adelante)

> Hallazgos analizados y **conscientemente pospuestos** (no son bugs de cálculo pendientes, sino
> tareas de infra de tests o que dependen de decisiones/otros dominios). Se retoman en una iteración
> posterior. Cada uno sigue documentado en detalle en su ficha de dominio.

| ID | Sev | Motivo del aplazamiento | Ficha |
|----|-----|-------------------------|-------|
| VR-06 | 🟡 | **Contraste Main ↔ nube.** El chequeo local ya existe (INV-06, cerrado): cada copia cuadra consigo misma. Falta compararlas **entre sí** — hoy no lo hace nada, y hay divergencias que no dejan ningún rastro. **Aplazado (2026-08-18) con el plan escrito en la ficha**, que va en dos pasos y en este orden: (1) poder **reintentar las ops en cuarentena** (hoy se saltan para siempre y el panel no dice cuál es cada una), (2) el **contraste de sumas** por agregados. Al revés no sirve: sabrías que no cuadran y la única herramienta disponible sería la que borra la venta que la Main no llegó a aplicar. | [venta-rapida.md](dominios/venta-rapida.md) |
| STAT-06 | 🔵 | Paridad Main↔Handy: la lógica ya se igualó a mano; falta el **harness de tests de contrato** (infra de tests). | [estadisticas.md](dominios/estadisticas.md) |
| INV-07 | 🔵 | Doble implementación Rust/worker: lógica igualada a mano; falta el **harness de tests de contrato** (misma infra que STAT-06). | [inventario.md](dominios/inventario.md) |
| LOGIN-04 | 🔵 | **PBKDF2 a 600k (OWASP): BLOQUEADO por el runtime, no por el plan.** ⚠️ Corregido 2026-08-09: el tope de 100k **no** viene del plan Free sino de `crypto.subtle` de Cloudflare Workers, que **rechaza** PBKDF2 con más de 100.000 iteraciones (ver la nota en `crates/tpv-domain/src/login.rs:11-15`). Como el worker **verifica** el hash en cada login/fichaje de Handy, 100k es el techo común de ambos runtimes; tener el plan de pago **no lo desbloquea**. Además, con un PIN de 4 dígitos (10⁴) pasar de 100k a 600k solo multiplica por 6 el coste del crackeo offline: irrelevante frente al tamaño del espacio de claves. **Lo que sí movería la aguja** (por orden): un **pepper** fuera de la BD (hace inútil el hash replicado), ampliar el espacio de PIN, o dejar de replicar `Password_Hash` (descartado: la Handy necesita que el worker verifique). El anti-brute-force online ya está resuelto por el lockout escalado de LOGIN-01. **Decisión (2026-08-09): aplazado a cambios futuros.** Riesgo bajo: para explotarlo hay que tener antes acceso de lectura a la BD del tenant en Turso, que es un escenario raro. Se retoma si algún día hay volumen de clientes que lo justifique. | [login.md](dominios/login.md) |
| LOGIN-05 | 🔵 | Doble implementación login/verify Rust↔worker: falta **harness de tests de contrato** de todos los caminos (setup, login, punch). Misma infra que STAT-06/INV-07. | [login.md](dominios/login.md) |
| MESA-11 | 🟡 | Doble implementación Main (Rust) ↔ worker (TS) del dominio mesas: la lógica se iguala a mano y **diverge** (ya pasó con MESA-04/MESA-07). Falta el **harness de tests de contrato** y un plan de unificación (ver §[Unificación de la doble implementación](#unificación-de-la-doble-implementación-mainworker)). | [mesas.md](dominios/mesas.md) |
| MESA-14 | 🔵 | Componentes de UI monolíticos (`MesaComandaModal.tsx` ~70 KB, `KitchenBoard.tsx` ~18 KB): troceo en subcomponentes (ticket / panel de cobro / selector de productos) + hooks. **Pospuesto por prioridad**, no hay bug de negocio detrás. | [mesas.md](dominios/mesas.md) |
| SYNC-17 | 🟡 | **Conectividad automática (eliminar el interruptor online/offline).** Hoy la Main sólo abre el WS si el usuario activa "online" en Configuración → Conectividad (`useConnectionMode`, por defecto `offline`). Objetivo: que el modo sea un **estado derivado** del WebSocket (intentar siempre con `tpv` + licencia válida + identidad; el badge refleja el estado real) en vez de un ajuste manual. Pendiente decidir dónde vive el gate de licencia (hoy `set_connection_mode` lo valida en Rust; lo natural sería que `/v1/ws/ticket` sea la autoridad y el cliente simplemente reintente con backoff). Incluye dos arreglos de fiabilidad detectados: **timeout de pong** (hoy se envía `ping` pero no se verifica respuesta → un socket medio-muerto no se detecta) y **reconexión inmediata en la Main** ante `online`/`focus` (la Handy ya lo hace). Prerrequisito de coste ya resuelto: SYNC-16 (hibernación) — es ese cambio el que hace que la Main tenga el WS abierto toda la jornada. | [sync-tenanthub.md](transversal/sync-tenanthub.md) |
| INFRA-01 | 🟡 | **No hay entorno de staging: se prueba contra producción.** Hoy existe un único worker (`tpv-api`) con una sola BD de control y los binarios apuntan a él por constante. No hay dónde validar un cambio de worker, de esquema o de licencias antes de que lo vea un cliente real. Ver §[Entorno de staging](#entorno-de-staging-infra-01--pendiente-completo). **Aplazado a cuando el SaaS esté más asentado** (decisión 2026-08-09): es un montaje completo, no un ajuste. | §Entorno de staging |
| FABLE-E | 🔵 | **Nonce anti-repetición en el device-proof.** La firma ya cubre el cuerpo (hecho el 2026-08-15), pero no lleva número de serie: dentro de la ventana de 2 min una petición firmada podría **reproducirse tal cual**. **Decisión: aplazado.** Para reproducirla hay que haber capturado el tráfico (va por TLS) y las escrituras son idempotentes por `Op_Id`, así que repetir una no duplica nada. **Lo que hace falta cuando se retome:** un almacén de nonces vistos, compartido — los isolates del worker no comparten memoria, así que un `Set` en RAM no vale. Opciones: **KV** (barato, pero eventualmente consistente: un replay en otro colo podría no ver el nonce todavía → mal encaje), **Durable Object** (consistente de verdad, ya existe `TenantHub`, pero mete un salto por petición) o una **tabla en Turso** con TTL (un INSERT por petición). Yo iría al DO si algún día pesa. | [auditoria-fable.md](../../auditoria-fable.md) |
| FABLE-B | 🟠 | **Fuga de stack traces al cliente.** `serverError(req, code, details)` serializa `details` en el cuerpo JSON, y varios handlers de pairing le pasan `{ message, name, stack }` del `Error` ([response.ts:48-63](../../apps/cloud-worker-licensing/src/server/utils/response.ts#L48-L63)). Cualquiera que llame a la API recibe la traza y el texto crudo del motor de Turso. **Decisión (2026-08-14): aplazado**, no hay clientes en producción todavía. **Cuando se haga, el cambio es en tres partes y hay que hacer las tres:** (1) `serverError` deja de serializar `details` y devuelve `{ ok, error, trace_id }`; (2) en cada `catch`, `console.error(trace_id, e?.stack)` + `Sentry.captureException` — hoy solo 9 ficheros loguean, así que sin esto **sí** se perdería información al quitar el `details`; (3) opcional pero recomendable, seguir devolviendo `details` cuando `env.ENVIRONMENT !== "prod"` (requiere añadir `ENVIRONMENT` a los `vars` de `wrangler.json`, hoy ausente). El stack se sigue viendo en `wrangler tail`, Sentry y Axiom. La forma de la respuesta ya la fijó el catálogo de códigos (`{ ok, code, error }`): lo que queda aquí es **dejar de serializar `details`**. | [auditoria-fable.md](../../auditoria-fable.md) |

**Nota:** el harness de tests de contrato Rust↔worker cubriría de una vez STAT-06, INV-07, MESA-11,
LOGIN-05 y el resto de `-parity` (CONF-06, PROV-07, RES-07, TAR-04, TRAB-06, CLI-05, VR-05). Es una
tarea transversal de infraestructura de testing, no de un dominio. Ver
[00-indice.md](00-indice.md#nota-importante-sobre-el-recuento).

---

## Unificación de la doble implementación Main↔worker

> **Problema (transversal):** la lógica de construir las **sentencias replicables** vive dos veces —
> Rust (Main) y TS (worker)— y tiene que ser **idéntica en comportamiento** para que la replicación
> sea consistente, pero se desincroniza a mano. Afecta a **MESA-11, STAT-06, INV-07, LOGIN-05**.
> Opciones, de menos a más ambiciosas:

1. **Tests de contrato (SQL golden) — barato, primer paso.** Para cada comando, con los mismos
   inputs, comparar que el conjunto de sentencias + args que produce Rust y el que produce el worker
   son equivalentes (normalizando espacios; stubbeando UUIDs/timestamps). No elimina la duplicación,
   pero convierte cada divergencia futura en un **test rojo**. Máximo retorno por esfuerzo; sin
   cambio de arquitectura.

   > **Decisión (2026-08-14): aplazado**, hay trabajo más urgente por delante. Punto de partida
   > cuando se retome, para no volver a levantarlo desde cero:
   >
   > - **El lado Rust casi está**: hay ~209 tests en 40 módulos, pero todos prueban **un solo lado**.
   >   Lo que falta es serializar las sentencias del comando; el sobre del outbox **ya es** ese JSON.
   > - **El lado worker está a cero**: no hay tests ni *runner* instalado (los `*.test.ts` que
   >   aparecen en `apps/` son de `node_modules`). Montar **vitest** en `tpv-api` es el primer paso
   >   real de esta tarea, y sirve además para cualquier otro test del worker.
   > - Montaje: fixtures compartidos (`tests/contract/casos/*.json`) → cada lado emite su JSON de
   >   sentencias+args → comparador que normaliza espacios del SQL y stubea UUIDs/timestamps → job de
   >   CI que corre los dos.
   > - Empezar por **un solo comando** (el cobro de mesas, que ya divergió en MESA-04 y MESA-07) para
   >   validar el andamiaje; después cada dominio es solo añadir fixtures.
2. **SQL en una única fuente compartida — medio.** Extraer los **textos SQL** a un activo neutro
   (ficheros `.sql` con nombres, o un JSON de sentencias con placeholders) consumido por Rust
   (`include_str!`) y TS (`import`). La mayoría de divergencias reales son en el texto del SQL y las
   listas de columnas; esto las elimina. La orquestación (qué sentencias, orden, valores calculados)
   seguiría duplicada.
3. **Un solo cerebro vía WASM — caro, arreglo definitivo.** Compilar la construcción de comandos
   (parte de `tpv-application` / los command builders) a **WebAssembly** e importarla en el Worker
   (Cloudflare soporta WASM). Main y Handy ejecutarían **el mismo código**; las lecturas (planes,
   FEFO) se inyectan como *host functions*. Encaja con el diseño hexagonal (los puertos ya abstraen
   el IO). Proyecto grande, pero elimina la duplicación en la raíz.
4. **La Handy siempre delega en una Main — decisión de producto.** La Handy no construye SQL: manda
   una **intención** y la Main (única escritora) genera las sentencias. Elimina la necesidad de que
   el worker construya SQL, pero **acopla la Handy a que haya una Main viva** (el mecanismo de
   *freeze* / `main_offline` ya lo asume en parte). Cambia la historia offline de la Handy.
5. **Codegen desde una spec — medio/alto.** Definir cada comando **una vez** en un DSL/spec (macro
   Rust o esquema neutro) y **generar** ambos builders. Añadir un comando pasa a ser una entrada de
   spec. Riesgo: el generador se vuelve su propia carga de mantenimiento y tiene límites de
   expresividad.

**Recomendación (fase de desarrollo):** **(1)** ya como red de seguridad barata → **(2)** para matar
la clase de divergencia más frecuente → **(3) WASM** como objetivo a largo plazo si la duplicación
sigue doliendo. **(4)** es más decisión de producto (¿puede el negocio operar Handy sin Main?) que
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
| ARCH-01 | 🟠 | **Doble implementación** Main(Rust)/Handy(worker) de la lógica de escritura. Mitigada a mano; falta el **harness de tests de contrato** (SQL golden) y, a medio plazo, una única fuente de generación de sentencias. Es el paraguas de todos los `-parity` (MESA-11, VR-05, INV-07, STAT-06, LOGIN-05, CONF-06, PROV-07, RES-07, TAR-04, TRAB-06, CLI-05). Ver §Unificación. | Refactor gradual post-lanzamiento |

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

