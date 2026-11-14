-- Los cobros de cada día de `dias(Dia)` ('YYYY-MM-DD') de las comandas de cada mesa: las filas de
-- `_Estad_Mesa_Dia` de esos días (§17 de `0001_inicial.sql`).
--
-- `dias` lo pone delante quien la usa: la Main (`tpv-infra-sqlite/src/estadisticas_diarias.rs` y
-- `stats.rs`) y el worker (`domains/stats/resumenDiario.ts` y `stats.queries.ts`), con un día
-- (`WITH dias(Dia) AS (SELECT ?1)`) para rehacerlo o contrastarlo, o con los días sucios de un
-- rango para leerlos de los cobros. Es una sola sentencia, sin punto y coma.
--
-- Sólo cobros ACTIVOS, y sólo de comandas con mesa (la venta rápida no tiene). Una devolución de
-- parte de un cobro (`ID_Pago_Origen`) resta del importe del día en que se devuelve, pero no es un
-- cobro: no cuenta como comanda.
--
-- Las dos últimas columnas cuentan cada comanda el día de su ÚLTIMO cobro, del mes o de siempre:
-- la comanda tiene un cobro ese día y ninguno más tarde. Sumadas dan comandas distintas, que es lo
-- que hace falta para no contar dos veces la que se cobró en dos días.
--
-- El `+` de `+p2.Estado` hace que los demás cobros de la comanda se busquen por la comanda
-- (idx_pagos_comanda_fecha) y no recorriendo todos los cobros activos (RI-02).
SELECT
  d.Dia AS Dia,
  c.ID_Mesa AS ID_Mesa,
  SUM(p.Importe_Total) AS Importe,
  COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS Comandas,
  COUNT(DISTINCT CASE
    WHEN p.ID_Pago_Origen IS NULL AND NOT EXISTS (
      SELECT 1
      FROM Pagos p2
      WHERE p2.ID_Comanda = p.ID_Comanda
        AND p2.Fecha_Hora >= date(d.Dia, '+1 day')
        AND p2.Fecha_Hora < date(d.Dia, 'start of month', '+1 month')
        AND +p2.Estado = 'ACTIVO'
        AND p2.ID_Pago_Origen IS NULL
    ) THEN p.ID_Comanda END) AS Comandas_Ultimo_Mes,
  COUNT(DISTINCT CASE
    WHEN p.ID_Pago_Origen IS NULL AND NOT EXISTS (
      SELECT 1
      FROM Pagos p2
      WHERE p2.ID_Comanda = p.ID_Comanda
        AND p2.Fecha_Hora >= date(d.Dia, '+1 day')
        AND +p2.Estado = 'ACTIVO'
        AND p2.ID_Pago_Origen IS NULL
    ) THEN p.ID_Comanda END) AS Comandas_Ultimo
FROM dias d
-- CROSS JOIN fija el orden: primero los días y, de cada uno, sus cobros por su fecha. Con un
-- JOIN, SQLite puede empezar por los cobros activos, todos, y cruzarlos después con los días.
CROSS JOIN Pagos p
  ON p.Estado = 'ACTIVO'
 AND p.Fecha_Hora >= d.Dia
 AND p.Fecha_Hora < date(d.Dia, '+1 day')
JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
WHERE c.ID_Mesa IS NOT NULL
GROUP BY d.Dia, c.ID_Mesa
