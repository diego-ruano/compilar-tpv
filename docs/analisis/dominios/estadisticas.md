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
Los 7 KPI (`mesas`, `list_categorias`, `productos`, `reservas`, `trabajadores`, `clientes`,
`proveedores`) están implementados dos veces, en `stats.rs` y en `stats.queries.ts`, y deben dar el
mismo número; una divergencia se ve como "la Handy me da otro total".

**Ojo con lo que dice el harness:** el de contrato compara el efecto de las **escrituras**, y stats
es **solo lectura** — por eso `tests/contract/README.md` lo lista entre los "no cubiertos: no hay
nada que contrastar". Es decir, **STAT-06 no lo cierra el harness actual**: hace falta el harness
de **paridad de lectura** (mismo seed → mismas filas devueltas por cada lado), que cerraría también
CLI-05. Mientras tanto la paridad se mantiene a mano y nada la vigila.
