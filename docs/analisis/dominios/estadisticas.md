# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (React Query).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: STAT-01 a STAT-05.

## Valoración general

**Acierto:** el manejo de **zona horaria** es correcto — compara `Fecha_Hora` (local almacenado)
contra límites `datetime('now','localtime',…)` **sin re-convertir**. Este módulo sirve de patrón.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| STAT-06 | 🔵 | Doble implementación Rust/worker (los KPIs deben coincidir Main↔Handy) | `stats.rs` ↔ `stats.*.ts` |

### STAT-06 🔵 Doble implementación
La lógica ya se igualó a mano; lo que falta es el **harness de tests de contrato** que impida que
vuelva a separarse (los KPIs son especialmente sensibles: una divergencia se ve como "la Handy me
da otro número"). Instancia de **ARCH-01** → ver
[BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Qué se corrigió (referencia rápida)

> **Resolución (2026-07-05).** Se alineó el modelo de ingresos de Main (Rust) al **nivel de pago**
> que ya usaba Handy: se suma `Pagos.Importe_Total` filtrado por `Pagos.Fecha_Hora` en el rango, sin
> exigir comanda 100 % pagada ni imputar al último pago (STAT-01/02). Al desaparecer los CTE
> `paid_det`/`comanda_paid_at`/`pagadas` con `NOT EXISTS` correlacionados se resolvió también el
> grueso de STAT-04; los índices `idx_pagos_fecha`/`idx_pagos_comanda_fecha` cubren las consultas
> nuevas. Semántica unificada en ambos lados a **por-mesa**.

| ID | Cómo quedó |
|----|------------|
| STAT-01 / STAT-02 | Ingresos a nivel de **pago** (`Pagos.Importe_Total` por `Pagos.Fecha_Hora`), coherente con caja y con Handy. |
| STAT-03 | Las horas ya no las infravaloran los fichajes colgados: TRAB-01 cierra automáticamente las jornadas abiertas de días anteriores. |
| STAT-04 | Consultas simplificadas (fuera los `NOT EXISTS` correlacionados) y cubiertas por índice. |
| STAT-05 | Retirados los checks defensivos `table_has_column`/`table_exists` (legacy sobre un esquema fijo). |
