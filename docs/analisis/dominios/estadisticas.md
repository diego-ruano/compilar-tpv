# D12 — Estadísticas (KPIs)

> **Ámbito.** Cuadros de mando: ventas por mesa/producto/categoría, reservas, clientes, proveedores y
> horas de personal, por rango (hoy/semana/mes/año).
> **Capas:** `crates/tpv-infra-sqlite/src/stats.rs`, `use_cases/stats.rs`,
> `apps/cloud-worker-licensing/src/domains/stats/*`,
> FE `apps/tpv-main/src/features/estadisticas/*` (React Query).

## Valoración general

> **STAT-07 cerrado (2026-08-24), y con él el retirado STAT-06.**
>
> El módulo de stats del worker **era** una implementación parcial del de la Main: `stats.trabajadores`
> devolvía tareas, horas y ranking a cero fijo y clasificaba por el texto libre de `Puesto` en vez de
> por el rol; `clientes` daba recurrentes y ticket medio a cero; `proveedores` no calculaba el
> porcentaje; `productos` no resolvía el peor producto vendible; y `reservas` modelaba el desglose por
> estado y las franjas horarias de otra forma. **Las cinco están portadas** y las siete consultas
> tienen caso de contrato de lectura en verde.
>
> Lo destapó el harness de lectura el mismo día que hubo con qué contrastarlo. La suposición con la
> que se había retirado STAT-06 el 23/08 —«los datos convergen, así que los agregados van detrás»—
> era falsa: **no van detrás, los calcula otro código**. Un par de detalles que sólo salen al
> ejecutar los dos lados a la vez y que ahora están fijados por sus goldens:
>
> - El **peor producto vendible** se busca partiendo del **catálogo**, no de lo vendido: el producto
>   que no compra nadie no aparece en ninguna línea de comanda, así que una consulta que salga de
>   `Detalle_Comanda` jamás puede encontrarlo.
> - El **ticket medio** de un camarero se agrupa primero **por comanda** y luego se promedia.
>   Promediando los pagos sueltos, una mesa cobrada en tres veces hundiría su media.
> - El desglose por **estado** y las **franjas horarias** son barras **fijas**, no un `GROUP BY`: un
>   día sin cancelaciones no puede quedarse sin esa barra y cambiar la forma de la gráfica solo.
> - El filtro de **turno** se aplica sólo al reparto de mesas, no al total: si filtrara en todo,
>   elegir «cena» cambiaría el total de reservas del día, que no es lo que ese selector significa.

**Acierto:** el manejo de **zona horaria** es correcto — compara `Fecha_Hora` (local almacenado)
contra límites `datetime('now','localtime',…)` **sin re-convertir**. Este módulo sirve de patrón.

## Hallazgos abiertos

Ninguno.


