// test/statsProductosUnaPasada.test.ts
//
// La estadística de productos se calcula en UNA pasada (`sqlProductos`) y tiene que dar
// EXACTAMENTE lo que daban las cuatro sentencias de antes: mismo mejor, mismo peor y los mismos
// top 10, en el mismo orden.
//
// Con un negocio de mucho movimiento, `/v1/stats/productos` tardaba más de lo que el Durable Object
// deja a una petición: cada una de las cuatro sentencias volvía a calcular las líneas cobradas del
// rango, y las dos de «el peor» recorrían además toda la historia de cada producto. Como la base de
// un negocio es el SQLite de un DO de un solo hilo, mientras tanto no se atendía a nadie más.
//
// Aquí se conservan las cuatro sentencias de antes como referencia y se comparan con lo de ahora
// sobre la siembra del caso de contrato `stats/productos_vendidos`, que lleva lo que puede torcer
// el resultado (empates, archivados, una categoría no vendible, cobros anulados y partidos,
// productos borrados del catálogo, decimales) y ventas de otros días, para que la semana, el mes y
// el año no sean lo mismo que hoy. Y sobre la del caso `stats/productos_nombre_que_es_un_id`: una
// línea sin producto cuyo nombre es el ID de un producto, que comparte clave con las de ese
// producto sin ser suya. La Main hace la misma comparación con su propia copia
// (`tests_productos_en_una_pasada` en `tpv-infra-sqlite/src/stats.rs`), y el arnés de lectura fija
// que los dos lados dan lo mismo.

import type { Client } from "@libsql/client/web";
import { describe, expect, it } from "vitest";

import type { ProductosStatsResponse } from "@tpv/contracts";

import caso from "../../../tests/contract/lecturas/casos/stats/productos_vendidos.json";
import casoNombreId from "../../../tests/contract/lecturas/casos/stats/productos_nombre_que_es_un_id.json";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { recortar } from "../src/lib/texto";
import { productos, sqlProductos } from "../src/domains/stats/stats.queries";
import type { StatsRange } from "../src/domains/stats/stats.schemas";

// ── Las cuatro sentencias de antes, tal cual estaban ─────────────────────────────────────────────

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

async function one(db: Client, sql: string, args: any[] = []): Promise<any> {
	const rs = await db.execute({ sql, args });
	return rows(rs)[0] ?? {};
}

async function productosAntes(
	db: Client,
	range: StatsRange,
	categoriaTopId: string | null,
	categoriaWorstId: string | null,
): Promise<ProductosStatsResponse> {
	const { start, end } = rangeBounds(range);

	// STAT-07: `paid_det` en vez de unir Pago_Detalles con Pagos a pelo. Una linea cobrada en dos
	// veces aparece dos veces en ese cruce y sus unidades se contarian dobles; con MIN(Fecha_Hora)
	// cada linea entra una vez y por la fecha de su PRIMER cobro, que es cuando se vendio.
	const CTES = `
		WITH
		rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
		paid_det AS (
			-- Solo pagos ACTIVOS (CUENTA-07): un ticket anulado no es una venta, asi que sus
			-- lineas no pueden aparecer en "lo mas vendido" ni sumar en el historico.
			-- El rango va AQUI y no fuera (RI-18): fuera, la CTE agrupaba todos los cobros de la
			-- historia antes de filtrar. Mismo resultado: lo de fuera de rango ya no contaba.
			SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
			FROM Pago_Detalles pd
			JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
			JOIN rng ON 1=1
			WHERE p.Estado = 'ACTIVO'
				AND p.Fecha_Hora >= rng.start_dt
				AND p.Fecha_Hora <  rng.end_dt
			GROUP BY pd.ID_Detalle
		)`;

	// LEFT JOIN y COALESCE en vez de JOIN: el catalogo puede borrar un producto que ya no se vende
	// (INV-05) y su venta del ano pasado sigue siendo una venta. Con un INNER esas lineas
	// desapareceran del historico SIN error. El nombre sale del catalogo si el producto sigue ahi
	// (asi un renombrado se ve en el informe) y del snapshot de la linea si ya no esta.
	const NOMBRE = "COALESCE(pr.Nombre, dc.Nombre_Producto, 'Producto')";
	const AGRUPA = "COALESCE(dc.ID_Producto, dc.Nombre_Producto)";

	// Lo VENDIDO en el rango. Se parte de las lineas cobradas.
	const vendidoSql = (filtro: string, orden: string, limite: number) => `
		${CTES}
		SELECT
			${NOMBRE} AS label,
			CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS value
		FROM Detalle_Comanda dc
		JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
		JOIN rng ON 1=1
		LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
		LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
		WHERE pd.paid_at >= rng.start_dt
			AND pd.paid_at < rng.end_dt
			AND COALESCE(cat.Vendible,1)=1
			${filtro}
		GROUP BY ${AGRUPA}
		HAVING SUM(COALESCE(dc.Cantidad,1)) > 0
		ORDER BY value ${orden}, pr.Nombre ASC
		LIMIT ${limite};`;

	// El PEOR parte del CATALOGO, no de lo vendido. Es la diferencia importante: el peor producto
	// vendible es justo el que no compra nadie, y ese no aparece en ninguna linea de comanda. Por eso
	// aqui se sale de Productos y las ventas entran por LEFT JOIN, contando 0 cuando no las hay.
	const noVendidoSql = (filtro: string, limite: number) => `
		${CTES}
		SELECT
			pr.Nombre AS label,
			CAST(ROUND(COALESCE(SUM(
				CASE WHEN pd.paid_at >= rng.start_dt AND pd.paid_at < rng.end_dt
					 THEN COALESCE(dc.Cantidad,1)
					 ELSE 0
				END
			),0),0) AS INTEGER) AS value
		FROM Productos pr
		JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
		LEFT JOIN Detalle_Comanda dc ON dc.ID_Producto = pr.ID_Producto
		LEFT JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
		JOIN rng ON 1=1
		WHERE COALESCE(cat.Vendible,1)=1
			${filtro}
		GROUP BY pr.ID_Producto
		ORDER BY value ASC, pr.Nombre ASC
		LIMIT ${limite};`;

	const topFilter = categoriaTopId && recortar(categoriaTopId) ? "AND pr.ID_Categoria = ?1" : "";
	const worstFilter =
		categoriaWorstId && recortar(categoriaWorstId) ? "AND pr.ID_Categoria = ?1" : "";

	const best = await one(db, vendidoSql("", "DESC", 1));
	const worst = await one(db, noVendidoSql("", 1));

	const topRs = await db.execute({
		sql: vendidoSql(topFilter, "DESC", 10),
		args: topFilter ? [categoriaTopId] : [],
	});
	const worstRs = await db.execute({
		sql: noVendidoSql(worstFilter, 10),
		args: worstFilter ? [categoriaWorstId] : [],
	});

	const top = rows(topRs);
	const worstRows = rows(worstRs);
	return {
		mejor_producto: best.label != null ? String(best.label) : null,
		peor_producto_vendible: worst.label != null ? String(worst.label) : null,
		top10_mejores: { labels: top.map((r) => String(r.label ?? "")), values: top.map((r) => num(r.value)) },
		top10_peores: {
			labels: worstRows.map((r) => String(r.label ?? "")),
			values: worstRows.map((r) => num(r.value)),
		},
	};
}

// ── La comparación ───────────────────────────────────────────────────────────────────────────────

const RANGOS: StatsRange[] = ["hoy", "semana", "mes", "anio"];

/** Sin filtro, en blanco (que es sin filtro), cada categoría, la no vendible y una que no existe. */
const CATEGORIAS = [null, "  ", "cat-platos", "cat-bebidas", "cat-postres", "cat-materia", "cat-que-no-existe"];

/** La base de un negocio en el SQLite de un Durable Object, con la siembra de un caso de contrato. */
async function conLaSiembra<R>(
	nombre: string,
	prueba: (db: Client, sql: any) => Promise<R>,
	siembra: string[] = caso.seed,
): Promise<R> {
	return enElHub(`stats-productos-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const sentencia of siembra) sql.exec(sentencia);
		return prueba(clienteSobre(sql) as unknown as Client, sql);
	});
}

/** Lo de antes y lo de ahora, en los cuatro rangos y con cada pareja de filtros. */
async function comparar(db: Client, siembra: string) {
	for (const range of RANGOS) {
		for (const top of CATEGORIAS) {
			for (const worst of CATEGORIAS) {
				const antes = await productosAntes(db, range, top, worst);
				const ahora = await productos(db, range, top, worst);
				expect(ahora, `${siembra}: ${range}, top ${top}, peores ${worst}`).toEqual(antes);
			}
		}
	}
}

describe("la estadística de productos en una pasada", () => {
	it("da lo mismo que las cuatro sentencias de antes, en todos los rangos y con cada filtro", async () => {
		await conLaSiembra("equivalencia", (db) => comparar(db, "ventas"));
		await conLaSiembra("equivalencia-nombre-id", (db) => comparar(db, "nombre que es un ID"), casoNombreId.seed);
	});

	it("una línea sin producto no es del producto cuyo ID lleva por nombre", async () => {
		await conLaSiembra(
			"nombre-id",
			async (db) => {
				// Sin filtro, lo de la clave va junto: P-7 son 10,13 del producto y 0,37 de la línea
				// suelta, 10,5 que redondean a 11 (sumando por partes saldría 10,499… y 10). M-1 no es
				// vendible: sólo queda su línea suelta.
				const todo = await productos(db, "hoy", null, null);
				expect(todo.top10_mejores).toEqual({ labels: ["P-7", "M-1", "Agua"], values: [11, 6, 1] });
				// En «los peores» y en una categoría sólo cuentan las líneas del producto.
				expect(todo.top10_peores).toEqual({ labels: ["Agua", "P-7"], values: [1, 10] });
				const bebidas = await productos(db, "hoy", "cat-bebidas", "cat-bebidas");
				expect(bebidas.top10_mejores).toEqual({ labels: ["P-7", "Agua"], values: [10, 1] });
			},
			casoNombreId.seed,
		);
	});

	it("la siembra ejercita los empates, el corte y el orden de SQLite", async () => {
		// Si la siembra dejara de vender nada hoy, la comparación de arriba pasaría en vacío.
		await conLaSiembra("siembra", async (db) => {
			const todo = await productos(db, "hoy", null, null);
			expect(todo.mejor_producto).toBe("Cerveza");
			expect(todo.peor_producto_vendible).toBe("Agua");
			expect(todo.top10_mejores.labels).toHaveLength(10);
			expect(todo.top10_peores.labels).toHaveLength(10);
			// Los borrados del catálogo van delante en su empate, y entre ellos por su nombre.
			expect(todo.top10_mejores.labels.slice(0, 7)).toEqual([
				"Cerveza", "Croquetas", "Tortilla", "Bocadillo retirado", "Menú antiguo", "Ensalada", "Paella",
			]);
			expect(todo.top10_mejores.values.slice(0, 7)).toEqual([6, 5, 5, 4, 4, 4, 4]);

			// Cuatro platos empatan a 2 y sólo caben tres: se queda fuera el último por nombre.
			const platos = await productos(db, "hoy", "cat-platos", "cat-bebidas");
			expect(platos.top10_mejores.labels.slice(7)).toEqual(["Alitas", "Jamón", "Pulpo"]);

			// El orden es el de SQLite, por bytes: U+FF46 va antes que U+1F37A. Comparando las cadenas
			// en JavaScript (UTF-16) saldrían al revés, y la Handy no diría lo mismo que la Main.
			const bebidas = await productos(db, "hoy", "cat-bebidas", null);
			const pos = (nombre: string) => bebidas.top10_mejores.labels.indexOf(nombre);
			expect(pos("ｆ Fanta")).toBeGreaterThan(-1);
			expect(pos("ｆ Fanta")).toBeLessThan(pos("🍺 Jarra"));
			expect("ｆ Fanta" < "🍺 Jarra").toBe(false);
		});
	});

	it("es una sola sentencia, y entra a los cobros una vez y por el rango", async () => {
		await conLaSiembra("plan", async (db, sql) => {
			const sentencias: string[] = [];
			const espia = {
				execute: (entrada: any) => {
					sentencias.push(typeof entrada === "string" ? entrada : entrada.sql);
					return db.execute(entrada);
				},
			} as unknown as Client;
			await productos(espia, "anio", "cat-platos", "cat-bebidas");
			expect(sentencias).toHaveLength(1);

			// El plan en el SQLite del DO, sin estadísticas: los cobros entran por su fecha, las
			// líneas por su clave, y nada recorre el histórico de cobros ni de líneas.
			const plan = sql
				.exec(`EXPLAIN QUERY PLAN ${sqlProductos("anio")}`)
				.toArray()
				.map((f: any) => String(f.detail));
			expect(plan).toContain(
				"SEARCH p USING INDEX idx_pagos_estado_fecha (Estado=? AND Fecha_Hora>? AND Fecha_Hora<?)",
			);
			expect(plan).toContain("SEARCH pd USING COVERING INDEX sqlite_autoindex_Pago_Detalles_1 (ID_Pago=?)");
			expect(plan).toContain("SEARCH dc USING INDEX sqlite_autoindex_Detalle_Comanda_1 (ID_Detalle=?)");
			expect(plan.filter((l: string) => /^SCAN (p|pd|dc)( |$)/.test(l))).toEqual([]);
			expect(plan.filter((l: string) => l.startsWith("SEARCH p "))).toHaveLength(1);
		});
	});
});
