// test/guardasEnElLote.test.ts
//
// SYNC-30 · Una ruta del worker decide leyendo la base fuera del lote que escribe, y entre su lectura
// y el lote puede entrar otra escritura (lo que sube la Main, otra Handy): mientras la ruta espera,
// el TenantHub atiende a los demás. Lo que decide va ahora en un paso `guard` del comando, que se
// evalúa dentro del mismo lote atómico que las escrituras, no se replica y, si no se cumple,
// deshace el lote entero y contesta el error de negocio de la ruta.
//
// Primero el paso por sí mismo, contra el motor de verdad (`aplicar`, el que usa una ruta): todo o
// nada, que no llega a la Main, que convive con las claves foráneas aplazadas y que un reintento
// con la misma clave vuelve a decidir. Después, cada comprobación que se ha pasado a una guarda, con
// la ruta de verdad y una escritura que entra en la base entre su lectura y su lote.
//
// SYNC-35 · Al final, las tres rutas que decidían por el recuento o por una lectura que devolvía el
// lote, y que en el reintento de una escritura cuyo resultado no se guardó entero contestaban mal:
// ahora lo decide una guarda, y la ruta no mira el resultado.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { cuerpoDeErrorConStatus } from "../src/lib/errorHttp";
import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

// Los routers van sueltos, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub, y su
// escritura va al motor del TenantHub de cada caso.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

const TENANT = "t-sync30";

/** La base del caso en curso: la que lee la ruta antes de mandar el lote. */
let nube: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", TENANT);
		c.set("deviceId", "handy-sync30");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(nube),
}));

const { reservasRoutes } = await import("../src/domains/reservas/reservas.routes");
const { mesasRoutes } = await import("../src/domains/mesas/mesas.routes");
const { trabajadoresRoutes } = await import("../src/domains/trabajadores/trabajadores.routes");
const { ventaRapidaRoutes } = await import("../src/domains/venta_rapida/venta_rapida.routes");
const { inventarioRoutes } = await import("../src/domains/inventario/inventario.routes");

const app = new Hono();
app.route("/v1/reservas", reservasRoutes);
app.route("/v1/mesas", mesasRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);
app.route("/v1/inventario", inventarioRoutes);
app.onError((e: any, c) => c.json(cuerpoDeErrorConStatus(e), e.status ?? 500));

const ADMIN = "00000000-0000-7000-8000-000000000001";
const CAMARERO = "00000000-0000-7000-8000-000000000002";

/** La hora local de quien escribe, como la manda la app (en los tests, UTC). */
const ahora = () => new Date().toISOString().slice(0, 19).replace("T", " ");

type Negocio = {
	hub: any;
	sql: any;
	/** Un número de una consulta. */
	n: (consulta: string) => number;
	/** Lo que el hub ha difundido a los demás dispositivos. */
	difundidos: any[];
	/** Lo que el hub ha mandado a Axiom. */
	eventos: string[];
	/**
	 * Pide una escritura por su ruta. `antesDelLote` entra en la base justo antes del lote, después
	 * de la lectura de la ruta; `clave` es la `X-Idempotency-Key` (una nueva si no se dice).
	 */
	pedir: (
		metodo: string,
		ruta: string,
		cuerpo?: unknown,
		opciones?: { antesDelLote?: string[]; clave?: string },
	) => Promise<{ status: number; json: any }>;
};

/** Un TenantHub con la base de verdad, la Main presente y `sembrar` dentro. */
async function conNegocio(nombre: string, sembrar: string[], prueba: (n: Negocio) => Promise<void>) {
	await enElHub(`sync30-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of sembrar) sql.exec(s);
		nube = clienteSobre(sql, hub.state.storage);

		// El lote va por el cliente de verdad (`loteEnBruto`), con lo que tenga que entrar antes.
		const real = clienteLocal(hub.state.storage);
		let antesDelLote: string[] = [];
		const db = {
			...real,
			async batch(sentencias: any[]) {
				for (const s of antesDelLote) sql.exec(s);
				antesDelLote = [];
				return real.batch(sentencias);
			},
		};
		hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
		hub.touchLastSeen = async () => {};
		hub.isMainConnected = () => true;
		hub.isMainReady = () => true;
		hub.maybePurgeSyncLog = async () => {};
		const difundidos: any[] = [];
		hub.broadcastAuthed = (m: any) => difundidos.push(m);
		const eventos: string[] = [];
		hub.emitSyncEvent = (nombreEvento: string) => eventos.push(nombreEvento);

		const env = {
			TenantHub: {
				idFromName: (n: string) => n,
				get: () => ({ aplicar: (p: any) => hub.aplicar(p) }),
			},
		};
		await prueba({
			hub,
			sql,
			n: (consulta) => Number(Object.values(sql.exec(consulta).toArray()[0] ?? {})[0] ?? 0),
			difundidos,
			eventos,
			async pedir(metodo, ruta, cuerpo, opciones = {}) {
				antesDelLote = opciones.antesDelLote ?? [];
				const res = await app.request(
					ruta,
					{
						method: metodo,
						headers: {
							"content-type": "application/json",
							"x-idempotency-key": opciones.clave ?? crypto.randomUUID(),
							"x-client-now": ahora(),
						},
						...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
					},
					env as any,
				);
				return { status: res.status, json: await res.json() };
			},
		});
	});
}

/* =========================================================
   El paso de guarda
========================================================= */

const guarda = (sql: string, error = "reserva_no_pendiente", status = 409) => ({
	kind: "guard" as const,
	sql,
	error,
	status,
});
const zona = (id: string) => ({
	kind: "execute" as const,
	sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?1);",
	args: [id],
});
const comando = (steps: any[]) => ({ type: "tenantDb.transaction" as const, payload: { steps } });

/** Una escritura por el motor, como la manda una ruta (`applyViaHub`). */
function aplicarEn(n: Negocio, opId: string, steps: any[], cloudPayload: unknown = { op: opId }) {
	return n.hub.aplicar({
		tenantId: TENANT,
		deviceId: "handy-sync30",
		opId,
		commandName: "prueba_guarda",
		command: comando(steps),
		cloudPayload,
		clientNow: ahora(),
	});
}

describe("SYNC-30 · el paso de guarda, al construir el lote", () => {
	it("se ejecuta con su guarda y no se replica", () => {
		const b = buildApplyBatch(comando([zona("z1"), guarda("SELECT 1;"), zona("z2")]));
		expect(b.middle.map((s) => s.sql)).toEqual([zona("z1").sql, "SELECT 1;", zona("z2").sql]);
		expect(b.middle[1].guarda).toEqual({ error: "reserva_no_pendiente", status: 409 });
		expect(b.replicated.map((s) => s.sql)).toEqual([zona("z1").sql, zona("z2").sql]);
		expect(b.replicated.some((s) => "guarda" in s)).toBe(false);
	});

	it("una guarda sin su error de negocio no se deja montar", () => {
		for (const mala of [
			guarda("SELECT 1;", ""),
			guarda("SELECT 1;", "x", 500),
			guarda("SELECT 1;", "x", 200),
			{ ...guarda("SELECT 1;"), status: "409" },
			{ kind: "guard", sql: "SELECT 1;" },
		]) {
			expect(() => buildApplyBatch(comando([mala])), JSON.stringify(mala)).toThrow(/invalid_transaction_step/);
		}
	});
});

describe("SYNC-30 · el paso de guarda, en el motor", () => {
	it("si no se cumple, no queda nada: ni lo escrito antes, ni el gate, ni el log, ni la difusión", async () => {
		await conNegocio("atomico", [], async (n) => {
			const r = await aplicarEn(n, "op-guarda-no", [zona("z1"), guarda("SELECT 0;"), zona("z2")]);
			expect(r).toEqual({ ok: false, error: "reserva_no_pendiente", status: 409 });
			expect(n.n("SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z1','z2')")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Applied_Operations")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);
			expect(n.difundidos).toEqual([]);
			// Es la respuesta de negocio de la ruta, no un fallo del motor.
			expect(n.eventos).not.toContain("apply_error");
		});
	});

	it("sin fila, o con NULL, tampoco se cumple", async () => {
		await conNegocio("sin-fila", [], async (n) => {
			for (const [i, consulta] of ["SELECT 1 WHERE 0;", "SELECT NULL;", "SELECT 'si';"].entries()) {
				const r = await aplicarEn(n, `op-sin-fila-${i}`, [guarda(consulta), zona("z1")]);
				expect(r.ok, consulta).toBe(false);
			}
			expect(n.n("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z1'")).toBe(0);
		});
	});

	it("si se cumple, entra, y a la Main sólo le llegan las escrituras", async () => {
		await conNegocio("replicado", [], async (n) => {
			const r = await aplicarEn(n, "op-guarda-si", [zona("z1"), guarda("SELECT 2;"), zona("z2")]);
			expect(r.ok).toBe(true);
			expect(n.n("SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z1','z2')")).toBe(2);
			const log = JSON.parse(String(n.sql.exec("SELECT Statements_Json AS s FROM Sync_Changes;").one().s));
			const escrituras = [zona("z1"), zona("z2")].map((s) => ({ sql: s.sql, args: s.args }));
			expect(log).toEqual(escrituras);
			expect(n.difundidos).toHaveLength(1);
			expect(n.difundidos[0].statements).toEqual(escrituras);
			expect(JSON.stringify(n.difundidos)).not.toContain("SELECT 2");
		});
	});

	it("con 'now','localtime', la hora es la de quien escribe", async () => {
		await conNegocio("hora", [], async (n) => {
			const hoy = ahora().slice(0, 10);
			const r = await aplicarEn(n, "op-hora", [
				{ kind: "guard", sql: "SELECT date('now','localtime') = ?1;", args: [hoy], error: "x_y", status: 409 },
				zona("z1"),
			]);
			expect(r.ok).toBe(true);
		});
	});

	// Un lote puede escribir una hija antes que su padre: `loteEnBruto` lo prueba sin aplazar las claves
	// foráneas y, al fallar la clave, lo repite aplazándolas. La guarda decide en esa segunda pasada
	// igual que en la primera, lo que sale es su error y no el de la clave, y el aplazamiento no se
	// queda puesto.
	it("con las claves foráneas aplazadas, la guarda decide igual y no deja nada", async () => {
		await conNegocio("aplazadas", [], async (n) => {
			const hija = {
				kind: "execute",
				sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES ('d1', 'c1', 1, 100);",
			};
			const padre = {
				kind: "execute",
				sql: "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'BARRA', '2026-11-14 10:00:00', 'Abierta');",
			};
			const no = await aplicarEn(n, "op-fk-no", [hija, guarda("SELECT 0;"), padre]);
			expect(no).toEqual({ ok: false, error: "reserva_no_pendiente", status: 409 });
			expect(n.n("SELECT COUNT(*) FROM Detalle_Comanda")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Comandas")).toBe(0);
			expect(n.n("PRAGMA defer_foreign_keys;")).toBe(0);

			const si = await aplicarEn(n, "op-fk-si", [hija, guarda("SELECT 1;"), padre]);
			expect(si.ok).toBe(true);
			expect(n.n("SELECT COUNT(*) FROM Detalle_Comanda")).toBe(1);
			expect(n.n("PRAGMA foreign_key_check;")).toBe(0);
		});
	});

	// La guarda que no se cumple no deja el gate: la operación no está aplicada, y el reintento con la
	// misma clave (la Handy que no oyó la respuesta) se vuelve a decidir. Con la base igual, contesta
	// lo mismo. El de una que sí entró choca con el gate y contesta lo guardado, sin mirar la guarda.
	it("el reintento de una que no pasó la guarda se vuelve a decidir; el de una que entró, no", async () => {
		await conNegocio("reintento", [], async (n) => {
			const pasos = [guarda("SELECT EXISTS (SELECT 1 FROM Zonas WHERE ID_Zona = 'permiso');"), zona("z1")];
			const rechazo = { ok: false, error: "reserva_no_pendiente", status: 409 };
			expect(await aplicarEn(n, "op-reintento", pasos)).toEqual(rechazo);
			expect(await aplicarEn(n, "op-reintento", pasos)).toEqual(rechazo);
			expect(n.n("SELECT COUNT(*) FROM Applied_Operations")).toBe(0);

			n.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('permiso', 'permiso');");
			expect((await aplicarEn(n, "op-reintento", pasos)).ok).toBe(true);
			expect(n.n("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z1'")).toBe(1);

			n.sql.exec("DELETE FROM Zonas WHERE ID_Zona = 'permiso';");
			expect((await aplicarEn(n, "op-reintento", pasos)).ok).toBe(true);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(1);
		});
	});
});

/* =========================================================
   Lo que se ha pasado a una guarda, con la ruta de verdad
========================================================= */

const MESA = [
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Sala')",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa', 'zona', '1', 4, 0, 0, 'rect', 80, 80)",
];
const reservaEn = (id: string, estado: string, hora = "21:00", origen = "TPV") =>
	`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen) VALUES ('${id}', 'mesa', '2030-05-10', '${hora}', 'cena', 2, '${estado}', '${origen}')`;
const estadoDe = (n: Negocio, id: string) =>
	n.sql.exec("SELECT Estado AS e FROM Reservas WHERE ID_Reserva = ?;", id).toArray()[0]?.e ?? null;

describe("SYNC-30 · cancelar una reserva desde la Handy", () => {
	it("si la Main la sienta entre la lectura y el lote, no se cancela", async () => {
		await conNegocio("cancelar-carrera", [...MESA, reservaEn("r1", "PROXIMA")], async (n) => {
			const r = await n.pedir("POST", "/v1/reservas/r1/cancelar", undefined, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'ACTIVA' WHERE ID_Reserva = 'r1'"],
				clave: "clave-cancelar-carrera",
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_no_pendiente" } });
			expect(estadoDe(n, "r1")).toBe("ACTIVA");
			expect(n.difundidos).toEqual([]);
			// El reintento con la misma clave contesta lo mismo: no se aplicó nada.
			const otra = await n.pedir("POST", "/v1/reservas/r1/cancelar", undefined, { clave: "clave-cancelar-carrera" });
			expect(otra).toEqual(r);
		});
	});

	it("sin carrera, la que aún no ha llegado se cancela; si entretanto otro la cancela, también", async () => {
		await conNegocio("cancelar", [...MESA, reservaEn("r1", "PROXIMA"), reservaEn("r2", "PROXIMA", "23:00")], async (n) => {
			expect(await n.pedir("POST", "/v1/reservas/r1/cancelar")).toEqual({ status: 200, json: { ok: true, cancelada: true } });
			const r2 = await n.pedir("POST", "/v1/reservas/r2/cancelar", undefined, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = 'r2'"],
			});
			expect(r2.status).toBe(200);
			expect([estadoDe(n, "r1"), estadoDe(n, "r2")]).toEqual(["CANCELADA", "CANCELADA"]);
		});
	});
});

describe("SYNC-30 · marcar desde la mesa que el cliente llega o se va", () => {
	it("si entre la lectura y el lote la cancelan, no se marca la llegada", async () => {
		await conNegocio("llegada-carrera", [...MESA, reservaEn("r1", "PROXIMA")], async (n) => {
			const r = await n.pedir("PUT", "/v1/mesas/reservas/r1/estado", { estado: "ACTIVA" }, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = 'r1'"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_cambiada" } });
			expect(estadoDe(n, "r1")).toBe("CANCELADA");
		});
	});

	it("si entre la lectura y el lote la marcan «No vino», no se marca la salida", async () => {
		await conNegocio("salida-carrera", [...MESA, reservaEn("r1", "ACTIVA")], async (n) => {
			const r = await n.pedir("PUT", "/v1/mesas/reservas/r1/estado", { estado: "FINALIZADA" }, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'NO_SHOW' WHERE ID_Reserva = 'r1'"],
			});
			expect(r.status).toBe(409);
			expect(estadoDe(n, "r1")).toBe("NO_SHOW");
		});
	});

	it("sin carrera se marca, y si otro la ha marcado igual entretanto, también vale", async () => {
		await conNegocio("llegada", [...MESA, reservaEn("r1", "PROXIMA"), reservaEn("r2", "PROXIMA", "23:00")], async (n) => {
			expect((await n.pedir("PUT", "/v1/mesas/reservas/r1/estado", { estado: "ACTIVA" })).status).toBe(200);
			const r2 = await n.pedir("PUT", "/v1/mesas/reservas/r2/estado", { estado: "ACTIVA" }, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'ACTIVA' WHERE ID_Reserva = 'r2'"],
			});
			expect(r2.status).toBe(200);
			expect([estadoDe(n, "r1"), estadoDe(n, "r2")]).toEqual(["ACTIVA", "ACTIVA"]);
		});
	});
});

describe("SYNC-30 · el solape de una reserva nueva", () => {
	const nueva = (forzar = false) => ({
		id_reserva: "nueva",
		id_mesa: "mesa",
		dia_ymd: "2030-05-10",
		hora: "21:00",
		turno: "cena",
		comensales: 2,
		duracion_min: null,
		nota: null,
		id_cliente: null,
		nombre_cliente: null,
		email: null,
		telefono: null,
		forzar_solape: forzar,
	});
	const otraEnLaMesa = reservaEn("otra", "PROXIMA", "21:30");
	const reservas = (n: Negocio) => n.n("SELECT COUNT(*) FROM Reservas");

	it("con los solapes prohibidos, una reserva que entra entre la lectura y el lote la para", async () => {
		await conNegocio("solape-prohibido", [...MESA, "UPDATE Business_Settings SET Reserva_Solape = 'prohibir' WHERE ID = 1"], async (n) => {
			const r = await n.pedir("POST", "/v1/reservas", nueva(true), { antesDelLote: [otraEnLaMesa] });
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_solapada_prohibida" } });
			expect(reservas(n)).toBe(1);
		});
	});

	it("con «avisar», la para si no llega confirmada, y entra si llega confirmada", async () => {
		await conNegocio("solape-avisar", MESA, async (n) => {
			const r = await n.pedir("POST", "/v1/reservas", nueva(false), { antesDelLote: [otraEnLaMesa] });
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_solapada" } });
			expect(reservas(n)).toBe(1);
			expect((await n.pedir("POST", "/v1/reservas", nueva(true))).status).toBe(200);
			expect(reservas(n)).toBe(2);
		});
	});

	it("si el cliente elegido se borra entre la lectura y el lote, cliente_no_encontrado", async () => {
		await conNegocio(
			"cliente-borrado",
			[...MESA, "INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli', 'Ana')"],
			async (n) => {
				const r = await n.pedir("POST", "/v1/reservas", { ...nueva(), id_cliente: "cli" }, {
					antesDelLote: ["DELETE FROM Clientes WHERE ID_Cliente = 'cli'"],
				});
				expect(r).toEqual({ status: 404, json: { ok: false, error: "cliente_no_encontrado" } });
				expect(reservas(n)).toBe(0);
			},
		);
	});

	// La duración y el modo los lee la guarda del negocio al aplicar: la ruta los leyó en «avisar» y
	// la reserva llegó confirmada, pero entretanto se prohíben los solapes y entra otra reserva.
	it("si entre la lectura y el lote se prohíben los solapes, una confirmada tampoco entra", async () => {
		await conNegocio("solape-ajustes", MESA, async (n) => {
			const r = await n.pedir("POST", "/v1/reservas", nueva(true), {
				antesDelLote: ["UPDATE Business_Settings SET Reserva_Solape = 'prohibir' WHERE ID = 1", otraEnLaMesa],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_solapada_prohibida" } });
			expect(reservas(n)).toBe(1);
		});
	});

	it("con la duración del negocio de cuando se aplica", async () => {
		// La otra empieza a las 22:30: con 120 min de duración por defecto choca, con 60 no.
		await conNegocio("solape-duracion", [...MESA, "UPDATE Business_Settings SET Reserva_Duracion_Min = 60 WHERE ID = 1"], async (n) => {
			const r = await n.pedir("POST", "/v1/reservas", nueva(), {
				antesDelLote: [
					"UPDATE Business_Settings SET Reserva_Duracion_Min = 120 WHERE ID = 1",
					reservaEn("otra", "PROXIMA", "22:30"),
				],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_solapada" } });
		});
	});

	// Las guardas van en el orden en que lo mira la ruta: un reintento con la base igual contesta lo
	// mismo que la primera vez.
	it("si a la vez se borra el cliente y entra otra reserva, el solape primero, también al reintentar", async () => {
		await conNegocio(
			"solape-y-cliente",
			[...MESA, "INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cli', 'Ana')"],
			async (n) => {
				const clave = "clave-del-solape-y-el-cliente";
				const primera = await n.pedir("POST", "/v1/reservas", { ...nueva(), id_cliente: "cli" }, {
					clave,
					antesDelLote: ["DELETE FROM Clientes WHERE ID_Cliente = 'cli'", otraEnLaMesa],
				});
				expect(primera.json.error).toBe("reserva_solapada");
				const reintento = await n.pedir("POST", "/v1/reservas", { ...nueva(), id_cliente: "cli" }, { clave });
				expect(reintento.status).toBe(409);
				expect(reintento.json.error).toBe("reserva_solapada");
			},
		);
	});
});

describe("SYNC-30 · el cliente nuevo de una reserva", () => {
	const conCliente = {
		id_reserva: "con-cliente",
		id_mesa: null,
		dia_ymd: "2030-05-10",
		hora: "21:00",
		turno: "cena",
		comensales: 2,
		duracion_min: null,
		nota: null,
		id_cliente: null,
		nombre_cliente: "Ana",
		email: "ana@bar.test",
		telefono: null,
		forzar_solape: false,
	};

	it("un email que ya es de otro cliente, también si entra entre la lectura y el lote, es email_duplicado", async () => {
		await conNegocio("email-duplicado", [], async (n) => {
			const r = await n.pedir("POST", "/v1/reservas", conCliente, {
				antesDelLote: ["INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('otro', 'Otra', 'ANA@bar.test')"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "email_duplicado" } });
			expect(n.n("SELECT COUNT(*) FROM Reservas")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Clientes")).toBe(1);
		});
	});

	// Antes la ruta lo miraba antes de mandar el lote, y el reintento de una reserva que había entrado
	// con su cliente nuevo se encontraba al cliente que ella misma había creado.
	it("el reintento de una que entró con su cliente nuevo contesta lo mismo que la primera vez", async () => {
		await conNegocio("email-reintento", [], async (n) => {
			const clave = "clave-de-la-reserva-con-cliente";
			const primera = await n.pedir("POST", "/v1/reservas", conCliente, { clave });
			expect(primera).toEqual({ status: 200, json: { ok: true, id_reserva: "con-cliente" } });
			expect(await n.pedir("POST", "/v1/reservas", conCliente, { clave })).toEqual(primera);
			expect(n.n("SELECT COUNT(*) FROM Clientes")).toBe(1);
		});
	});
});

const USUARIOS = [
	`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) VALUES ('ana', '${ADMIN}', 'ana@bar.test', 'x', 'Ana', 'Activo')`,
	`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) VALUES ('luis', '${ADMIN}', 'luis@bar.test', 'x', 'Luis', 'Activo')`,
	"INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('trab-ana', 'ana')",
	"INSERT INTO Turnos (ID_Turno, Nombre_Turno) VALUES ('manana', 'Mañana')",
];
const rolDe = (n: Negocio, id: string) =>
	n.sql.exec("SELECT ID_Rol AS r FROM Usuarios WHERE ID_Usuario = ?;", id).toArray()[0]?.r ?? null;
const anaCamarera = { id_trabajador: "trab-ana", id_usuario: "ana", id_rol: CAMARERO, email: "ana@bar.test", nombre: "Ana", estado: "Activo" };

describe("SYNC-30 · el último administrador", () => {
	it("si el otro administrador deja de serlo entre la lectura y el lote, Ana sigue siéndolo", async () => {
		await conNegocio("ultimo-admin-carrera", USUARIOS, async (n) => {
			const r = await n.pedir("PUT", "/v1/trabajadores/trab-ana", anaCamarera, {
				antesDelLote: ["UPDATE Usuarios SET Estado = 'Inactivo' WHERE ID_Usuario = 'luis'"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "ultimo_administrador" } });
			expect(rolDe(n, "ana")).toBe(ADMIN);
		});
	});

	it("con el otro administrador, se le quita el rol", async () => {
		await conNegocio("ultimo-admin", USUARIOS, async (n) => {
			expect((await n.pedir("PUT", "/v1/trabajadores/trab-ana", anaCamarera)).status).toBe(200);
			expect(rolDe(n, "ana")).toBe(CAMARERO);
		});
	});
});

describe("SYNC-30 · el turno repetido de un trabajador", () => {
	const turno = { id_trabajador: "trab-ana", fecha: "2030-05-10", id_turno: "manana", area: "Sala" };
	const asignaciones = (n: Negocio) => n.n("SELECT COUNT(*) FROM Asignacion_Turnos");

	it("si otro dispositivo lo asigna entre la lectura y el lote, no se repite", async () => {
		await conNegocio("turno-carrera", USUARIOS, async (n) => {
			const r = await n.pedir("POST", "/v1/trabajadores/horarios/asignaciones", turno, {
				antesDelLote: [
					"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area) VALUES ('otra', 'trab-ana', '2030-05-10', 'manana', 'Barra')",
				],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "asignacion_duplicada" } });
			expect(asignaciones(n)).toBe(1);
		});
	});

	// Antes la ruta lo miraba antes de mandar el lote, y el reintento de una asignación que sí entró
	// se encontraba a sí misma: contestaba `asignacion_duplicada`. Ahora el gate contesta lo guardado.
	it("el reintento de una que entró contesta lo mismo que la primera vez", async () => {
		await conNegocio("turno-reintento", USUARIOS, async (n) => {
			const primera = await n.pedir("POST", "/v1/trabajadores/horarios/asignaciones", turno, { clave: "clave-del-turno-repetido" });
			expect(primera.status).toBe(200);
			const reintento = await n.pedir("POST", "/v1/trabajadores/horarios/asignaciones", turno, { clave: "clave-del-turno-repetido" });
			expect(reintento).toEqual(primera);
			expect(asignaciones(n)).toBe(1);
		});
	});
});

const CARTA = [
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar')",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cafe', 'cat', 'Café', 130)",
	...MESA,
	"INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado) VALUES ('de-mesa', 'mesa', 'MESA', '2026-11-14 10:00:00', 'Abierta')",
	"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('de-barra', 'BARRA', '2026-11-14 10:00:00', 'Abierta')",
];
const ARCHIVAR = "UPDATE Productos SET Archivado_En = '2026-11-14 10:05:00' WHERE ID_Producto = 'cafe'";
const COBRAR = (id: string) => `UPDATE Comandas SET Estado = 'Pagada', Fecha_Hora_Cierre = '2026-11-14 10:05:00' WHERE ID_Comanda = '${id}'`;
const lineasDe = (n: Negocio, id: string) => n.n(`SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda = '${id}'`);

describe("SYNC-30 · una línea de un producto que se acaba de archivar, o en una comanda que se acaba de cobrar", () => {
	const deMesa = { id_comanda: "de-mesa", id_producto: "cafe", cantidad: 1 };
	const deBarra = { id_comanda: "de-barra", id_producto: "cafe", cantidad: 1 };

	it("en la mesa", async () => {
		await conNegocio("linea-mesa", CARTA, async (n) => {
			expect(await n.pedir("POST", "/v1/mesas/lineas", deMesa, { antesDelLote: [ARCHIVAR] })).toEqual({
				status: 409,
				json: { ok: false, error: "producto_archivado" },
			});
			n.sql.exec("UPDATE Productos SET Archivado_En = NULL WHERE ID_Producto = 'cafe'");
			expect(await n.pedir("POST", "/v1/mesas/lineas", deMesa, { antesDelLote: [COBRAR("de-mesa")] })).toEqual({
				status: 409,
				json: { ok: false, error: "comanda_cobrada" },
			});
			expect(lineasDe(n, "de-mesa")).toBe(0);
		});
	});

	it("en la barra", async () => {
		await conNegocio("linea-barra", CARTA, async (n) => {
			expect(await n.pedir("POST", "/v1/venta-rapida/lineas", deBarra, { antesDelLote: [ARCHIVAR] })).toEqual({
				status: 409,
				json: { ok: false, error: "producto_archivado" },
			});
			n.sql.exec("UPDATE Productos SET Archivado_En = NULL WHERE ID_Producto = 'cafe'");
			expect(await n.pedir("POST", "/v1/venta-rapida/lineas", deBarra, { antesDelLote: [COBRAR("de-barra")] })).toEqual({
				status: 409,
				json: { ok: false, error: "comanda_cobrada" },
			});
			expect(lineasDe(n, "de-barra")).toBe(0);
		});
	});

	// La Handy repite la línea porque no oyó la respuesta y, entretanto, la Main ha cobrado la comanda.
	// La línea entró antes del cobro: el reintento contesta lo guardado, no `comanda_cobrada`.
	it("el reintento de una línea que entró antes del cobro contesta lo guardado", async () => {
		await conNegocio("linea-reintento", CARTA, async (n) => {
			const primera = await n.pedir("POST", "/v1/venta-rapida/lineas", deBarra, { clave: "clave-de-la-linea-de-barra" });
			expect(primera.status).toBe(200);
			n.sql.exec(COBRAR("de-barra"));
			const reintento = await n.pedir("POST", "/v1/venta-rapida/lineas", deBarra, { clave: "clave-de-la-linea-de-barra" });
			expect(reintento).toEqual(primera);
			expect(lineasDe(n, "de-barra")).toBe(1);
		});
	});
});

/* =========================================================
   SYNC-35: el reintento de una escritura cuyo resultado no se guardó
========================================================= */

/**
 * La escritura de `clave` aplicada, con su resultado guardado sin lo que dependía de la base: lo que
 * deja el gate (`storageResult`) cuando no se llega a refinar después de aplicarla (SYNC-10, que es
 * best-effort).
 */
function sinResultadoGuardado(n: Negocio, clave: string) {
	expect(n.n(`SELECT COUNT(*) FROM Applied_Operations WHERE Op_Id = '${clave}'`)).toBe(1);
	n.sql.exec("UPDATE Applied_Operations SET Result_Json = 'null' WHERE Op_Id = ?;", clave);
}

describe("SYNC-35 · editar la ficha de un trabajador", () => {
	const ana = { ...anaCamarera, id_rol: ADMIN };

	it("una que no existe, o que otro borra entre la lectura y el lote, es trabajador_no_encontrado, también al reintentarla", async () => {
		await conNegocio("ficha-borrada", USUARIOS, async (n) => {
			const noExiste = await n.pedir("PUT", "/v1/trabajadores/otro", { ...ana, id_trabajador: "otro" });
			expect(noExiste).toEqual({ status: 404, json: { ok: false, error: "trabajador_no_encontrado" } });

			const clave = "clave-de-la-ficha-borrada";
			const primera = await n.pedir("PUT", "/v1/trabajadores/trab-ana", ana, {
				clave,
				antesDelLote: ["DELETE FROM Trabajadores WHERE ID_Trabajador = 'trab-ana'"],
			});
			expect(primera).toEqual({ status: 404, json: { ok: false, error: "trabajador_no_encontrado" } });
			expect(await n.pedir("PUT", "/v1/trabajadores/trab-ana", ana, { clave })).toEqual(primera);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);
		});
	});

	it("el reintento de una edición que entró contesta ok aunque su recuento no se guardara", async () => {
		await conNegocio("ficha-reintento", USUARIOS, async (n) => {
			const clave = "clave-de-la-ficha-editada";
			const cambio = { ...ana, nombre: "Ana María" };
			expect((await n.pedir("PUT", "/v1/trabajadores/trab-ana", cambio, { clave })).status).toBe(200);
			sinResultadoGuardado(n, clave);
			n.sql.exec("DELETE FROM Trabajadores WHERE ID_Trabajador = 'trab-ana'");
			expect(await n.pedir("PUT", "/v1/trabajadores/trab-ana", cambio, { clave })).toEqual({ status: 200, json: { ok: true } });
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(1);
		});
	});
});

describe("SYNC-35 · editar una asignación de un tramo", () => {
	const ASIGNACIONES = [
		...USUARIOS,
		"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin) VALUES ('sola', 'trab-ana', '2030-05-10', 'manana', 'Sala', '09:00', '14:00')",
		"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Grupo, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin) VALUES ('t1', 'g', 'trab-ana', '2030-05-11', 'manana', 'Sala', '09:00', '12:00')",
		"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Grupo, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin) VALUES ('t2', 'g', 'trab-ana', '2030-05-11', 'manana', 'Sala', '17:00', '20:00')",
	];
	const cambio = { id_turno: "manana", area: "Barra", hora_inicio: "10:00", hora_fin: "15:00", notas: null };
	const areaDe = (n: Negocio, id: string) =>
		n.sql.exec("SELECT Area AS a FROM Asignacion_Turnos WHERE ID_Asignacion = ?;", id).toArray()[0]?.a ?? null;

	it("una de dos tramos se edita como un conjunto, y una que no está es asignacion_no_encontrada", async () => {
		await conNegocio("asignacion-guardas", ASIGNACIONES, async (n) => {
			expect(await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/t1", { ...cambio, id_asignacion: "t1" })).toEqual({
				status: 409,
				json: { ok: false, error: "horario_editar_conjunto" },
			});
			expect(await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/no-esta", { ...cambio, id_asignacion: "no-esta" })).toEqual({
				status: 404,
				json: { ok: false, error: "asignacion_no_encontrada" },
			});
			expect((await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/sola", { ...cambio, id_asignacion: "sola" })).status).toBe(200);
			expect([areaDe(n, "sola"), areaDe(n, "t1")]).toEqual(["Barra", "Sala"]);
		});
	});

	it("si otro la borra antes del lote, el reintento contesta lo mismo; si entró, ok aunque su recuento no se guardara", async () => {
		await conNegocio("asignacion-reintento", ASIGNACIONES, async (n) => {
			const borrada = "clave-de-la-asignacion-borrada";
			const primera = await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/sola", { ...cambio, id_asignacion: "sola" }, {
				clave: borrada,
				antesDelLote: ["DELETE FROM Asignacion_Turnos WHERE ID_Asignacion = 'sola'"],
			});
			expect(primera).toEqual({ status: 404, json: { ok: false, error: "asignacion_no_encontrada" } });
			expect(await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/sola", { ...cambio, id_asignacion: "sola" }, { clave: borrada })).toEqual(primera);

			n.sql.exec(
				"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area) VALUES ('otra-sola', 'trab-ana', '2030-05-12', 'manana', 'Sala')",
			);
			const editada = "clave-de-la-asignacion-editada";
			expect((await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/otra-sola", { ...cambio, id_asignacion: "otra-sola" }, { clave: editada })).status).toBe(200);
			sinResultadoGuardado(n, editada);
			n.sql.exec("DELETE FROM Asignacion_Turnos WHERE ID_Asignacion = 'otra-sola'");
			expect(await n.pedir("PUT", "/v1/trabajadores/horarios/asignaciones/otra-sola", { ...cambio, id_asignacion: "otra-sola" }, { clave: editada })).toEqual({
				status: 200,
				json: { ok: true },
			});
		});
	});
});

describe("SYNC-35 · quitar un producto del catálogo", () => {
	const PRODUCTO = [
		"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar')",
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cafe', 'cat', 'Café', 130)",
		"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('abierta', 'BARRA', '2026-11-14 10:00:00', 'Abierta')",
	];
	const LINEA =
		"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('l1', 'abierta', 'cafe', 1, 130)";
	const productos = (n: Negocio) => n.n("SELECT COUNT(*) FROM Productos WHERE ID_Producto = 'cafe'");

	it("en una comanda abierta, también si la línea entra entre la lectura y el lote, no se quita", async () => {
		await conNegocio("producto-en-uso", PRODUCTO, async (n) => {
			const r = await n.pedir("DELETE", "/v1/inventario/productos/cafe", undefined, { antesDelLote: [LINEA] });
			expect(r).toEqual({ status: 409, json: { ok: false, error: "producto_en_comanda_abierta" } });
			expect(productos(n)).toBe(1);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);
		});
	});

	// Antes la ruta decidía con una lectura que devolvía el lote (`en_uso`), y en el reintento de un
	// borrado que había entrado llegaba sin ella: contestaba el 409 aunque el producto ya no estuviera.
	it("el reintento de un borrado que entró contesta ok aunque su resultado no se guardara", async () => {
		await conNegocio("producto-reintento", PRODUCTO, async (n) => {
			const clave = "clave-del-producto-quitado";
			const ok = { status: 200, json: { ok: true } };
			expect(await n.pedir("DELETE", "/v1/inventario/productos/cafe", undefined, { clave })).toEqual(ok);
			expect(productos(n)).toBe(0);
			sinResultadoGuardado(n, clave);
			expect(await n.pedir("DELETE", "/v1/inventario/productos/cafe", undefined, { clave })).toEqual(ok);
		});
	});
});
