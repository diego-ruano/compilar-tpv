// test/otpCambioDeEquipo.test.ts
//
// RI-68 · Los topes del código de 6 cifras que mueve una licencia a otro equipo.
//
// Los 5 intentos y los 60 s entre envíos eran por pareja (licencia, equipo nuevo). Con la clave de
// licencia —que es la premisa: sin ella no se llega aquí— cada `deviceId` inventado abría su pareja,
// y pedir otro código devolvía los 5 intentos. Eran intentos sin fin y un correo al titular por
// cada uno. Lo que se fija aquí es que los topes de verdad van por LICENCIA, y que un dueño que
// cambia de PC de verdad no los roza.
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`). El aprovisionamiento de la base
// del negocio y los correos se sustituyen: no son lo que se prueba.

import { describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import configuracionDelWorker from "../wrangler.json";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import {
	OTP_CODIGOS_AL_DIA,
	OTP_FALLOS_AL_DIA,
	OTP_VENTANA_MS,
	otpHash,
} from "../src/domains/licensing/licensing.helpers";
import { issueLicense, putDeviceOtp } from "../src/server/licenseStore";
import { purgarBaseCentral } from "../src/server/purga";

const correosEnviados: string[] = [];

vi.mock("../src/domains/licensing/licensing.helpers", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licensing.helpers")>();
	return { ...original, provisionTenantDatabase: async () => ({ reused: true }) };
});

vi.mock("../src/domains/licensing/licenseEmails", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/licensing/licenseEmails")>();
	return {
		...original,
		sendDeviceChangeCodeEmail: async (_env: unknown, args: { code: string }) => {
			correosEnviados.push(args.code);
			return true;
		},
		sendDeviceChangedNoticeEmail: async () => true,
	};
});

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_STORE_KEY: STORE_KEY,
	EMAIL_FROM_ADDRESS: "no-responder@ejemplo.test",
};
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

/**
 * Una licencia ya activada en `equipo-a`, que es lo que hace que otro equipo necesite el código, en
 * una central propia.
 */
async function conLicenciaActivada<T>(
	prueba: (e: { clave: string; licenseId: string; central: CentralDePrueba }) => Promise<T>,
): Promise<T> {
	const central = await centralDePrueba();
	correosEnviados.length = 0;
	const { license, keyPlain } = await issueLicense(central.db, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "manual",
		customerEmail: "bar@ejemplo.test",
	});
	expect((await activar(central, keyPlain, "equipo-a", PUB_A)).status).toBe(200);
	return prueba({ clave: keyPlain, licenseId: license.license_id, central });
}

async function activar(
	central: CentralDePrueba,
	clave: string,
	deviceId: string,
	devicePubKey: string,
	deviceChangeCode?: string,
) {
	const res = await licenseRoutes.request(
		"/activate",
		await activacionFirmada({
			activationKey: clave,
			deviceId,
			devicePubKey,
			deviceChangeCode,
			tenantInfo: { displayName: "Bar de Pruebas" },
		}),
		{ ...ENV, ...central.entorno },
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

async function pedirCodigo(central: CentralDePrueba, clave: string, deviceId: string) {
	const res = await licenseRoutes.request(
		"/device-change/request",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ activationKey: clave, deviceId }),
		},
		{ ...ENV, ...central.entorno },
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

/** Deja preparado un código conocido para la pareja (licencia, `deviceId`). */
async function codigoConocido(central: CentralDePrueba, licenseId: string, deviceId: string, codigo: string) {
	await putDeviceOtp(central.db, {
		licenseId,
		newDeviceId: deviceId,
		codeHash: await otpHash(codigo),
		expiresAtMs: Date.now() + 60_000,
	});
}

describe("RI-68 · cuántos códigos se mandan", () => {
	it("como mucho OTP_CODIGOS_AL_DIA por licencia, aunque cada uno lo pida un equipo distinto", async () => {
		await conLicenciaActivada(async ({ clave, central }) => {
			for (let i = 0; i < OTP_CODIGOS_AL_DIA + 3; i++) {
				const r = await pedirCodigo(central, clave, `inventado-${i}`);
				// La respuesta no cambia: no le dice a nadie si la clave existe ni si hay cupo.
				expect(r).toEqual({ status: 200, body: { ok: true } });
			}
			expect(correosEnviados).toHaveLength(OTP_CODIGOS_AL_DIA);
		});
	});

	it("y los envíos de hace más de un día ya no cuentan", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			for (let i = 0; i < OTP_CODIGOS_AL_DIA; i++) {
				await filasDe(
					central,
					`INSERT INTO license_otp_eventos (license_id, tipo, at_ms) VALUES (?, 'envio', ?);`,
					licenseId,
					Date.now() - OTP_VENTANA_MS - 1000,
				);
			}
			await pedirCodigo(central, clave, "equipo-b");
			expect(correosEnviados).toHaveLength(1);
		});
	});
});

describe("RI-68 · cuántos códigos incorrectos se aceptan", () => {
	it("pasado OTP_FALLOS_AL_DIA por licencia, ni el código bueno entra, aunque cada fallo fuera de otro equipo", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
				await codigoConocido(central, licenseId, `inventado-${i}`, "111111");
				const r = await activar(central, clave, `inventado-${i}`, PUB_B, "999999");
				expect(r.body.error).toBe("invalid_code");
			}

			await codigoConocido(central, licenseId, "equipo-b", "222222");
			const r = await activar(central, clave, "equipo-b", PUB_B, "222222");
			expect(r.status).toBe(429);
			expect(r.body.error).toBe("too_many_attempts");
			expect(r.body.message).toContain("mañana");
		});
	});

	it("pedir otro código no devuelve los intentos de la licencia", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
				// El mismo equipo, pidiendo un código nuevo cada vez: eso reinicia los 5 del código,
				// pero no los de la licencia.
				await codigoConocido(central, licenseId, "equipo-b", "111111");
				await activar(central, clave, "equipo-b", PUB_B, "999999");
			}
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			expect((await activar(central, clave, "equipo-b", PUB_B, "222222")).status).toBe(429);
		});
	});

	it("un dueño que se equivoca una vez y luego acierta mueve su licencia", async () => {
		await conLicenciaActivada(async ({ clave, licenseId, central }) => {
			await codigoConocido(central, licenseId, "equipo-b", "222222");
			expect((await activar(central, clave, "equipo-b", PUB_B, "999999")).body.error).toBe("invalid_code");
			const r = await activar(central, clave, "equipo-b", PUB_B, "222222");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
		});
	});

	it("la purga diaria se lleva los eventos que ya no cuentan, y no los que sí", async () => {
		await conLicenciaActivada(async ({ licenseId, central }) => {
			const ahora = Date.now();
			await filasDe(
				central,
				`INSERT INTO license_otp_eventos (license_id, tipo, at_ms) VALUES (?, 'fallo', ?), (?, 'envio', ?);`,
				licenseId,
				ahora - OTP_VENTANA_MS - 1,
				licenseId,
				ahora - OTP_VENTANA_MS + 1000,
			);
			const purgado = await purgarBaseCentral(central.db, ahora);
			expect(purgado.eventosDeCodigo).toBe(1);
			expect(await filasDe(central, `SELECT tipo FROM license_otp_eventos;`)).toEqual([{ tipo: "envio" }]);
		});
	});
});

describe("RI-68 · el filtro por IP", () => {
	it("va delante: con el cupo de la red agotado no se lee ni la clave", async () => {
		const lleno = { ...ENV, LIMITADOR_LICENCIA: { limit: () => Promise.resolve({ success: false }) } };
		const res = await licenseRoutes.request(
			"/device-change/request",
			{ method: "POST", headers: { "content-type": "application/json" }, body: "esto no es json" },
			lleno,
			CONTEXTO as any,
		);
		expect(res.status).toBe(429);
		expect(((await res.json()) as any).error).toBe("too_many_attempts");
	});

	it("sigue declarado en wrangler.json, con 10 peticiones por minuto", () => {
		// Si desapareciera no habría ningún síntoma: el filtro deja pasar sin el binding.
		const limitador = (configuracionDelWorker as any).ratelimits.find(
			(l: any) => l.name === "LIMITADOR_LICENCIA",
		);
		expect(limitador?.simple).toEqual({ limit: 10, period: 60 });
	});
});
