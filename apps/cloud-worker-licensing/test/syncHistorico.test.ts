// test/syncHistorico.test.ts
//
// SYNC-19 · La FASE 2: el histórico que la ventana de la fase 1 dejó fuera, paginado.
//
// Lo que se fija aquí es la paginación, y su fallo característico es mudo: un cursor que salte una
// fila deja un hueco en el histórico que nadie va a notar hasta que alguien busque un ticket de
// hace meses, y uno que repita deja al job girando para siempre sin avanzar.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

let clienteActual: any = null;
let esTpv = true;

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

const { syncRoutes } = await import("../src/domains/sync/sync.routes");

type Pagina = {
	ok: boolean;
	tabla: string;
	columnas: string[];
	filas: any[][];
	siguiente_cursor: number | null;
};

/**
 * Levanta un tenant, lo siembra y deja pedir varias páginas seguidas sobre el MISMO estado. El
 * recorrido completo es lo que se prueba: una página suelta no dice si el cursor avanza bien.
 */
async function conTenant<R>(
	nombre: string,
	sembrar: (sql: any) => void,
	usar: (
		pedir: (cuerpo: any) => Promise<{ status: number; body: Pagina }>,
	) => R | Promise<R>,
): Promise<R> {
	return enElHub(`historico-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sembrar(sql);

		clienteActual = clienteSobre(sql);
		const app = new Hono();
		app.route("/", syncRoutes);

		const pedir = async (cuerpo: any) => {
			const res = await app.request(
				"/historico",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(cuerpo),
				},
				{} as any,
			);
			return { status: res.status, body: (await res.json()) as Pagina };
		};

		return usar(pedir);
	});
}

/** `n` comandas de barra, para tener algo que paginar. */
function sembrarComandas(sql: any, n: number) {
	for (let i = 0; i < n; i++) {
		sql.exec(
			`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
			 VALUES (?, 'BARRA', '2020-01-01 12:00:00', 'Pagada');`,
			`c-${String(i).padStart(4, "0")}`,
		);
	}
}

beforeEach(() => {
	esTpv = true;
	clienteActual = null;
});

describe("POST /v1/sync/historico", () => {
	it("sólo lo sirve la Main", async () => {
		// Una Handy no tiene BD local que rellenar, y esto es el histórico entero del negocio.
		esTpv = false;
		const { status, body } = await conTenant("no-tpv", () => {}, (pedir) =>
			pedir({ tabla: "Comandas" }),
		);
		expect(status).toBe(403);
		expect((body as any).error).toBe("forbidden_not_tpv");
	});

	it("recorre la tabla entera sin saltar ni repetir una sola fila", async () => {
		// El corazón del asunto. Se pagina por `rowid` y no por clave primaria porque seis de las
		// tablas de la fase 2 tienen PK compuesta; lo que hay que demostrar es que el recorrido es
		// una partición exacta de la tabla.
		const vistas = await conTenant(
			"recorrido",
			(sql) => sembrarComandas(sql, 25),
			async (pedir) => {
				const acumuladas: string[] = [];
				let cursor: number | null = 0;
				let vueltas = 0;
				do {
					const { body } = await pedir({ tabla: "Comandas", cursor, limite: 10 });
					const i = body.columnas.indexOf("ID_Comanda");
					acumuladas.push(...body.filas.map((f) => String(f[i])));
					cursor = body.siguiente_cursor;
					vueltas++;
				} while (cursor !== null && vueltas < 20);
				return acumuladas;
			},
		);

		expect(vistas).toHaveLength(25);
		expect(new Set(vistas).size).toBe(25);
		expect(vistas[0]).toBe("c-0000");
		expect(vistas[24]).toBe("c-0024");
	});

	it("el cursor se cierra en la última página, no en la vacía", async () => {
		// Una página corta ya significa "no queda nada". Devolver cursor ahí obligaría a una vuelta
		// extra por tabla; devolverlo en una página COMPLETA que resulta ser la última es correcto y
		// se paga con una consulta vacía, que es lo barato de las dos.
		await conTenant(
			"cierre-cursor",
			(sql) => sembrarComandas(sql, 15),
			async (pedir) => {
				const p1 = await pedir({ tabla: "Comandas", cursor: 0, limite: 10 });
				expect(p1.body.filas).toHaveLength(10);
				expect(p1.body.siguiente_cursor).not.toBeNull();

				const p2 = await pedir({
					tabla: "Comandas",
					cursor: p1.body.siguiente_cursor,
					limite: 10,
				});
				expect(p2.body.filas).toHaveLength(5);
				expect(p2.body.siguiente_cursor).toBeNull();
			},
		);
	});

	it("las filas van posicionales y SIN el cursor dentro", async () => {
		// El `rowid` viaja como `siguiente_cursor`, no como una columna más: la Main construye el
		// INSERT con `columnas`, así que una columna de sobra sería un INSERT que no compila —
		// o, peor, una que sí compila desplazando todos los valores un puesto.
		await conTenant(
			"forma",
			(sql) => sembrarComandas(sql, 1),
			async (pedir) => {
				const { body } = await pedir({ tabla: "Comandas" });
				expect(body.columnas).not.toContain("__rowid");
				expect(body.columnas[0]).toBe("ID_Comanda");
				expect(body.filas[0]).toHaveLength(body.columnas.length);
				expect(body.filas[0][0]).toBe("c-0000");
			},
		);
	});

	it("una tabla que no es de la fase 2 se rechaza", async () => {
		// El nombre se interpola en el SQL (no se puede enlazar con `?`), así que la defensa es una
		// lista blanca cerrada y no un saneado: los maestros ya vienen enteros en la fase 1 y no
		// hay ningún motivo legítimo para pedirlos por aquí.
		await conTenant("lista-blanca", () => {}, async (pedir) => {
			for (const tabla of ["Usuarios", "Sync_Changes", "Comandas; DROP TABLE Pagos", ""]) {
				const { status, body } = await pedir({ tabla });
				expect(status, tabla).toBe(400);
				expect((body as any).error).toBe("tabla_no_paginable");
			}
		});
	});

	it("una tabla que este tenant todavía no tiene se informa vacía, no revienta", async () => {
		// Misma regla que el bootstrap: un negocio con una versión de esquema por detrás debe poder
		// recuperarse igual. Si esto fuera un error, el backfill se quedaría atascado en esa tabla
		// para siempre y ninguna de las siguientes llegaría a bajarse.
		await conTenant(
			"tabla-ausente",
			(sql) => sql.exec("DROP TABLE Movimientos_Caja;"),
			async (pedir) => {
				const { status, body } = await pedir({ tabla: "Movimientos_Caja" });
				expect(status).toBe(200);
				expect(body.filas).toEqual([]);
				expect(body.siguiente_cursor).toBeNull();
			},
		);
	});

	it("el tamaño de página lo impone el servidor", async () => {
		// El cliente pide, no manda: una página sin techo es una respuesta que no cabe en el
		// isolate, que es exactamente el problema del que viene todo esto.
		await conTenant(
			"limite",
			(sql) => sembrarComandas(sql, 30),
			async (pedir) => {
				const alto = await pedir({ tabla: "Comandas", limite: 999_999 });
				expect(alto.body.filas.length).toBeLessThanOrEqual(2_000);

				const cero = await pedir({ tabla: "Comandas", limite: 0 });
				expect(cero.body.filas.length).toBe(30);
			},
		);
	});
});
