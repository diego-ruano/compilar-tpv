// test/precioNegativo.test.ts
//
// AUD-17: un precio de venta negativo no entra por la API de la Handy.
//
// El esquema deja «Precio_Venta >= 0» a la capa de aplicación (DB-06) y nadie lo comprobaba: una
// Handy daba de alta un producto a −50 €, el DO lo guardaba y lo replicaba tal cual a la Main, y
// allí el cobro de mesa quedaba ACTIVO en −50 € con el arqueo cuadrado. Aquí se recorre el camino de
// la Handy de verdad: la ruta `POST /v1/inventario/productos` con su validador, el `apply` y el
// `applyViaHub` reales y el lote que aplica el DO (`buildApplyBatch`) sobre el esquema real del
// tenant. Lo mismo para el coste de un lote. La regla misma, con su texto, está en
// `validacion_casos.json`, que también lee la Main.
//
// Lo único que se sustituye es lo que no se puede levantar aquí: la autenticación del dispositivo
// (`tenantAuth`, que deja pasar a una Handy emparejada), el cliente de Turso (se sirve con el SQLite
// del DO y el esquema de producción) y el stub del DO, que en vez de esperar a una Main conectada
// ejecuta el lote igual que `applyInternalCommandIdempotent`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import * as z from "zod";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

/** El cliente «Turso» de la prueba: el SQLite del DO con el esquema real. */
let dbActual: any = null;
/** Lo que la ruta pide aplicar al DO, tal como llega a `aplicar`. */
const aplicados: any[] = [];
/** Lo que el DO difunde a la Main tras aplicar cada lote (`buildApplyBatch(...).replicated`). */
const replicados: any[] = [];

const PRECIO_NEGATIVO = "El precio no puede ser negativo.";
const COSTE_NEGATIVO = "El coste unitario no puede ser negativo.";

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	// Una Handy emparejada y con licencia: el JWT y el device-proof ya están verificados.
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-aud17");
		c.set("deviceId", "dev-handy");
		await next();
	},
}));

vi.mock("../src/server/db", () => ({
	getDb: () => ({ execute: async () => ({ rows: [{ role: "handy" }] }) }),
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(dbActual),
}));

const { inventarioRoutes } = await import("../src/domains/inventario/inventario.routes");
const { upsertProductoSchema, autorStockSchema } = await import("../src/domains/inventario/inventario.schemas");
const { validarConMensaje } = await import("../src/lib/validacion");
const { buildApplyBatch } = await import("../src/durableObjects/tenantHub.lote");

const app = new Hono();
app.route("/v1/inventario", inventarioRoutes);

/**
 * El binding `TenantHub` de la prueba. `applyViaHub` es el real (con `escrituraVetada`); lo que se
 * sustituye es el DO: ejecuta el lote del comando sobre el SQLite del hub, con el mismo sobre que
 * `applyInternalCommandIdempotent` (`PRAGMA defer_foreign_keys` + las sentencias del lote).
 */
function hubDePrueba(hub: any, sql: any) {
	return {
		idFromName: (n: string) => n,
		get: () => ({
			aplicar: async (params: any) => {
				aplicados.push(params);
				const lote = buildApplyBatch(params.command);
				const resultados: any[] = [];
				hub.state.storage.transactionSync(() => {
					sql.exec("PRAGMA defer_foreign_keys = ON;");
					for (const st of lote.middle) {
						const cur = sql.exec(st.sql, ...(st.args ?? []));
						resultados.push({ rows: cur.toArray(), rowsAffected: cur.rowsWritten ?? 0 });
					}
				});
				replicados.push(...lote.replicated);
				return { ok: true, data: lote.resolveResult(resultados, 0) };
			},
		}),
	};
}

async function pedir(metodo: string, ruta: string, cuerpo: unknown, env: unknown, op: string) {
	const res = await app.request(
		ruta,
		{
			method: metodo,
			headers: {
				"content-type": "application/json",
				"X-Idempotency-Key": op,
				"X-Client-Now": "2026-11-08 13:00:00",
			},
			body: JSON.stringify(cuerpo),
		},
		env as any,
	);
	return { status: res.status, json: (await res.json()) as any };
}

/** Un hub con el esquema real, una categoría y un café a 1,50 € con un lote. */
async function conHub(nombre: string, fn: (sql: any, env: unknown) => Promise<void>) {
	await enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Vendible) VALUES ('cat-1', 'Bebidas', 1);");
		sql.exec("INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cafe', 'cat-1', 'Café', 150);");
		sql.exec(
			"INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada, Coste_Unitario) VALUES ('lote-1', 'cafe', 'L-1', 5, '2026-11-01 10:00:00', 40);",
		);
		dbActual = clienteSobre(sql, hub.state.storage);
		await fn(sql, { TenantHub: hubDePrueba(hub, sql) });
	});
}

function filas(sql: any, q: string): any[] {
	return sql.exec(q).toArray();
}

/**
 * Aplica lo que el DO difunde a otra base con el esquema real, como la Main (`sync.rs::apply_one`:
 * las sentencias tal cual, en una transacción): lo que se mira es lo que queda, no el SQL.
 */
async function enOtraBase(nombre: string, sentencias: any[], fn: (sql: any) => void) {
	await enElHub(nombre, (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Vendible) VALUES ('cat-1', 'Bebidas', 1);");
		hub.state.storage.transactionSync(() => {
			for (const st of sentencias) sql.exec(st.sql, ...(st.args ?? []));
		});
		fn(sql);
	});
}

beforeEach(() => {
	aplicados.length = 0;
	replicados.length = 0;
	dbActual = null;
});

describe("AUD-17 · el precio de venta no es negativo", () => {
	it("el cuerpo de la ruta lo rechaza con el texto de la Main; 0 € y sin precio valen", async () => {
		// Es exactamente el schema de la ruta `POST /productos`.
		const cuerpoDeLaRuta = upsertProductoSchema.extend({
			id_usuario: autorStockSchema,
			conservar_precio: z.boolean().optional(),
		});
		const base = { id_categoria: "c1", nombre: "Ajuste", id_usuario: "u1" };
		const malo = await validarConMensaje(cuerpoDeLaRuta, { ...base, precio_venta: -5000 });
		expect(malo.success).toBe(false);
		expect((malo as any).mensaje).toBe(PRECIO_NEGATIVO);
		expect((await validarConMensaje(cuerpoDeLaRuta, { ...base, precio_venta: 0 })).success).toBe(true);
		expect((await validarConMensaje(cuerpoDeLaRuta, base)).success).toBe(true);
	});

	it("una Handy no da de alta un producto a −50,00 €: 400 y al DO no le llega nada", async () => {
		await conHub("aud17-alta", async (sql, env) => {
			const r = await pedir(
				"POST",
				"/v1/inventario/productos",
				{ id_producto: "prod-neg", id_categoria: "cat-1", nombre: "Ajuste", precio_venta: -5000, id_usuario: "u1" },
				env,
				"op-alta-neg",
			);
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ error: "validation_error", message: PRECIO_NEGATIVO });
			expect(aplicados).toEqual([]);
			expect(filas(sql, "SELECT COUNT(*) AS n FROM Productos WHERE ID_Producto = 'prod-neg';")).toEqual([{ n: 0 }]);
		});
	});

	it("tampoco deja un producto existente a −8,00 €", async () => {
		await conHub("aud17-edicion", async (sql, env) => {
			const r = await pedir(
				"POST",
				"/v1/inventario/productos",
				{ id_producto: "cafe", id_categoria: "cat-1", nombre: "Café", precio_venta: -800, id_usuario: "u1", conservar_precio: false },
				env,
				"op-edicion-neg",
			);
			expect(r.status).toBe(400);
			expect(r.json.message).toBe(PRECIO_NEGATIVO);
			expect(aplicados).toEqual([]);
			expect(filas(sql, "SELECT Precio_Venta AS p FROM Productos WHERE ID_Producto = 'cafe';")).toEqual([{ p: 150 }]);
		});
	});

	it("un producto a 0,00 € (una invitación) sí entra y se replica", async () => {
		await conHub("aud17-cero", async (sql, env) => {
			const r = await pedir(
				"POST",
				"/v1/inventario/productos",
				{ id_producto: "agua", id_categoria: "cat-1", nombre: "Agua", precio_venta: 0, id_usuario: "u1" },
				env,
				"op-alta-cero",
			);
			expect(r).toEqual({ status: 200, json: { id_producto: "agua" } });
			expect(aplicados).toHaveLength(1);
			expect(filas(sql, "SELECT Precio_Venta AS p FROM Productos WHERE ID_Producto = 'agua';")).toEqual([{ p: 0 }]);
		});

		// Lo que el DO difunde, aplicado en otra base como lo aplica la Main, deja el mismo 0 €.
		expect(replicados.length).toBeGreaterThan(0);
		await enOtraBase("aud17-cero-main", replicados, (main) => {
			expect(filas(main, "SELECT Precio_Venta AS p, typeof(Precio_Venta) AS t FROM Productos WHERE ID_Producto = 'agua';")).toEqual([
				{ p: 0, t: "integer" },
			]);
		});
	});
});

describe("AUD-17 · el coste de un lote no es negativo", () => {
	it("ni al darlo de alta", async () => {
		await conHub("aud17-lote-alta", async (sql, env) => {
			const r = await pedir(
				"POST",
				"/v1/inventario/lotes",
				{ id_producto: "cafe", codigo_lote: "L-2", stock_disponible: 3, coste_unitario: -1, id_usuario: "u1" },
				env,
				"op-lote-neg",
			);
			expect(r.status).toBe(400);
			expect(r.json.message).toBe(COSTE_NEGATIVO);
			expect(aplicados).toEqual([]);
			expect(filas(sql, "SELECT COUNT(*) AS n FROM Lotes_Producto;")).toEqual([{ n: 1 }]);
		});
	});

	it("ni al editarlo", async () => {
		await conHub("aud17-lote-edicion", async (sql, env) => {
			const r = await pedir(
				"PUT",
				"/v1/inventario/lotes/lote-1",
				{ id_lote: "lote-1", id_producto: "cafe", codigo_lote: "L-1", coste_unitario: -1 },
				env,
				"op-lote-edicion-neg",
			);
			expect(r.status).toBe(400);
			expect(r.json.message).toBe(COSTE_NEGATIVO);
			expect(aplicados).toEqual([]);
			expect(filas(sql, "SELECT Coste_Unitario AS c FROM Lotes_Producto WHERE ID_Lote = 'lote-1';")).toEqual([{ c: 40 }]);
		});
	});
});
