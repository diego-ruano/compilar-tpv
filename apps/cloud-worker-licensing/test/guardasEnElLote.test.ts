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
import { MENSAJES } from "../src/lib/errorCodes";
import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { centralDePrueba } from "./helpers/central";
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
const { clientesRoutes } = await import("../src/domains/clientes/clientes.routes");

const app = new Hono();
app.route("/v1/reservas", reservasRoutes);
app.route("/v1/mesas", mesasRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);
app.route("/v1/inventario", inventarioRoutes);
app.route("/v1/clientes", clientesRoutes);
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

/**
 * Un TenantHub con la base de verdad, la Main presente y `sembrar` dentro. Su base central es una
 * de verdad.
 */
async function conNegocio(nombre: string, sembrar: string[], prueba: (n: Negocio) => Promise<void>) {
	const central = await centralDePrueba();
	await enElHub(`sync30-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of sembrar) sql.exec(s);

		// La ruta lee y el lote escribe por el cliente de verdad (`loteEnBruto`); el lote, con lo que
		// tenga que entrar antes.
		const real = clienteLocal(hub.state.storage);
		nube = real;
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
	}, { central });
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

	// SYN-INC-04: un formulario abierto mientras otro equipo cancela la reserva no la cambia.
	it("una reserva que se cierra entre la lectura y el lote no se cambia", async () => {
		await conNegocio("editar-cancelada", [...MESA, reservaEn("r1", "PROXIMA")], async (n) => {
			const cambio = { ...nueva(true), id_reserva: "r1", comensales: 7 };
			const r = await n.pedir("POST", "/v1/reservas", cambio, {
				antesDelLote: ["UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = 'r1'"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_cerrada" } });
			expect(n.n("SELECT Comensales FROM Reservas WHERE ID_Reserva = 'r1'")).toBe(2);
			expect(estadoDe(n, "r1")).toBe("CANCELADA");
			expect(MENSAJES.reserva_cerrada).toMatch(/ya está cerrada/);
			// Viva, sí: también la que ya está en la mesa.
			n.sql.exec("UPDATE Reservas SET Estado = 'ACTIVA';");
			expect((await n.pedir("POST", "/v1/reservas", cambio)).status).toBe(200);
			expect(n.n("SELECT Comensales FROM Reservas WHERE ID_Reserva = 'r1'")).toBe(7);
		});
	});

	// RES-INC-03: la Main subió los comensales a 3 con la reserva abierta en la Handy, que sólo tocó la
	// nota y al guardar volvía a escribir sus 2. La edición trae lo que vio el formulario.
	it("una edición sobre una reserva que ha cambiado desde que se abrió no se guarda", async () => {
		await conNegocio("editar-cambiada", [...MESA, reservaEn("r1", "PROXIMA")], async (n) => {
			const visto = { id_mesa: "mesa", dia_ymd: "2030-05-10", hora: "21:00", comensales: 2, duracion_min: null, nota: null, id_cliente: null };
			const soloLaNota = { ...nueva(true), id_reserva: "r1", nota: "Cumpleaños", visto };
			const r = await n.pedir("POST", "/v1/reservas", soloLaNota, {
				antesDelLote: ["UPDATE Reservas SET Comensales = 3 WHERE ID_Reserva = 'r1'"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "reserva_cambiada_al_editar" } });
			expect(n.n("SELECT Comensales FROM Reservas WHERE ID_Reserva = 'r1'")).toBe(3);
			expect(MENSAJES.reserva_cambiada_al_editar).toMatch(/ha cambiado en otro equipo/);

			// Con lo de ahora, entra.
			const alDia = { ...soloLaNota, comensales: 3, visto: { ...visto, comensales: 3 } };
			expect((await n.pedir("POST", "/v1/reservas", alDia)).status).toBe(200);
			expect(n.n("SELECT COUNT(*) FROM Reservas WHERE Nota = 'Cumpleaños' AND Comensales = 3")).toBe(1);

			// Una borrada entretanto no vuelve.
			const tarde = await n.pedir("POST", "/v1/reservas", { ...alDia, visto: { ...visto, comensales: 3, nota: "Cumpleaños" } }, {
				antesDelLote: ["DELETE FROM Reservas WHERE ID_Reserva = 'r1'"],
			});
			expect(tarde.status).toBe(409);
			expect(n.n("SELECT COUNT(*) FROM Reservas")).toBe(0);
		});
	});

	// RES-04: una comanda abierta hoy en la mesa no se salta ni confirmando el aviso.
	it("una comanda que se abre hoy entre la lectura y el lote la para, aunque llegue confirmada", async () => {
		await conNegocio("solape-comanda-hoy", MESA, async (n) => {
			const hoy = ahora().slice(0, 10);
			const comanda = `INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'mesa', 'MESA', '${ahora()}', 'Abierta')`;
			const r = await n.pedir("POST", "/v1/reservas", { ...nueva(true), dia_ymd: hoy, hora: "23:59" }, { antesDelLote: [comanda] });
			expect(r).toEqual({ status: 409, json: { ok: false, error: "mesa_con_comanda_hoy" } });
			expect(reservas(n)).toBe(0);
			// Leída por la ruta, lo dice con la hora de la comanda.
			const otra = await n.pedir("POST", "/v1/reservas", { ...nueva(true), dia_ymd: hoy, hora: "23:59" });
			expect(otra.status).toBe(409);
			expect(otra.json.error).toBe("mesa_con_comanda_hoy");
			expect(otra.json.message).toMatch(/hoy no se puede reservar/);
			expect(reservas(n)).toBe(0);
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

	// CAJ-INC-02: la Handy tiene en pantalla una comanda de mesa que ya no está. Antes la guarda la
	// dejaba pasar, la línea no entraba y la ruta contestaba `ok` sin ella: el producto se perdía.
	it("en la mesa, en una comanda que ya no existe", async () => {
		await conNegocio("linea-mesa-quitada", CARTA, async (n) => {
			expect(
				await n.pedir("POST", "/v1/mesas/lineas", deMesa, {
					antesDelLote: ["DELETE FROM Comandas WHERE ID_Comanda = 'de-mesa'"],
				}),
			).toEqual({
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

describe("borrar una categoría con sus productos", () => {
	const CATEGORIA = [
		"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar')",
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cafe', 'cat', 'Café', 130)",
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('te', 'cat', 'Té', 150)",
		"INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('abierta', 'BARRA', '2026-11-14 10:00:00', 'Abierta')",
	];
	const LINEA =
		"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('l1', 'abierta', 'te', 1, 150)";
	const categorias = (n: Negocio) => n.n("SELECT COUNT(*) FROM Categorias_Producto WHERE ID_Categoria = 'cat'");
	const productos = (n: Negocio) => n.n("SELECT COUNT(*) FROM Productos WHERE ID_Categoria = 'cat'");

	it("con un producto en una comanda abierta, también si la línea entra entre la lectura y el lote, no se toca nada", async () => {
		await conNegocio("categoria-en-uso", CATEGORIA, async (n) => {
			const r = await n.pedir("DELETE", "/v1/inventario/categorias/cat", undefined, { antesDelLote: [LINEA] });
			expect(r).toEqual({ status: 409, json: { ok: false, error: "categoria_en_comanda_abierta" } });
			expect([categorias(n), productos(n)]).toEqual([1, 2]);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);
		});
	});

	it("se lleva sus productos, y el reintento contesta ok aunque su resultado no se guardara", async () => {
		await conNegocio("categoria-reintento", CATEGORIA, async (n) => {
			const clave = "clave-de-la-categoria-borrada";
			const ok = { status: 200, json: { ok: true } };
			expect(await n.pedir("DELETE", "/v1/inventario/categorias/cat", undefined, { clave })).toEqual(ok);
			expect([categorias(n), n.n("SELECT COUNT(*) FROM Productos")]).toEqual([0, 0]);
			sinResultadoGuardado(n, clave);
			expect(await n.pedir("DELETE", "/v1/inventario/categorias/cat", undefined, { clave })).toEqual(ok);
		});
	});
});

/* =========================================================
   El ajuste de existencias (RI-55): lo visto lo decide la guarda
========================================================= */

describe("SYNC-30 · ajustar las existencias de un lote o el stock suelto", () => {
	const STOCK = [
		...USUARIOS,
		"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar')",
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto) VALUES ('cafe', 'cat', 'Café', 130, 10)",
		"INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada) VALUES ('lote', 'cafe', 'L1', 5, '2026-11-01 10:00:00')",
	];
	const VENTA_DEL_LOTE = "UPDATE Lotes_Producto SET Stock_Disponible = 4 WHERE ID_Lote = 'lote'";
	const lote = (n: Negocio) => n.n("SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote = 'lote'");
	const suelto = (n: Negocio) => n.n("SELECT Stock_Suelto FROM Productos WHERE ID_Producto = 'cafe'");
	const ajustes = (n: Negocio) => n.n("SELECT COUNT(*) FROM Movimientos_Stock WHERE Tipo = 'AJUSTE'");
	const ok = { status: 200, json: { ok: true } };

	// Antes la ruta miraba lo visto antes del lote: en el reintento de un ajuste que ya había entrado
	// veía lo nuevo y contestaba `stock_cambiado`.
	it("el reintento de un ajuste que entró contesta ok, también si después ha cambiado", async () => {
		await conNegocio("ajuste-reintento", STOCK, async (n) => {
			const clave = "clave-del-ajuste";
			const ajuste = { stock_visto: 5, stock_nuevo: 3, motivo: null, id_usuario: "ana" };
			expect(await n.pedir("PATCH", "/v1/inventario/lotes/lote", ajuste, { clave })).toEqual(ok);
			expect([lote(n), ajustes(n)]).toEqual([3, 1]);
			expect(await n.pedir("PATCH", "/v1/inventario/lotes/lote", ajuste, { clave })).toEqual(ok);
			// Una venta después: el reintento sigue siendo el de algo que ya entró.
			n.sql.exec("UPDATE Lotes_Producto SET Stock_Disponible = 2 WHERE ID_Lote = 'lote'");
			expect(await n.pedir("PATCH", "/v1/inventario/lotes/lote", ajuste, { clave })).toEqual(ok);
			expect([lote(n), ajustes(n)]).toEqual([2, 1]);

			const claveSuelto = "clave-del-ajuste-suelto";
			const ajusteSuelto = { stock_visto: 10, stock_nuevo: 7, motivo: null, id_usuario: "ana" };
			expect(await n.pedir("PATCH", "/v1/inventario/productos/cafe/stock-suelto", ajusteSuelto, { clave: claveSuelto })).toEqual(ok);
			n.sql.exec("UPDATE Productos SET Stock_Suelto = 6 WHERE ID_Producto = 'cafe'");
			expect(await n.pedir("PATCH", "/v1/inventario/productos/cafe/stock-suelto", ajusteSuelto, { clave: claveSuelto })).toEqual(ok);
			expect([suelto(n), ajustes(n)]).toEqual([6, 2]);
		});
	});

	it("una venta entre la lectura de la ruta y el lote es stock_cambiado, con lo que hay ahora, y no deja nada", async () => {
		await conNegocio("ajuste-tarde", STOCK, async (n) => {
			const r = await n.pedir("PATCH", "/v1/inventario/lotes/lote", { stock_visto: 5, stock_nuevo: 3, motivo: null, id_usuario: "ana" }, {
				antesDelLote: [VENTA_DEL_LOTE],
			});
			expect(r.status).toBe(409);
			expect(r.json).toMatchObject({ ok: false, error: "stock_cambiado" });
			expect(r.json.message).toContain("ahora hay 4");
			expect([lote(n), ajustes(n)]).toEqual([4, 0]);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);

			const s = await n.pedir("PATCH", "/v1/inventario/productos/cafe/stock-suelto", { stock_visto: 10, stock_nuevo: 7, motivo: null, id_usuario: "ana" }, {
				antesDelLote: ["UPDATE Productos SET Stock_Suelto = 9 WHERE ID_Producto = 'cafe'"],
			});
			expect(s.status).toBe(409);
			expect(s.json.message).toContain("ahora hay 9");
			expect([suelto(n), ajustes(n)]).toEqual([9, 0]);
		});
	});

	it("lo visto que ya no es lo que hay es stock_cambiado, y lo que ya está como se pide es ok sin escribir", async () => {
		await conNegocio("ajuste-visto", STOCK, async (n) => {
			const tarde = await n.pedir("PATCH", "/v1/inventario/lotes/lote", { stock_visto: 8, stock_nuevo: 3, motivo: null, id_usuario: "ana" });
			expect(tarde.status).toBe(409);
			expect(tarde.json.message).toContain("ahora hay 5");
			expect(await n.pedir("PATCH", "/v1/inventario/lotes/lote", { stock_visto: 8, stock_nuevo: 5, motivo: null, id_usuario: "ana" })).toEqual(ok);
			expect([lote(n), ajustes(n)]).toEqual([5, 0]);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(0);
		});
	});
});

// INV-INC-03: repetir el nombre de una categoría enseñaba el error del motor («UNIQUE constraint
// failed: Categorias_Producto.Nombre»). Ahora lo rechaza una guarda con su frase, como la Main.
describe("INV-INC-03 · una categoría con el nombre de otra", () => {
	const SEMBRADO = ["INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('bar', 'Bebidas');"];
	const categoria = (id: string | null, nombre: string) =>
		({ id_categoria: id, nombre, nombre_imagen: "", ruta_imagen: "", vendible: true, pasa_cocina: false });

	it("se rechaza con su frase, sin escribir nada", async () => {
		await conNegocio("categoria-repetida", SEMBRADO, async (n) => {
			const r = await n.pedir("POST", "/v1/inventario/categorias", categoria(null, " Bebidas "));
			expect(r.status).toBe(409);
			expect(r.json.error).toBe("categoria_repetida");
			// La frase la pone `completarErrores` por el código, con el mismo texto que la Main.
			expect(MENSAJES.categoria_repetida).toBe("Ya hay una categoría con ese nombre.");
			expect(n.n("SELECT COUNT(*) FROM Categorias_Producto")).toBe(1);
		});
	});

	it("la misma, guardada con su nombre, y otra con otro nombre, entran", async () => {
		await conNegocio("categoria-no-repetida", SEMBRADO, async (n) => {
			expect((await n.pedir("POST", "/v1/inventario/categorias", categoria("bar", "Bebidas"))).status).toBe(200);
			expect((await n.pedir("POST", "/v1/inventario/categorias", categoria(null, "Postres"))).status).toBe(200);
			expect(n.n("SELECT COUNT(*) FROM Categorias_Producto")).toBe(2);
		});
	});
});

describe("Eliminar a un trabajador", () => {
	const FICHAJE_DE_ANA =
		"INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado) VALUES ('f1', 'ana', '2026-01-01', 1, '2026-01-01 09:00:00', '2026-01-01 17:00:00', 'CERRADO')";
	const CON_PLAN = [
		...USUARIOS,
		"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area) VALUES ('futura', 'trab-ana', '2099-01-01', 'manana', 'Sala')",
		"INSERT INTO Horario_Predeterminado (ID_Default, ID_Trabajador, Weekday, ID_Turno, Area) VALUES ('d1', 'trab-ana', 1, 'manana', 'Sala')",
	];

	it("sin historia se borra, con su plan", async () => {
		await conNegocio("eliminar-sin-historia", CON_PLAN, async (n) => {
			const r = await n.pedir("DELETE", "/v1/trabajadores/trab-ana");
			expect(r).toEqual({ status: 200, json: { retirado: false } });
			expect(n.n("SELECT COUNT(*) FROM Usuarios WHERE ID_Usuario = 'ana'")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Trabajadores")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Asignacion_Turnos")).toBe(0);
			expect(n.n("SELECT COUNT(*) FROM Horario_Predeterminado")).toBe(0);
			// Y la Main recibe las mismas sentencias.
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(1);
		});
	});

	it("con historia se retira: no puede entrar, sale de las listas y su fichaje sigue", async () => {
		await conNegocio("eliminar-con-historia", [...CON_PLAN, FICHAJE_DE_ANA], async (n) => {
			const r = await n.pedir("DELETE", "/v1/trabajadores/trab-ana");
			expect(r).toEqual({ status: 200, json: { retirado: true } });
			expect(n.n("SELECT COUNT(*) FROM Usuarios WHERE ID_Usuario = 'ana' AND Estado = 'Inactivo' AND Archivado_En IS NOT NULL")).toBe(1);
			expect(n.n("SELECT COUNT(*) FROM Fichajes")).toBe(1);
			expect(n.n("SELECT COUNT(*) FROM Asignacion_Turnos")).toBe(0);

			const lista = await n.pedir("GET", "/v1/trabajadores");
			expect(lista.json).toEqual([]);
			// Ni se edita ni se vuelve a eliminar.
			expect(await n.pedir("PUT", "/v1/trabajadores/trab-ana", { ...anaCamarera, id_rol: ADMIN })).toEqual({
				status: 404,
				json: { ok: false, error: "trabajador_no_encontrado" },
			});
			expect(await n.pedir("DELETE", "/v1/trabajadores/trab-ana")).toEqual({
				status: 404,
				json: { ok: false, error: "trabajador_no_encontrado" },
			});
		});
	});

	it("si el otro administrador deja de serlo entre la lectura y el lote, Ana no se elimina", async () => {
		await conNegocio("eliminar-ultimo-admin", USUARIOS, async (n) => {
			const r = await n.pedir("DELETE", "/v1/trabajadores/trab-ana", undefined, {
				antesDelLote: ["UPDATE Usuarios SET Estado = 'Inactivo' WHERE ID_Usuario = 'luis'"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "ultimo_administrador" } });
			expect(n.n("SELECT COUNT(*) FROM Usuarios WHERE ID_Usuario = 'ana' AND Archivado_En IS NULL")).toBe(1);
		});
	});

	it("lo que se replica no deja sin administrador a la base que lo aplica, donde el otro ya no está", async () => {
		// Dos administradores eliminados a la vez desde dos equipos: cada uno veía al otro activo. En
		// la base que aplica lo de este equipo (la Main), Luis ya se ha ido: eliminar a Ana, desactivarla
		// o quitarle el rol no hace nada allí.
		const { eliminarTrabajador, updateTrabajador } = await import("../src/domains/trabajadores/trabajadores.commands");
		await conNegocio("eliminar-replicado-ultimo-admin", USUARIOS, async (n) => {
			const replicado = (built: any) => buildApplyBatch(built.command).replicated;
			const eliminar = replicado(eliminarTrabajador("trab-ana", "ana"));
			const edicion = (id_rol: string, estado: string) =>
				replicado(
					updateTrabajador(
						"trab-ana",
						{ ...anaCamarera, id_rol, estado, apellido: null, telefono: null, puesto: null, fecha_inicio_contrato: null, fecha_fin_contrato: null, sin_pin: null } as any,
						null,
					),
				);
			const desactivar = edicion(ADMIN, "Inactivo");
			const quitarRol = edicion(CAMARERO, "Activo");
			const aplicar = (sentencias: any[]) => {
				for (const s of sentencias) n.sql.exec(s.sql, ...s.args);
			};
			const anaAdministradora = () =>
				n.n(`SELECT COUNT(*) FROM Usuarios WHERE ID_Usuario = 'ana' AND Estado = 'Activo' AND Archivado_En IS NULL AND ID_Rol = '${ADMIN}'`);

			n.sql.exec("UPDATE Usuarios SET Estado = 'Inactivo', Archivado_En = '2026-01-01 10:00:00' WHERE ID_Usuario = 'luis'");
			aplicar(eliminar);
			aplicar(desactivar);
			aplicar(quitarRol);
			expect(anaAdministradora()).toBe(1);
			expect(n.n("SELECT COUNT(*) FROM Trabajadores WHERE ID_Trabajador = 'trab-ana'")).toBe(1);

			// Con Luis activo, la misma edición sí se aplica.
			n.sql.exec("UPDATE Usuarios SET Estado = 'Activo', Archivado_En = NULL WHERE ID_Usuario = 'luis'");
			aplicar(quitarRol);
			expect(anaAdministradora()).toBe(0);
		});
	});

	it("el reintento de una que entró contesta lo mismo", async () => {
		await conNegocio("eliminar-reintento", [...USUARIOS, FICHAJE_DE_ANA], async (n) => {
			const clave = "clave-de-eliminar-a-ana";
			const primera = await n.pedir("DELETE", "/v1/trabajadores/trab-ana", undefined, { clave });
			expect(primera).toEqual({ status: 200, json: { retirado: true } });
			expect(await n.pedir("DELETE", "/v1/trabajadores/trab-ana", undefined, { clave })).toEqual(primera);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(1);
		});
	});
});

describe("Libre: el día libre de un trabajador", () => {
	const LIBRE = "00000000-0000-7000-8000-000000000101";
	const CON_TURNO = [
		...USUARIOS,
		"INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin) VALUES ('turno', 'trab-ana', '2099-01-06', 'manana', 'Sala', '09:00', '14:00')",
	];
	const delDia = (n: Negocio) =>
		n.sql.exec("SELECT ID_Turno, Hora_Inicio FROM Asignacion_Turnos WHERE ID_Trabajador = 'trab-ana' AND Fecha = '2099-01-06';").toArray();

	it("sustituye lo que tuviera ese día por el turno LIBRE sin horas, y se replica", async () => {
		await conNegocio("libre-marcar", CON_TURNO, async (n) => {
			const r = await n.pedir("POST", "/v1/trabajadores/horarios/libre", { id_trabajador: "trab-ana", fecha: "2099-01-06" });
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(delDia(n)).toEqual([{ ID_Turno: LIBRE, Hora_Inicio: null }]);
			expect(n.n("SELECT COUNT(*) FROM Sync_Changes")).toBe(1);
		});
	});

	it("un turno guardado ese día lo deja de ser", async () => {
		await conNegocio("libre-y-turno", USUARIOS, async (n) => {
			await n.pedir("POST", "/v1/trabajadores/horarios/libre", { id_trabajador: "trab-ana", fecha: "2099-01-06" });
			const r = await n.pedir("POST", "/v1/trabajadores/horarios/guardar", {
				id_trabajador: "trab-ana",
				fecha: "2099-01-06",
				id_turno: "manana",
				area: "Sala",
				tramos: [{ hora_inicio: "09:00", hora_fin: "14:00" }],
			});
			expect(r.status).toBe(200);
			expect(delDia(n)).toEqual([{ ID_Turno: "manana", Hora_Inicio: "09:00" }]);
		});
	});

	it("una edición que llega después de «Libre» no le quita el libre al día", async () => {
		await conNegocio("libre-y-edicion", CON_TURNO, async (n) => {
			// Otro equipo marca el día libre entre la lectura de la edición y su lote.
			const r = await n.pedir(
				"POST",
				"/v1/trabajadores/horarios/guardar",
				{
					id_asignacion: "turno",
					id_trabajador: "trab-ana",
					fecha: "2099-01-06",
					id_turno: "manana",
					area: "Sala",
					tramos: [{ hora_inicio: "10:00", hora_fin: "15:00" }],
				},
				{
					antesDelLote: [
						"DELETE FROM Asignacion_Turnos WHERE ID_Trabajador = 'trab-ana' AND Fecha = '2099-01-06'",
						`INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area) VALUES ('libre', 'trab-ana', '2099-01-06', '${LIBRE}', 'Libre')`,
					],
				},
			);
			expect(r.status).toBe(404);
			expect(delDia(n)).toEqual([{ ID_Turno: LIBRE, Hora_Inicio: null }]);
		});
	});

	it("de alguien que ya no está en la plantilla, trabajador_no_encontrado", async () => {
		await conNegocio("libre-fuera", USUARIOS, async (n) => {
			n.sql.exec("UPDATE Usuarios SET Estado = 'Inactivo', Archivado_En = '2026-01-01 00:00:00' WHERE ID_Usuario = 'ana'");
			const r = await n.pedir("POST", "/v1/trabajadores/horarios/libre", { id_trabajador: "trab-ana", fecha: "2099-01-06" });
			expect(r).toEqual({ status: 404, json: { ok: false, error: "trabajador_no_encontrado" } });
		});
	});
});

describe("Un turno sólo se le pone a alguien de la plantilla", () => {
	const RETIRAR = "UPDATE Usuarios SET Estado = 'Inactivo', Archivado_En = '2026-01-01 00:00:00' WHERE ID_Usuario = 'ana'";
	const turnos = (n: Negocio) => n.n("SELECT COUNT(*) FROM Asignacion_Turnos WHERE ID_Trabajador = 'trab-ana'");

	it("guardar un horario a un retirado, también si se retira entre la lectura y el lote, es trabajador_no_encontrado", async () => {
		await conNegocio("turno-retirado-guardar", USUARIOS, async (n) => {
			const r = await n.pedir(
				"POST",
				"/v1/trabajadores/horarios/guardar",
				{ id_trabajador: "trab-ana", fecha: "2099-01-06", id_turno: "manana", area: "Sala", tramos: [{ hora_inicio: "09:00", hora_fin: "14:00" }] },
				{ antesDelLote: [RETIRAR] },
			);
			expect(r).toEqual({ status: 404, json: { ok: false, error: "trabajador_no_encontrado" } });
			expect(turnos(n)).toBe(0);
			expect(n.difundidos).toEqual([]);
		});
	});

	it("crear una asignación a un retirado es trabajador_no_encontrado", async () => {
		await conNegocio("turno-retirado-crear", [...USUARIOS, RETIRAR], async (n) => {
			const r = await n.pedir("POST", "/v1/trabajadores/horarios/asignaciones", {
				id_trabajador: "trab-ana", fecha: "2099-01-06", id_turno: "manana", area: "Sala", hora_inicio: "09:00", hora_fin: "14:00", notas: null,
			});
			expect(r).toEqual({ status: 404, json: { ok: false, error: "trabajador_no_encontrado" } });
			expect(turnos(n)).toBe(0);
		});
	});
});

/* =========================================================
   El correo de un cliente (SYN-INC-07)
========================================================= */

describe("SYNC-30 · el correo de un cliente lo decide la guarda del lote", () => {
	const ana = { id_cliente: "ana-handy", nombre: "Ana", email: "Ana@Bar.test", telefono: null, notas: null };

	it("un alta con el correo de otro cliente, también si entra entre la lectura y el lote, es email_duplicado", async () => {
		await conNegocio("cliente-alta", [], async (n) => {
			const r = await n.pedir("POST", "/v1/clientes", ana, {
				antesDelLote: ["INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('ana-main', 'Ana', 'ana@bar.test')"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "email_duplicado" } });
			expect(n.n("SELECT COUNT(*) FROM Clientes")).toBe(1);
			expect(n.difundidos).toEqual([]);
		});
	});

	it("cambiar el correo al de otro, también si entra entre la lectura y el lote, es email_duplicado", async () => {
		await conNegocio("cliente-editar", ["INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('bea', 'Bea', 'bea@bar.test')"], async (n) => {
			const r = await n.pedir("PUT", "/v1/clientes/bea", { nombre: "Bea", email: "ana@bar.test", telefono: null, notas: null }, {
				antesDelLote: ["INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('ana-main', 'Ana', 'ANA@bar.test')"],
			});
			expect(r).toEqual({ status: 409, json: { ok: false, error: "email_duplicado" } });
			expect(n.n("SELECT COUNT(*) FROM Clientes WHERE Email = 'bea@bar.test'")).toBe(1);
		});
	});

	it("guardar una ficha con su propio correo entra, y el reintento de un alta contesta lo mismo", async () => {
		await conNegocio("cliente-propio", [], async (n) => {
			const clave = "clave-del-alta-de-ana";
			const primera = await n.pedir("POST", "/v1/clientes", ana, { clave });
			expect(primera).toEqual({ status: 200, json: { ok: true, id_cliente: "ana-handy" } });
			expect(await n.pedir("POST", "/v1/clientes", ana, { clave })).toEqual(primera);
			const editar = await n.pedir("PUT", "/v1/clientes/ana-handy", { nombre: "Ana López", email: "ana@bar.test", telefono: null, notas: null });
			expect(editar).toEqual({ status: 200, json: { ok: true } });
			expect(n.n("SELECT COUNT(*) FROM Clientes WHERE Nombre = 'Ana López'")).toBe(1);
		});
	});
});

/* =========================================================
   FISCAL-02 · Los datos fiscales y la Handy de la versión anterior
========================================================= */

// No es una guarda, pero se prueba con el mismo arnés: la ruta de verdad y el motor del TenantHub.
// La Handy de la versión anterior no conoce el NIF, la razón social ni la dirección fiscal y no los
// manda; el worker se despliega antes que las apps, así que convive con ella. Lo que no viene no se
// toca: si no, al editar el teléfono de una ficha le borraría los datos que le puso la Main.
describe("FISCAL-02 · una ficha guardada sin los datos fiscales los conserva", () => {
	const conDatos =
		"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, NIF, Razon_Social, Direccion_Fiscal) VALUES ('ana', 'Ana', '600000000', 'B12345674', 'Comidas SL', 'Calle Mayor 1')";
	const intactos = "SELECT COUNT(*) FROM Clientes WHERE ID_Cliente = 'ana' AND NIF = 'B12345674' AND Razon_Social = 'Comidas SL' AND Direccion_Fiscal = 'Calle Mayor 1'";

	it("editar desde una Handy que no los manda no los borra", async () => {
		await conNegocio("fiscal-editar-antigua", [conDatos], async (n) => {
			const r = await n.pedir("PUT", "/v1/clientes/ana", { nombre: "Ana", email: null, telefono: "611111111", notas: null });
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(n.n("SELECT COUNT(*) FROM Clientes WHERE Telefono = '611111111'")).toBe(1);
			expect(n.n(intactos)).toBe(1);
		});
	});

	it("el reintento de un alta que no los manda tampoco los borra", async () => {
		await conNegocio("fiscal-alta-antigua", [conDatos], async (n) => {
			const r = await n.pedir("POST", "/v1/clientes", { id_cliente: "ana", nombre: "Ana", email: null, telefono: "600000000", notas: null });
			expect(r).toEqual({ status: 200, json: { ok: true, id_cliente: "ana" } });
			expect(n.n(intactos)).toBe(1);
		});
	});

	it("la Handy de ahora, que los manda vacíos, sí los borra; y los cambia si vienen", async () => {
		await conNegocio("fiscal-editar-nueva", [conDatos], async (n) => {
			const base = { nombre: "Ana", email: null, telefono: null, notas: null };
			await n.pedir("PUT", "/v1/clientes/ana", { ...base, nif: "a58818501", razon_social: "Otra SA", direccion_fiscal: null });
			expect(n.n("SELECT COUNT(*) FROM Clientes WHERE NIF = 'A58818501' AND Razon_Social = 'Otra SA' AND Direccion_Fiscal IS NULL")).toBe(1);
			await n.pedir("PUT", "/v1/clientes/ana", { ...base, nif: null, razon_social: null, direccion_fiscal: null });
			expect(n.n("SELECT COUNT(*) FROM Clientes WHERE NIF IS NULL AND Razon_Social IS NULL AND Direccion_Fiscal IS NULL")).toBe(1);
		});
	});
});
