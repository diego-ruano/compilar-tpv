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

**Nota:** el harness de tests de contrato Rust↔worker cubriría de una vez STAT-06, INV-07 (y
LOGIN-05 si acaba aplazado). Es una tarea transversal de infraestructura de testing, no de un dominio.
