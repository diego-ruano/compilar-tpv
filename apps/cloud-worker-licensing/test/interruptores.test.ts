// test/interruptores.test.ts
//
// PROD-06 · Interruptores remotos de emergencia.
//
// Lo que tiene que ser verdad para que esto sea un freno de mano y no un punto único de fallo:
//
//   · Que un interruptor aplique exactamente a quien debe: global o de un tenant, en un rango de
//     versiones, y sólo mientras no haya caducado.
//   · Que si la base central no contesta, TODO esté encendido (lo contrario convertiría una caída
//     de Turso en «el TPV deja de sincronizar»).
//   · Que administración no deje apagar nada para siempre, y que encender deje rastro.
//   · Que la cola del DO apagada no aplique ni pierda nada, y que al encenderse drene.
//
// Corre contra el esquema real del control-plane sobre el SQLite del Durable Object.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import {
	aplicaAVersion,
	apagadosPara,
	estaApagado,
	olvidarInterruptoresCacheados,
	reducir,
	type FilaInterruptor,
} from "../src/lib/interruptores";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const TOKEN = "token-de-pruebas";
const AHORA = 1_800_000_000_000;
const HORA = 3_600_000;

function fila(p: Partial<FilaInterruptor>): FilaInterruptor {
	return {
		interruptor_id: crypto.randomUUID(),
		interruptor: "reparacion_nube",
		tenant_id: "*",
		version_desde: null,
		version_hasta: null,
		motivo: "pruebas",
		expires_at_ms: AHORA + HORA,
		created_at_ms: AHORA,
		...p,
	};
}

beforeEach(() => olvidarInterruptoresCacheados());

describe("PROD-06 · a quién aplica un interruptor", () => {
	it("global aplica a todos; de un tenant, sólo a ése", () => {
		const filas = [
			fila({ interruptor: "reparacion_nube" }),
			fila({ interruptor: "imagenes", tenant_id: "t-otro" }),
		];
		expect(reducir(filas, "t-1", null, AHORA).map((a) => a.interruptor)).toEqual([
			"reparacion_nube",
		]);
		expect(
			reducir(filas, "t-otro", null, AHORA)
				.map((a) => a.interruptor)
				.sort(),
		).toEqual(["imagenes", "reparacion_nube"]);
	});

	it("caducado es encendido, aunque la fila siga ahí", () => {
		const filas = [fila({ expires_at_ms: AHORA - 1 }), fila({ interruptor: "imagenes", expires_at_ms: AHORA })];
		expect(reducir(filas, "t-1", null, AHORA)).toEqual([]);
	});

	it("un nombre que esta versión no conoce se ignora en vez de romper", () => {
		expect(reducir([fila({ interruptor: "uno_del_futuro" })], "t-1", null, AHORA)).toEqual([]);
	});

	it("varias filas del mismo: gana la que dura más", () => {
		const filas = [
			fila({ motivo: "corta", expires_at_ms: AHORA + HORA }),
			fila({ motivo: "larga", tenant_id: "t-1", expires_at_ms: AHORA + 5 * HORA }),
		];
		expect(reducir(filas, "t-1", null, AHORA)).toEqual([
			{ interruptor: "reparacion_nube", motivo: "larga", hasta_ms: AHORA + 5 * HORA },
		]);
	});

	it("rango de versiones: inclusivo en los dos extremos", () => {
		const f = { version_desde: "1.4.0", version_hasta: "1.4.2" };
		expect(aplicaAVersion(f, "1.3.9")).toBe(false);
		expect(aplicaAVersion(f, "1.4.0")).toBe(true);
		expect(aplicaAVersion(f, "1.4.1")).toBe(true);
		expect(aplicaAVersion(f, "1.4.2")).toBe(true);
		expect(aplicaAVersion(f, "1.4.10")).toBe(false);
		expect(aplicaAVersion({ version_desde: "1.4.0", version_hasta: null }, "2.0.0")).toBe(true);
		expect(aplicaAVersion({ version_desde: null, version_hasta: "1.4.0" }, "1.4.0-beta.1")).toBe(true);
	});

	it("sin versión conocida sólo aplica lo que no tiene rango", () => {
		expect(aplicaAVersion({ version_desde: null, version_hasta: null }, null)).toBe(true);
		expect(aplicaAVersion({ version_desde: "1.0.0", version_hasta: null }, null)).toBe(false);
	});
});

describe("PROD-06 · leer de la base central", () => {
	it("lee de la tabla real y filtra por tenant, caducidad y versión", async () => {
		await enElHub("interruptores-leer", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			sql.exec("DELETE FROM interruptores;");
			const db = clienteSobre(sql);
			const ahora = Date.now();
			const ins = (i: string, t: string, exp: number, desde: string | null = null) =>
				sql.exec(
					`INSERT INTO interruptores (interruptor_id, interruptor, tenant_id, version_desde, motivo, expires_at_ms)
					 VALUES (?, ?, ?, ?, 'x', ?);`,
					crypto.randomUUID(),
					i,
					t,
					desde,
					exp,
				);
			ins("volcado_atraso", "*", ahora + HORA);
			ins("imagenes", "t-1", ahora + HORA);
			ins("cola_do", "t-2", ahora + HORA);
			ins("backfill_historico", "*", ahora - 1);
			ins("cifrado_pii", "*", ahora + HORA, "9.0.0");

			const nombres = async (t: string, v: string | null) =>
				(await apagadosPara(() => db as any, t, v)).map((a) => a.interruptor).sort();

			expect(await nombres("t-1", "1.0.0")).toEqual(["imagenes", "volcado_atraso"]);
			olvidarInterruptoresCacheados();
			expect(await nombres("t-1", "9.1.0")).toEqual(["cifrado_pii", "imagenes", "volcado_atraso"]);
			expect(await nombres("t-2", "1.0.0")).toEqual(["cola_do", "volcado_atraso"]);
		});
	});

	it("si la base central no contesta, todo está encendido", async () => {
		const rota = () => ({
			execute: async () => {
				throw new Error("turso caido");
			},
		});
		expect(await apagadosPara(rota as any, "t-1", "1.0.0")).toEqual([]);
		expect(await estaApagado(rota as any, "t-1", "cola_do")).toBeNull();

		// Y si ni siquiera se puede construir el cliente (falta el secreto), igual.
		const sinCliente = () => {
			throw new Error("missing_env_TURSO_AUTH_TOKEN");
		};
		expect(await apagadosPara(sinCliente as any, "t-1", null)).toEqual([]);
	});

	it("un fallo no se cachea: en cuanto la base vuelve, se obedece", async () => {
		let caida = true;
		const db = () => ({
			execute: async () => {
				if (caida) throw new Error("turso caido");
				return { rows: [fila({ interruptor: "imagenes", expires_at_ms: Date.now() + HORA })] };
			},
		});
		expect(await apagadosPara(db as any, "t-1", null)).toEqual([]);
		caida = false;
		expect((await apagadosPara(db as any, "t-1", null)).map((a) => a.interruptor)).toEqual(["imagenes"]);
	});
});

describe("PROD-06 · administración", () => {
	async function conAdmin<T>(
		fn: (x: { post: (r: string, b?: unknown) => Promise<Response>; get: (r: string) => Promise<Response>; sql: any }) => Promise<T>,
	) {
		return enElHub("interruptores-admin", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			for (const t of ["interruptores", "admin_audit"]) sql.exec(`DELETE FROM ${t};`);
			dbDePruebas = clienteSobre(sql);
			const env = { ADMIN_API_TOKEN: TOKEN } as any;
			const pedir = async (ruta: string, init: RequestInit) =>
				await adminRoutes.fetch(
					new Request(`https://api${ruta}`, {
						...init,
						headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
					}),
					env,
				);
			return fn({
				sql,
				post: (r, b) => pedir(r, { method: "POST", body: JSON.stringify(b ?? {}) }),
				get: (r) => pedir(r, { method: "GET" }),
			});
		});
	}

	it("apaga, lista y enciende dejando rastro", async () => {
		await conAdmin(async ({ post, get, sql }) => {
			const r = await post("/interruptores", {
				interruptor: "reparacion_nube",
				motivo: "Reparación pisando filas buenas",
				horas: 2,
			});
			expect(r.status).toBe(200);
			const { interruptorId, tenantId } = (await r.json()) as any;
			expect(tenantId).toBe("*");

			const lista = (await (await get("/interruptores")).json()) as any;
			expect(lista.interruptores).toHaveLength(1);
			expect(lista.interruptores[0]).toMatchObject({ interruptor: "reparacion_nube", vigente: true });

			expect(
				await estaApagado(() => dbDePruebas as any, "cualquiera", "reparacion_nube"),
			).toMatchObject({ motivo: "Reparación pisando filas buenas" });

			const enc = await post(`/interruptores/${interruptorId}/encender`);
			expect(enc.status).toBe(200);
			// Encender no borra: la fila queda en el historial, caducada.
			expect((await (await get("/interruptores")).json() as any).interruptores).toHaveLength(0);
			const hist = (await (await get("/interruptores?historial=1")).json()) as any;
			expect(hist.interruptores[0]).toMatchObject({ interruptorId, vigente: false });

			// Y la caché de este isolate se ha vaciado: se obedece al momento.
			expect(await estaApagado(() => dbDePruebas as any, "cualquiera", "reparacion_nube")).toBeNull();

			const acciones = sql
				.exec("SELECT action FROM admin_audit ORDER BY at_ms, rowid;")
				.toArray()
				.map((f: any) => f.action);
			expect(acciones).toEqual(["interruptor_apagar", "interruptor_encender"]);

			// Encender dos veces lo mismo: ya no está vigente.
			expect((await post(`/interruptores/${interruptorId}/encender`)).status).toBe(404);
		});
	});

	it("de un tenant y con rango de versiones", async () => {
		await conAdmin(async ({ post }) => {
			const r = await post("/interruptores", {
				interruptor: "imagenes",
				tenantId: "t-9",
				versionDesde: "1.4.2",
				versionHasta: "1.4.2",
				motivo: "Bucle de subidas",
				horas: 1,
			});
			expect(r.status).toBe(200);
			const db = () => dbDePruebas as any;
			expect(await estaApagado(db, "t-9", "imagenes", "1.4.2")).not.toBeNull();
			expect(await estaApagado(db, "t-9", "imagenes", "1.4.3")).toBeNull();
			expect(await estaApagado(db, "t-8", "imagenes", "1.4.2")).toBeNull();
		});
	});

	it("no deja apagar nada para siempre", async () => {
		await conAdmin(async ({ post, sql }) => {
			const base = { motivo: "pruebas de tope" };
			expect((await post("/interruptores", { ...base, interruptor: "imagenes", horas: 169 })).status).toBe(400);
			expect((await post("/interruptores", { ...base, interruptor: "imagenes", horas: 168 })).status).toBe(200);
			// Sin caducidad, no.
			expect((await post("/interruptores", { ...base, interruptor: "imagenes" })).status).toBe(400);
			// Un nombre fuera de la lista cerrada, no.
			expect((await post("/interruptores", { ...base, interruptor: "cobrar", horas: 1 })).status).toBe(400);
			// Sin motivo, no: es lo que se enseña en la pantalla del bar.
			expect((await post("/interruptores", { interruptor: "imagenes", horas: 1 })).status).toBe(400);

			expect(sql.exec("SELECT COUNT(*) AS n FROM interruptores;").toArray()[0].n).toBe(1);
		});
	});

	it("sin el token de administración, nada", async () => {
		await enElHub("interruptores-admin", async () => {
			const r = await adminRoutes.fetch(
				new Request("https://api/interruptores", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ interruptor: "imagenes", motivo: "xxx", horas: 1 }),
				}),
				{ ADMIN_API_TOKEN: TOKEN } as any,
			);
			expect(r.status).toBe(401);
		});
	});
});

describe("PROD-06 · la cola del DO apagada", () => {
	const TENANT = "tenant-1";
	const SEMILLA = [
		"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
		"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
		"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 300);",
		"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');",
	];
	const op = (n: number) => ({
		opId: `op-${n}`,
		commandName: "add_linea",
		cmd: {
			type: "tenantDb.transaction" as const,
			payload: {
				steps: [
					{
						kind: "execute" as const,
						sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES (?1, 'comanda-1', 'prod-1', 1, 300);",
						args: [`det-${n}`],
					},
				],
			},
		},
		deviceId: "device-main",
		requestPayloadJson: "{}",
		cloudPayloadJson: "{}",
		clientNow: "2026-01-01 12:30:00",
	});

	function preparar(hub: any) {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of SEMILLA) sql.exec(s);
		const db = clienteSobre(sql, hub.state.storage);
		hub.getTenantDb = async () => db;
		return sql;
	}
	const enCola = (sql: any) => sql.exec("SELECT COUNT(*) AS n FROM _Cola_Entrada;").toArray()[0].n;
	const lineas = (sql: any) => sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n;

	it("no aplica nada, no aparta nada, y vuelve a mirar en unos minutos", async () => {
		await enElHub("interruptores-cola-pausada", async (hub: any) => {
			const sql = preparar(hub);
			hub.encolar(TENANT, [op(1), op(2)]);
			const hasta = Date.now() + 2 * HORA;
			hub.colaPausada = async () => ({ hasta_ms: hasta });
			await hub.state.storage.deleteAlarm();

			await hub.alarm();

			expect(enCola(sql)).toBe(2);
			expect(lineas(sql)).toBe(0);
			expect(sql.exec("SELECT COUNT(*) AS n FROM _Cola_Muerta;").toArray()[0].n).toBe(0);
			const t = Number(await hub.state.storage.getAlarm()) - Date.now();
			expect(t).toBeGreaterThan(4 * 60_000);
			expect(t).toBeLessThanOrEqual(5 * 60_000);
		});
	});

	it("si el apagado caduca antes de la próxima revisión, se revisa al caducar", async () => {
		await enElHub("interruptores-cola-caduca", async (hub: any) => {
			preparar(hub);
			hub.encolar(TENANT, [op(1)]);
			const hasta = Date.now() + 30_000;
			hub.colaPausada = async () => ({ hasta_ms: hasta });

			await hub.alarm();

			expect(Number(await hub.state.storage.getAlarm())).toBe(hasta);
		});
	});

	it("al encenderse drena todo lo que esperaba", async () => {
		await enElHub("interruptores-cola-reanuda", async (hub: any) => {
			const sql = preparar(hub);
			hub.encolar(TENANT, [op(1), op(2), op(3)]);
			hub.colaPausada = async () => ({ hasta_ms: Date.now() + HORA });
			await hub.alarm();
			expect(lineas(sql)).toBe(0);

			hub.colaPausada = async () => null;
			await hub.alarm();

			expect(enCola(sql)).toBe(0);
			expect(lineas(sql)).toBe(3);
		});
	});

	it("sin base central alcanzable (lo normal en tests) la cola drena como siempre", async () => {
		// Es el método de verdad, sin sustituir: en tests no hay TURSO_AUTH_TOKEN, así que `getDb`
		// lanza y el interruptor tiene que darse por encendido.
		dbDePruebas = null;
		await enElHub("interruptores-cola-sin-central", async (hub: any) => {
			const sql = preparar(hub);
			hub.encolar(TENANT, [op(1)]);
			await hub.alarm();
			expect(lineas(sql)).toBe(1);
		});
	});
});
