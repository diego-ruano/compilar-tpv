// test/syncGzip.test.ts
//
// Las respuestas de sync que crecen con el negocio salen comprimidas con gzip si la Main lo acepta
// (`lib/gzip.ts`): `/v1/sync/changes`, `/bootstrap`, `/historico` y las tres de `/verificar/*`.
//
// Lo que se fija:
//   · sólo si se pide: sin `Accept-Encoding: gzip` la respuesta es la de siempre, que es lo que
//     reciben las Main que no lo mandan;
//   · comprimida dice lo mismo: descomprimida es, byte a byte, la respuesta sin comprimir;
//   · un error no se comprime;
//   · se comprime una vez y en el Worker: dentro del TenantHub la ruta contesta sin comprimir.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { dentroDelHub } from "../src/lib/hubLocal";
import { aceptaGzip } from "../src/lib/gzip";

let clienteActual: any = null;
let esTpv = true;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_c: any, fn: any) => fn(clienteActual),
}));

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
	soloLaMain: () => async (c: any, next: any) => {
		if (!esTpv) return c.json({ ok: false, code: "external", error: "forbidden_not_tpv" }, 403);
		await next();
	},
}));

const { syncRoutes } = await import("../src/domains/sync/sync.routes");

const app = new Hono();
app.route("/", syncRoutes);

/** Las rutas que comprimen, con un cuerpo de los que manda la Main. */
const RUTAS: Array<[string, unknown]> = [
	["/changes", { since: 0 }],
	["/bootstrap", {}],
	["/historico", { tabla: "Comandas", cursor: 0, limite: 1_000 }],
	["/verificar/resumen", {}],
	["/verificar/filas", { tabla: "Comandas", desde: "2020-01-01 00:00:00", cubos: 16, pedir: [0, 1, 2, 3, 4, 5, 6, 7] }],
	["/verificar/claves", { tabla: "Comandas", limite: 1_000 }],
	["/verificar/por-clave", { tabla: "Comandas", claves: [["c-1"]] }],
];

function sembrar(sql: any): void {
	crearEsquemaTenant(sql);
	sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza de la ría');");
	for (let i = 0; i < 300; i++) {
		sql.exec(
			`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
			 VALUES (?, 'BARRA', '2020-01-01 12:00:00', 'Abierta');`,
			`c-${String(i).padStart(4, "0")}`,
		);
	}
	for (let i = 1; i <= 20; i++) {
		sql.exec(
			`INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms)
			 VALUES (?, 'mesas.abrir', '[{"sql":"SELECT 1;","args":[]}]', 'd2', ?);`,
			`op-${i}`,
			i,
		);
	}
}

type Opciones = { acepta?: string; cf?: Record<string, unknown> };

function pedir(ruta: string, cuerpo: unknown, { acepta, cf }: Opciones = {}): Promise<Response> {
	const peticion = new Request(`http://tpv.test${ruta}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(acepta === undefined ? {} : { "Accept-Encoding": acepta }) },
		body: JSON.stringify(cuerpo),
		...(cf ? { cf } : {}),
	});
	return Promise.resolve(app.request(peticion, undefined, {} as any));
}

async function descomprimida(res: Response): Promise<string> {
	return new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Con una base sembrada y el reloj parado: dos peticiones seguidas contestan lo mismo. */
async function conBase<R>(nombre: string, prueba: (sql: any) => Promise<R>): Promise<R> {
	return enElHub(`gzip-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		sembrar(sql);
		clienteActual = clienteSobre(sql);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			return await prueba(sql);
		} finally {
			vi.useRealTimers();
		}
	});
}

beforeEach(() => {
	clienteActual = null;
	esTpv = true;
});

describe("qué `Accept-Encoding` admite gzip", () => {
	it.each([
		["gzip", true],
		["gzip, br", true],
		["br;q=1.0, gzip;q=0.8, *;q=0.1", true],
		["GZIP", true],
		["x-gzip", true],
		["deflate,gzip", true],
		["gzip;q=0", false],
		["gzip; q=0.0, br", false],
		["br, deflate", false],
		["identity", false],
		// Sólo si lo nombra: «cualquiera» no es pedir gzip.
		["*", false],
		["", false],
		[null, false],
		[undefined, false],
	])("%j → %s", (cabecera, esperado) => {
		expect(aceptaGzip(cabecera)).toBe(esperado);
	});
});

describe("las respuestas de sync, comprimidas", () => {
	it("sin `Accept-Encoding: gzip` salen como siempre", async () => {
		await conBase("sin-pedirlo", async () => {
			for (const [ruta, cuerpo] of RUTAS) {
				for (const acepta of [undefined, "identity", "gzip;q=0", "br"]) {
					const res = await pedir(ruta, cuerpo, { acepta });
					expect(res.status, ruta).toBe(200);
					expect(res.headers.get("Content-Encoding"), `${ruta} · ${acepta}`).toBeNull();
					expect(res.headers.get("Vary"), ruta).toBeNull();
					// Y es JSON legible tal cual.
					expect(typeof (await res.json()), ruta).toBe("object");
				}
			}
		});
	});

	it("con él salen en gzip, y descomprimidas son la misma respuesta byte a byte", async () => {
		await conBase("pidiendolo", async () => {
			for (const [ruta, cuerpo] of RUTAS) {
				const llana = await (await pedir(ruta, cuerpo)).text();

				const res = await pedir(ruta, cuerpo, { acepta: "gzip" });
				expect(res.status, ruta).toBe(200);
				expect(res.headers.get("Content-Encoding"), ruta).toBe("gzip");
				expect(res.headers.get("Vary"), ruta).toBe("Accept-Encoding");
				expect(res.headers.get("Content-Length"), ruta).toBeNull();
				expect(res.headers.get("content-type"), ruta).toContain("application/json");

				const comprimida = new Uint8Array(await res.clone().arrayBuffer());
				// La cabecera de gzip: 1f 8b.
				expect([comprimida[0], comprimida[1]], ruta).toEqual([0x1f, 0x8b]);
				expect(await descomprimida(res), ruta).toBe(llana);
			}

			// Y sirve de algo: el volcado de 300 comandas se queda en una fracción.
			const llana = await (await pedir("/bootstrap", {})).arrayBuffer();
			const comprimida = await (await pedir("/bootstrap", {}, { acepta: "gzip" })).arrayBuffer();
			expect(comprimida.byteLength).toBeLessThan(llana.byteLength / 3);
		});
	});

	it("un error no se comprime", async () => {
		await conBase("errores", async () => {
			const noPaginable = await pedir("/historico", { tabla: "Usuarios" }, { acepta: "gzip" });
			expect(noPaginable.status).toBe(400);
			expect(noPaginable.headers.get("Content-Encoding")).toBeNull();
			expect((await noPaginable.json<any>()).error).toBe("tabla_no_paginable");

			esTpv = false;
			const vetada = await pedir("/bootstrap", {}, { acepta: "gzip" });
			expect(vetada.status).toBe(403);
			expect(vetada.headers.get("Content-Encoding")).toBeNull();
			expect((await vetada.json<any>()).error).toBe("forbidden_not_tpv");
		});
	});

	it("manda lo que pidió el cliente, no lo que Cloudflare le dice al Worker que acepta", async () => {
		// Cloudflare puede cambiar `Accept-Encoding` antes de que llegue al Worker; cuando lo hace,
		// lo que mandó el cliente queda en `cf.clientAcceptEncoding`.
		await conBase("cf", async () => {
			const sinPedirlo = await pedir("/bootstrap", {}, { acepta: "gzip, br", cf: { clientAcceptEncoding: "" } });
			expect(sinPedirlo.headers.get("Content-Encoding")).toBeNull();

			const pidiendolo = await pedir("/bootstrap", {}, { acepta: "br", cf: { clientAcceptEncoding: "gzip" } });
			expect(pidiendolo.headers.get("Content-Encoding")).toBe("gzip");
			expect(JSON.parse(await descomprimida(pidiendolo)).ok).toBe(true);
		});
	});

	it("dentro del TenantHub la ruta contesta sin comprimir: comprime el Worker, una vez", async () => {
		await conBase("en-el-hub", async (sql) => {
			for (const [ruta, cuerpo] of RUTAS) {
				const res = await dentroDelHub(
					{
						identidad: { tenantId: "t1", deviceId: "d1", token: "", licHash: "", rol: "tpv" },
						base: async () => clienteActual,
						sql: async () => sql,
						aplicar: async () => {
							throw new Error("estas rutas no aplican nada");
						},
						estaAprovisionado: () => true,
						aprovisionar: async () => {
							throw new Error("estas rutas no dan de alta la base");
						},
					},
					() => pedir(ruta, cuerpo, { acepta: "gzip" }),
				);
				expect(res.status, ruta).toBe(200);
				expect(res.headers.get("Content-Encoding"), ruta).toBeNull();
				expect(typeof (await res.json()), ruta).toBe("object");
			}
		});
	});
});
