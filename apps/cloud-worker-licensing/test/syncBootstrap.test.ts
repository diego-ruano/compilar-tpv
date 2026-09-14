// test/syncBootstrap.test.ts
//
// `/v1/sync/bootstrap` — el volcado con el que una Main reconstruye su `data.db` desde cero.
//
// No es el catch-up: el catch-up sirve para volver de un CORTE (reproduce lo que te perdiste) y
// esto sirve para volver de perder la BASE (el estado actual entero). Es la última salida de un
// equipo que se quedó sin datos, y hasta ahora no tenía ni un test.
//
// Lo que se fija aquí es el CONTRATO con el lado que lo consume
// (`tpv-infra-sqlite::sync::bootstrap_restaurar`): qué tablas viajan, en qué forma van las filas y
// de dónde sale el `Seq` con el que la Main deja su checkpoint. Si alguna de esas tres cosas
// cambia sin que cambie el lado Rust, la recuperación se rompe en silencio y sólo se descubre el
// día que un cliente pierde su base de datos.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { DDL_TABLAS_DE_NUBE } from "../src/server/tablasDeNube";

/** Cliente SQL del test en curso; lo lee el `tenantQuery` simulado. */
let clienteActual: any = null;
/** Qué contesta `isTpvDevice`: el guard del endpoint. */
let esTpv = true;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_env: any, _tenantId: string, fn: any) => fn(clienteActual),
}));

vi.mock("../src/lib/deviceAuth", async (original) => ({
	...(await (original as any)()),
	isTpvDevice: async () => esTpv,
}));

// El router monta `tenantAuth` él mismo; aquí se sustituye por el mínimo que necesita el handler.
vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
}));

const { syncRoutes } = await import("../src/domains/sync/sync.routes");

type Volcado = {
	ok: boolean;
	seq: number;
	totalFilas: number;
	tablas: Array<{ nombre: string; columnas: string[]; filas: any[][] }>;
};

/** Levanta un tenant real sobre el SqlStorage del DO, lo siembra y pide el volcado. */
async function pedirVolcado(
	nombre: string,
	sembrar: (sql: any) => void,
): Promise<{ status: number; body: any }> {
	return enElHub(`bootstrap-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		// El esquema de negocio (las mismas migraciones que producción) + las tablas que sólo
		// existen en la nube, que es justo lo que el volcado tiene que saber excluir.
		crearEsquemaTenant(sql);
		for (const ddl of DDL_TABLAS_DE_NUBE) sql.exec(ddl);
		sembrar(sql);

		clienteActual = clienteSobre(sql);
		const app = new Hono();
		app.route("/", syncRoutes);
		const res = await app.request("/bootstrap", { method: "POST" }, {} as any);
		return { status: res.status, body: await res.json() };
	});
}

function tabla(body: Volcado, nombre: string) {
	return body.tablas.find((t) => t.nombre === nombre);
}

beforeEach(() => {
	esTpv = true;
	clienteActual = null;
});

describe("POST /v1/sync/bootstrap", () => {
	it("sólo lo sirve la Main", async () => {
		// Una Handy no tiene BD local que reconstruir, y el volcado es el estado ENTERO del
		// negocio: no es algo que deba poder descargarse desde un móvil que se queda en la barra.
		esTpv = false;

		const { status, body } = await pedirVolcado("no-tpv", () => {});

		expect(status).toBe(403);
		expect(body.error).toBe("forbidden_not_tpv");
	});

	it("devuelve el estado actual y el Seq de la foto", async () => {
		const { status, body } = await pedirVolcado("estado", (sql) => {
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');");
			sql.exec(
				"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-1', '[]', 1);",
			);
			sql.exec(
				"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-2', '[]', 2);",
			);
		});

		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		// El `Seq` es el del último cambio aplicado: es donde la Main deja su checkpoint para
		// seguir por el catch-up sin huecos ni solapes.
		expect(body.seq).toBe(2);

		const zonas = tabla(body, "Zonas");
		expect(zonas).toBeDefined();
		expect(zonas!.filas).toHaveLength(1);
	});

	it("el sobre lleva EXACTAMENTE los nombres que deserializa Rust", async () => {
		// Esto es lo que faltaba, y costó caro: el fichero decía fijar el contrato con
		// `bootstrap_restaurar`, pero comprobaba las tablas y las filas y NO los nombres del sobre.
		// El worker mandó `totalFilas` desde el primer día (db4b5d8) mientras `BootstrapSnapshot`
		// esperaba `total_filas`, así que serde fallaba con "missing field" y la recuperación desde
		// la nube —la única salida de quien pierde su `data.db`— nunca llegó a funcionar. No lo vio
		// nadie porque ningún test recorría ese camino entero.
		//
		// La lista de abajo es la de `crates/tpv-contracts/src/sync.rs::BootstrapSnapshot`. Si
		// añades un campo allí, añádelo aquí; si lo renombras en uno de los dos lados, este test
		// cae antes de que caiga un cliente.
		const { body } = await pedirVolcado("sobre", (sql) => {
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');");
		});

		for (const campo of ["seq", "total_filas", "tablas", "backfill"]) {
			expect(Object.keys(body), `falta "${campo}" en la respuesta`).toContain(campo);
		}
		expect(typeof body.total_filas).toBe("number");
		expect(Array.isArray(body.backfill)).toBe(true);

		// Y cada tabla, igual: son los campos de `BootstrapTabla`.
		for (const campo of ["nombre", "columnas", "filas"]) {
			expect(Object.keys(body.tablas[0]), `falta "${campo}" en una tabla`).toContain(campo);
		}
	});

	it("las filas van posicionales y en el orden de `columnas`", async () => {
		// Es el formato que parsea `bootstrap_restaurar`: construye el INSERT con `columnas` y
		// enlaza cada fila por posición. Si el worker devolviera objetos, la Main restauraría
		// nulos en todas las columnas sin que nada fallara.
		const { body } = await pedirVolcado("posicional", (sql) => {
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');");
		});

		const zonas = tabla(body, "Zonas")!;
		const fila = zonas.filas[0];
		expect(Array.isArray(fila)).toBe(true);
		expect(fila).toHaveLength(zonas.columnas.length);
		expect(fila[zonas.columnas.indexOf("ID_Zona")]).toBe("z1");
		expect(fila[zonas.columnas.indexOf("Nombre_Zona")]).toBe("Terraza");
	});

	it("el andamiaje de la nube no viaja", async () => {
		// `Sync_Changes` y compañía son de la nube: la Main mantiene sus equivalentes locales
		// (`_Sync_*`) y restaurarlas encima le pisaría su propio checkpoint y su anti-eco.
		const { body } = await pedirVolcado("excluidas", (sql) => {
			sql.exec(
				"INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-1', '[]', 1);",
			);
			sql.exec(
				"INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('d1', 5, 1);",
			);
			sql.exec(
				"INSERT INTO Applied_Operations (Op_Id, Command_Name, Request_Hash, Created_At_Ms, Updated_At_Ms) VALUES ('op-1', 'main', 'h', 1, 1);",
			);
		});

		const nombres = body.tablas.map((t: any) => t.nombre);
		expect(nombres).not.toContain("Sync_Changes");
		expect(nombres).not.toContain("Sync_Main_Checkpoints");
		expect(nombres).not.toContain("Applied_Operations");
		// Ni las internas de SQLite ni las de control con `_` delante (`_migrations`).
		expect(nombres.some((n: string) => n.startsWith("_"))).toBe(false);
		expect(nombres.some((n: string) => n.startsWith("sqlite_"))).toBe(false);
		// Y sí las de negocio, para que la exclusión no se haya llevado media base por delante.
		expect(nombres).toContain("Zonas");
		expect(nombres).toContain("Usuarios");
	});

	it("una base recién aprovisionada se vuelca vacía, no falla", async () => {
		// El caso del TPV que pierde la base el primer día: no hay nada que traer, pero el
		// endpoint tiene que contestar igual para que la recuperación pueda terminar.
		const { status, body } = await pedirVolcado("vacia", () => {});

		expect(status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.seq).toBe(0);
		expect(body.tablas.length).toBeGreaterThan(0);
	});
});
