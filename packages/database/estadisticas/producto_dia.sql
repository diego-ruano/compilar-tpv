-- Lo vendido de UN día (?1, 'YYYY-MM-DD'), por producto y nombre de línea: las filas de
-- `_Estad_Producto_Dia` de ese día (§17 de `0001_inicial.sql`).
--
-- La leen tal cual la Main (`tpv-infra-sqlite/src/estadisticas_diarias.rs`) y el worker
-- (`domains/stats/resumenDiario.ts`): las dos le ponen delante el INSERT, y las dos la usan sola
-- para contrastar lo guardado. Es una sola sentencia, sin punto y coma.
--
-- Una línea cuenta el día de su ÚLTIMO cobro activo: tiene un cobro activo ese día y ninguno en un
-- día posterior. Cobrada dos veces el mismo día, entra una vez (GROUP BY). Sólo cobros ACTIVOS: un
-- ticket anulado no es una venta (CUENTA-07). Una devolución de parte de un cobro no resta
-- unidades: no pasa por Pago_Detalles.
--
-- El `+` de `+p2.Estado` es el de `v_lineas_cobradas` (RI-02): que los demás cobros de la línea se
-- busquen por la línea y no recorriendo todos los cobros activos.
SELECT
  ?1 AS Dia,
  dc.ID_Producto AS ID_Producto,
  dc.Nombre_Producto AS Nombre_Producto,
  SUM(COALESCE(dc.Cantidad, 1)) AS Unidades
FROM (
  SELECT pd.ID_Detalle AS ID_Detalle
  FROM Pagos p
  JOIN Pago_Detalles pd ON pd.ID_Pago = p.ID_Pago
  WHERE p.Estado = 'ACTIVO'
    AND p.Fecha_Hora >= ?1
    AND p.Fecha_Hora < date(?1, '+1 day')
    AND NOT EXISTS (
      SELECT 1
      FROM Pago_Detalles pd2
      JOIN Pagos p2 ON p2.ID_Pago = pd2.ID_Pago
      WHERE pd2.ID_Detalle = pd.ID_Detalle
        AND +p2.Estado = 'ACTIVO'
        AND p2.Fecha_Hora >= date(?1, '+1 day')
    )
  GROUP BY pd.ID_Detalle
) cobrada
JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
GROUP BY dc.ID_Producto, dc.Nombre_Producto
