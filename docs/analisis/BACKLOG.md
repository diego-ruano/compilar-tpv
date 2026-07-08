# Backlog de hallazgos aplazados (resolver más adelante)

> Hallazgos analizados y **conscientemente pospuestos** (no son bugs de cálculo pendientes, sino
> tareas de infra de tests o que dependen de decisiones/otros dominios). Se retoman en una iteración
> posterior. Cada uno sigue documentado en detalle en su ficha de dominio.

| ID | Sev | Motivo del aplazamiento | Ficha |
|----|-----|-------------------------|-------|
| STAT-03 | 🟡 | Horas infravaloradas por fichajes abiertos: **bloqueado por TRAB-01** (cierre automático de fichajes, dominio trabajadores). | [estadisticas.md](dominios/estadisticas.md) |
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
