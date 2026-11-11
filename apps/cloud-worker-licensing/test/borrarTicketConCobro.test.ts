// test/borrarTicketConCobro.test.ts
//
// AUD-14: qué contesta `POST /v1/venta-rapida/comandas/delete-if-safe` a la Handy. La ruta mira en
// la base si el ticket tiene cobros o líneas cobradas (aunque sea por el cobro de otra comanda) y,
// si no, manda los `DELETE`, que llevan la misma condición dentro (el efecto lo fija
// `contract.test.ts`, «borrar un ticket no se lleva su cobro»). Si el cobro sube
// entre la lectura y el lote, el lote no borra nada, y la Handy tiene que oír lo mismo que si lo
// hubiera visto antes, no que el ticket se ha borrado.
//
// Se pasa por lo real: la ruta de Hono, `applyViaHub` y el motor del TenantHub. Sólo se sustituyen
// `tenantAuth` (la identidad de la Handy), la presencia de la Main y la base del negocio, que es el
// SQLite del propio DO con el esquema real. Cada caso usa su propia instancia del DO.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { cuerpoDeErrorConStatus } from "../src/lib/errorHttp";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

/** La base del tenant del caso en curso: la que lee la ruta antes de mandar el lote. */
let turso: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-aud14");
		c.set("deviceId", "handy-aud14");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(turso),
}));

const { ventaRapidaRoutes } = await import("../src/domains/venta_rapida/venta_rapida.routes");

const app = new Hono();
app.route("/v1/venta-rapida", ventaRapidaRoutes);
app.onError((e: any, c) => c.json(cuerpoDeErrorConStatus(e), e.status));

const SIEMBRA = [
	"INSERT INTO Categorias_Producto (ID_Categoria,Nombre) VALUES ('cat','Bebidas')",
	"INSERT INTO Productos (ID_Producto,ID_Categoria,Nombre,Precio_Venta) VALUES ('cana','cat','Caña',200)",
	"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Estado) VALUES ('ticket','BARRA','2026-11-08 12:00:00','Abierta')",
	"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea','ticket','cana',3,200)",
];
// Lo que sube la Main de su cobro en efectivo (lo esencial).
const COBRO = [
	"UPDATE Comandas SET Estado='Pagada', Total_Comanda=600, Fecha_Hora_Cierre='2026-11-08 12:05:00' WHERE ID_Comanda='ticket'",
	"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('pago','ticket','2026-11-08 12:05:00','Efectivo',600,'FRACCIONADO')",
	"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago','linea')",
];
// La línea del ticket, cobrada por el cobro de OTRA comanda. Ningún camino lo deja así hoy; los
// `DELETE` lo impiden igual, y la ruta tiene que decir lo mismo que ellos.
const LINEA_DE_OTRO_COBRO = [
	"INSERT INTO Comandas (ID_Comanda,Canal,Fecha_Hora_Apertura,Fecha_Hora_Cierre,Estado,Total_Comanda) VALUES ('otra','BARRA','2026-11-08 11:00:00','2026-11-08 11:30:00','Pagada',200)",
	"INSERT INTO Detalle_Comanda (ID_Detalle,ID_Comanda,ID_Producto,Cantidad,Precio_Unitario) VALUES ('linea-otra','otra','cana',1,200)",
	"INSERT INTO Pagos (ID_Pago,ID_Comanda,Fecha_Hora,Metodo_Pago,Importe_Total,Tipo) VALUES ('pago-otra','otra','2026-11-08 11:30:00','Efectivo',800,'FRACCIONADO')",
	"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago-otra','linea-otra')",
	"INSERT INTO Pago_Detalles (ID_Pago,ID_Detalle) VALUES ('pago-otra','linea')",
];

type Guion = {
	/** Lo que entra en la base justo antes que el lote, después de la lectura de la ruta. */
	antesDelLote?: string[];
};

/**
 * Prepara el DO del caso y pide el borrado de `idComanda` por la ruta. Devuelve la respuesta, lo
 * que el DO le devolvió a la ruta (`devuelto`) y cómo queda la base.
 */
async function borrar(nombre: string, sembrar: string[], guion: Guion, idComanda = "ticket") {
	return enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of sembrar) sql.exec(s);
		const base = clienteSobre(sql, hub.state.storage);
		let primero = true;
		const db = {
			...base,
			async batch(sentencias: any[], modo?: string) {
				if (modo !== "write" || !primero) return base.batch(sentencias, modo);
				primero = false;
				for (const s of guion.antesDelLote ?? []) sql.exec(s);
				return base.batch(sentencias, modo);
			},
		};
		turso = base;
		hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
		hub.touchLastSeen = async () => {};
		hub.isMainConnected = () => true;
		hub.isMainReady = () => true;
		hub.maybePurgeSyncLog = async () => {};
		hub.broadcastAuthed = () => {};

		const devuelto: any[] = [];
		const env = {
			TenantHub: {
				idFromName: (n: string) => n,
				get: () => ({
					aplicar: async (p: any) => {
						const r = await hub.aplicar(p);
						devuelto.push(r);
						return r;
					},
				}),
			},
		};
		const res = await app.request(
			"/v1/venta-rapida/comandas/delete-if-safe",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-idempotency-key": `op-${nombre}`,
					"x-client-now": "2026-11-08 12:10:00",
				},
				body: JSON.stringify({ id_comanda: idComanda }),
			},
			env as any,
		);
		const n = (q: string) => Number(Object.values(sql.exec(q).toArray()[0] ?? {})[0] ?? 0);
		return {
			status: res.status,
			json: (await res.json()) as any,
			devuelto,
			turso: {
				ticket: n("SELECT COUNT(*) FROM Comandas WHERE ID_Comanda='ticket'"),
				lineas: n("SELECT COUNT(*) FROM Detalle_Comanda WHERE ID_Comanda='ticket'"),
				pagos: n("SELECT COUNT(*) FROM Pagos WHERE ID_Pago='pago'"),
				pago_detalles: n("SELECT COUNT(*) FROM Pago_Detalles WHERE ID_Pago='pago'"),
			},
			lineas_de_otro_cobro: n(
				"SELECT COUNT(*) FROM v_lineas_cobradas v JOIN Detalle_Comanda dc ON dc.ID_Detalle = v.ID_Detalle WHERE dc.ID_Comanda='ticket' AND v.ID_Pago='pago-otra'",
			),
		};
	});
}

const TIENE_COBROS = { ok: false, error: "comanda_has_paid_lines" };
const COBRADO = { ticket: 1, lineas: 1, pagos: 1, pago_detalles: 1 };
const BORRADO = { ticket: 0, lineas: 0, pagos: 0, pago_detalles: 0 };

describe("borrar un ticket desde la Handy (AUD-14)", () => {
	it("con el cobro ya en la base, 409 y no se manda nada", async () => {
		const r = await borrar("aud14-ruta-cobrado", [...SIEMBRA, ...COBRO], {});
		expect([r.status, r.json]).toEqual([409, TIENE_COBROS]);
		expect(r.devuelto).toEqual([]);
		expect(r.turso).toEqual(COBRADO);
	});

	it("sin cobro, se borra", async () => {
		const r = await borrar("aud14-ruta-libre", SIEMBRA, {});
		expect(r.devuelto).toEqual([{ ok: true, data: 1 }]);
		expect([r.status, r.json]).toEqual([200, { ok: true }]);
		expect(r.turso).toEqual(BORRADO);
	});

	it("si el cobro sube entre la lectura y el lote, el lote no borra nada y la Handy oye que tiene cobros", async () => {
		const r = await borrar("aud14-ruta-carrera", SIEMBRA, { antesDelLote: COBRO });
		expect(r.devuelto).toEqual([{ ok: true, data: 0 }]);
		expect([r.status, r.json]).toEqual([409, TIENE_COBROS]);
		expect(r.turso).toEqual(COBRADO);
	});

	it("un ticket que ya no existe contesta como siempre", async () => {
		const r = await borrar("aud14-ruta-inexistente", SIEMBRA, {}, "no-existe");
		expect(r.devuelto).toEqual([{ ok: true, data: 0 }]);
		expect([r.status, r.json]).toEqual([200, { ok: true }]);
	});

	describe("con una línea del ticket cobrada por el cobro de otra comanda", () => {
		const SIGUE = { ticket: 1, lineas: 1, pagos: 0, pago_detalles: 0 };

		it("si ya está en la base, 409 y no se manda nada", async () => {
			const r = await borrar("aud14-ruta-otro-cobro", [...SIEMBRA, ...LINEA_DE_OTRO_COBRO], {});
			expect([r.status, r.json]).toEqual([409, TIENE_COBROS]);
			expect(r.devuelto).toEqual([]);
			expect([r.turso, r.lineas_de_otro_cobro]).toEqual([SIGUE, 1]);
		});

		it("si entra entre la lectura y el lote, el lote no borra nada y la Handy no lo da por borrado", async () => {
			const r = await borrar("aud14-ruta-otro-cobro-carrera", SIEMBRA, { antesDelLote: LINEA_DE_OTRO_COBRO });
			expect(r.devuelto).toEqual([{ ok: true, data: 0 }]);
			expect([r.status, r.json]).toEqual([409, TIENE_COBROS]);
			expect([r.turso, r.lineas_de_otro_cobro]).toEqual([SIGUE, 1]);
		});
	});
});
