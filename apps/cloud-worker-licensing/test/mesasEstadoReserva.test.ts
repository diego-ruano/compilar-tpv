// test/mesasEstadoReserva.test.ts
//
// Marcar desde la mesa que el cliente ha llegado o que se ha ido, desde la Handy. La mesa abierta
// enseña una foto de la reserva: si mientras tanto el cliente la canceló o pasó a «No vino», marcar
// la llegada la resucitaba. La ruta decide con la reserva como está ahora, como la Main
// (`cambio_desde_la_mesa`), y replica la escritura sin condición.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/** El estado de cada reserva de la prueba: lo que leería la ruta en Turso. */
let estados: Record<string, string> = {};
/** Los comandos que la ruta manda aplicar. */
const aplicados: any[] = [];

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "dev-handy");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(null),
}));

vi.mock("../src/domains/reservas/reservas.queries", async (original) => ({
	...(await (original as any)()),
	estadoYOrigen: async (_db: unknown, id: string) => (estados[id] ? { estado: estados[id], origen: "WEB" } : null),
}));

vi.mock("../src/lib/rutas", async (original) => ({
	...(await (original as any)()),
	apply: async (_c: unknown, built: any) => {
		aplicados.push(built);
		return 1;
	},
}));

const { mesasRoutes } = await import("../src/domains/mesas/mesas.routes");

const app = new Hono();
app.route("/v1/mesas", mesasRoutes);

async function marcar(id: string, estado: string) {
	const res = await app.request(`/v1/mesas/reservas/${id}/estado`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ estado }),
	});
	return { status: res.status, json: (await res.json()) as any };
}

beforeEach(() => {
	aplicados.length = 0;
	estados = { "por-llegar": "PROXIMA", sentada: "ACTIVA", cancelada: "CANCELADA", "no-vino": "NO_SHOW" };
});

describe("marcar desde la mesa", () => {
	it("llegar a una por llegar e irse de una sentada se escriben", async () => {
		expect(await marcar("por-llegar", "ACTIVA")).toEqual({ status: 200, json: { ok: true } });
		expect(await marcar("sentada", "FINALIZADA")).toEqual({ status: 200, json: { ok: true } });
		expect(aplicados.map((b) => b.cloudPayload)).toEqual([
			{ id_reserva: "por-llegar", estado: "ACTIVA" },
			{ id_reserva: "sentada", estado: "FINALIZADA" },
		]);
	});

	it("una reserva cancelada o sin presentarse no se resucita, y una que ya no existe tampoco", async () => {
		for (const id of ["cancelada", "no-vino", "otra"]) {
			expect(await marcar(id, "ACTIVA"), id).toEqual({ status: 409, json: { error: "reserva_cambiada" } });
		}
		expect(aplicados).toEqual([]);
	});

	it("lo que ya está así no se vuelve a escribir", async () => {
		expect(await marcar("sentada", "ACTIVA")).toEqual({ status: 200, json: { ok: true } });
		expect(aplicados).toEqual([]);
	});

	it("desde la mesa no se cancela ni se marca «No vino»", async () => {
		for (const estado of ["CANCELADA", "NO_SHOW", "PROXIMA"]) {
			expect((await marcar("por-llegar", estado)).status, estado).toBe(400);
		}
		expect(aplicados).toEqual([]);
	});
});
