// src/domains/stats/stats.queries.ts

import type { Client } from "@libsql/client/web";
import { recortar } from "../../lib/texto";
import { CERO, deLaBase, entre } from "../../lib/dinero";

import type {
	ClientesStatsResponse,
	MesasStatsResponse,
	ProductosStatsResponse,
	ProveedoresStatsResponse,
	ReservasStatsResponse,
	StatsCategoriaRow,
	StatsTurno,
	TrabajadoresStatsResponse,
} from "@tpv/contracts";

import { resumenAlDia, SELECT_MESA_DIA, SELECT_PRODUCTO_DIA } from "./resumenDiario";
import type { StatsRange } from "./stats.schemas";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

function num(v: any, fallback = 0): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function rangeBounds(range: StatsRange): { start: string; end: string } {
	if (range === "semana") {
		return {
			start: "datetime('now','localtime','-6 days','start of day')",
			end: "datetime('now','localtime')",
		};
	}
	if (range === "mes") {
		return {
			start: "datetime('now','localtime','start of month')",
			end: "datetime('now','localtime')",
		};
	}
	if (range === "anio") {
		return {
			start: "datetime('now','localtime','start of year')",
			end: "datetime('now','localtime')",
		};
	}
	return {
		start: "datetime('now','localtime','start of day')",
		end: "datetime('now','localtime')",
	};
}

function bucket(range: StatsRange, expr: string): string {
	if (range === "hoy") return `strftime('%H', ${expr})`;
	if (range === "anio") return `strftime('%m/%Y', ${expr})`;
	return `strftime('%d/%m', ${expr})`;
}

async function one(db: Client, sql: string, args: any[] = []): Promise<any> {
	const rs = await db.execute({ sql, args });
	return rows(rs)[0] ?? {};
}

async function tableExists(db: Client, table: string): Promise<boolean> {
	const r = await one(
		db,
		"SELECT name FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
		[table],
	);
	return Boolean(r.name);
}

/**
 * El inicio de hoy. Las estadísticas de productos y de mesas leen del resumen diario
 * (`resumenDiario.ts`) los días del rango anteriores a éste, y de los cobros lo de hoy.
 */
const HOY = "datetime('now','localtime','start of day')";

/**
 * Antes de leer del resumen diario los días cerrados de un rango, rehace los que estén sucios
 * (`resumenAlDia`). El rango de hoy no lee del resumen.
 */
async function resumenDelRangoAlDia(db: Client, range: StatsRange): Promise<void> {
	if (range === "hoy") return;
	await resumenAlDia(db, rangeBounds(range).start);
}

/**
 * Los días cerrados del rango que el resumen diario tiene por rehacer, como `dias(Dia)` de las
 * sentencias compartidas (`packages/database/estadisticas/`): esos días se leen de los cobros y no
 * del resumen. Va detrás de `rng`. Materializada: si no, SQLite la deshace dentro de la sentencia
 * compartida y recorre los cobros de todos los días sucios, también los de fuera del rango (un
 * histórico recién descargado), antes de mirar el rango.
 */
const DIAS_SUCIOS_DEL_RANGO = `dias AS MATERIALIZED (
			SELECT s.Dia AS Dia
			FROM _Estad_Dias_Sucios s
			JOIN rng ON 1=1
			WHERE s.Dia >= date(rng.start_dt)
				AND s.Dia <  date(rng.hoy_dt)
		)`;

/**
 * Los cobros de mesa del rango, por día y mesa (`por_mesa_dia`): la cabecera que comparten las
 * sentencias de la estadística de mesas.
 *
 * Los días del rango anteriores a hoy salen de `_Estad_Mesa_Dia` (antes de leer, `mesas` rehace los
 * que estén sucios; el que se ensucie después se lee de los cobros, con la misma sentencia que lo
 * rehace) y lo de hoy, de los cobros hasta ahora. Cada fila trae lo cobrado y tres recuentos de comandas, porque una comanda cobrada en dos
 * días no puede contarse dos veces: `comandas` son las de ese día, `comandas_mes` las que tienen
 * ese día su último cobro del mes y `comandas_rango` las que lo tienen de siempre (ver la tabla en
 * `0001_inicial.sql`). Hoy las tres son lo mismo: es el último día del rango y de su mes. Y va una
 * fila más por mesa, sin importe, con las comandas que el resumen ya no cuenta en su día porque
 * tienen un cobro fechado después de ahora: sólo suman a los dos recuentos de comandas distintas.
 *
 * Una devolución de parte de un cobro (`ID_Pago_Origen`) resta de lo cobrado el día que se
 * devuelve, pero no cuenta como comanda: no es un cobro. La venta rápida no tiene mesa
 * (Canal='BARRA', ID_Mesa NULL). Mismo modelo que Main/Rust (STAT-01/02/06): la misma cabecera,
 * en `sql_cobros_por_mesa_y_dia` de `tpv-infra-sqlite/src/stats.rs`.
 */
function sqlCobrosPorMesaYDia(range: StatsRange): string {
	const { start, end } = rangeBounds(range);
	return `
		WITH
		rng AS (SELECT ${start} AS start_dt, ${HOY} AS hoy_dt, ${end} AS end_dt),
		${DIAS_SUCIOS_DEL_RANGO},
		sucios AS (${SELECT_MESA_DIA}),
		por_mesa_dia AS (
			SELECT
				e.Dia AS dia,
				e.ID_Mesa AS id_mesa,
				e.Importe AS importe,
				e.Comandas AS comandas,
				e.Comandas_Ultimo_Mes AS comandas_mes,
				e.Comandas_Ultimo AS comandas_rango
			FROM _Estad_Mesa_Dia e
			JOIN rng ON 1=1
			WHERE e.Dia >= date(rng.start_dt)
				AND e.Dia <  date(rng.hoy_dt)
				AND e.Dia NOT IN (SELECT Dia FROM dias)
			UNION ALL
			SELECT Dia, ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo FROM sucios
			UNION ALL
			SELECT
				date(rng.hoy_dt),
				c.ID_Mesa,
				SUM(p.Importe_Total),
				COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END),
				COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END),
				COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END)
			FROM Pagos p
			JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
			JOIN rng ON 1=1
			WHERE p.Fecha_Hora >= rng.hoy_dt
				AND p.Fecha_Hora <  rng.end_dt
				AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
				AND c.ID_Mesa IS NOT NULL
			GROUP BY c.ID_Mesa
			UNION ALL
			-- Las comandas con un cobro dentro del rango antes de hoy, ninguno hoy hasta ahora y otro
			-- fechado despues de ahora (un reloj adelantado): el resumen no las cuenta en el que era su
			-- ultimo dia, porque ya no lo es, y lo de hoy tampoco. Solo suman a los recuentos de
			-- comandas distintas: no son un cobro de hoy (sin importe ni comandas del dia).
			SELECT
				date(rng.hoy_dt),
				c.ID_Mesa,
				NULL,
				0,
				COUNT(DISTINCT CASE
					WHEN p.Fecha_Hora < datetime(rng.hoy_dt, 'start of month', '+1 month') AND EXISTS (
						SELECT 1 FROM Pagos p2
						WHERE p2.ID_Comanda = p.ID_Comanda
							AND +p2.Estado = 'ACTIVO'
							AND p2.ID_Pago_Origen IS NULL
							AND p2.Fecha_Hora >= MAX(rng.start_dt, datetime(rng.hoy_dt, 'start of month'))
							AND p2.Fecha_Hora <  rng.hoy_dt
					) THEN p.ID_Comanda END),
				COUNT(DISTINCT p.ID_Comanda)
			FROM Pagos p
			JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
			JOIN rng ON 1=1
			WHERE p.Fecha_Hora >= rng.end_dt
				AND p.Estado = 'ACTIVO'
				AND p.ID_Pago_Origen IS NULL
				AND c.ID_Mesa IS NOT NULL
				AND EXISTS (
					SELECT 1 FROM Pagos p2
					WHERE p2.ID_Comanda = p.ID_Comanda
						AND +p2.Estado = 'ACTIVO'
						AND p2.ID_Pago_Origen IS NULL
						AND p2.Fecha_Hora >= rng.start_dt
						AND p2.Fecha_Hora <  rng.hoy_dt
				)
				AND NOT EXISTS (
					SELECT 1 FROM Pagos p2
					WHERE p2.ID_Comanda = p.ID_Comanda
						AND +p2.Estado = 'ACTIVO'
						AND p2.ID_Pago_Origen IS NULL
						AND p2.Fecha_Hora >= rng.hoy_dt
						AND p2.Fecha_Hora <  rng.end_dt
				)
			GROUP BY c.ID_Mesa
		)`;
}

/** Ingresos y mesas servidas del rango. Una mesa cuenta si tiene algún cobro (no una devolución). */
export function sqlMesasIngresos(range: StatsRange): string {
	return `${sqlCobrosPorMesaYDia(range)}
		SELECT
			COALESCE(SUM(d.importe),0) AS total,
			COUNT(DISTINCT CASE WHEN d.comandas > 0 THEN d.id_mesa END) AS ocupadas
		FROM por_mesa_dia d
		JOIN Mesas m ON m.ID_Mesa = d.id_mesa;`;
}

/** La mesa con más comandas cobradas en el rango. */
export function sqlMesaTopComandas(range: StatsRange): string {
	return `${sqlCobrosPorMesaYDia(range)}
		SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, SUM(d.comandas_rango) AS comandas
		FROM por_mesa_dia d
		JOIN Mesas m ON m.ID_Mesa = d.id_mesa
		JOIN Zonas z ON z.ID_Zona = m.ID_Zona
		GROUP BY m.ID_Mesa
		ORDER BY comandas DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
		LIMIT 1;`;
}

/**
 * Las comandas cobradas de cada tramo de la gráfica. Por horas (hoy) se leen de los cobros; por
 * días, del recuento de cada día; por meses, del que cuenta cada comanda una vez en su mes.
 */
export function sqlMesasServicios(range: StatsRange): string {
	if (range === "hoy") {
		const { start, end } = rangeBounds(range);
		return `SELECT ${bucket(range, "p.Fecha_Hora")} AS label, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS value
			 FROM Pagos p
			 JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
			 JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
			 WHERE p.Fecha_Hora >= ${start} AND p.Fecha_Hora < ${end}
			   AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
			 GROUP BY label ORDER BY label ASC;`;
	}
	const [tramo, recuento] =
		range === "anio" ? ["strftime('%m/%Y', d.dia)", "d.comandas_mes"] : ["strftime('%d/%m', d.dia)", "d.comandas"];
	// Sólo los tramos con algún cobro. Las filas sin importe son las de las comandas con un cobro
	// fechado después de ahora (`sqlCobrosPorMesaYDia`), que no son un cobro de hoy: por días no
	// cuentan, y por meses sólo si suman al mes de hoy, que entonces ya tiene un cobro antes de hoy.
	// Si su cobro de dentro del rango es de un mes anterior, no hacen aparecer el mes de hoy.
	const conCobros =
		range === "anio" ? "WHERE d.importe IS NOT NULL OR d.comandas_mes > 0" : "WHERE d.importe IS NOT NULL";
	return `${sqlCobrosPorMesaYDia(range)}
		SELECT ${tramo} AS label, SUM(${recuento}) AS value
		FROM por_mesa_dia d
		JOIN Mesas m ON m.ID_Mesa = d.id_mesa
		${conCobros}
		GROUP BY label ORDER BY label ASC;`;
}

/**
 * Las diez mesas que más han ingresado en el rango. Entre dos con lo mismo, primero la de número
 * menor (y, con el mismo número en dos zonas, la de ID menor).
 */
export function sqlMesasTopIngresos(range: StatsRange): string {
	return `${sqlCobrosPorMesaYDia(range)}
		SELECT m.Numero_Mesa AS mesa, z.Nombre_Zona AS zona, COALESCE(SUM(d.importe),0) AS total
		FROM por_mesa_dia d
		JOIN Mesas m ON m.ID_Mesa = d.id_mesa
		JOIN Zonas z ON z.ID_Zona = m.ID_Zona
		GROUP BY m.ID_Mesa
		ORDER BY total DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
		LIMIT 10;`;
}

export async function mesas(
	db: Client,
	range: StatsRange,
): Promise<MesasStatsResponse> {
	// Los días cerrados del rango se leen del resumen diario: primero, que esté al día.
	await resumenDelRangoAlDia(db, range);
	return mesasCon(db, {
		ingresos: sqlMesasIngresos(range),
		topComandas: sqlMesaTopComandas(range),
		servicios: sqlMesasServicios(range),
		topIngresos: sqlMesasTopIngresos(range),
	});
}

/**
 * Las cuatro sentencias de la estadística de mesas: ingresos y mesas servidas (`total`,
 * `ocupadas`), la mesa con más comandas (`mesa`, `zona`, `comandas`), las comandas de cada tramo de
 * la gráfica (`label`, `value`) y las diez mesas que más han ingresado (`mesa`, `zona`, `total`).
 */
export type SentenciasMesas = {
	ingresos: string;
	topComandas: string;
	servicios: string;
	topIngresos: string;
};

/**
 * La estadística de mesas a partir de sus cuatro sentencias. Los tests de equivalencia le pasan las
 * de antes del resumen diario, que recorren los cobros.
 */
export async function mesasCon(db: Client, sql: SentenciasMesas): Promise<MesasStatsResponse> {
	const total = await one(
		db,
		"SELECT COUNT(*) AS n FROM Mesas WHERE Archivada_En IS NULL;",
	);
	// Ingresos al nivel de PAGO (fuente de verdad = Pagos, coherente con caja), semántica por-mesa:
	// 'ocupadas' = nº de mesas reales con cobro en el rango; ingresos = lo cobrado. Las cuatro
	// sentencias leen lo mismo: `por_mesa_dia` (`sqlCobrosPorMesaYDia`).
	const ingresos = await one(db, sql.ingresos);
	const top = await one(db, sql.topComandas);
	const servRs = await db.execute(sql.servicios);
	const topRs = await db.execute(sql.topIngresos);
	const servicios = rows(servRs);
	const topMesas = rows(topRs);
	const ocupadas = num(ingresos.ocupadas);

	return {
		total_mesas: num(total.n),
		ocupadas,
		// Un promedio de importes sigue siendo fraccionario: vuelve a centimo entero con la MISMA
		// regla que la Main (`Dinero::entre`), o las dos pantallas ensenan cifras distintas.
		ticket_medio_por_mesa: ocupadas > 0 ? entre(deLaBase(ingresos.total), ocupadas) : CERO,
		mesa_top_comandas: top.mesa
			? { mesa: String(top.mesa), zona: String(top.zona ?? ""), comandas: num(top.comandas) }
			: null,
		servicios: {
			labels: servicios.map((r) => String(r.label ?? "")),
			values: servicios.map((r) => num(r.value)),
		},
		top_mesas_ingresos: topMesas.map((r) => ({
			mesa: String(r.mesa ?? ""),
			zona: String(r.zona ?? ""),
			total: deLaBase(r.total),
		})),
	};
}

export async function listCategorias(db: Client): Promise<StatsCategoriaRow[]> {
	const rs = await db.execute(`
		SELECT ID_Categoria, Nombre
		FROM Categorias_Producto
		WHERE COALESCE(Vendible,1)=1
		ORDER BY Nombre ASC;
	`);
	return rows(rs) as StatsCategoriaRow[];
}

/**
 * La sentencia de la estadística de productos: lo vendido en el rango, sin recorrer sus cobros.
 *
 * Devuelve dos clases de fila, ya ordenadas por el nombre del catálogo: lo vendido en el rango
 * (`de_venta = 1`, una por clave, con sus unidades) y el catálogo vendible (`de_venta = 0`). El
 * mejor, el peor y los dos top 10 los saca `productos` de ahí sin hacer cuentas: todas las sumas y
 * los redondeos son de SQLite.
 *
 * Los días ya cerrados del rango salen de `_Estad_Producto_Dia`, que los tiene sumados por producto,
 * y sólo lo de hoy se lee de los cobros: lo que tarda no crece con el rango ni con el histórico, que
 * es lo que hace falta en el SQLite del Durable Object, que atiende a todo el negocio en un solo
 * hilo. Antes de leer, `productos` rehace los días sucios; el que se haya ensuciado después (un cobro
 * que ha entrado entre medias, mientras se cedía el paso) no se lee del resumen sino de los cobros,
 * con la misma sentencia que lo rehace (`DIAS_SUCIOS_DEL_RANGO`), así que la lectura nunca mezcla un
 * día viejo con lo nuevo. Es una sola sentencia a propósito: con una por lista, cada una volvería a
 * leer lo mismo.
 * La misma sentencia, en la Main: `sql_productos` de `tpv-infra-sqlite/src/stats.rs`.
 */
export function sqlProductos(range: StatsRange): string {
	const { start, end } = rangeBounds(range);
	return `
		WITH
		rng AS (SELECT ${start} AS start_dt, ${HOY} AS hoy_dt, ${end} AS end_dt),
		${DIAS_SUCIOS_DEL_RANGO},
		sucios AS (${SELECT_PRODUCTO_DIA}),
		paid_det AS (
			-- Las lineas cuyo ultimo cobro es de hoy o posterior, que el resumen no tiene en ningun
			-- dia: entran si tienen un cobro dentro del rango, hoy hasta ahora o antes de hoy. Uno
			-- fechado despues de ahora (un reloj adelantado) no cuenta, pero tampoco saca del rango a
			-- la linea que tiene otro dentro.
			-- STAT-07: cada linea entra UNA vez. Uniendo Pago_Detalles con Pagos a pelo, una linea
			-- cobrada en dos veces saldria dos veces y sus unidades se contarian dobles.
			-- Solo pagos ACTIVOS (CUENTA-07): un ticket anulado no es una venta, asi que sus
			-- lineas no pueden aparecer en "lo mas vendido" ni sumar en el historico.
			SELECT pd.ID_Detalle AS ID_Detalle
			FROM Pago_Detalles pd
			JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
			JOIN rng ON 1=1
			WHERE p.Estado = 'ACTIVO'
				AND p.Fecha_Hora >= rng.hoy_dt
			GROUP BY pd.ID_Detalle
			HAVING MIN(p.Fecha_Hora) < MIN(rng.end_dt)
				OR EXISTS (
					SELECT 1
					FROM Pago_Detalles pd2
					JOIN Pagos p2 ON p2.ID_Pago = pd2.ID_Pago
					JOIN rng r2 ON 1=1
					WHERE pd2.ID_Detalle = pd.ID_Detalle
						AND +p2.Estado = 'ACTIVO'
						AND p2.Fecha_Hora >= r2.start_dt
						AND p2.Fecha_Hora <  r2.hoy_dt
				)
		),
		lineas AS (
			-- Los dias del rango anteriores a hoy, del resumen: cada fila es lo que sumaron ese dia
			-- las lineas de un producto con un mismo nombre, y cada linea esta en el dia de su ultimo
			-- cobro, asi que la que se cobro ayer y otra vez hoy no sale aqui sino abajo. Los sucios,
			-- de los cobros.
			SELECT e.ID_Producto AS ID_Producto, e.Nombre_Producto AS Nombre_Producto, e.Milesimas AS Milesimas
			FROM _Estad_Producto_Dia e
			JOIN rng ON 1=1
			WHERE e.Dia >= date(rng.start_dt)
				AND e.Dia <  date(rng.hoy_dt)
				AND e.Dia NOT IN (SELECT Dia FROM dias)
			UNION ALL
			SELECT ID_Producto, Nombre_Producto, Milesimas FROM sucios
			UNION ALL
			SELECT dc.ID_Producto, dc.Nombre_Producto, CAST(ROUND(COALESCE(dc.Cantidad,1) * 1000) AS INTEGER)
			FROM paid_det cobrada
			JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
		),
		vendido AS (
			-- Se agrupa ANTES de mirar el catalogo: asi el catalogo se consulta una vez por clave y
			-- no una por linea. La clave es el producto o, si la linea ya no lo tiene, su nombre.
			-- Una linea sin producto cuyo nombre es justo el ID de un producto comparte clave con las
			-- de ese producto sin ser suya: por eso van tres sumas, la de todas, la de las que tienen
			-- producto y la de las que no. Si hay lineas con producto, su ID es la clave.
			-- nombre_linea es el de la linea que elige SQLite al agrupar, sin MIN ni MAX que se lo
			-- cambien: el que se ensena cuando el producto ya no esta en el catalogo. Las cantidades
			-- se suman en milesimas enteras, exactas, y vuelven a unidades al final.
			SELECT
				COALESCE(l.ID_Producto, l.Nombre_Producto) AS clave,
				l.Nombre_Producto AS nombre_linea,
				SUM(l.Milesimas) / 1000.0 AS suma,
				SUM(CASE WHEN l.ID_Producto IS NOT NULL THEN l.Milesimas END) / 1000.0 AS suma_con_producto,
				SUM(CASE WHEN l.ID_Producto IS NULL THEN l.Milesimas END) / 1000.0 AS suma_sin_producto
			FROM lineas l
			GROUP BY COALESCE(l.ID_Producto, l.Nombre_Producto)
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
			-- LEFT JOIN y COALESCE en vez de JOIN: el catalogo puede borrar un producto que ya no se
			-- vende (INV-05) y su venta del ano pasado sigue siendo una venta. Con un INNER esas
			-- lineas desaparecerian del historico SIN error. El nombre sale del catalogo si el
			-- producto sigue ahi (asi un renombrado se ve en el informe) y del snapshot de la linea
			-- si ya no esta.
			--
			-- Las lineas de un producto de una categoria no vendible no cuentan. "general" es lo que
			-- cuenta la clave en las listas sin filtro de categoria; "del_producto", lo que cuentan
			-- las lineas del producto, que es lo suyo en "los peores" y dentro de su categoria.
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
		-- El catalogo vendible entero, a cero: el peor producto es justo el que no compra nadie, y
		-- ese no aparece en ninguna linea de comanda. Sus unidades se le ponen al leer el resultado.
		SELECT 0, pr.ID_Producto, pr.Nombre, pr.Nombre, pr.ID_Producto, pr.ID_Categoria, 0, 0, 0, 0
		FROM Productos pr
		JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
		WHERE COALESCE(cat.Vendible,1)=1
		-- El desempate de los cuatro resultados es el nombre del catalogo: se ordena aqui, con el
		-- criterio de SQLite, y al leer el resultado solo se reordena por unidades, sin deshacerlo.
		-- La clave deja fijo el orden de dos productos con el mismo nombre (uno archivado y el que
		-- lo relevo).
		ORDER BY nombre ASC, clave ASC;`;
}

export async function productos(
	db: Client,
	range: StatsRange,
	categoriaTopId: string | null,
	categoriaWorstId: string | null,
): Promise<ProductosStatsResponse> {
	// Los días cerrados del rango se leen del resumen diario: primero, que esté al día.
	await resumenDelRangoAlDia(db, range);
	return productosCon(db, sqlProductos(range), categoriaTopId, categoriaWorstId);
}

/**
 * La estadística de productos a partir de su sentencia (`sqlProductos`). Los tests de equivalencia
 * le pasan la de antes del resumen diario, que recorre los cobros.
 */
export async function productosCon(
	db: Client,
	sql: string,
	categoriaTopId: string | null,
	categoriaWorstId: string | null,
): Promise<ProductosStatsResponse> {
	const filas = rows(await db.execute(sql));
	const vendidos = filas.filter((f) => num(f.de_venta) === 1);
	const catalogo = filas.filter((f) => num(f.de_venta) !== 1);

	// Las unidades de cada producto del catálogo: las de sus líneas. El que no se ha vendido no está
	// y vale 0.
	const unidadesDe = new Map<string, number>();
	for (const v of vendidos) {
		if (v.id_producto != null && v.unidades_producto != null) {
			unidadesDe.set(String(v.id_producto), num(v.unidades_producto));
		}
	}

	// El filtro de categoría de cada lista, el suyo: sin categoría (o en blanco) entra todo.
	const deLaCategoria = (id: string | null) => {
		if (!id || !recortar(id)) return null;
		return (f: any) => f.id_categoria != null && String(f.id_categoria) === id;
	};

	// `sort` es estable: entre dos con las mismas unidades queda el orden por nombre que trae el SQL.
	// «Los mejores» sólo cuentan lo que se ha vendido (suma > 0, sin redondear). Sin filtro de
	// categoría entra todo lo vendido, por su clave. Con filtro entran las líneas de los productos
	// de esa categoría: un producto que ya no está en el catálogo no tiene categoría y no entra en
	// ninguna.
	const mejores = (categoria: string | null, limite: number) => {
		const filtro = deLaCategoria(categoria);
		const lista = filtro
			? vendidos
					.filter(filtro)
					.filter((f) => num(f.con_ventas_producto) === 1)
					.map((f) => ({ label: f.label, value: num(f.unidades_producto) }))
			: vendidos
					.filter((f) => num(f.con_ventas) === 1)
					.map((f) => ({ label: f.label, value: num(f.unidades) }));
		return lista.sort((a, b) => b.value - a.value).slice(0, limite);
	};
	// «Los peores» salen del catálogo, con 0 lo que no ha comprado nadie.
	const peores = (categoria: string | null, limite: number) => {
		const filtro = deLaCategoria(categoria);
		return (filtro ? catalogo.filter(filtro) : catalogo)
			.map((f) => ({ label: f.label, value: unidadesDe.get(String(f.id_producto)) ?? 0 }))
			.sort((a, b) => a.value - b.value)
			.slice(0, limite);
	};

	// El mejor y el peor son de toda la carta; las categorías sólo filtran los dos top 10.
	const best = mejores(null, 1)[0];
	const worst = peores(null, 1)[0];
	const top = mejores(categoriaTopId, 10);
	const worstRows = peores(categoriaWorstId, 10);
	return {
		mejor_producto: best?.label != null ? String(best.label) : null,
		peor_producto_vendible: worst?.label != null ? String(worst.label) : null,
		top10_mejores: { labels: top.map((r) => String(r.label ?? "")), values: top.map((r) => r.value) },
		top10_peores: {
			labels: worstRows.map((r) => String(r.label ?? "")),
			values: worstRows.map((r) => r.value),
		},
	};
}

/**
 * Reservas tiene su PROPIA ventana y su propio bucket, distintos de los del resto de stats: la
 * ventana llega hasta el final del dia de hoy (una reserva de esta noche ya esta hecha aunque aun
 * no haya pasado), y el bucket se calcula sobre la fecha+hora de la reserva, no sobre un cobro.
 */
function rangeBoundsReservas(range: StatsRange): { start: string; end: string } {
	const end = "datetime('now','localtime','start of day','+1 day')";
	if (range === "semana") {
		return { start: "datetime('now','localtime','-6 days','start of day')", end };
	}
	if (range === "mes") return { start: "datetime('now','localtime','start of month')", end };
	if (range === "anio") return { start: "datetime('now','localtime','start of year')", end };
	return { start: "datetime('now','localtime','start of day')", end };
}

function bucketReservas(range: StatsRange): string {
	if (range === "hoy") return "strftime('%H', res_at)";
	if (range === "anio") return "strftime('%m/%Y', res_at)";
	return "strftime('%d/%m', res_at)";
}

export async function reservas(
	db: Client,
	range: StatsRange,
	turno: StatsTurno,
): Promise<ReservasStatsResponse> {
	const { start, end } = rangeBoundsReservas(range);
	const b = bucketReservas(range);

	// El JOIN con Mesas no es decorativo: una reserva cuya mesa ya no existe no cuenta como mesa
	// ocupada, y dejarla dentro descuadraria el reparto reservadas/libres.
	const CTES = `
		WITH
		rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		res AS (
			SELECT
				r.ID_Reserva,
				r.ID_Mesa,
				r.Turno,
				r.Estado,
				datetime(r.Dia_YMD || ' ' || r.Hora) AS res_at
			FROM Reservas r
			JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
		),
		res_rng AS (
			SELECT res.* FROM res, rng
			WHERE res.res_at >= rng.start_dt AND res.res_at < rng.end_dt
		)`;

	// STAT-07: el filtro de turno se aplica SOLO al reparto de mesas. El total, las cancelaciones y
	// las graficas son de todo el rango: si se filtrara en todo, elegir "cena" cambiaria el total de
	// reservas del dia, que no es lo que ese selector significa.
	const turnoFilter =
		turno === "COMIDA" ? "AND Turno='COMIDA'" : turno === "CENA" ? "AND Turno='CENA'" : "";

	const totalMesas = await one(db, "SELECT COUNT(*) AS n FROM Mesas WHERE Archivada_En IS NULL;");
	const total = await one(db, `${CTES} SELECT COUNT(*) AS n FROM res_rng;`);
	const cancel = await one(
		db,
		`${CTES} SELECT COUNT(*) AS n FROM res_rng WHERE COALESCE(Estado,'')='CANCELADA';`,
	);
	const mesasRes = await one(
		db,
		`${CTES}
		 SELECT COUNT(DISTINCT ID_Mesa) AS n FROM res_rng
		 WHERE COALESCE(Estado,'') <> 'CANCELADA' ${turnoFilter};`,
	);
	const bucketRs = await db.execute(
		`${CTES} SELECT ${b} AS label, COUNT(*) AS value FROM res_rng GROUP BY label ORDER BY label ASC;`,
	);
	// Estado y franjas son barras FIJAS, no un GROUP BY: la grafica tiene siempre las mismas tres
	// (o cuatro) columnas aunque alguna valga cero. Agrupando por el valor crudo, un dia sin
	// cancelaciones se quedaria sin esa barra y la grafica cambiaria de forma sola.
	const estado = await one(
		db,
		`${CTES}
		 SELECT
			SUM(CASE WHEN COALESCE(Estado,'')='PROXIMA' THEN 1 ELSE 0 END) AS proximas,
			SUM(CASE WHEN COALESCE(Estado,'')='ACTIVA' THEN 1 ELSE 0 END) AS activas,
			SUM(CASE WHEN COALESCE(Estado,'')='FINALIZADA' THEN 1 ELSE 0 END) AS finalizadas,
			SUM(CASE WHEN COALESCE(Estado,'')='CANCELADA' THEN 1 ELSE 0 END) AS canceladas,
			SUM(CASE WHEN COALESCE(Estado,'')='NO_SHOW' THEN 1 ELSE 0 END) AS no_vinieron
		 FROM res_rng;`,
	);
	const franjas = await one(
		db,
		`${CTES}
		 SELECT
			SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 0  AND 11 THEN 1 ELSE 0 END) AS f1,
			SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 12 AND 15 THEN 1 ELSE 0 END) AS f2,
			SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 16 AND 19 THEN 1 ELSE 0 END) AS f3,
			SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 20 AND 23 THEN 1 ELSE 0 END) AS f4
		 FROM res_rng;`,
	);

	const br = rows(bucketRs);
	const reservadas = num(mesasRes.n);
	return {
		total_reservas: num(total.n),
		cancelaciones: num(cancel.n),
		mesas_turno: {
			turno,
			mesas_reservadas: reservadas,
			mesas_no_reservadas: Math.max(0, num(totalMesas.n) - reservadas),
		},
		reservas_por_bucket: {
			labels: br.map((r) => String(r.label ?? "")),
			values: br.map((r) => num(r.value)),
		},
		estado: {
			// Los cinco estados de una reserva, como la Main.
			labels: ["Por llegar", "En la mesa", "Terminadas", "Canceladas", "No vinieron"],
			values: [
				num(estado.proximas),
				num(estado.activas),
				num(estado.finalizadas),
				num(estado.canceladas),
				num(estado.no_vinieron),
			],
		},
		franjas: {
			labels: ["00-11", "12-15", "16-19", "20-23"],
			values: [num(franjas.f1), num(franjas.f2), num(franjas.f3), num(franjas.f4)],
		},
	};
}

// STAT-03: una jornada auto-cerrada por olvido de fichar la salida imputa una jornada estandar en
// vez de 0 horas. El mismo numero que usa la Main.
const HORAS_JORNADA_SIN_SALIDA = 8;

/**
 * Fecha-hora de un fichaje. La columna puede traer ya la fecha dentro ("2026-05-10 09:00:00") o solo
 * la hora ("09:00"), asi que se compone con `Fecha` cuando hace falta.
 */
function fichajeDt(col: string): string {
	return `CASE WHEN f.${col} LIKE '%-%' THEN datetime(f.${col}) ELSE datetime(f.Fecha || ' ' || f.${col}) END`;
}

/**
 * Tarjetas y ranking de trabajadores.
 *
 * STAT-07: esto devolvia las tarjetas con las tareas, las horas y el ranking a CERO FIJO, la
 * puntualidad nula, y clasificaba por el texto libre de `Puesto` en vez de por el rol de la tabla
 * `Roles`. En la Handy la pantalla enseñaba ceros. Portado desde `stats.rs` para que las dos digan
 * lo mismo: siete consultas y un ensamblaje, exactamente las de la Main.
 */
export async function trabajadores(
	db: Client,
	range: StatsRange,
): Promise<TrabajadoresStatsResponse> {
	const { start, end } = rangeBounds(range);
	const vacio: TrabajadoresStatsResponse = {
		cocineros: [],
		camareros: [],
		limpieza: [],
		ranking_ventas: { labels: [], values: [] },
	};

	// La base son los trabajadores con un ROL de los tres que tienen tarjeta. El rol sale de la
	// tabla Roles, no del texto libre de Puesto: `Puesto` lo escribe una persona y "cocinero jefe",
	// "Cocina" o un dedazo caerian en cubos distintos segun quien lo teclee.
	const baseRs = await db.execute(`
		SELECT
			t.ID_Trabajador AS id_trabajador,
			u.ID_Usuario AS id_usuario,
			u.Nombre AS nombre,
			u.Apellido AS apellido,
			r.Nombre_Rol AS rol
		FROM Trabajadores t
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		JOIN Roles r ON r.ID_Rol = u.ID_Rol
		WHERE r.Nombre_Rol IN ('Cocinero','Camarero','Limpieza')
		ORDER BY r.Nombre_Rol ASC, u.Nombre ASC;
	`);
	const base = rows(baseRs)
		.map((r) => {
			const nombre = recortar(String(r.nombre ?? ""));
			const apellido = recortar(String(r.apellido ?? ""));
			return {
				id_trabajador: String(r.id_trabajador ?? ""),
				id_usuario: String(r.id_usuario ?? ""),
				nombre: apellido ? `${nombre} ${apellido}` : nombre,
				rol: String(r.rol ?? ""),
			};
		})
		.filter((w) => w.id_trabajador !== "" && w.id_usuario !== "");

	if (base.length === 0) return vacio;

	const porClave = (filas: any[], clave: string, valor: string): Map<string, number> => {
		const m = new Map<string, number>();
		for (const r of filas) {
			const k = String(r[clave] ?? "");
			if (k) m.set(k, num(r[valor]));
		}
		return m;
	};

	// Tareas: asignadas y finalizadas DENTRO del rango, cada una por su propia fecha.
	const tareasRs = await db.execute(`
		WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		SELECT
			ID_Trabajador AS id,
			SUM(CASE WHEN datetime(Asignada_At) >= (SELECT start_dt FROM rng)
					  AND datetime(Asignada_At) <  (SELECT end_dt FROM rng)
					 THEN 1 ELSE 0 END) AS asignadas,
			SUM(CASE WHEN COALESCE(Estado,'')='FINALIZADA'
					  AND Finalizada_At IS NOT NULL
					  AND datetime(Finalizada_At) >= (SELECT start_dt FROM rng)
					  AND datetime(Finalizada_At) <  (SELECT end_dt FROM rng)
					 THEN 1 ELSE 0 END) AS finalizadas
		FROM Tarea_Asignaciones
		GROUP BY ID_Trabajador;
	`);
	const tareas = rows(tareasRs);
	const tareasAsig = porClave(tareas, "id", "asignadas");
	const tareasFin = porClave(tareas, "id", "finalizadas");

	// Cocina: comandas distintas que ha tocado, por ID_USUARIO (asi lo guarda Detalle_Comanda).
	const cocRs = await db.execute(`
		WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		SELECT ID_Usuario_Cocinero AS id, COUNT(DISTINCT ID_Comanda) AS n
		FROM Detalle_Comanda
		WHERE ID_Usuario_Cocinero IS NOT NULL
			AND Fecha_Hora_Cocina IS NOT NULL
			AND datetime(Fecha_Hora_Cocina) >= (SELECT start_dt FROM rng)
			AND datetime(Fecha_Hora_Cocina) <  (SELECT end_dt FROM rng)
		GROUP BY ID_Usuario_Cocinero;
	`);
	const cocComandas = porClave(rows(cocRs), "id", "n");

	// Sala: comandas abiertas por cada camarero.
	const camComRs = await db.execute(`
		WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		SELECT ID_Trabajador AS id, COUNT(*) AS n
		FROM Comandas
		WHERE ID_Trabajador IS NOT NULL
			AND Fecha_Hora_Apertura >= (SELECT start_dt FROM rng)
			AND Fecha_Hora_Apertura <  (SELECT end_dt FROM rng)
		GROUP BY ID_Trabajador;
	`);
	const camComandas = porClave(rows(camComRs), "id", "n");

	// Cobros: solo los de quien tiene rol Camarero.
	const cobrosRs = await db.execute(`
		WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		SELECT p.ID_Trabajador_Cobrador AS id, COUNT(*) AS n
		FROM Pagos p
		JOIN rng ON 1=1
		JOIN Trabajadores t ON t.ID_Trabajador = p.ID_Trabajador_Cobrador
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		JOIN Roles r ON r.ID_Rol = u.ID_Rol
		WHERE p.Fecha_Hora >= rng.start_dt
			AND p.Fecha_Hora <  rng.end_dt
			AND p.Estado = 'ACTIVO'
			AND p.ID_Trabajador_Cobrador IS NOT NULL
			AND p.ID_Pago_Origen IS NULL
			AND r.Nombre_Rol = 'Camarero'
		GROUP BY p.ID_Trabajador_Cobrador;
	`);
	const camCobros = porClave(rows(cobrosRs), "id", "n");

	// Ventas y ticket medio: se agrupa PRIMERO por comanda y luego se promedia. Promediar los pagos
	// sueltos daria un "ticket medio" que en realidad es el importe medio de cada cobro parcial.
	const salesRs = await db.execute(`
		WITH
		rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		pagos_rng AS (
			SELECT ID_Comanda, COALESCE(Importe_Total,0) AS imp
			FROM Pagos, rng
			WHERE Fecha_Hora >= rng.start_dt AND Fecha_Hora < rng.end_dt
			  AND Estado = 'ACTIVO'
		),
		comanda_trab AS (
			SELECT ID_Comanda, ID_Trabajador FROM Comandas WHERE ID_Trabajador IS NOT NULL
		),
		comanda_tot AS (
			SELECT c.ID_Trabajador AS id_trabajador, p.ID_Comanda AS id_comanda, SUM(p.imp) AS total
			FROM pagos_rng p
			JOIN comanda_trab c ON c.ID_Comanda = p.ID_Comanda
			GROUP BY c.ID_Trabajador, p.ID_Comanda
		)
		SELECT
			id_trabajador AS id,
			COALESCE(SUM(total),0) AS ventas_total,
			CAST(ROUND(COALESCE(AVG(total),0)) AS INTEGER) AS ticket_medio
		FROM comanda_tot
		GROUP BY id_trabajador;
	`);
	const sales = rows(salesRs);
	const camVentas = porClave(sales, "id", "ventas_total");
	const camTicket = porClave(sales, "id", "ticket_medio");

	// Horas: se suman todos los tramos del rango. Un turno partido son filas separadas (columna
	// Parte), no columnas extra, asi que basta con sumar por trabajador.
	const entDt = fichajeDt("Hora_Entrada");
	const salDt = fichajeDt("Hora_Salida");
	const horasRs = await db.execute(`
		WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		SELECT
			t.ID_Trabajador AS id,
			ROUND(COALESCE(SUM(
				CASE
					WHEN f.Hora_Entrada IS NOT NULL AND f.Hora_Salida IS NOT NULL
					 AND ${entDt} >= rng.start_dt AND ${entDt} < rng.end_dt
					THEN max(0, (julianday(${salDt}) - julianday(${entDt})) * 24.0)
					WHEN f.Hora_Entrada IS NOT NULL AND f.Hora_Salida IS NULL
					 AND f.Cerrado_Automatico = 1
					 AND ${entDt} >= rng.start_dt AND ${entDt} < rng.end_dt
					THEN ${HORAS_JORNADA_SIN_SALIDA}
					ELSE 0
				END
			),0),2) AS horas
		FROM Trabajadores t
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		LEFT JOIN Fichajes f ON f.ID_Usuario = u.ID_Usuario
		JOIN rng ON 1=1
		GROUP BY t.ID_Trabajador;
	`);
	const horas = porClave(rows(horasRs), "id", "horas");

	// Puntualidad: el ULTIMO turno programado del rango que ademas tenga fichaje ese dia, y si se
	// llego a tiempo. Solo uno por trabajador, que es lo que la tarjeta enseña.
	const puntRs = await db.execute(`
		WITH
		rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		asig AS (
			SELECT
				a.ID_Trabajador, t.ID_Usuario, a.Fecha, a.Hora_Inicio,
				datetime(a.Fecha || ' ' || a.Hora_Inicio) AS prog_dt
			FROM Asignacion_Turnos a
			JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
			WHERE a.Hora_Inicio IS NOT NULL
				AND datetime(a.Fecha || ' ' || a.Hora_Inicio) >= (SELECT start_dt FROM rng)
				AND datetime(a.Fecha || ' ' || a.Hora_Inicio) <  (SELECT end_dt FROM rng)
		),
		fich AS (
			SELECT ID_Usuario, Fecha, MIN(datetime(Fecha || ' ' || Hora_Entrada)) AS ent_dt
			FROM Fichajes WHERE Hora_Entrada IS NOT NULL
			GROUP BY ID_Usuario, Fecha
		),
		joined AS (
			SELECT a.ID_Trabajador, a.Fecha, a.prog_dt, f.ent_dt
			FROM asig a
			JOIN fich f ON f.ID_Usuario = a.ID_Usuario AND f.Fecha = a.Fecha
		),
		ranked AS (
			SELECT
				ID_Trabajador, prog_dt, ent_dt,
				ROW_NUMBER() OVER (PARTITION BY ID_Trabajador ORDER BY date(Fecha) DESC, prog_dt ASC) AS rn
			FROM joined
		)
		SELECT
			ID_Trabajador AS id,
			strftime('%H:%M', prog_dt) AS programado,
			strftime('%H:%M', ent_dt) AS entrada,
			CASE WHEN ent_dt <= prog_dt THEN 1 ELSE 0 END AS puntual,
			CAST(MAX(0, ROUND((julianday(ent_dt) - julianday(prog_dt)) * 24 * 60, 0)) AS INTEGER) AS minutos_retraso
		FROM ranked
		WHERE rn = 1;
	`);
	const puntualidad = new Map<string, any>();
	for (const r of rows(puntRs)) {
		const id = String(r.id ?? "");
		if (!id) continue;
		const mins = num(r.minutos_retraso);
		puntualidad.set(id, {
			puntual: num(r.puntual) === 1,
			programado: String(r.programado ?? ""),
			entrada: String(r.entrada ?? ""),
			minutos_retraso: mins < 0 ? 0 : mins,
		});
	}

	const cocineros: any[] = [];
	const camareros: any[] = [];
	const limpieza: any[] = [];

	for (const w of base) {
		const comun = {
			id_trabajador: w.id_trabajador,
			nombre: w.nombre,
			tareas_asignadas: tareasAsig.get(w.id_trabajador) ?? 0,
			tareas_finalizadas: tareasFin.get(w.id_trabajador) ?? 0,
			puntualidad: puntualidad.get(w.id_trabajador) ?? null,
			horas_trabajadas: horas.get(w.id_trabajador) ?? 0,
		};
		if (w.rol === "Cocinero") {
			cocineros.push({
				...comun,
				rol: "Cocinero",
				comandas_preparadas: cocComandas.get(w.id_usuario) ?? 0,
				comandas_tomadas: null,
				cobros_realizados: null,
				ticket_medio: null,
			});
		} else if (w.rol === "Camarero") {
			camareros.push({
				...comun,
				rol: "Camarero",
				comandas_preparadas: null,
				comandas_tomadas: camComandas.get(w.id_trabajador) ?? 0,
				cobros_realizados: camCobros.get(w.id_trabajador) ?? 0,
				ticket_medio: camTicket.get(w.id_trabajador) ?? 0,
			});
		} else {
			limpieza.push({
				...comun,
				rol: "Limpieza",
				comandas_preparadas: null,
				comandas_tomadas: null,
				cobros_realizados: null,
				ticket_medio: null,
			});
		}
	}

	// El ranking es solo de camareros, por ventas, de mas a menos. Orden estable: se recorre `base`,
	// que ya viene ordenada por rol y nombre, y se reordena por ventas conservando ese orden en los
	// empates (Array.prototype.sort es estable).
	const ranking = base
		.filter((w) => w.rol === "Camarero")
		.map((w) => ({ nombre: w.nombre, ventas: camVentas.get(w.id_trabajador) ?? 0 }))
		.sort((a, b) => b.ventas - a.ventas);

	return {
		cocineros,
		camareros,
		limpieza,
		ranking_ventas: {
			labels: ranking.map((r) => r.nombre),
			values: ranking.map((r) => r.ventas),
		},
	} as unknown as TrabajadoresStatsResponse;
}

export async function clientes(
	db: Client,
	range: StatsRange,
): Promise<ClientesStatsResponse> {
	const { start, end } = rangeBounds(range);
	const hasClientes = await tableExists(db, "Clientes");
	if (!hasClientes) {
		return {
			nuevos: 0,
			recurrentes: 0,
			no_recurrentes: 0,
			ticket_medio_cliente: CERO,
			nuevos_por_bucket: { labels: [], values: [] },
			top_clientes_gasto: { labels: [], values: [] },
		};
	}

	const altaDt = "datetime(cl.Created_At)";
	const b = bucket(range, altaDt);
	const nuevos = await one(
		db,
		`WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		 SELECT COUNT(*) AS n
		 FROM Clientes cl, rng
		 WHERE cl.Created_At IS NOT NULL AND ${altaDt} >= rng.start_dt AND ${altaDt} < rng.end_dt;`,
	);
	const evoRs = await db.execute(
		`WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
		 SELECT ${b} AS label, COUNT(*) AS value
		 FROM Clientes cl, rng
		 WHERE cl.Created_At IS NOT NULL AND ${altaDt} >= rng.start_dt AND ${altaDt} < rng.end_dt
		 GROUP BY label ORDER BY label ASC;`,
	);

	// STAT-07: recurrentes, no recurrentes y ticket medio se calculaban a cero fijo.
	//
	// Un cliente es "recurrente" si compro en este rango y ademas YA habia comprado antes de que el
	// rango empezara. Por eso no basta con mirar el rango: hace falta la fecha de su PRIMER cobro de
	// toda la historia (`firsts`) y compararla con el inicio de la ventana. El cliente se identifica
	// por la reserva de la comanda, que es el unico hilo que ata un cobro a una persona.
	//
	// `allp` va MATERIALIZED: la leen tres CTE, y sin esa palabra SQLite la deshace dentro de cada
	// una y recorre tres veces todos los cobros de la historia. Asi los recorre una. El resultado
	// es el mismo; igual en la Main (`sql_clientes_recurrentes`).
	const rec = await one(
		db,
		`WITH
		 rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		 allp AS MATERIALIZED (
			SELECT
				r.ID_Cliente AS id_cliente,
				datetime(p.Fecha_Hora) AS paid_at,
				COALESCE(p.Importe_Total,0) AS imp
			FROM Pagos p
			JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
			JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
			WHERE c.ID_Reserva IS NOT NULL
				AND r.ID_Cliente IS NOT NULL
				AND p.Fecha_Hora IS NOT NULL
				AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
		 ),
		 cust_range AS (
			SELECT DISTINCT id_cliente FROM allp, rng
			WHERE paid_at >= rng.start_dt AND paid_at < rng.end_dt
		 ),
		 firsts AS (
			SELECT id_cliente, MIN(paid_at) AS first_paid FROM allp GROUP BY id_cliente
		 ),
		 tot_range AS (
			SELECT id_cliente, SUM(imp) AS total FROM allp, rng
			WHERE paid_at >= rng.start_dt AND paid_at < rng.end_dt
			GROUP BY id_cliente
		 )
		 SELECT
			(SELECT COUNT(*) FROM cust_range cr
			 JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
			 WHERE f.first_paid < rng.start_dt) AS recurrentes,
			(SELECT COUNT(*) FROM cust_range cr
			 JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
			 WHERE f.first_paid >= rng.start_dt AND f.first_paid < rng.end_dt) AS no_recurrentes,
			COALESCE((SELECT SUM(total) FROM tot_range),0) AS ventas_total,
			(SELECT COUNT(*) FROM cust_range) AS clientes_rango;`,
	);
	const clientesRango = num(rec.clientes_rango);

	const nombre =
		"CASE WHEN COALESCE(trim(Nombre),'') <> '' THEN trim(Nombre) ELSE 'Cliente' END";
	const topRs = await db.execute(
		`SELECT
			(${nombre} || ' #' || CAST(ID_Cliente AS TEXT)) AS label,
			COALESCE(Total_Gastado,0) AS value
		 FROM Clientes
		 ORDER BY COALESCE(Total_Gastado,0) DESC, label ASC
		 LIMIT 10;`,
	);

	const evo = rows(evoRs);
	const top = rows(topRs);
	return {
		nuevos: num(nuevos.n),
		recurrentes: num(rec.recurrentes),
		no_recurrentes: num(rec.no_recurrentes),
		ticket_medio_cliente:
			clientesRango > 0 ? entre(deLaBase(rec.ventas_total), clientesRango) : CERO,
		nuevos_por_bucket: {
			labels: evo.map((r) => String(r.label ?? "")),
			values: evo.map((r) => num(r.value)),
		},
		top_clientes_gasto: {
			labels: top.map((r) => String(r.label ?? "")),
			values: top.map((r) => deLaBase(r.value)),
		},
	};
}

export async function proveedores(
	db: Client,
	range: StatsRange,
): Promise<ProveedoresStatsResponse> {
	if (!(await tableExists(db, "Cuentas_Gastos"))) {
		return {
			total_gasto: CERO,
			num_gastos: 0,
			gasto_medio: CERO,
			porcentaje_sobre_total_gastos: 0,
			proveedor_top: null,
			gastos_evolucion: { labels: [], values: [] },
			gasto_por_proveedor: { labels: [], values: [] },
			ultimos_gastos: [],
		};
	}
	const { start, end } = rangeBounds(range);
	const dt = "CASE WHEN cg.Fecha LIKE '%:%' THEN datetime(cg.Fecha) ELSE datetime(cg.Fecha || ' 00:00:00') END";
	const b = bucket(range, dt);
	const filter = "AND (cg.ID_Proveedor IS NOT NULL OR lower(COALESCE(cg.Tipo_Gasto,'')) LIKE '%proveedor%')";
	// STAT-07: el nombre que se pinta. Un gasto con proveedor cuya ficha ya no esta (o tiene el
	// nombre en blanco) sale como "Proveedor #id", no como "Sin proveedor": son dos cosas distintas
	// y mezclarlas juntaria en una sola barra gastos que no son del mismo sitio.
	const nombreProveedor = `
		CASE
			WHEN cg.ID_Proveedor IS NOT NULL THEN
				COALESCE(NULLIF(trim(p.Nombre_Empresa),''), ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT)))
			ELSE 'Sin proveedor'
		END`;
	// El denominador del porcentaje: TODO el gasto del rango, con proveedor o sin el.
	const totalTodos = await one(
		db,
		`SELECT COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
		 FROM Cuentas_Gastos cg
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end};`,
	);
	const total = await one(
		db,
		`SELECT COALESCE(SUM(cg.Importe),0) AS total, COUNT(*) AS n
		 FROM Cuentas_Gastos cg
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter};`,
	);
	const top = await one(
		db,
		`SELECT ${nombreProveedor} AS nombre, COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY nombre ORDER BY total DESC, nombre ASC LIMIT 1;`,
	);
	const evoRs = await db.execute(
		`SELECT ${b} AS label, SUM(cg.Importe) AS value
		 FROM Cuentas_Gastos cg
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY label ORDER BY label ASC;`,
	);
	const barRs = await db.execute(
		`SELECT ${nombreProveedor} AS label, COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS value
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 GROUP BY label ORDER BY value DESC, label ASC LIMIT 12;`,
	);
	const lastRs = await db.execute(
		`SELECT strftime('%Y-%m-%d', ${dt}) AS fecha, ${nombreProveedor} AS proveedor, COALESCE(cg.Concepto,'') AS concepto, COALESCE(cg.Importe,0) AS importe
		 FROM Cuentas_Gastos cg
		 LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor
		 WHERE cg.Fecha IS NOT NULL AND ${dt} >= ${start} AND ${dt} < ${end} ${filter}
		 ORDER BY datetime(${dt}) DESC LIMIT 10;`,
	);
	const evo = rows(evoRs);
	const bar = rows(barRs);
	const last = rows(lastRs);
	return {
		total_gasto: deLaBase(total.total),
		num_gastos: num(total.n),
		gasto_medio: num(total.n) > 0 ? entre(deLaBase(total.total), num(total.n)) : CERO,
		porcentaje_sobre_total_gastos:
			Math.abs(num(totalTodos.total)) > 0.000001
				? Math.round((num(total.total) / num(totalTodos.total)) * 100 * 100) / 100
				: 0,
		proveedor_top: top.nombre
			? { nombre: String(top.nombre), total: deLaBase(top.total) }
			: null,
		gastos_evolucion: {
			labels: evo.map((r) => String(r.label ?? "")),
			values: evo.map((r) => deLaBase(r.value)),
		},
		gasto_por_proveedor: {
			labels: bar.map((r) => String(r.label ?? "")),
			values: bar.map((r) => deLaBase(r.value)),
		},
		ultimos_gastos: last.map((r) => ({
			fecha: String(r.fecha ?? ""),
			proveedor: String(r.proveedor ?? ""),
			concepto: String(r.concepto ?? ""),
			importe: deLaBase(r.importe),
		})),
	};
}
