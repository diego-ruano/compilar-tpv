// test/cambiosConTecho.test.ts
//
// `/v1/sync/changes` tiene un techo en bytes además del de cambios (`CAMBIOS_MAX_BYTES`). Hasta mil
// cambios por página, con sus sentencias enteras: un cambio puede llevar cientos (un plano, un cobro
// de cien líneas), y mil de ésos eran cientos de megas montados en el TenantHub y bajados de golpe
// por la Main. Aquí, sobre el SQLite de un DO con el esquema de verdad y la ruta real:
//
//   · la página se corta antes de pasar del techo, con el `nextSince` de su último cambio, y
//     recorrerla página a página trae todos los cambios, en orden, sin saltar ni repetir ninguno;
//   · un cambio que solo ya pasa del techo viaja igual, solo: si no, la Main se atascaría en él;
//   · el tope de cambios (`limit`) sigue mandando cuando llega antes;
//   · con el techo de verdad, una página de cambios de un mega no pasa de él.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

/** Cliente SQL del test en curso; lo lee el `tenantQuery` sustituido. */
let clienteActual: any = null;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_c: any, fn: any) => fn(clienteActual),
}));

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-techo");
		c.set("deviceId", "main-1");
		await next();
	},
	soloLaMain: () => async (_c: any, next: any) => {
		await next();
	},
}));

const { syncRoutes, leerPaginaDeCambios, CAMBIOS_MAX_BYTES } = await import("../src/domains/sync/sync.routes");

const app = new Hono();
app.route("/", syncRoutes);

async function pedirCambios(since: number, limit = 1000): Promise<{ json: any; bytes: number }> {
	const res = await app.request(
		"/changes",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ since, limit }) },
		{} as any,
	);
	expect(res.status).toBe(200);
	const texto = await res.text();
	return { json: JSON.parse(texto), bytes: new TextEncoder().encode(texto).length };
}

/** Un cambio cuyas sentencias ocupan unos `bytes` (un array JSON de una sentencia con un texto largo). */
function anotar(sql: any, seq: number, bytes: number) {
	const relleno = "x".repeat(Math.max(0, bytes - 40));
	sql.exec(
		"INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?1, ?2, 'venta', ?3, 'main-1', ?4);",
		seq,
		`op-${seq}`,
		JSON.stringify([{ sql: "SELECT ?1", args: [relleno] }]),
		Date.now(),
	);
}

function conLaBase<R>(nombre: string, prueba: (sql: any, db: any) => Promise<R>): Promise<R> {
	return enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		const db = clienteLocal(hub.state.storage);
		clienteActual = db;
		try {
			return await prueba(sql, db);
		} finally {
			clienteActual = null;
		}
	});
}

describe("/v1/sync/changes se corta por bytes", () => {
	it("cada página cabe en el techo y, recorridas, traen todos los cambios en orden", async () => {
		await conLaBase("techo-paginas", async (sql, db) => {
			for (let seq = 1; seq <= 10; seq++) anotar(sql, seq, 1000);

			// Con 3.000 bytes caben dos: cada uno ocupa sus 1.000 y lo de alrededor.
			const vistos: number[] = [];
			let since = 0;
			for (let vuelta = 0; vuelta < 20; vuelta++) {
				const { items, highWater } = await leerPaginaDeCambios(db, since, 1000, 3000);
				expect(highWater).toBe(10);
				if (!items.length) break;
				expect(items.length, `página desde ${since}`).toBeLessThanOrEqual(2);
				const bytes = items.reduce((n: number, i: any) => n + new TextEncoder().encode(String(i.Statements_Json)).length, 0);
				expect(bytes).toBeLessThanOrEqual(3000);
				vistos.push(...items.map((i: any) => Number(i.Seq)));
				since = Number(items[items.length - 1].Seq);
			}
			expect(vistos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		});
	});

	it("un cambio que solo ya pasa del techo viaja igual, solo", async () => {
		await conLaBase("techo-uno-grande", async (sql, db) => {
			anotar(sql, 1, 500);
			anotar(sql, 2, 5000);
			anotar(sql, 3, 500);

			expect((await leerPaginaDeCambios(db, 0, 1000, 2000)).items.map((i: any) => Number(i.Seq))).toEqual([1]);
			expect((await leerPaginaDeCambios(db, 1, 1000, 2000)).items.map((i: any) => Number(i.Seq))).toEqual([2]);
			expect((await leerPaginaDeCambios(db, 2, 1000, 2000)).items.map((i: any) => Number(i.Seq))).toEqual([3]);
			expect((await leerPaginaDeCambios(db, 3, 1000, 2000)).items).toEqual([]);
		});
	});

	it("el tope de cambios sigue mandando cuando llega antes", async () => {
		await conLaBase("techo-limit", async (sql) => {
			for (let seq = 1; seq <= 20; seq++) anotar(sql, seq, 100);
			const { json } = await pedirCambios(0, 5);
			expect(json.items.map((i: any) => i.seq)).toEqual([1, 2, 3, 4, 5]);
			expect(json).toMatchObject({ nextSince: 5, highWater: 20, purgadoHasta: 0 });
		});
	});

	it("con el techo de verdad, una página de cambios de un mega no pasa de él, y la siguiente sigue", async () => {
		await conLaBase("techo-real", async (sql) => {
			const MEGA = 1024 * 1024;
			for (let seq = 1; seq <= 6; seq++) anotar(sql, seq, MEGA);

			const primera = await pedirCambios(0);
			expect(primera.json.items.map((i: any) => i.seq)).toEqual([1, 2, 3]);
			expect(primera.json).toMatchObject({ nextSince: 3, highWater: 6 });
			expect(primera.bytes).toBeLessThanOrEqual(CAMBIOS_MAX_BYTES);

			const segunda = await pedirCambios(3);
			expect(segunda.json.items.map((i: any) => i.seq)).toEqual([4, 5, 6]);
			expect(segunda.json.nextSince).toBe(6);

			const ultima = await pedirCambios(6);
			expect(ultima.json).toMatchObject({ items: [], nextSince: 6, highWater: 6 });
		});
	});
});
