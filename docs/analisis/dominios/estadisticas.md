# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (React Query).

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
