// test/retirarUnNegocio.test.ts
//
// Retirar un negocio de pruebas es borrar todo lo que guarda en la nube, con los objetos de verdad:
//
// - su `TenantHub`: se cierran las sesiones que siguieran vivas, se quita la alarma de la cola y se
//   borra todo lo guardado, y nada de lo que llega después (el cierre de esos sockets) vuelve a
//   crear tablas en un objeto que tiene que quedarse vacío;
// - su `AgendaWeb`: lo que esperaba a la Main, con los datos de quien reservó, y su alarma;
// - sus imágenes: la carpeta del negocio en el bucket, y sólo la suya.
//
// Qué negocios se retiran lo decide `retirarNegociosDePrueba` (`test/pruebasRetiradas.test.ts`).

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { enLaAgenda, stubDeLaAgenda } from "./helpers/agenda";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";
import { borrarImagenesDelNegocio } from "../src/domains/admin/pruebas";

const env = entorno as any;

/** Las tablas que hay en el SQLite del objeto, sin las de SQLite ni las del runtime. */
const tablas = (sql: any): string[] =>
	sql
		.exec(
			`SELECT name FROM sqlite_master
			  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			  ORDER BY name;`,
		)
		.toArray()
		.map((f: any) => String(f.name));

type Conexion = { cliente: WebSocket; servidor: WebSocket; recibidos: any[]; cierre: { code: number; reason: string } | null };

/** Un socket aceptado por el DO con el attachment que deja un saludo correcto. */
function conectar(hub: any, tenantId: string, deviceId: string, role: "tpv" | "handy"): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({ tenantId, deviceId, role, authed: true, pubkeyB64: null, challenge: null, recovering: false });
	const c: Conexion = { cliente: par[0], servidor: par[1], recibidos: [], cierre: null };
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => c.recibidos.push(JSON.parse(String(ev.data))));
	par[0].addEventListener("close", (ev: CloseEvent) => (c.cierre = { code: ev.code, reason: ev.reason }));
	return c;
}

async function esperarA(cond: () => boolean, ms = 3_000): Promise<boolean> {
	const limite = Date.now() + ms;
	while (!cond() && Date.now() < limite) await new Promise((r) => setTimeout(r, 10));
	return cond();
}

describe("TenantHub.borrarTodo", () => {
	it("cierra las sesiones vivas, quita la alarma y no deja nada guardado", async () => {
		const tenantId = "retirar-hub";
		const stub = env.TenantHub.get(env.TenantHub.idFromName(tenantId));
		expect(await stub.aprovisionar(tenantId)).toEqual({ reused: false });

		const { main, handy } = await enElHub(tenantId, async (hub: any) => {
			hub.touchLastSeen = async () => {};
			hub.colaPausada = async () => null;
			hub.state.storage.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
			laMainEs(hub, "la-main");
			// Algo en la cola: es lo que programa la alarma del objeto.
			hub.encolar(tenantId, [
				{
					opId: "op-en-cola",
					commandName: "x",
					cmd: { type: "tenantDb.exec", payload: { sql: "UPDATE Zonas SET Nombre_Zona = 'Otra';", args: [] } },
					deviceId: "la-main",
					requestPayloadJson: "{}",
					cloudPayloadJson: "{}",
					clientNow: "",
				},
			]);
			await hub.state.storage.setAlarm(Date.now() + 60_000);
			expect(await hub.state.storage.getAlarm()).not.toBeNull();
			expect(tablas(hub.state.storage.sql)).toContain("Zonas");
			return { main: conectar(hub, tenantId, "la-main", "tpv"), handy: conectar(hub, tenantId, "una-handy", "handy") };
		});

		await stub.borrarTodo();

		// Las dos sesiones, cerradas por el DO.
		expect(await esperarA(() => main.cierre !== null && handy.cierre !== null)).toBe(true);
		expect(main.cierre).toEqual({ code: 4001, reason: "negocio_retirado" });
		expect(handy.cierre).toEqual({ code: 4001, reason: "negocio_retirado" });

		await enElHub(tenantId, async (hub: any) => {
			expect(tablas(hub.state.storage.sql)).toEqual([]);
			expect(await hub.state.storage.getAlarm()).toBeNull();
			for (const c of [main, handy]) {
				expect(c.servidor.deserializeAttachment()).toMatchObject({ authed: false, fuera: true });
			}

			// El cierre de esos sockets llega después, y no puede volver a crear nada en el objeto.
			await hub.webSocketClose(main.servidor, 4001, "negocio_retirado", true);
			await hub.webSocketClose(handy.servidor, 4001, "negocio_retirado", true);
			expect(tablas(hub.state.storage.sql)).toEqual([]);
		});

		expect(await stub.estaAprovisionado()).toBe(false);
		expect(await stub.leerParaLaWeb(tenantId, { que: "plano" })).toMatchObject({
			ok: false,
			code: "tenant_db_not_provisioned",
		});
	});

	it("borrar dos veces no hace nada, y un negocio que nunca tuvo base tampoco falla", async () => {
		const stub = env.TenantHub.get(env.TenantHub.idFromName("retirar-hub-vacio"));
		await stub.borrarTodo();
		await stub.borrarTodo();
		expect(await enElHub("retirar-hub-vacio", (hub: any) => tablas(hub.state.storage.sql))).toEqual([]);
	});

	it("el negocio se puede volver a dar de alta en el mismo objeto, vacío", async () => {
		const tenantId = "retirar-hub-y-volver";
		const stub = env.TenantHub.get(env.TenantHub.idFromName(tenantId));
		await stub.aprovisionar(tenantId);
		await enElHub(tenantId, (hub: any) => {
			hub.state.storage.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
		});

		await stub.borrarTodo();

		expect(await stub.aprovisionar(tenantId)).toEqual({ reused: false });
		const r = await stub.leerParaLaWeb(tenantId, { que: "plano" });
		expect(r).toMatchObject({ ok: true, valor: { salones: [] } });
	});
});

describe("AgendaWeb.borrarTodo", () => {
	it("borra lo que la agenda guarda del negocio y su alarma, y la agenda sigue sirviendo", async () => {
		const nombre = "retirar-agenda";
		await enLaAgenda(nombre, async (_motor, state) => {
			const { sql } = state.storage;
			sql.exec(`INSERT INTO estado (clave, valor) VALUES ('tenant', 'retirar-agenda');`);
			sql.exec(`INSERT INTO intentos (clave, respuesta_json, creado_ms) VALUES ('clave-de-un-intento', '{"nombre":"Ana López"}', 1);`);
			await state.storage.setAlarm(Date.now() + 60_000);
			expect(tablas(sql)).toContain("peticiones");
		});

		await stubDeLaAgenda(nombre).borrarTodo();

		await enLaAgenda(nombre, async (motor, state) => {
			expect(tablas(state.storage.sql)).toEqual([]);
			expect(await state.storage.getAlarm()).toBeNull();
			// El objeto sigue vivo: lo siguiente que se le pida encuentra una agenda vacía, no un error.
			expect(await motor.pendientes({ tenantId: nombre })).toMatchObject({ ok: true });
			expect(Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM intentos;").one().n)).toBe(0);
		});
	});
});

describe("las imágenes de un negocio", () => {
	const JPEG = new Uint8Array([255, 216, 255, 224]);

	it("se borra su carpeta del bucket, y sólo la suya", async () => {
		const claves = [
			"neg-1/images/productos/a.jpg",
			"neg-1/images/logo/logo.png",
			"neg-1/images/categorias/b.webp",
			// El id de otro negocio empieza igual: su carpeta es otra.
			"neg-10/images/productos/c.jpg",
			"neg-1x/images/productos/d.jpg",
			"otro/images/productos/neg-1/e.jpg",
		];
		for (const clave of claves) await env.IMAGES.put(clave, JPEG);

		expect(await borrarImagenesDelNegocio(env.IMAGES, "neg-1")).toBe(3);

		const quedan = (await env.IMAGES.list()).objects.map((o: any) => o.key).sort();
		expect(quedan).toEqual(["neg-10/images/productos/c.jpg", "neg-1x/images/productos/d.jpg", "otro/images/productos/neg-1/e.jpg"]);
		// Repetirlo no hace nada.
		expect(await borrarImagenesDelNegocio(env.IMAGES, "neg-1")).toBe(0);
	});

	it("sigue hasta el final cuando la lista viene por páginas", async () => {
		const guardadas = new Set(Array.from({ length: 2_500 }, (_, i) => `grande/images/productos/${i}.jpg`));
		guardadas.add("grande-2/images/productos/x.jpg");
		const listas: number[] = [];
		const bucket = {
			async list({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit: number }) {
				// Como R2: el cursor dice por qué clave se iba, y la página siguiente sigue detrás de ella.
				const quedan = [...guardadas].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
				const pagina = quedan.slice(0, limit);
				listas.push(pagina.length);
				const truncated = quedan.length > limit;
				return { objects: pagina.map((key) => ({ key })), truncated, cursor: truncated ? pagina[pagina.length - 1] : undefined };
			},
			async delete(claves: string[]) {
				expect(claves.length).toBeLessThanOrEqual(1000);
				for (const k of claves) guardadas.delete(k);
			},
		} as unknown as R2Bucket;

		expect(await borrarImagenesDelNegocio(bucket, "grande")).toBe(2_500);
		expect(listas).toEqual([1000, 1000, 500]);
		expect([...guardadas]).toEqual(["grande-2/images/productos/x.jpg"]);
	});

	it("un id que no nombra la carpeta de un negocio no borra nada", async () => {
		await env.IMAGES.put("neg-2/images/productos/a.jpg", JPEG);
		for (const id of ["", "neg-2/images", "/", "neg-2/"]) {
			await expect(borrarImagenesDelNegocio(env.IMAGES, id), JSON.stringify(id)).rejects.toThrow("tenant_id_invalido");
		}
		expect((await env.IMAGES.list({ prefix: "neg-2/" })).objects).toHaveLength(1);
	});
});
