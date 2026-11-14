// test/cobroSoloMain.test.ts
//
// Cobrar es cosa de la Main y solo de la Main: una Handy no tiene impresora ni cajón, así que
// cerrar una mesa desde ella dejaría al cliente sin ticket, el número correlativo sin asignar y el
// dinero sin registrar en el cajón.
//
// Es una regla que el servidor tiene que hacer cumplir por su cuenta. Dejarla solo en la interfaz
// de la Handy significa que cualquiera con su token puede cobrar igualmente — y el token de una
// Handy vive en un móvil que se queda en la barra.
//
// El veto se prueba suelto (el middleware con el rol que devuelve la base central) y por el camino
// desplegado: la `app` entera, `tenantAuth`, `alHub` y la ruta dentro del TenantHub, que decide con
// el rol de la identidad.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { conNegocioFirmado, HANDY, MAIN, pedirComo } from "./helpers/negocioFirmado";

/** Rol que devuelve la BD central en cada test del veto suelto. */
let rolEnLaBd: string | null = "handy";
const consultas: Array<{ sql: string; args: unknown[] }> = [];
/** La base central de verdad, en los tests por el camino desplegado. */
let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/server/db")>()),
	getDb: () =>
		dbCentral ?? {
			execute: async (q: { sql: string; args: unknown[] }) => {
				consultas.push(q);
				return { rows: rolEnLaBd === null ? [] : [{ role: rolEnLaBd }] };
			},
		},
}));

const { soloLaMainCobra, rolDelDispositivo } = await import("../src/middleware/tenant");
const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const deps = { ponerCentral: (db: unknown) => void (dbCentral = db), firmarSesion, olvidarLicenciasCacheadas };

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

describe("por el camino desplegado", () => {
	it("la Handy no cobra ni en mesas ni en la barra: lo decide el TenantHub, antes de mirar el cuerpo", async () => {
		await conNegocioFirmado(deps, "cobro-desplegado", async (n) => {
			for (const ruta of ["/v1/mesas/cobrar-detalles", "/v1/venta-rapida/cobrar-fraccionado"]) {
				// Un cuerpo que no vale: si el veto fuera detrás del validador, saldría un 400.
				const handy = await pedirComo(deps, app, n, HANDY, "POST", ruta, { esto: "no es un cobro" });
				expect(handy.status, ruta).toBe(403);
				expect(handy.json, ruta).toMatchObject({ ok: false, error: "cobro_solo_en_main" });
				expect(handy.viajes, ruta).toBe(1);

				// La Main pasa el veto y llega al validador.
				const main = await pedirComo(deps, app, n, MAIN, "POST", ruta, { esto: "no es un cobro" });
				expect(main.status, ruta).toBe(400);
				expect(main.viajes, ruta).toBe(1);
			}
			// El rol viajó con la identidad: el veto no se lo pidió a la base central (`rolDelDispositivo`).
			expect(n.central.filter((q) => /SELECT role FROM devices WHERE .*revoked_at_ms IS NULL/.test(q))).toEqual([]);
		});
	});
});
