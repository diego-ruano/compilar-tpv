# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (8 ficheros, ~2552 líneas, React Query).

## Valoración general

**Acierto:** el manejo de **zona horaria** es **correcto** aquí — compara `Fecha_Hora` (local
almacenado) contra límites `datetime('now','localtime',…)` **sin re-convertir**, a diferencia del
tablero de cocina (MESA-08). Este módulo puede servir de patrón. Los hallazgos son de **atribución de
ingresos** (heredan las inconsistencias del modelo de cobro) y de **rendimiento**.

## Resumen de hallazgos

| ID | Sev | Estado | Título | Ubicación |
|----|-----|--------|--------|-----------|
| STAT-01 | 🟡 | ✅ | Ingresos: solo cuenta comandas **totalmente pagadas**, imputadas al último pago → parciales/partidos mal fechados o excluidos | `stats.rs:223-247` |
| STAT-02 | 🟡 | ✅ | Ingresos desde importes de **detalle**, no de `Pagos.Importe_Total` → diverge de caja si se editó el pago o se usó `cerrar_comanda` | `stats.rs:228` |
| STAT-03 | 🟡 | ⛔ | Horas de personal dependen de fichajes **cerrados**; los abiertos colgados (TRAB-01) infravaloran | stats trabajadores |
| STAT-04 | 🟡 | ✅ | Consultas pesadas (CTEs + `NOT EXISTS` correlacionados) sin límite → rendimiento en históricos grandes | `stats.rs:211-251` |
| STAT-05 | 🔵 | ✅ | Checks defensivos `table_has_column`/`table_exists` (legacy) añaden queries sobre esquema fijo | `stats.rs:42-71` |
| STAT-06 | 🔵 | 🟡 | Doble implementación Rust/worker (KPIs deben coincidir Main↔Handy) | `stats.rs` ↔ `stats.*.ts` |

> **Resolución (2026-07-05).** Se alineó el modelo de ingresos de Main (Rust) al **nivel de pago** que
> ya usaba Handy: se suma `Pagos.Importe_Total` filtrado por `Pagos.Fecha_Hora` en el rango, sin
> exigir comanda 100% pagada ni imputar al último pago (STAT-01/02). Al desaparecer los CTE
> `paid_det`/`comanda_paid_at`/`pagadas` con `NOT EXISTS` correlacionados, se resuelve también el
> grueso de STAT-04 (los índices `idx_pagos_fecha`/`idx_pagos_comanda_fecha` ya cubren las nuevas
> consultas; no se añaden tablas de resumen). Semántica unificada en ambos lados a **por-mesa**:
> `ocupadas` = mesas distintas con cobro en el rango y `ticket_medio_por_mesa` = ingresos/mesas
> (antes el worker contaba por comanda → divergía). Se excluyen las mesas de sistema (venta rápida)
> del tablero de mesas en todas las consultas. Con esto Main↔Handy quedan alineados para `mesas`
> (STAT-06 baja a 🟡: falta el harness de tests de contrato). Se retiraron los checks defensivos
> `table_has_column`/`table_exists` y el código muerto de columnas `Hora_Entrada_2/Salida_2`
> inexistentes (STAT-05). **STAT-03 sigue ⛔ bloqueado por TRAB-01** (cierre automático de fichajes),
> que es de otro dominio.

---

## Detalle de hallazgos

### STAT-01 🟡 Atribución de ingresos por pagos parciales/partidos — CONFIRMADO
- **Ubicación:** el CTE `pagadas` (`stats.rs:234-247`) solo incluye comandas donde **no existe**
  ningún detalle sin pagar, y usa `paid_at = MAX(pago)` (`:227`).
- **Fallo:** una comanda pagada **en varias veces** (o **a caballo de dos días**) no se cuenta hasta
  quedar **completamente** pagada, y entonces se imputa **entera** a la fecha del **último** pago. Los
  cobros parciales no se reflejan en su día, y una comanda que se cierra parcialmente y no se termina
  de pagar **no aparece nunca** en ingresos.
- **Impacto:** los ingresos por día/hora pueden estar mal fechados o infravalorados.
- **Arreglo:** contabilizar los ingresos a nivel de **pago** (cada `Pago` en su fecha), no a nivel de
  comanda-totalmente-pagada. Cruce con [cuentas.md](cuentas.md) y [mesas.md](mesas.md).

### STAT-02 🟡 Ingresos desde detalle vs `Pagos`
- **Ubicación:** `comanda_paid_at.total = SUM(dc.Cantidad*dc.Precio_Unitario)` (`:228`) — importes de
  **detalle**, no `Pagos.Importe_Total`.
- **Fallo:** si un pago se editó (CUENTA-02) o una comanda se cerró vía `cerrar_comanda` con un total
  del cliente (MESA-05), la caja y las estadísticas **no coinciden** (usan fuentes distintas).
- **Arreglo:** unificar la fuente de verdad de ingresos (recomendado: `Pagos`), coherente con caja.
  Cruce con CUENTA-02 y MESA-05.

### STAT-03 🟡 Horas infravaloradas por fichajes abiertos
- Las horas de personal se calculan de `Fichajes` cerrados (Hora_Salida). Los fichajes que quedan
  ABIERTOS por falta de cierre automático (**TRAB-01**) no suman → horas por debajo de lo real.
- **Arreglo:** resolver TRAB-01 (cierre automático) primero. Cruce con [trabajadores.md](trabajadores.md).

### STAT-04 🟡 Rendimiento de las agregaciones
- **Ubicación:** múltiples CTEs con `NOT EXISTS` correlacionados por comanda y `GROUP BY` amplios,
  sin límite temporal más allá del rango.
- **Arreglo:** medir con `EXPLAIN QUERY PLAN`; apoyarse en índices por fecha; considerar tablas de
  resumen precomputadas para rangos amplios (mes/año).

### STAT-05 🔵 Defensividad legacy
- `table_has_column`/`table_exists` (`:42-71`) comprueban el esquema en runtime; con el esquema ya
  fijo por migraciones, añaden queries innecesarias. **Arreglo:** retirar si el esquema está garantizado.

### STAT-06 🔵 Doble implementación
- Los KPIs se calculan en Rust (Main) y worker (Handy) por separado; deben dar **el mismo número**.
  **Arreglo:** tests de contrato que comparen resultados para el mismo dataset.

---

## Workflow de corrección (D12)

1. **STAT-01 / STAT-02 (fuente de verdad de ingresos).** Contabilizar por `Pago` en su fecha; alinear
   con caja. Coordinar con [cuentas.md](cuentas.md), [mesas.md](mesas.md).
2. **STAT-03 (horas).** Depende de TRAB-01.
3. **STAT-04 (rendimiento).** Índices/resúmenes precomputados.
4. **STAT-05/06 (limpieza y parity).** Retirar defensividad; tests de contrato.

**Invariante clave:** los KPIs deben derivar de una **fuente de verdad consistente** con caja y ser
**idénticos** entre Main y Handy; la zona horaria (ya correcta aquí) debe mantenerse.
