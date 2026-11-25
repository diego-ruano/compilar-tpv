// test/licenciaTraslado.test.ts
//
// `/v1/license/activate` le dice al equipo si la activación ha trasladado la licencia desde otro.
//
// Es lo que decide, en la Main, si su base local vale o hay que reconstruirla desde la nube: tras
// un traslado lo que tenga es de antes, y trabajar con ello —o subir su outbox— pisaría lo que el
// otro equipo hizo mientras tanto. Por eso lo tiene que decir el servidor, que sabe a qué equipo
// estaba ligada la licencia, y no el cliente por haber escrito un código.
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`). El aprovisionamiento de la base
// del negocio y los correos se sustituyen: no son lo que se prueba.

import { describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { centralDePrueba, type CentralDePrueba } from "./helpers/central";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { otpHash } from "../src/domains/licensing/licensing.helpers";
import { getLicenseById, issueLicense, putDeviceOtp } from "../src/server/licenseStore";

vi.mock("../src/domains/licensing/licensing.helpers", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licensing.helpers")>();
	return { ...original, provisionTenantDatabase: async () => ({ reused: true }) };
});

vi.mock("../src/domains/licensing/licenseEmails", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licenseEmails")>();
	return {
		...original,
		sendDeviceChangeCodeEmail: async () => {},
		sendDeviceChangedNoticeEmail: async () => {},
	};
});

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: STORE_KEY,
};
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

type Licencia = {
	licenseId: string;
	central: CentralDePrueba;
	/** Pide la activación de la licencia en `deviceId`, con el código de traslado `codigo`. */
	activar: (deviceId: string, devicePubKey: string, codigo?: string) => Promise<{ status: number; body: any }>;
};

/** Una licencia recién emitida, sin activar, en una base central propia. */
async function conLicencia<T>(prueba: (l: Licencia) => Promise<T>) {
	const central = await centralDePrueba();
	const { license, keyPlain } = await issueLicense(central.db, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "manual",
		customerEmail: "bar@ejemplo.test",
	});
	const activar = async (deviceId: string, devicePubKey: string, deviceChangeCode?: string) => {
		const res = await licenseRoutes.request(
			"/activate",
			await activacionFirmada({
				activationKey: keyPlain,
				deviceId,
				devicePubKey,
				deviceChangeCode,
				tenantInfo: { displayName: "Bar de Pruebas" },
			}),
			{ ...ENV, ...central.entorno },
			CONTEXTO as any,
		);
		return { status: res.status, body: (await res.json()) as any };
	};
	return prueba({ licenseId: license.license_id, central, activar });
}

describe("activar dice si la licencia se ha trasladado a este equipo", () => {
	it("la primera activación no es un traslado", async () => {
		await conLicencia(async ({ activar }) => {
			const r = await activar("equipo-a", PUB_A);
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(false);
		});
	});

	it("volver a activar en el mismo equipo no es un traslado, aunque llegue un código", async () => {
		await conLicencia(async ({ activar }) => {
			await activar("equipo-a", PUB_A);
			const r = await activar("equipo-a", PUB_A, "123456");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(false);
		});
	});

	it("activar en otro equipo con su código sí lo es, y la licencia pasa a ese equipo", async () => {
		await conLicencia(async ({ licenseId, central, activar }) => {
			await activar("equipo-a", PUB_A);

			const sinCodigo = await activar("equipo-b", PUB_B);
			expect(sinCodigo.body.error).toBe("device_change_required");

			await putDeviceOtp(central.db, {
				licenseId,
				newDeviceId: "equipo-b",
				codeHash: await otpHash("654321"),
				expiresAtMs: Date.now() + 10 * 60 * 1000,
			});
			const r = await activar("equipo-b", PUB_B, "654321");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
			expect((await getLicenseById(central.db, licenseId))?.main_device_id).toBe("equipo-b");
		});
	});

	it("y también cuando la licencia vuelve al equipo en el que estuvo antes", async () => {
		// El caso que motiva todo esto: la base de ese equipo es de antes de que se fuera.
		await conLicencia(async ({ licenseId, central, activar }) => {
			await activar("equipo-a", PUB_A);
			for (const [equipo, pub, codigo] of [
				["equipo-b", PUB_B, "111111"],
				["equipo-a", PUB_A, "222222"],
			] as const) {
				await putDeviceOtp(central.db, {
					licenseId,
					newDeviceId: equipo,
					codeHash: await otpHash(codigo),
					expiresAtMs: Date.now() + 10 * 60 * 1000,
				});
				const r = await activar(equipo, pub, codigo);
				expect(r.body.cambioDeEquipo, equipo).toBe(true);
			}
		});
	});
});
