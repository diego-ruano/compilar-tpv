// test/verificarClavesTope.test.ts
//
// REV-21 — `/v1/sync/verificar-claves` tenía techo por tabla y ninguno para la respuesta entera.
//
// La petición admite 60 tablas y se resolvían TODAS a la vez en un `batch`, así que el peor caso
// eran 60 × 200.000 listas de claves vivas en un isolate de 128 MB. No hacía falta un atacante: un
// negocio con años de histórico y varias tablas descuadradas lo alcanza solo — y justo el día que
// la verificación hace falta, que es el único día en que este endpoint se pide.
//
// El reparto se prueba sobre `leerClaves` con un tope pequeño —sembrar doscientas mil filas para
// comprobar una resta no prueba nada más y tarda un minuto—, y la ruta se prueba entera aparte.
// Lo que tiene que quedar fijado: las primeras tablas salen enteras y las que ya no caben se
// marcan `truncada`, que es lo que la Main sabe leer («ésta no la puedo comparar, la salto»,
// `sync.rs::contrastar_con_la_nube`).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

let clienteActual: any = null;
let esTpv = true;
/** Cuántas consultas ha llegado a lanzar el handler: lo que prueba que no pide lo que no cabe. */
let consultas = 0;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_c: any, fn: any) => fn(clienteActual),
}));

vi.mock("../src/lib/deviceAuth", async (original) => ({
	...(await (original as any)()),
	isTpvDevice: async () => esTpv,
}));

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
}));

const { syncRoutes, leerClaves } = await import("../src/domains/sync/sync.routes");

type Respuesta = {
	tablas: Array<{ nombre: string; columnas: string[]; claves: any[][]; truncada: boolean }>;
};

/** Levanta un tenant real, lo siembra y pide la verificación de las tablas indicadas. */
async function verificar(
	nombre: string,
	sembrar: (sql: any) => void,
	tablas: Array<{ nombre: string; claves: string[] }>,
): Promise<{ status: number; body: Respuesta }> {
	return enElHub(`rev21-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sembrar(sql);

		const real = clienteSobre(sql);
		consultas = 0;
		clienteActual = {
			...real,
			execute: (q: any) => {
				consultas += 1;
				return real.execute(q);
			},
		};

		const app = new Hono();
		app.route("/", syncRoutes);
		const res = await app.request(
			"/verificar-claves",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ tablas }),
			},
			{} as any,
		);
		return { status: res.status, body: (await res.json()) as Respuesta };
	});
}

/** Como `verificar`, pero entregando el cliente SQL para llamar a `leerClaves` directamente. */
async function conTablas<T>(
	nombre: string,
	sembrar: (sql: any) => void,
	fn: (db: any, espia: () => number) => Promise<T>,
): Promise<T> {
	return enElHub(`rev21-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sembrar(sql);
		const real = clienteSobre(sql);
		let n = 0;
		const db = { ...real, execute: (q: any) => ((n += 1), real.execute(q)) };
		return fn(db, () => n);
	});
}

/** `n` zonas, que es la tabla de negocio más barata de llenar. */
function zonas(sql: any, n: number) {
	for (let i = 0; i < n; i++) {
		sql.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z${i}', 'Zona ${i}');`);
	}
}

beforeEach(() => {
	esTpv = true;
	clienteActual = null;
	consultas = 0;
});

describe("REV-21 · el presupuesto de la respuesta", () => {
	it("con todo dentro del presupuesto, cada tabla trae sus claves", async () => {
		const { status, body } = await verificar(
			"cabe",
			(sql) => {
				zonas(sql, 3);
				sql.exec(`INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c1', 'Bebidas');`);
			},
			[
				{ nombre: "Zonas", claves: ["ID_Zona"] },
				{ nombre: "Categorias_Producto", claves: ["ID_Categoria"] },
			],
		);

		expect(status).toBe(200);
		expect(body.tablas.map((t) => t.truncada)).toEqual([false, false]);
		expect(body.tablas[0].claves).toHaveLength(3);
		expect(body.tablas[1].claves).toEqual([["c1"]]);
	});

	it("una tabla sola que pasa del tope se marca truncada y no manda media lista", async () => {
		// Media lista se leería como «te sobran 400.000 filas», que es peor que no decir nada.
		const r = await conTablas("una-grande", (sql) => zonas(sql, 12), (db) =>
			leerClaves(db, [{ nombre: "Zonas", claves: ["ID_Zona"] }], 5),
		);

		expect(r.tablas[0].truncada).toBe(true);
		expect(r.tablas[0].claves).toEqual([]);
	});

	it("el presupuesto es de la RESPUESTA, no de cada tabla: la que no cabe detrás se trunca", async () => {
		// El fallo entero en una línea. Con techo sólo por tabla, estas tres cabían las tres y la
		// respuesta valía el triple del tope; sesenta tablas, sesenta veces.
		const r = await conTablas(
			"presupuesto",
			(sql) => {
				zonas(sql, 3);
				for (let i = 0; i < 3; i++) {
					sql.exec(
						`INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c${i}', 'Cat ${i}');`,
					);
				}
			},
			(db) =>
				leerClaves(
					db,
					[
						{ nombre: "Zonas", claves: ["ID_Zona"] },
						{ nombre: "Categorias_Producto", claves: ["ID_Categoria"] },
					],
					5,
				),
		);

		// Las dos tablas tienen 3 filas, o sea que cada una cabe de sobra en un tope de 5. Lo que
		// no cabe es la suma: con techo sólo por tabla salían las dos y la respuesta valía 6.
		expect(r.tablas.map((t) => t.truncada)).toEqual([false, true]);
		const total = r.tablas.reduce((n, t) => n + t.claves.length, 0);
		expect(total).toBeLessThanOrEqual(5);
	});

	it("agotado el presupuesto ya ni se consulta: traer filas para tirarlas cuesta lo mismo", async () => {
		const r = await conTablas(
			"sin-consultar",
			(sql) => zonas(sql, 3),
			async (db, espia) => {
				const res = await leerClaves(
					db,
					[
						{ nombre: "Zonas", claves: ["ID_Zona"] },
						{ nombre: "Zonas", claves: ["ID_Zona"] },
					],
					3,
				);
				return { ...res, consultas: espia() };
			},
		);

		expect((r as any).consultas).toBe(1);
	});

	it("las tablas se resuelven de una en una, no todas a la vez", async () => {
		// Es la diferencia entre un techo por tabla y un techo de verdad: con el `batch` las 60
		// consultas se materializaban juntas, así que el tope por tabla no acotaba la respuesta.
		const { body } = await verificar(
			"secuencial",
			(sql) => {
				zonas(sql, 2);
				sql.exec(`INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c1', 'Bebidas');`);
			},
			[
				{ nombre: "Zonas", claves: ["ID_Zona"] },
				{ nombre: "Categorias_Producto", claves: ["ID_Categoria"] },
			],
		);

		expect(body.tablas).toHaveLength(2);
		expect(consultas).toBe(2);
	});

	it("no se piden más de 60 tablas por petición", async () => {
		const muchas = Array.from({ length: 80 }, () => ({ nombre: "Zonas", claves: ["ID_Zona"] }));
		const { body } = await verificar("tope-tablas", (sql) => zonas(sql, 1), muchas);

		expect(body.tablas).toHaveLength(60);
	});

	it("una tabla que no es de negocio no se consulta", async () => {
		const { body } = await verificar("no-negocio", (sql) => zonas(sql, 1), [
			{ nombre: "_Sync_Outbox", claves: ["Op_Id"] },
			{ nombre: "Applied_Operations", claves: ["Op_Id"] },
		]);

		expect(body.tablas).toEqual([]);
		expect(consultas).toBe(0);
	});
});
