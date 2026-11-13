// test/negocioDelHub.test.ts
//
// DO-NEGOCIO · Un TenantHub sabe de qué negocio es, y sólo atiende al suyo.
//
// El Worker llega al objeto por el nombre del negocio, y el negocio viaja otra vez en cada llamada.
// El objeto lo apunta al darse de alta en el sello de su base (`_Negocio`, `tenantHub.negocio.ts`)
// y contrasta con él toda llamada que trae uno. Con el objeto de verdad y por las puertas de verdad (RPC, `ejecutarRuta` y
// el upgrade del WebSocket), aquí se fija que:
//
//   · el alta apunta el negocio, y no cambia aunque después se le pida otra alta con otro;
//   · una llamada con el negocio de otro se rechaza con `negocio_ajeno` antes de tocar la base, por
//     todas las puertas, y no deja nada escrito;
//   · un objeto que ya tenía base cuando esto no existía se queda con el negocio de la primera
//     llamada que le llega, y a partir de ahí rechaza los demás;
//   · un objeto sin base no apunta nada ni crea tablas por preguntarle;
//   · retirado el negocio, el objeto se olvida de quién era y puede volver a darse de alta;
//   · los eventos de salud llevan el negocio apuntado aunque la instancia no haya recibido ninguna
//     llamada que se lo diga (la que despierta una alarma).

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { negocioApuntado } from "../src/durableObjects/tenantHub.negocio";
import type { ApplyParams, IdentidadDelWorker } from "../src/durableObjects/tenantHub.rpc";

// Una ruta que se encuentra sin base pregunta a la base central si el negocio ha nacido
// (`lib/basePerdida.ts`). Aquí ninguno lo ha hecho: no hay licencias.
vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => ({ execute: async () => ({ rows: [] }) }) };
});

const env = entorno as any;
const stub = (nombre: string) => env.TenantHub.get(env.TenantHub.idFromName(nombre));

/** Las tablas del objeto, sin las de SQLite ni las del runtime. */
const tablas = (sql: any): string[] =>
	sql
		.exec(
			`SELECT name FROM sqlite_master
			  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			  ORDER BY name;`,
		)
		.toArray()
		.map((f: any) => String(f.name));

/**
 * Con qué rechaza una llamada RPC. El `await` va aquí dentro: si el rechazo se entrega a `expect`
 * sin esperar, se queda un microtask sin manejador y workerd lo cuenta como no manejado.
 */
async function rechazo(llamada: () => Promise<unknown>): Promise<string> {
	try {
		await llamada();
		return "__aceptada__";
	} catch (e: any) {
		return String(e?.message ?? e);
	}
}

const zonas = (nombre: string): Promise<number> =>
	enElHub(nombre, (hub: any) => Number(hub.state.storage.sql.exec("SELECT COUNT(*) AS n FROM Zonas;").one().n));

const identidad = (tenantId: string): IdentidadDelWorker => ({
	tenantId,
	deviceId: "una-handy",
	token: "t",
	licHash: "h",
	rol: "handy",
});

/** Una ruta de lectura cualquiera, que dentro del DO lee la base del negocio. */
const peticionDeLectura = () =>
	new Request("https://tpv-api.test/v1/trabajadores/permisos/00000000-0000-7000-8000-000000000001");

const escritura = (tenantId: string): ApplyParams => ({
	tenantId,
	deviceId: "una-handy",
	opId: "op-negocio-ajeno",
	commandName: "prueba",
	command: {
		type: "tenantDb.exec",
		payload: { sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-ajena', 'Ajena');", args: [] },
	},
});

describe("el alta apunta el negocio del objeto", () => {
	it("queda apuntado al aprovisionar y otra alta con otro negocio se rechaza", async () => {
		const negocio = "negocio-hub-alta";
		expect(await enElHub(negocio, (hub: any) => negocioApuntado(hub.state.storage))).toBeNull();

		expect(await stub(negocio).aprovisionar(negocio)).toEqual({ reused: false });
		expect(await enElHub(negocio, (hub: any) => negocioApuntado(hub.state.storage))).toBe(negocio);

		// Repetir el alta del mismo es lo de siempre.
		expect(await stub(negocio).aprovisionar(negocio)).toEqual({ reused: true });
		// La de otro negocio, no: ni se migra ni se siembra nada, y el apuntado no cambia.
		expect(await rechazo(() => stub(negocio).aprovisionar("otro-negocio"))).toMatch(/negocio_ajeno/);
		expect(await rechazo(() => stub(negocio).aprovisionar(""))).toMatch(/missing_tenant_id/);
		expect(await enElHub(negocio, (hub: any) => negocioApuntado(hub.state.storage))).toBe(negocio);
	});
});

describe("una llamada con el negocio de otro no llega a la base", () => {
	it("consultar, anotarEstado, aplicar y releerMain la rechazan con negocio_ajeno", async () => {
		const negocio = "negocio-hub-rpc";
		await stub(negocio).aprovisionar(negocio);
		const eventos: any[] = [];
		await enElHub(negocio, (hub: any) => {
			hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => void eventos.push({ name, ...campos });
			hub.mainEnCentral = async () => null;
		});

		const ajeno = { ok: false, code: "negocio_ajeno", status: 500 };
		expect(await stub(negocio).consultar("otro-negocio", ["SELECT COUNT(*) AS n FROM Usuarios;"], false)).toMatchObject(ajeno);
		expect(await stub(negocio).consultar("", ["SELECT 1;"], false)).toMatchObject(ajeno);
		expect(
			await stub(negocio).anotarEstado("otro-negocio", {
				sql: "INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('d', 1, 1);",
				args: [],
			}),
		).toMatchObject(ajeno);
		expect(await stub(negocio).aplicar(escritura("otro-negocio"))).toEqual({ ok: false, error: "negocio_ajeno", status: 500 });
		expect(await rechazo(() => stub(negocio).releerMain("otro-negocio"))).toMatch(/negocio_ajeno/);

		// Nada de eso ha escrito: ni la zona, ni el checkpoint, ni la tabla de quién es la Main.
		await enElHub(negocio, (hub: any) => {
			const sql = hub.state.storage.sql;
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Zonas;").one().n)).toBe(0);
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Sync_Main_Checkpoints;").one().n)).toBe(0);
			expect(tablas(sql)).not.toContain("_Main_Vigente");
		});
		expect(eventos.filter((e) => e.name === "negocio_ajeno").map((e) => [e.operacion, e.recibido])).toEqual([
			["consultar", "otro-negocio"],
			["consultar", ""],
			["anotarEstado", "otro-negocio"],
			["aplicar", "otro-negocio"],
			["releerMain", "otro-negocio"],
		]);

		// Con el suyo, todo sigue como siempre.
		expect(await stub(negocio).consultar(negocio, ["SELECT COUNT(*) AS n FROM Zonas;"], false)).toMatchObject({
			ok: true,
			resultados: [{ rows: [[0]] }],
		});
		await expect(stub(negocio).releerMain(negocio)).resolves.toBeUndefined();
		// Sin Main conectada no entra, pero ha pasado la comprobación del negocio.
		expect(await stub(negocio).aplicar(escritura(negocio))).toEqual({ ok: false, error: "main_offline", status: 400 });
	});

	it("ejecutarRuta contesta un 500 sin ejecutar la ruta", async () => {
		const negocio = "negocio-hub-ruta";
		await stub(negocio).aprovisionar(negocio);

		const ajena: Response = await stub(negocio).ejecutarRuta(peticionDeLectura(), identidad("otro-negocio"));
		expect(ajena.status).toBe(500);
		expect(await ajena.json()).toEqual({ ok: false, code: "internal", error: "negocio_ajeno" });

		// La misma ruta con la identidad del negocio se ejecuta (el usuario no existe: `null`).
		const propia: Response = await stub(negocio).ejecutarRuta(peticionDeLectura(), identidad(negocio));
		expect(propia.status).toBe(200);
		expect(await propia.json()).toBeNull();
	});

	it("el WebSocket de otro negocio no se acepta", async () => {
		const negocio = "negocio-hub-ws";
		await stub(negocio).aprovisionar(negocio);
		await enElHub(negocio, async (hub: any) => {
			hub.touchLastSeen = async () => {};
			const abrir = (tenantId: string): Promise<Response> =>
				hub.fetch(
					new Request("https://hub/ws", {
						headers: { Upgrade: "websocket", "x-tenant-id": tenantId, "x-device-id": "una-handy", "x-role": "handy" },
					}),
				);

			const ajeno = await abrir("otro-negocio");
			expect(ajeno.status).toBe(500);
			expect(ajeno.webSocket).toBeNull();
			expect(hub.state.getWebSockets().length).toBe(0);

			const propio = await abrir(negocio);
			expect(propio.status).toBe(101);
			expect(hub.state.getWebSockets().length).toBe(1);
			propio.webSocket!.accept();
			propio.webSocket!.close(1000, "fin");
		});
	});
});

describe("un objeto que ya tenía base sin negocio apuntado", () => {
	it("se queda con el de la primera llamada y rechaza los demás", async () => {
		const negocio = "negocio-hub-anterior";
		await stub(negocio).aprovisionar(negocio);
		// Como lo dejó un alta anterior a que se apuntara el negocio: con su base y sin sellar.
		await enElHub(negocio, (hub: any) => {
			hub.state.storage.sql.exec("DELETE FROM _Negocio;");
			expect(negocioApuntado(hub.state.storage)).toBeNull();
		});

		expect(await stub(negocio).consultar(negocio, ["SELECT 1 AS uno;"], false)).toMatchObject({ ok: true });
		expect(await enElHub(negocio, (hub: any) => negocioApuntado(hub.state.storage))).toBe(negocio);
		expect(await stub(negocio).consultar("otro-negocio", ["SELECT 1 AS uno;"], false)).toMatchObject({
			ok: false,
			code: "negocio_ajeno",
		});
	});
});

describe("un objeto sin base", () => {
	it("no apunta nada ni crea tablas por preguntarle", async () => {
		const negocio = "negocio-hub-sin-base";
		expect(await stub(negocio).consultar(negocio, ["SELECT 1;"], false)).toMatchObject({
			ok: false,
			code: "tenant_db_not_provisioned",
		});
		const res: Response = await stub(negocio).ejecutarRuta(peticionDeLectura(), identidad(negocio));
		expect(res.status).toBe(404);
		// Tampoco la de un `tpv`, que antes mira si es la Main (`vetoDeMain`): sin tabla, no se ha leído.
		const deLaMain: Response = await stub(negocio).ejecutarRuta(peticionDeLectura(), {
			...identidad(negocio),
			deviceId: "la-main",
			rol: "tpv",
		});
		expect(deLaMain.status).toBe(404);

		await enElHub(negocio, (hub: any) => {
			expect(negocioApuntado(hub.state.storage)).toBeNull();
			expect(tablas(hub.state.storage.sql)).toEqual([]);
		});
	});

	it("retirado el negocio, el objeto se olvida de quién era y puede volver a darse de alta", async () => {
		const negocio = "negocio-hub-retirado";
		await stub(negocio).aprovisionar(negocio);
		await stub(negocio).borrarTodo();
		await enElHub(negocio, (hub: any) => {
			expect(negocioApuntado(hub.state.storage)).toBeNull();
			expect(tablas(hub.state.storage.sql)).toEqual([]);
		});

		expect(await stub(negocio).aprovisionar(negocio)).toEqual({ reused: false });
		expect(await enElHub(negocio, (hub: any) => negocioApuntado(hub.state.storage))).toBe(negocio);
		expect(await zonas(negocio)).toBe(0);
	});
});

describe("los eventos de salud", () => {
	it("llevan el negocio apuntado sin que ninguna llamada se lo haya dicho a la instancia", async () => {
		const negocio = "negocio-hub-trazas";
		await stub(negocio).aprovisionar(negocio);
		await enElHub(negocio, (hub: any) => {
			// Como la instancia que despierta una alarma: no ha visto ninguna petición.
			hub.tenantIdVisto = null;
			expect(hub.negocioParaTrazas()).toBe(negocio);
		});
		// Sin base no hay negocio apuntado: vale el de la última llamada, y si no la hay, ninguno.
		await enElHub("negocio-hub-trazas-sin-base", (hub: any) => {
			expect(hub.negocioParaTrazas()).toBeUndefined();
			hub.tenantIdVisto = "visto";
			expect(hub.negocioParaTrazas()).toBe("visto");
		});
	});
});
