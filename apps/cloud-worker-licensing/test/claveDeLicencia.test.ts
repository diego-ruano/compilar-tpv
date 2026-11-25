// test/claveDeLicencia.test.ts
//
// LIC-INC-01 · Una clave mal escrita no es una clave que no existe.
//
// `/v1/license/activate` contestaba a las dos con `license_not_found` y sin `message`, y el TPV
// enseñaba el genérico de ese código: «No hay una licencia activa». A quien se había comido una
// letra al teclear la clave le decía que no tenía licencia.
//
// Aquí se fija la regla de la clave contra la tabla que comparte con la Main y con la pantalla
// (`crates/tpv-domain/src/clave_licencia_casos.json`), y lo que contesta la ruta a cada caso, con una
// base central de verdad (`helpers/central.ts`).

import { describe, expect, it } from "vitest";

import tabla from "../../../crates/tpv-domain/src/clave_licencia_casos.json";
import { activacionFirmada, clavePublica } from "./helpers/activar";
import { centralDePrueba } from "./helpers/central";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { CLAVE_DESCONOCIDA, generateLicenseKey, normalizeLicenseKey } from "../src/domains/licensing/licenseKey";
import { MENSAJES, SIN_MENSAJE_PROPIO, wireToCode } from "../src/lib/errorCodes";

const ENV = {
	LICENSE_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
} as any;

const CLAVE_EQUIPO = await clavePublica(61);

describe("LIC-INC-01 · la forma de la clave, la misma que en la Main y en la pantalla", () => {
	it.each(tabla.casos as Array<[string, string | null, string]>)("%j → %j (%s)", (entrada, canonica) => {
		expect(normalizeLicenseKey(entrada)).toBe(canonica);
	});

	it("una clave recién generada ya está en su forma canónica", () => {
		for (let i = 0; i < 50; i++) {
			const clave = generateLicenseKey();
			expect(normalizeLicenseKey(clave)).toBe(clave);
		}
	});

	it("lo que se enseña a quien la escribe mal es el texto de la tabla", () => {
		expect(MENSAJES.invalid_license_key_format).toBe(tabla.mensaje);
		expect(wireToCode("invalid_license_key_format", 400)).toBe("validation");
	});
});

describe("LIC-INC-01 · lo que contesta /v1/license/activate", () => {
	/** Pide la activación con `activationKey` contra una base central nueva, sin licencias. */
	async function activar(activationKey: string) {
		const central = await centralDePrueba();
		const res = await licenseRoutes.request(
			"/activate",
			await activacionFirmada({ activationKey, deviceId: "equipo-lic-inc-01", devicePubKey: CLAVE_EQUIPO }),
			{ ...ENV, ...central.entorno },
			{ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as any,
		);
		return { status: res.status, body: (await res.json()) as any };
	}

	it("una clave mal escrita: 400 invalid_license_key_format, no «No hay una licencia activa»", async () => {
		const r = await activar("TPV-ABCD-EFGH-JKMN");
		expect(r.status).toBe(400);
		expect(r.body.error).toBe("invalid_license_key_format");
		// Su texto lo pone `completarErrores` desde `MENSAJES`: no es de los que van sin mensaje.
		expect(SIN_MENSAJE_PROPIO.has("invalid_license_key_format")).toBe(false);
	});

	it("una clave bien escrita que no es de ninguna licencia: 404 license_not_found con su propia frase", async () => {
		const r = await activar("tpv abcde fghjk mnpqr stvwx");
		expect(r).toEqual({
			status: 404,
			body: { ok: false, error: "license_not_found", message: CLAVE_DESCONOCIDA },
		});
		expect(CLAVE_DESCONOCIDA).toBe("No hay ninguna licencia con esa clave. Revísala.");
	});
});
