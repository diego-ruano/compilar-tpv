-- Lo vendido de cada día de `dias(Dia)` ('YYYY-MM-DD'), por producto y nombre de línea: las filas
-- de `_Estad_Producto_Dia` de esos días (§17 de `0001_inicial.sql`).
--
-- `dias` lo pone delante quien la usa: la Main (`tpv-infra-sqlite/src/estadisticas_diarias.rs` y
-- `stats.rs`) y el worker (`domains/stats/resumenDiario.ts` y `stats.queries.ts`), con un día
-- (`WITH dias(Dia) AS (SELECT ?1)`) para rehacerlo o contrastarlo, o con los días sucios de un
-- rango para leerlos de los cobros. Es una sola sentencia, sin punto y coma.
--
-- Una línea cuenta el día de su ÚLTIMO cobro activo: tiene un cobro activo ese día y ninguno en un
-- día posterior. Cobrada dos veces el mismo día, entra una vez (GROUP BY). Sólo cobros ACTIVOS: un
-- ticket anulado no es una venta (CUENTA-07). Una devolución de parte de un cobro no resta
-- unidades: no pasa por Pago_Detalles. Las cantidades se suman en milésimas enteras: sumando
-- REAL, el mismo 1,5 sale 1,4999999999999998 según cómo se agrupe, y redondea a otra unidad.
--
-- El `+` de `+p2.Estado` es el de `v_lineas_cobradas` (RI-02): que los demás cobros de la línea se
-- busquen por la línea y no recorriendo todos los cobros activos.
SELECT
  cobrada.Dia AS Dia,
  dc.ID_Producto AS ID_Producto,
  dc.Nombre_Producto AS Nombre_Producto,
  SUM(CAST(ROUND(COALESCE(dc.Cantidad, 1) * 1000) AS INTEGER)) AS Milesimas
FROM (
  SELECT d.Dia AS Dia, pd.ID_Detalle AS ID_Detalle
  FROM dias d
  JOIN Pagos p
    ON p.Estado = 'ACTIVO'
   AND p.Fecha_Hora >= d.Dia
   AND p.Fecha_Hora < date(d.Dia, '+1 day')
  JOIN Pago_Detalles pd ON pd.ID_Pago = p.ID_Pago
  WHERE NOT EXISTS (
    SELECT 1
    FROM Pago_Detalles pd2
    JOIN Pagos p2 ON p2.ID_Pago = pd2.ID_Pago
    WHERE pd2.ID_Detalle = pd.ID_Detalle
      AND +p2.Estado = 'ACTIVO'
      AND p2.Fecha_Hora >= date(d.Dia, '+1 day')
  )
  GROUP BY d.Dia, pd.ID_Detalle
) cobrada
JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
GROUP BY cobrada.Dia, dc.ID_Producto, dc.Nombre_Producto
