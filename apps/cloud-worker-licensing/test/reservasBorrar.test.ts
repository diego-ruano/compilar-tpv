// test/reservasBorrar.test.ts
//
// Borrar y cancelar una reserva desde la Handy (docs/estudios/reservas-web.md §5.6). Borrar la quita;
// cancelar la deja, cancelada, y sólo se cancela la que aún no ha llegado. Una reserva web no se
// borra nunca. Lo decide la ruta al leerla y, que la reserva aún no haya llegado, la guarda del
// comando al aplicarlo (SYNC-30, `guardasEnElLote.test.ts`). Lo que se replica es sólo la sentencia
// elegida, sin condición: se vuelve a evaluar en la Main, donde la reserva puede estar en otro
// estado. El efecto lo fijan los casos de contrato `reservas/eliminar` y `reservas/cancelar`; aquí,
// qué contesta la ruta y qué se replica.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

/** Las reservas de la prueba, por id: lo que leería la ruta en la base del negocio. */
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
const { buildApplyBatch } = await import("../src/durableObjects/tenantHub.lote");

const app = new Hono();
app.route("/v1/reservas", reservasRoutes);

async function pedir(metodo: "DELETE" | "POST", ruta: string) {
	const res = await app.request(`/v1/reservas/${ruta}`, { method: metodo });
	return { status: res.status, json: (await res.json()) as any };
}

/** Lo que se replica a la Main de lo que la ruta mandó aplicar. */
const sentencias = () => aplicados.flatMap((b) => buildApplyBatch(b.command).replicated.map((s) => s.sql));
/** Las guardas que lleva lo que la ruta mandó aplicar (SYNC-30): no se replican. */
const guardas = () =>
	aplicados.flatMap((b) => b.command.payload.steps.filter((s: any) => s.kind === "guard").map((s: any) => s.error));

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
		expect(guardas()).toEqual(["reserva_no_pendiente", "reserva_no_pendiente"]);
	});

	it("ya cancelada no se vuelve a escribir, y una que no existe dice que no", async () => {
		expect(await pedir("POST", "web-cancelada/cancelar")).toEqual({ status: 200, json: { ok: true, cancelada: true } });
		expect(await pedir("POST", "otra/cancelar")).toEqual({ status: 200, json: { ok: true, cancelada: false } });
		expect(aplicados).toEqual([]);
	});

	// Ya no lo mira la ruta: lo mira la guarda dentro del lote, también si la Main la sienta entre la
	// lectura y el lote. Que la rechace lo prueba `guardasEnElLote.test.ts`, con el motor de verdad.
	it("sentada o sin presentarse: la ruta manda el comando con su guarda, que la rechaza al aplicarlo", async () => {
		for (const id of ["sentada", "no-vino"]) await pedir("POST", `${id}/cancelar`);
		expect(guardas()).toEqual(["reserva_no_pendiente", "reserva_no_pendiente"]);
	});
});
