// test/reservasBorrar.test.ts
//
// Borrar y cancelar una reserva desde la Handy (docs/estudios/reservas-web.md §5.6). Borrar la quita;
// cancelar la deja, cancelada, y sólo se cancela la que aún no ha llegado. Una reserva web no se
// borra nunca. Lo decide la ruta al leerla, y el comando lleva sólo la sentencia elegida, sin
// condición: lo que se replica a la Main se vuelve a evaluar allí, donde la reserva puede estar en
// otro estado. El efecto lo fijan los casos de contrato `reservas/eliminar` y `reservas/cancelar`;
// aquí, qué contesta la ruta y qué se replica.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/** Las reservas de la prueba, por id: lo que leería la ruta en Turso. */
let filas: Record<string, { estado: string; origen: string }> = {};
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
	estadoYOrigen: async (_db: unknown, id: string) => filas[id] ?? null,
}));

vi.mock("../src/lib/rutas", async (original) => ({
	...(await (original as any)()),
	apply: async (_c: unknown, built: any) => {
		aplicados.push(built);
		return 1;
	},
}));

const { reservasRoutes } = await import("../src/domains/reservas/reservas.routes");

const app = new Hono();
app.route("/v1/reservas", reservasRoutes);

async function pedir(metodo: "DELETE" | "POST", ruta: string) {
	const res = await app.request(`/v1/reservas/${ruta}`, { method: metodo });
	return { status: res.status, json: (await res.json()) as any };
}

const sentencias = () => aplicados.flatMap((b) => b.command.payload.steps.map((s: any) => s.sql));

beforeEach(() => {
	aplicados.length = 0;
	filas = {
		web: { estado: "PROXIMA", origen: "WEB" },
		"web-cancelada": { estado: "CANCELADA", origen: "WEB" },
		tpv: { estado: "PROXIMA", origen: "TPV" },
		sentada: { estado: "ACTIVA", origen: "TPV" },
		"no-vino": { estado: "NO_SHOW", origen: "WEB" },
	};
});

describe("borrar una reserva", () => {
	it("una web no se borra nunca, ni por venir ni ya cancelada", async () => {
		for (const id of ["web", "web-cancelada"]) {
			expect(await pedir("DELETE", id), id).toEqual({ status: 409, json: { error: "reserva_web_no_se_borra" } });
		}
		expect(aplicados).toEqual([]);
	});

	it("las demás: desvincular sus comandas y borrarla, sin condición", async () => {
		expect((await pedir("DELETE", "tpv")).status).toBe(200);
		expect(sentencias()).toEqual([
			"UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
			"DELETE FROM Reservas WHERE ID_Reserva = ?1;",
		]);
	});
});

describe("cancelar una reserva", () => {
	it("la que aún no ha llegado se cancela, web o no, y sólo se replica la cancelación", async () => {
		for (const id of ["web", "tpv"]) {
			expect(await pedir("POST", `${id}/cancelar`), id).toEqual({ status: 200, json: { ok: true, cancelada: true } });
		}
		expect(sentencias()).toEqual([
			"UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;",
			"UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;",
		]);
	});

	it("ya cancelada no se vuelve a escribir, y una que no existe dice que no", async () => {
		expect(await pedir("POST", "web-cancelada/cancelar")).toEqual({ status: 200, json: { ok: true, cancelada: true } });
		expect(await pedir("POST", "otra/cancelar")).toEqual({ status: 200, json: { ok: true, cancelada: false } });
		expect(aplicados).toEqual([]);
	});

	it("sentada o sin presentarse ya no se cancela", async () => {
		for (const id of ["sentada", "no-vino"]) {
			expect(await pedir("POST", `${id}/cancelar`), id).toEqual({ status: 409, json: { error: "reserva_no_pendiente" } });
		}
		expect(aplicados).toEqual([]);
	});
});
