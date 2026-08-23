# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (React Query).

## Valoración general

> **Paridad Main↔Handy de los KPI: retirada como hallazgo (2026-08-23, decisión del responsable).**
> Los 7 KPI están implementados dos veces (`stats.rs` y `stats.queries.ts`) y el harness de contrato
> no los cubre, porque compara el efecto de las **escrituras** y esto es solo lectura. Se asume: los
> **datos** de los que salen sí convergen —de eso se encargan los casos de contrato de escritura—,
> así que los agregados van detrás. Un desajuste aquí sería de presentación (un total que se calcula
> distinto), no de datos, y se vería al comparar pantallas.

**Acierto:** el manejo de **zona horaria** es correcto — compara `Fecha_Hora` (local almacenado)
contra límites `datetime('now','localtime',…)` **sin re-convertir**. Este módulo sirve de patrón.

## Hallazgos abiertos

Ninguno.


