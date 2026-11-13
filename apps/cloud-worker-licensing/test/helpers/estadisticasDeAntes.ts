// test/helpers/estadisticasDeAntes.ts
//
// Las sentencias de las estadísticas de productos y de mesas de antes del resumen diario, que
// recorren los cobros: la referencia con la que se comparan las de ahora
// (`statsResumenDiario.test.ts`).

import type { SentenciasMesas } from "../../src/domains/stats/stats.queries";
import type { StatsRange } from "../../src/domains/stats/stats.schemas";

function rangeBounds(range: StatsRange): { start: string; end: string } {
	const end = "datetime('now','localtime')";
	if (range === "semana") return { start: "datetime('now','localtime','-6 days','start of day')", end };
	if (range === "mes") return { start: "datetime('now','localtime','start of month')", end };
	if (range === "anio") return { start: "datetime('now','localtime','start of year')", end };
	return { start: "datetime('now','localtime','start of day')", end };
}

function bucket(range: StatsRange, expr: string): string {
	if (range === "hoy") return `strftime('%H', ${expr})`;
	if (range === "anio") return `strftime('%m/%Y', ${expr})`;
	return `strftime('%d/%m', ${expr})`;
}

/** La de productos, tal cual estaba: una pasada por las líneas cobradas del rango. */
export function productosDeAntes(range: StatsRange): string {
	const { start, end } = rangeBounds(range);
	return `
		WITH
		rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		paid_det AS (
			SELECT pd.ID_Detalle AS ID_Detalle
			FROM Pago_Detalles pd
			JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
			JOIN rng ON 1=1
			WHERE p.Estado = 'ACTIVO'
				AND p.Fecha_Hora >= rng.start_dt
				AND p.Fecha_Hora <  rng.end_dt
			GROUP BY pd.ID_Detalle
		),
		vendido AS (
			SELECT
				COALESCE(dc.ID_Producto, dc.Nombre_Producto) AS clave,
				dc.Nombre_Producto AS nombre_linea,
				SUM(COALESCE(dc.Cantidad,1)) AS suma,
				SUM(CASE WHEN dc.ID_Producto IS NOT NULL THEN COALESCE(dc.Cantidad,1) END) AS suma_con_producto,
				SUM(CASE WHEN dc.ID_Producto IS NULL THEN COALESCE(dc.Cantidad,1) END) AS suma_sin_producto
			FROM paid_det cobrada
			JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
			GROUP BY COALESCE(dc.ID_Producto, dc.Nombre_Producto)
		)
		SELECT
			1 AS de_venta,
			clave,
			label,
			nombre,
			id_producto,
			id_categoria,
			CAST(ROUND(general,0) AS INTEGER) AS unidades,
			general > 0 AS con_ventas,
			CAST(ROUND(del_producto,0) AS INTEGER) AS unidades_producto,
			del_producto > 0 AS con_ventas_producto
		FROM (
			SELECT
				v.clave AS clave,
				CASE WHEN v.suma_con_producto IS NOT NULL AND COALESCE(cat.Vendible,1)=1
					 THEN COALESCE(pr.Nombre, v.nombre_linea, 'Producto')
					 ELSE COALESCE(v.clave, 'Producto')
				END AS label,
				CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.Nombre END AS nombre,
				pr.ID_Producto AS id_producto,
				CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.ID_Categoria END AS id_categoria,
				CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma ELSE v.suma_sin_producto END AS general,
				CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma_con_producto END AS del_producto
			FROM vendido v
			LEFT JOIN Productos pr ON v.suma_con_producto IS NOT NULL AND pr.ID_Producto = v.clave
			LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
			WHERE COALESCE(cat.Vendible,1)=1 OR v.suma_sin_producto IS NOT NULL
		)
		UNION ALL
		SELECT 0, pr.ID_Producto, pr.Nombre, pr.Nombre, pr.ID_Producto, pr.ID_Categoria, 0, 0, 0, 0
		FROM Productos pr
		JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
		WHERE COALESCE(cat.Vendible,1)=1
		ORDER BY nombre ASC, clave ASC;`;
}

/**
 * Las cuatro de mesas, tal cual estaban salvo en el desempate de las dos listas de mesas, que no lo
 * tenían entero: dos mesas con lo mismo salían en el orden en que las dejara SQLite (en la siembra
 * de `mesas_semana`, la 3 antes que la 2). Ahora va primero la de número menor y, con el mismo
 * número, la de ID menor.
 */
export function mesasDeAntes(range: StatsRange): SentenciasMesas {
	const { start, end } = rangeBounds(range);
	const desde = `
		FROM Pagos p
		JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
		JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa`;
	const donde = `
		WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end}
		  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'`;
	return {
		ingresos: `SELECT COALESCE(SUM(p.Importe_Total),0) AS total, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN c.ID_Mesa END) AS ocupadas
			${desde} ${donde};`,
		topComandas: `SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS comandas
			${desde}
			JOIN Zonas z ON z.ID_Zona = m.ID_Zona
			${donde}
			GROUP BY m.ID_Mesa
			ORDER BY comandas DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
			LIMIT 1;`,
		servicios: `SELECT ${bucket(range, "p.Fecha_Hora")} AS label, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS value
			${desde} ${donde}
			GROUP BY label ORDER BY label ASC;`,
		topIngresos: `SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, SUM(p.Importe_Total) AS total
			${desde}
			JOIN Zonas z ON z.ID_Zona = m.ID_Zona
			${donde}
			GROUP BY m.ID_Mesa
			ORDER BY total DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
			LIMIT 10;`,
	};
}
