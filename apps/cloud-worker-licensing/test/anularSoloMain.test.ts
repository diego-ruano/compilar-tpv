// test/anularSoloMain.test.ts
//
// Anular un cobro desde una Handy se rechaza (CUENTA-07).
//
// La caja se MIRA desde la sala y no se toca: el cajón, el recuento y la impresora están en la
// Main. Y anular es la escritura de caja que más importa cerrar — es por donde se va el dinero de
// un bar sin dejar rastro, que es justo el agujero que este plan tapa. Dejar la regla sólo en la
// interfaz significa que cualquiera con el token de una Handy anula igualmente, y ese token vive
// en un móvil que se queda en la barra.

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Rol que devuelve la BD central en cada test. */
let rolEnLaBd: string | null = "handy";

vi.mock("../src/server/db", () => ({
	getDb: () => ({
		execute: async () => ({ rows: rolEnLaBd === null ? [] : [{ role: rolEnLaBd }] }),
	}),
}));

const { soloLaMainEscribeCaja } = await import("../src/middleware/tenant");

/** Contexto de Hono con lo justo que mira el guard. */
function contexto() {
	return {
		env: {} as any,
		get: (k: string) => (k === "tenantId" ? "t1" : "d1"),
		json: (body: any, status = 200) => ({ body, status }) as any,
	};
}

beforeEach(() => {
	rolEnLaBd = "handy";
});

describe("anular un cobro desde una Handy", () => {
	it("se rechaza con un código que la app sabe traducir", async () => {
		const veto = (await soloLaMainEscribeCaja(contexto())) as any;

		expect(veto).not.toBeNull();
		expect(veto.status).toBe(403);
		expect(veto.body.error).toBe("caja_solo_en_main");
	});

	it("un dispositivo revocado o desconocido tampoco anula", async () => {
		rolEnLaBd = null;
		expect(await soloLaMainEscribeCaja(contexto())).not.toBeNull();
	});

	it("un rol inventado no cuela", async () => {
		for (const rol of ["main", "TPV_MAIN", "admin", "", "tpv2"]) {
			rolEnLaBd = rol;
			expect(await soloLaMainEscribeCaja(contexto()), rol).not.toBeNull();
		}
	});
});

describe("anular desde la Main", () => {
	it("pasa", async () => {
		rolEnLaBd = "tpv";
		expect(await soloLaMainEscribeCaja(contexto())).toBeNull();
	});
});

describe("la ruta de anular", () => {
	it("es un POST a /pagos/:id/anular y pide el veto antes que nada", async () => {
		// El veto no puede ir después de leer el cuerpo ni de tocar el DO: si la ruta cambiara de
		// orden, una Handy dejaría rastro (o efecto) antes de que nadie la eche.
		// El fuente se lee con `?raw` (Vite): dentro del pool de workers no hay `node:fs`.
		const fuente: string = (
			await import("../src/domains/cuentas/cuentas.routes.ts?raw")
		).default;

		const inicio = fuente.indexOf('cuentasRoutes.post("/pagos/:id/anular"');
		expect(inicio, "la ruta de anular no existe").toBeGreaterThan(-1);
		const bloque = fuente.slice(inicio);
		expect(bloque.indexOf("soloLaMainEscribeCaja")).toBeLessThan(bloque.indexOf("parseBody"));
		expect(bloque.indexOf("soloLaMainEscribeCaja")).toBeLessThan(bloque.indexOf("cmd.anularPago"));
	});
});
