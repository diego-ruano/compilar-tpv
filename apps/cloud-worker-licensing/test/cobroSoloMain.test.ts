// test/cobroSoloMain.test.ts
//
// Cobrar es cosa de la Main y solo de la Main: una Handy no tiene impresora ni cajón, así que
// cerrar una mesa desde ella dejaría al cliente sin ticket, el número correlativo sin asignar y el
// dinero sin registrar en el cajón.
//
// Es una regla que el servidor tiene que hacer cumplir por su cuenta. Dejarla solo en la interfaz
// de la Handy significa que cualquiera con su token puede cobrar igualmente — y el token de una
// Handy vive en un móvil que se queda en la barra.

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rol que devuelve la BD central en cada test. */
let rolEnLaBd: string | null = "handy";
const consultas: Array<{ sql: string; args: unknown[] }> = [];

vi.mock("../src/server/db", () => ({
	getDb: () => ({
		execute: async (q: { sql: string; args: unknown[] }) => {
			consultas.push(q);
			return { rows: rolEnLaBd === null ? [] : [{ role: rolEnLaBd }] };
		},
	}),
}));

const { soloLaMainCobra, rolDelDispositivo } = await import("../src/middleware/tenant");

/** Contexto de Hono con lo justo que mira el guard. */
function contexto() {
	const respuestas: Array<{ body: any; status: number }> = [];
	return {
		ctx: {
			env: {} as any,
			get: (k: string) => (k === "tenantId" ? "t1" : "d1"),
			json: (body: any, status = 200) => {
				respuestas.push({ body, status });
				return { body, status } as any;
			},
		},
		respuestas,
	};
}

/**
 * Ejecuta el veto —que es un middleware— y devuelve su respuesta de rechazo, o `null` si dejó
 * pasar. Es middleware y no una función dentro del handler porque tiene que decidir antes de que
 * se lea y valide el cuerpo (ver `middleware/tenant.ts`).
 */
async function ejecutarVeto(mw: any, ctx: any): Promise<any> {
	let paso = false;
	const r = await mw(ctx, async () => {
		paso = true;
	});
	return paso ? null : r;
}

beforeEach(() => {
	consultas.length = 0;
	rolEnLaBd = "handy";
});

describe("cobrar desde una Handy", () => {
	it("se rechaza con un código que la app sabe traducir", async () => {
		const { ctx } = contexto();
		const veto = (await ejecutarVeto(soloLaMainCobra, ctx)) as any;

		expect(veto).not.toBeNull();
		expect(veto.status).toBe(403);
		expect(veto.body.error).toBe("cobro_solo_en_main");
	});

	it("un dispositivo revocado o desconocido tampoco cobra", async () => {
		// Sin fila (revocado, borrado, de otro tenant) el rol sale vacío: no es `tpv`, no cobra.
		rolEnLaBd = null;
		const { ctx } = contexto();

		expect(await ejecutarVeto(soloLaMainCobra, ctx)).not.toBeNull();
	});

	it("un rol inventado no cuela", async () => {
		// Lo único que abre la puerta es exactamente "tpv".
		for (const rol of ["main", "TPV_MAIN", "admin", "", "tpv2"]) {
			rolEnLaBd = rol;
			const { ctx } = contexto();
			expect(await ejecutarVeto(soloLaMainCobra, ctx), rol).not.toBeNull();
		}
	});
});

describe("cobrar desde la Main", () => {
	it("pasa", async () => {
		rolEnLaBd = "tpv";
		const { ctx } = contexto();

		expect(await ejecutarVeto(soloLaMainCobra, ctx)).toBeNull();
	});

	it("el rol se lee sin distinguir mayúsculas", async () => {
		// La fila la escribe el aprovisionamiento; que una mayúscula deje a un cliente sin poder
		// cobrar sería un incidente de los caros.
		rolEnLaBd = "TPV";
		const { ctx } = contexto();

		expect(await ejecutarVeto(soloLaMainCobra, ctx)).toBeNull();
	});
});

describe("de dónde sale el rol", () => {
	it("de la fila del dispositivo, nunca de una cabecera del cliente", async () => {
		// Si el rol viniera del JWT o de `x-role`, el propio dispositivo se estaría autorizando.
		await rolDelDispositivo({} as any, "t1", "d1");

		expect(consultas).toHaveLength(1);
		expect(consultas[0].sql).toContain("FROM devices");
		expect(consultas[0].args).toEqual(["t1", "d1"]);
	});

	it("y solo si el dispositivo sigue vivo", async () => {
		// Un dispositivo revocado conserva su fila: sin este filtro, un móvil dado de baja
		// seguiría cobrando.
		await rolDelDispositivo({} as any, "t1", "d1");

		expect(consultas[0].sql).toContain("revoked_at_ms IS NULL");
	});
});
