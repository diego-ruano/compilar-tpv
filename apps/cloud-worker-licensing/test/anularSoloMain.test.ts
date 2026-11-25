// test/anularSoloMain.test.ts
//
// Anular un cobro desde una Handy se rechaza (CUENTA-07).
//
// La caja se MIRA desde la sala y no se toca: el cajón, el recuento y la impresora están en la
// Main. Y anular es la escritura de caja que más importa cerrar — es por donde se va el dinero de
// un bar sin dejar rastro, que es justo el agujero que este plan tapa. Dejar la regla sólo en la
// interfaz significa que cualquiera con el token de una Handy anula igualmente, y ese token vive
// en un móvil que se queda en la barra.
//
// El veto se prueba suelto (el middleware con el rol que tiene el dispositivo en la base central) y
// por el camino desplegado: la `app` entera, `tenantAuth`, `alHub` y la ruta dentro del TenantHub,
// que decide con el rol de la identidad. Las dos, contra una base central de verdad
// (`helpers/central.ts`).

import { describe, it, expect } from "vitest";

import { centralConUnDispositivo } from "./helpers/central";
import { conNegocioFirmado, HANDY, MAIN, pedirComo } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";
import { soloLaMainEscribeCaja } from "../src/middleware/tenant";

const deps = { firmarSesion, olvidarLicenciasCacheadas };

/** Contexto de Hono con lo justo que mira el guard, con la central `entorno`. */
function contexto(entorno: unknown) {
	return {
		env: entorno as any,
		get: (k: string) => (k === "tenantId" ? "t1" : "d1"),
		json: (body: any, status = 200) => ({ body, status }) as any,
	};
}

/**
 * Ejecuta el veto —que es un middleware— con el dispositivo de la central `entorno`, y devuelve su
 * respuesta de rechazo, o `null` si dejó pasar. Es middleware y no una función dentro del handler
 * porque tiene que decidir antes de que se lea y valide el cuerpo (ver `middleware/tenant.ts`).
 */
async function ejecutarVeto(entorno: unknown): Promise<any> {
	let paso = false;
	const r = await soloLaMainEscribeCaja(contexto(entorno) as any, async () => {
		paso = true;
	});
	return paso ? null : r;
}

describe("anular un cobro desde una Handy", () => {
	it("se rechaza con un código que la app sabe traducir", async () => {
		const veto = await ejecutarVeto((await centralConUnDispositivo("handy")).entorno);

		expect(veto).not.toBeNull();
		expect(veto.status).toBe(403);
		expect(veto.body.error).toBe("caja_solo_en_main");
	});

	it("un dispositivo revocado o desconocido tampoco anula", async () => {
		expect(await ejecutarVeto((await centralConUnDispositivo(null)).entorno)).not.toBeNull();
		expect(await ejecutarVeto((await centralConUnDispositivo("tpv", { revocado: true })).entorno)).not.toBeNull();
	});

	it("un rol inventado no cuela", async () => {
		for (const rol of ["main", "TPV_MAIN", "admin", "", "tpv2"]) {
			const { entorno } = await centralConUnDispositivo("tpv", { contestar: rol });
			expect(await ejecutarVeto(entorno), rol).not.toBeNull();
		}
	});
});

describe("anular desde la Main", () => {
	it("pasa", async () => {
		expect(await ejecutarVeto((await centralConUnDispositivo("tpv")).entorno)).toBeNull();
		const { entorno } = await centralConUnDispositivo("tpv", { contestar: " TPV " });
		expect(await ejecutarVeto(entorno), " TPV ").toBeNull();
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
		expect(bloque.indexOf("soloLaMainEscribeCaja")).toBeLessThan(bloque.indexOf("cuerpo("));
		expect(bloque.indexOf("soloLaMainEscribeCaja")).toBeLessThan(bloque.indexOf("cmd.anularPago"));
	});
});

describe("por el camino desplegado", () => {
	it("la Handy no anula: lo decide el TenantHub con el rol de la identidad, antes de mirar el cuerpo", async () => {
		await conNegocioFirmado(deps, "anular-desplegado", async (n) => {
			// Un cuerpo que no vale: si el veto fuera detrás del validador, saldría un 400.
			const handy = await pedirComo(deps, app, n, HANDY, "POST", "/v1/cuentas/pagos/p-1/anular", { esto: "no" });
			expect(handy.status).toBe(403);
			expect(handy.json).toMatchObject({ ok: false, error: "caja_solo_en_main" });
			expect(handy.viajes).toBe(1);

			// La Main pasa el veto y llega al validador.
			const main = await pedirComo(deps, app, n, MAIN, "POST", "/v1/cuentas/pagos/p-1/anular", { esto: "no" });
			expect(main.status).toBe(400);
			expect(main.viajes).toBe(1);
		});
	});
});
