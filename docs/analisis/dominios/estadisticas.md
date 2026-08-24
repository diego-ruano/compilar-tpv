# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (React Query).

## Valoración general

> ### STAT-07 🟠 El módulo de stats del worker es una implementación parcial (reabre STAT-06)
>
> **La suposición con la que se retiró STAT-06 el 2026-08-23 era falsa.** Decía: «los datos de los que
> salen los KPI sí convergen, así que los agregados van detrás». No van detrás — **los calcula otro
> código**, y ese código está a medias. Lo destapó el harness de contrato de **lectura** el 2026-08-24,
> en cuanto hubo con qué contrastarlo: de las 7 consultas, **5 divergen**.
>
> `stats.queries.ts` tiene 434 líneas frente a las 1764 de `stats.rs`, y la diferencia no es
> concisión:
>
> | Consulta | Qué hace el worker |
> |---|---|
> | `trabajadores` | **Devuelve las tarjetas con `tareas_asignadas`, `tareas_finalizadas` y `horas_trabajadas` a CERO FIJO**, `puntualidad` a null y el ranking de ventas vacío. Y clasifica por el texto libre de `Puesto` en vez de por el rol de la tabla `Roles`. La Main lo calcula leyendo fichajes y tareas (~520 líneas). En la Handy esa pantalla enseña ceros. |
> | `clientes` | `recurrentes` y `ticket_medio_cliente` a cero fijo; da por no recurrentes a todos los nuevos. |
> | `proveedores` | No calcula `porcentaje_sobre_total_gastos`. |
> | `productos` | No resuelve `peor_producto_vendible`. |
> | `reservas` | Modela dos gráficas distinto: el desglose por estado agrupa por el valor crudo de la columna (la Main devuelve siempre las tres barras Activas/Finalizadas/Canceladas) y las franjas horarias son la hora en crudo (la Main, bandas 00-11/12-15/16-19/20-23). |
>
> `stats.categorias` y `stats.mesas` **sí** coinciden y ya tienen caso de contrato en verde.
>
> **Estado:** los cinco casos están **escritos y bendecidos** en
> [`tests/contract/lecturas/`](../../../tests/contract/lecturas/) —el lado Rust los corre, así que
> definen exactamente lo que la Handy debería devolver—, y están excluidos del lado worker con su
> motivo en `lecturas/cobertura.json`. Enchufarlos el día que se porte el cálculo es añadir su par
> caso/golden y borrar la entrada. **Portar ~1300 líneas de analítica a TypeScript es un trabajo con
> nombre propio**, no algo que quepa dentro de la tarea de escribir tests.
>
> **La lección**, que vale para el resto del análisis: verificar a mano no es lo mismo que contrastar.
> Esto se dio por bueno razonando sobre el código; bastó ejecutarlo en paralelo para verlo.

**Acierto:** el manejo de **zona horaria** es correcto — compara `Fecha_Hora` (local almacenado)
contra límites `datetime('now','localtime',…)` **sin re-convertir**. Este módulo sirve de patrón.

## Hallazgos abiertos

Ninguno.


