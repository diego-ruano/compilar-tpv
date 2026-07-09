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
| LOGIN-04 | 🟡 | **Subir PBKDF2 a 600k (OWASP) al activar el plan de pago de Cloudflare Workers.** Ahora en 100k porque el plan **Free** tiene un tope de 10 ms de CPU/petición y 600k lo superaría → rompería el login de Handy (el worker verifica el hash en cada login/fichaje). El rehash-en-login ya está cableado (`crates/tpv-infra-sqlite/src/login.rs`): basta subir `PBKDF2_ITERS` (Rust) y `DEFAULT_ITERS` (`login.crypto.ts`) y la Main migra los hashes viejos en el primer login de cada usuario. | [login.md](dominios/login.md) |
| LOGIN-05 | 🔵 | Doble implementación login/verify Rust↔worker: falta **harness de tests de contrato** de todos los caminos (setup, login, punch). Misma infra que STAT-06/INV-07. | [login.md](dominios/login.md) |
| LOGIN-02 (hash nube) | 🟠 | *(Opcional, no necesario)* No replicar / segregar `Password_Hash` de la nube. Con LOGIN-04 (600k) el crackeo offline ya se encarece mucho, así que este rediseño (que Handy delegue la auth en la Main, o un pepper fuera de la BD) queda como extra, no como pendiente. | [login.md](dominios/login.md) |
| MESA-11 | 🟡 | Doble implementación Main (Rust) ↔ worker (TS) del dominio mesas: la lógica se iguala a mano y **diverge** (ya pasó con MESA-04/MESA-07). Falta el **harness de tests de contrato** y un plan de unificación (ver §[Unificación de la doble implementación](#unificación-de-la-doble-implementación-mainworker)). | [mesas.md](dominios/mesas.md) |
| MESA-14 | 🔵 | Componentes de UI monolíticos (`MesaComandaModal.tsx` ~70 KB, `KitchenBoard.tsx` ~18 KB): troceo en subcomponentes (ticket / panel de cobro / selector de productos) + hooks. **Pospuesto por prioridad**, no hay bug de negocio detrás. | [mesas.md](dominios/mesas.md) |

**Nota:** el harness de tests de contrato Rust↔worker cubriría de una vez STAT-06, INV-07, MESA-11 (y
LOGIN-05 si acaba aplazado). Es una tarea transversal de infraestructura de testing, no de un dominio.

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

## Dependiente del plan de pago de Cloudflare Workers

> Mejoras **bloqueadas por el plan Free** de Cloudflare Workers (tope de **10 ms de CPU/petición** y
> features de pago). Se activan al migrar al plan de pago.

- **PBKDF2 100k → 600k (OWASP).** Ya detallado en **LOGIN-04** (arriba). El plan Free no admite 600k
  (superaría el tope de CPU/petición del worker en cada login/fichaje de Handy). El rehash-en-login
  ya está cableado: al activar el plan de pago basta subir `PBKDF2_ITERS` (Rust) y `DEFAULT_ITERS`
  (`login.crypto.ts`) y la Main migra los hashes viejos en el primer login de cada usuario.
- **Logpush.** Exportar los logs de petición HTTP del Worker a un destino (Axiom/R2/…) sin código,
  vía Cloudflare Logpush — requiere plan de pago. Da retención/observabilidad más allá de
  `wrangler tail` y del SDK de telemetría actual. Ya anotado en
  [observability.md §8](../observability.md#8-notas-y-próximos-pasos).
- **Envío de correo con Cloudflare Email Service (dejar de depender de Resend).** El objetivo es
  enviar los correos de pedido a proveedor con el servicio nativo de Cloudflare en vez de Resend
  (ya previsto en los comentarios de `apps/cloud-worker-licensing/src/domains/email/email.routes.ts`
  y `commands/email_config.rs`). **Requiere plan de pago:** enviar a destinatarios arbitrarios
  (los proveedores) exige el **Workers Paid plan** ($5/mes mínimo). En el plan Free solo se puede
  enviar a **direcciones de destino verificadas** de la cuenta (vía Email Routing), lo que **no**
  sirve para mandar pedidos a cualquier proveedor. Precio en el plan de pago: **3.000 correos/mes
  incluidos**, luego **$0,35 por 1.000**. Al activarlo basta sustituir el `fetch` a la API de Resend
  en `email.routes.ts` por el binding/servicio de Cloudflare (gateado por env), sin tocar el resto
  del flujo (la Main/Handy siguen llamando a `POST /v1/email/enviar-pedido`).
  Ref.: [Cloudflare Email Service — Pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

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
| ARCH-02 | 🟡 | **Errores estructurados** en la frontera: hoy `AppError`→`String`. Pasar a un DTO `{ kind, code, message }` (ts-rs) para que el FE ramifique por tipo/código en vez de string-matching. El worker debe devolver la misma forma. | **Al pasar al worker de pago** (junto con el resto de la infra) |
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

| ID | Sev | Qué falta | Notas |
|----|-----|-----------|-------|
| LIC-01 | 🟡 | La respuesta de licencia **no se verifica criptográficamente** (`call_status`, `lib.rs:217`): solo se confía en TLS. Un usuario con proxy local + CA propia podría forzar `allowed=true` y saltarse el gate. **Arreglo:** el servidor **firma** el estado de licencia (ed25519) y el cliente lo verifica contra una **clave pública pineada** en el binario. | Mayor retorno de seguridad; el gate sigue en cliente (evadible en última instancia), pero eleva mucho la barrera. |
| LIC-02 | 🟡 | Sin **certificate pinning** del host de la API (habilita el MITM de LIC-01). En pairing el impacto es bajo (handshake ed25519 + JWT firmado). | Opcional si se implementa LIC-01 (la firma pineada es más robusta que el pinning de transporte). |
| LIC-06 | 🔵 | `LICENSE_API_BASE` y `TPV_SERVER_BASE` son **dos constantes al mismo host** (`lib.rs:37-38`, legacy de la fusión de workers). | Limpieza; unificar en una sola constante. |

> **LIC-03** verificado como **no explotable** en pairing (todos los caminos firmados validan `ts` a
> 2 min; `fetch-token` con nonce de un solo uso). **LIC-05** (SMTP al keyring) quedó **moot**: DB-04
> eliminó el SMTP propio (correo por worker). **LIC-04** es documentar el modelo de amenaza del gate.
