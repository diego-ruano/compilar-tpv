# Backlog de hallazgos aplazados (resolver más adelante)

> Hallazgos analizados y **conscientemente pospuestos** (no son bugs de cálculo pendientes, sino
> tareas de infra de tests o que dependen de decisiones/otros dominios). Se retoman en una iteración
> posterior. Cada uno sigue documentado en detalle en su ficha de dominio.

| ID | Sev | Motivo del aplazamiento | Ficha |
|----|-----|-------------------------|-------|
| TRAB-03 | 🟡 | **PII sensible (DNI, IBAN, Nº Seg. Social) en claro y replicada a la nube (Turso).** Cifrado a nivel de campo y/o minimizar la replicación (¿la nube/Handy necesita esos datos?). Tarea de arquitectura/GDPR transversal (cruce con DB-04). Diferida a pase dedicado. | [trabajadores.md](dominios/trabajadores.md) |
| STAT-06 | 🔵 | Paridad Main↔Handy: la lógica ya se igualó a mano; falta el **harness de tests de contrato** (infra de tests). | [estadisticas.md](dominios/estadisticas.md) |
| INV-06 | 🔵 | Reconciliación de stock: la tabla `Movimientos_Stock` es su cimiento, pero la fórmula depende de **VR-06** (modelo de consumo, venta-rápida) y de decisiones de producto (dónde corre, qué alerta). | [inventario.md](dominios/inventario.md) |
| INV-07 | 🔵 | Doble implementación Rust/worker: lógica igualada a mano; falta el **harness de tests de contrato** (misma infra que STAT-06). | [inventario.md](dominios/inventario.md) |
| LOGIN-04 | 🔵 | **PBKDF2 a 600k (OWASP): BLOQUEADO por el runtime, no por el plan.** ⚠️ Corregido 2026-08-09: el tope de 100k **no** viene del plan Free sino de `crypto.subtle` de Cloudflare Workers, que **rechaza** PBKDF2 con más de 100.000 iteraciones (ver la nota en `crates/tpv-domain/src/login.rs:11-15`). Como el worker **verifica** el hash en cada login/fichaje de Handy, 100k es el techo común de ambos runtimes; tener el plan de pago **no lo desbloquea**. Además, con un PIN de 4 dígitos (10⁴) pasar de 100k a 600k solo multiplica por 6 el coste del crackeo offline: irrelevante frente al tamaño del espacio de claves. **Lo que sí movería la aguja** (por orden): un **pepper** fuera de la BD (hace inútil el hash replicado), ampliar el espacio de PIN, o dejar de replicar `Password_Hash` (descartado: la Handy necesita que el worker verifique). El anti-brute-force online ya está resuelto por el lockout escalado de LOGIN-01. **Decisión (2026-08-09): aplazado a cambios futuros.** Riesgo bajo: para explotarlo hay que tener antes acceso de lectura a la BD del tenant en Turso, que es un escenario raro. Se retoma si algún día hay volumen de clientes que lo justifique. | [login.md](dominios/login.md) |
| LOGIN-05 | 🔵 | Doble implementación login/verify Rust↔worker: falta **harness de tests de contrato** de todos los caminos (setup, login, punch). Misma infra que STAT-06/INV-07. | [login.md](dominios/login.md) |
| LIC-07 | 🟡 | **Stripe: reembolsos y chargebacks no revocan la licencia.** El webhook solo escucha `checkout.session.completed` y `checkout.session.async_payment_succeeded` (`stripe.routes.ts:53`), así que un pago devuelto o disputado deja la licencia **activa hasta que caduque**. Mitigación actual: revocar a mano con `pnpm license:revoke`. **Arreglo:** suscribir `charge.refunded` y `charge.dispute.created`, resolver la licencia por `stripe_customer_id`/sesión y revocarla (o recortar `expires_at`), registrando el motivo en `admin_audit`. Pequeño y acotado; se hará cuando haya volumen de ventas real. | [PLAN_LICENCIAS_PROPIAS.md](../PLAN_LICENCIAS_PROPIAS.md) |
| MESA-11 | 🟡 | Doble implementación Main (Rust) ↔ worker (TS) del dominio mesas: la lógica se iguala a mano y **diverge** (ya pasó con MESA-04/MESA-07). Falta el **harness de tests de contrato** y un plan de unificación (ver §[Unificación de la doble implementación](#unificación-de-la-doble-implementación-mainworker)). | [mesas.md](dominios/mesas.md) |
| MESA-14 | 🔵 | Componentes de UI monolíticos (`MesaComandaModal.tsx` ~70 KB, `KitchenBoard.tsx` ~18 KB): troceo en subcomponentes (ticket / panel de cobro / selector de productos) + hooks. **Pospuesto por prioridad**, no hay bug de negocio detrás. | [mesas.md](dominios/mesas.md) |
| SYNC-17 | 🟡 | **Conectividad automática (eliminar el interruptor online/offline).** Hoy la Main sólo abre el WS si el usuario activa "online" en Configuración → Conectividad (`useConnectionMode`, por defecto `offline`). Objetivo: que el modo sea un **estado derivado** del WebSocket (intentar siempre con `tpv` + licencia válida + identidad; el badge refleja el estado real) en vez de un ajuste manual. Pendiente decidir dónde vive el gate de licencia (hoy `set_connection_mode` lo valida en Rust; lo natural sería que `/v1/ws/ticket` sea la autoridad y el cliente simplemente reintente con backoff). Incluye dos arreglos de fiabilidad detectados: **timeout de pong** (hoy se envía `ping` pero no se verifica respuesta → un socket medio-muerto no se detecta) y **reconexión inmediata en la Main** ante `online`/`focus` (la Handy ya lo hace). Prerrequisito de coste ya resuelto: SYNC-16 (hibernación) — es ese cambio el que hace que la Main tenga el WS abierto toda la jornada. | [sync-tenanthub.md](transversal/sync-tenanthub.md) |
| INFRA-01 | 🟡 | **No hay entorno de staging: se prueba contra producción.** Hoy existe un único worker (`tpv-api`) con una sola BD de control y los binarios apuntan a él por constante. No hay dónde validar un cambio de worker, de esquema o de licencias antes de que lo vea un cliente real. Ver §[Entorno de staging](#entorno-de-staging-infra-01--pendiente-completo). **Aplazado a cuando el SaaS esté más asentado** (decisión 2026-08-09): es un montaje completo, no un ajuste. | §Entorno de staging |
| FABLE-B | 🟠 | **Fuga de stack traces al cliente.** `serverError(req, code, details)` serializa `details` en el cuerpo JSON, y varios handlers de pairing le pasan `{ message, name, stack }` del `Error` ([response.ts:48-63](../../apps/cloud-worker-licensing/src/server/utils/response.ts#L48-L63)). Cualquiera que llame a la API recibe la traza y el texto crudo del motor de Turso. **Decisión (2026-08-14): aplazado**, no hay clientes en producción todavía. **Cuando se haga, el cambio es en tres partes y hay que hacer las tres:** (1) `serverError` deja de serializar `details` y devuelve `{ ok, error, trace_id }`; (2) en cada `catch`, `console.error(trace_id, e?.stack)` + `Sentry.captureException` — hoy solo 9 ficheros loguean, así que sin esto **sí** se perdería información al quitar el `details`; (3) opcional pero recomendable, seguir devolviendo `details` cuando `env.ENVIRONMENT !== "prod"` (requiere añadir `ENVIRONMENT` a los `vars` de `wrangler.json`, hoy ausente). El stack se sigue viendo en `wrangler tail`, Sentry y Axiom. Conviene hacerlo **junto a ARCH-02** (contrato de errores): es el mismo cambio de forma de la respuesta. | [auditoria-fable.md](../../auditoria-fable.md) |
| FABLE-G | 🟠 | **CSP del cliente Tauri con comodín `https:`** (`script-src`/`connect-src` heredan de `default-src` → cualquier XSS futuro podría cargar código remoto y usar las APIs de Tauri). La investigación está **hecha y la solución redactada** (CSP estricta + `devCsp` + recorte de capacidades, ver §[Endurecimiento de la CSP](#endurecimiento-de-la-csp-del-cliente-tauri-fable-g--solución-lista-pendiente-de-aplicar)); aplazado porque aplicarla exige **probar a mano muchos flujos** (la CSP falla en runtime, no en compilación). | [auditoria-fable.md](../../auditoria-fable.md) |

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

## Plan de pago de Cloudflare Workers — ya no bloquea nada

> **Actualizado 2026-08-09.** El plan de pago está contratado y las dos mejoras que dependían de él
> **ya están hechas**; esta sección se queda solo como traza.

- **Envío de correo con Cloudflare Email Service — ✅ HECHO.** Resend está fuera. El worker envía por
  el binding `EMAIL` (`send_email` en `wrangler.json`, remitente `EMAIL_FROM_ADDRESS`), sin claves de
  API: el binding autentica solo. Ver `apps/cloud-worker-licensing/src/domains/email/email.routes.ts`.
- **Logpush — ✅ ACTIVADO en el worker** (`"logpush": true` en `wrangler.json`). El destino del job
  (Axiom/R2/…) se configura en el panel de Cloudflare, fuera del repo.

> ⚠️ **PBKDF2 100k → 600k nunca dependió del plan** (corregido 2026-08-09): el tope lo impone el
> `crypto.subtle` de Workers (máx. 100.000 iteraciones), y es del **runtime**. Tener el plan de pago
> **no** lo desbloquea. Ver **LOGIN-04** arriba.

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
| ARCH-02 | 🟡 | **Errores estructurados** en la frontera: hoy `AppError`→`String`. Pasar a un DTO `{ kind, code, message }` (ts-rs) para que el FE ramifique por tipo/código en vez de string-matching. El worker debe devolver la misma forma. | Refactor gradual post-lanzamiento (ya no espera al plan de pago: está contratado) |
| ARCH-05 | 🔵 | **Catálogo de códigos de error** estable y compartido (Rust/worker/FE); retirar `AppError::Raw`. Es la misma pieza que ARCH-02. | Con ARCH-02 |
| ARCH-03 | 🟡 | **Tipos del worker** (zod `*.schemas.ts`) desde fuente única ts-rs. Patrón ya probado en el repo: **drift-guard de tipos** como en OBS-05 (`SpoolEvent`→`telemetry.ts` + guard en `telemetry.routes.ts`), replicado por dominio. | Refactor gradual post-lanzamiento |

> **ARCH-04** (invalidación selectiva de React Query) y **ARCH-06** (deriva de documentación
> `schema.sql`) **ya están resueltos** (= SYNC-06 y DB-10 respectivamente); no van al backlog.
> **ARCH-07** son aciertos a mantener (hexagonal, ts-rs, Local-First, React Query), no un pendiente.

---

## Licenciamiento (T3) — revisar al fijar el modelo de precios

> **Decisión (responsable):** de momento se deja **como está**. El endurecimiento del licenciamiento
> se abordará **más adelante, cuando se decida el modelo de precios** (planes, activación, etc.), ya
> que el diseño concreto depende de eso. Ficha: [licensing-pairing.md](transversal/licensing-pairing.md).

> **Actualizado 2026-08-09:** **LIC-01 y LIC-06 ya están resueltos** por el sistema de licencias
> propio ([PLAN_LICENCIAS_PROPIAS.md](../PLAN_LICENCIAS_PROPIAS.md)): el worker firma el estado con
> ed25519 y el cliente lo verifica contra la clave pública **pineada en el binario**
> (`LICENSE_SIGNING_PUBLIC_KEY_B64`, `crates/tpv-infra-licensing/src/lib.rs:55-61`), y las dos
> constantes de host se unificaron en una. Queda solo lo de abajo.

| ID | Sev | Qué falta | Notas |
|----|-----|-----------|-------|
| LIC-02 | 🔵 | Sin **certificate pinning** del host de la API. | Prácticamente *moot* con LIC-01 resuelto: la firma pineada es más robusta que el pinning de transporte. Un MITM ya no puede falsificar el estado de licencia. |
| LIC-04 | 🔵 | Documentar el **modelo de amenaza** del gate (corre en cliente → evadible en última instancia). | Tarea de documentación. |

> **LIC-03** verificado como **no explotable** en pairing (todos los caminos firmados validan `ts` a
> 2 min; `fetch-token` con nonce de un solo uso). **LIC-05** (SMTP al keyring) quedó **moot**: DB-04
> eliminó el SMTP propio (correo por worker). **LIC-04** es documentar el modelo de amenaza del gate.

---

## Endurecimiento de la CSP del cliente Tauri (FABLE-G) — solución lista, pendiente de aplicar

> Hallazgo 🟠 **G** de [auditoria-fable.md](../../auditoria-fable.md). Investigación completada el
> 2026-07-18 (verificada contra el código del repo y la doc oficial de Tauri v2); **solo falta
> aplicar los 3 cambios y pasar el checklist de pruebas manuales**. Se aplazó porque la CSP falla en
> runtime (no en compilación) y la verificación toca muchos flujos.

**Hallazgo clave de la investigación:** la webview usa mucha menos red de la que la auditoría asumía.
El REST al worker va SIEMPRE por el proxy Rust (`tpv_server_post_json`, ver `shared/lib/cloudApi.ts`)
y Sentry de la webview reenvía por `invoke` al SDK de Rust. Lo único directo desde la webview es el
**WebSocket** (`useMainSocket`/`useHandySocket`) y las **imágenes** (asset local en Main, bucket R2
público en Handy vía `shared/lib/imageUrl.ts`). No hay fuentes remotas, ni iframes, ni workers, ni
wasm. Por eso `connect-src` NO necesita `https://tpv-api...` (a diferencia de lo que proponía la
auditoría).

### Cambio 1 — `csp` de producción en `apps/tpv-main/src-tauri/tauri.conf.json`

```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost wss://tpv-api.altarialights.workers.dev; img-src 'self' asset: http://asset.localhost https://asset.localhost https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'"
```

- ~~`style-src 'unsafe-inline'` es necesario: hay ~34 atributos `style={{…}}` en el frontend.~~
  ❌ **Corregido 2026-08-14: es falso, y meterlo debilitaría la CSP a cambio de nada.** La CSP
  **actual ya es `style-src 'self'`** (sin `'unsafe-inline'`) y los 34 `style={{…}}` funcionan,
  porque React **no** escribe el atributo `style` del HTML: asigna por CSSOM
  (`node.style.setProperty`), y la CSP no gobierna la manipulación programática de estilos. Lo que
  `style-src` bloquea son `<style>` y el **atributo** `style="…"` del marcado. Verificado además que
  en `apps/tpv-main/src/` no hay `dangerouslySetInnerHTML`, ni `setAttribute("style", …)`, ni
  `.cssText`, ni `createElement("style")` (la regla de §8 de CLAUDE.md se está cumpliendo). **Dejar
  `style-src 'self'` tal cual, en la `csp` y en la `devCsp`.**
- `ipc: http://ipc.localhost` es el transporte del IPC de Tauri en Windows (requisito documentado).
- Tauri inyecta nonces/hashes para sus scripts de arranque en build → `script-src 'self'` funciona
  (no tocar `dangerousDisableAssetCspModification`).
- ⚠️ Si algún día se cambia `CDN_IMAGES_BASE` (`imageUrl.ts`) a dominio propio, actualizar el
  `img-src` a la vez.
- ✅ **Bug del `img-src` — CONFIRMADO en emulador y ARREGLADO (2026-08-15).** La `img-src` no
  incluía el bucket R2 y, al estar declarada explícitamente, **no** heredaba el comodín `https:` de
  `default-src`: en la **Handy** (que carga las fotos de `https://pub-…r2.dev`, ver
  `shared/lib/imageUrl.ts`) **ninguna imagen de producto/categoría podía cargar**. En la Main no se
  notaba porque usa el protocolo `asset:` con el fichero local. Arreglado añadiendo el host del
  bucket a la `img-src` de `tauri.conf.json`. Cómo se verificó (método reutilizable para el resto
  del endurecimiento, ver §Cómo probar la CSP de verdad, abajo).

### Cambio 2 — añadir `devCsp` (OBLIGATORIO junto al cambio 1)

Si `devCsp` no existe, la `csp` de producción se aplica también en `tauri dev` y **rompe el dev**:
el HMR de Vite usa `ws://localhost:1420` (y `ws://<IP>:1421` en dev Android por LAN) y el preámbulo
de react-refresh es un script inline sin nonce (la inyección de nonces es solo en build).

```json
"devCsp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; connect-src 'self' ipc: http://ipc.localhost ws: wss://tpv-api.altarialights.workers.dev; img-src 'self' asset: http://asset.localhost https://asset.localhost https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev blob: data:"
```

**Sobre el `<script>` inline de `index.html`** (el anti-FOUC que aplica el tema antes del primer
pintado) — **resuelto por lectura del código de Tauri, 2026-08-15: no bloquea el cambio.** En el
build empaquetado, `tauri-codegen` recorre cada HTML embebido, calcula el **sha256 de cada script
inline** y lo añade a `script-src` (`inject_script_hashes`, selector `script:not(:empty)`, en
`tauri-codegen/src/context.rs:47`), así que `script-src 'self'` sigue ejecutándolo. Ojo al matiz:
esos hashes se calculan **solo sobre los assets embebidos**, no sobre el HTML que sirve Vite en
dev — por eso la `devCsp` **sí** necesita `'unsafe-inline'` en `script-src` (y por eso es
obligatoria). El nonce automático (`inject_nonce_token`) **no** cubre este caso: solo se aplica a
`script[src^='http']` y a `<style>`.

### Cambio 3 — recorte de capacidades en `apps/tpv-main/src-tauri/capabilities/default.json`

- **Quitar `opener:default`**: `@tauri-apps/plugin-opener` no se importa en ningún sitio del
  frontend ni se usa en `crates/` (solo el `.init()` en `lib.rs`). Puede quitarse el plugin entero
  (Cargo.toml + dependencia JS), no solo la capacidad.
- **Quitar `fs:scope-download`, `fs:scope-desktop`, `fs:scope-document`**: los únicos `writeFile`
  del frontend (exportar PDFs en `Cuentas.tsx` y `Trabajadores.tsx`) escriben en rutas elegidas con
  el diálogo `save()`, y el plugin dialog añade la ruta elegida al scope de fs en runtime
  (verificado en el fuente de `plugins-workspace`: el comando `save` hace `allow_file(&path)`).
  Basta con `fs:default` + `fs:allow-write-file` + los permisos de `dialog:*`.

### Cómo probar la CSP de verdad (sonda por CDP — verificado 2026-08-15)

El problema de siempre con la CSP es que **no se puede probar en `tauri dev`** (ahí no se aplica) y
que a ojo solo se ve el síntoma, no la causa. Esto la interroga directamente, sin depender de tener
datos ni de emparejar nada:

```bash
# 1. Emulador + APK EMPAQUETADO (el de `tauri android dev` NO sirve: apunta al server de Vite y
#    se salta la CSP).
emulator -avd Pixel_7 &
adb install -r apps/tpv-main/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell monkey -p com.altarialights.tpv -c android.intent.category.LAUNCHER 1

# 2. Abrir el puerto de DevTools de la webview (el pid sale del propio socket).
adb shell cat /proc/net/unix | grep webview_devtools
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl -s http://localhost:9222/json/list      # da el webSocketDebuggerUrl
```

3. Con ese WebSocket, un `Runtime.evaluate` que intente cargar el recurso y escuche
   `securitypolicyviolation` dice **exactamente** qué directiva bloqueó y qué URI. El script usado
   está en el histórico de la sesión; son ~40 líneas de Node (WebSocket nativo, sin dependencias).
   Resultado del 2026-08-15 sobre el build actual:

   | Recurso | Resultado |
   |---|---|
   | `https://pub-…r2.dev/probe.jpg` (bucket de la Handy) | ❌ bloqueado — `img-src` |
   | `https://example.com/probe.jpg` (control) | ❌ bloqueado — `img-src` (confirma que **no** hereda el `https:` de `default-src`) |
   | `data:image/gif;base64,…` (control positivo) | ✅ carga |

Ventaja sobre el checklist manual: se puede correr **antes** de aplicar el endurecimiento, con cada
URL que la app vaya a necesitar, y te dice el veredicto sin recorrer pantallas.

### Checklist de verificación manual (el motivo del aplazamiento)

Los fallos de CSP aparecen en la consola de la webview como `Refused to connect/load…`. Probar:

1. Arranque de la app (el IPC pasa por `connect-src`).
2. Modo online: WebSocket conectado y sincronizando (Main y Handy).
3. Imágenes de productos en Main (protocolo `asset:`) y en Handy (bucket R2).
4. Preview al subir/cambiar una imagen de producto/categoría (`blob:`).
5. Exportar PDF desde Cuentas y desde Trabajadores (dialog `save()` + `writeFile`, valida también
   el recorte de `fs:scope-*`).
6. `pnpm tauri dev` con HMR vivo (valida el `devCsp`).

**Colateral detectado en la investigación:** ~~hay un `package-lock.json` huérfano en
`apps/tpv-main/` que viola la regla pnpm-only (§8 de CLAUDE.md) → borrarlo en un commit aparte.~~
✅ **Hecho (2026-08-14):** se borraron los cuatro locks parásitos (`package-lock.json` de npm y
`pnpm-lock.yaml` por-app, en `apps/tpv-main` y `apps/cloud-worker-licensing`) y se añadió el patrón
al `.gitignore`. El único lock válido sigue siendo el de la raíz, que es el que instala CI con
`--frozen-lockfile`.

**Superficie de red de la webview, reverificada 2026-08-14:** en `apps/tpv-main/src/` **no hay
ningún `fetch()`** — las dos únicas conexiones directas son los `new WebSocket(...)` de
`useMainSocket.ts:321` y `useHandySocket.ts:188`. Sentry de la webview no sale a la red (el
transporte de `tauri-plugin-sentry-api` reenvía por `invoke` al SDK de Rust). O sea que apretar
`connect-src` a `'self' ipc: http://ipc.localhost wss://tpv-api…` es seguro.
