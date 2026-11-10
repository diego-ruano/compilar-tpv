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
// El aprovisionamiento en Turso y los correos se sustituyen: salen a internet y no son lo que se
// prueba.

import { describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
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

let dbDePruebas: unknown = null;
const correosEnviados: string[] = [];

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

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
	TURSO_DATABASE_URL: "libsql://no-se-usa",
	TURSO_AUTH_TOKEN: "no-se-usa",
	TURSO_PLATFORM_TOKEN: "no-se-usa",
	TURSO_ORG_SLUG: "no-se-usa",
	EMAIL_FROM_ADDRESS: "no-responder@ejemplo.test",
};
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };

/** Una licencia ya activada en `equipo-a`, que es lo que hace que otro equipo necesite el código. */
async function conLicenciaActivada<T>(
	nombre: string,
	prueba: (e: { clave: string; licenseId: string; sql: any }) => Promise<T>,
) {
	return enElHub(`otp-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "devices", "tenants", "license_device_otp", "license_otp_eventos"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}
		correosEnviados.length = 0;
		dbDePruebas = clienteSobre(sql);
		const { license, keyPlain } = await issueLicense(dbDePruebas as any, {
			claves: STORE_KEY,
			termMonths: 12,
			origin: "manual",
			customerEmail: "bar@ejemplo.test",
		});
		expect((await activar(keyPlain, "equipo-a", PUB_A)).status).toBe(200);
		return prueba({ clave: keyPlain, licenseId: license.license_id, sql });
	});
}

async function activar(clave: string, deviceId: string, devicePubKey: string, deviceChangeCode?: string) {
	const res = await licenseRoutes.request(
		"/activate",
		await activacionFirmada({
			activationKey: clave,
			deviceId,
			devicePubKey,
			deviceChangeCode,
			tenantInfo: { displayName: "Bar de Pruebas" },
		}),
		ENV,
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

async function pedirCodigo(clave: string, deviceId: string, env: Record<string, unknown> = ENV) {
	const res = await licenseRoutes.request(
		"/device-change/request",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ activationKey: clave, deviceId }),
		},
		env,
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

/** Deja preparado un código conocido para la pareja (licencia, `deviceId`). */
async function codigoConocido(licenseId: string, deviceId: string, codigo: string) {
	await putDeviceOtp(dbDePruebas as any, {
		licenseId,
		newDeviceId: deviceId,
		codeHash: await otpHash(codigo),
		expiresAtMs: Date.now() + 60_000,
	});
}

describe("RI-68 · cuántos códigos se mandan", () => {
	it("como mucho OTP_CODIGOS_AL_DIA por licencia, aunque cada uno lo pida un equipo distinto", async () => {
		await conLicenciaActivada("envios", async ({ clave }) => {
			for (let i = 0; i < OTP_CODIGOS_AL_DIA + 3; i++) {
				const r = await pedirCodigo(clave, `inventado-${i}`);
				// La respuesta no cambia: no le dice a nadie si la clave existe ni si hay cupo.
				expect(r).toEqual({ status: 200, body: { ok: true } });
			}
			expect(correosEnviados).toHaveLength(OTP_CODIGOS_AL_DIA);
		});
	});

	it("y los envíos de hace más de un día ya no cuentan", async () => {
		await conLicenciaActivada("ventana", async ({ clave, licenseId, sql }) => {
			for (let i = 0; i < OTP_CODIGOS_AL_DIA; i++) {
				sql.exec(
					`INSERT INTO license_otp_eventos (license_id, tipo, at_ms) VALUES (?, 'envio', ?);`,
					licenseId,
					Date.now() - OTP_VENTANA_MS - 1000,
				);
			}
			await pedirCodigo(clave, "equipo-b");
			expect(correosEnviados).toHaveLength(1);
		});
	});
});

describe("RI-68 · cuántos códigos incorrectos se aceptan", () => {
	it("pasado OTP_FALLOS_AL_DIA por licencia, ni el código bueno entra, aunque cada fallo fuera de otro equipo", async () => {
		await conLicenciaActivada("fallos", async ({ clave, licenseId }) => {
			for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
				await codigoConocido(licenseId, `inventado-${i}`, "111111");
				const r = await activar(clave, `inventado-${i}`, PUB_B, "999999");
				expect(r.body.error).toBe("invalid_code");
			}

			await codigoConocido(licenseId, "equipo-b", "222222");
			const r = await activar(clave, "equipo-b", PUB_B, "222222");
			expect(r.status).toBe(429);
			expect(r.body.error).toBe("too_many_attempts");
			expect(r.body.message).toContain("mañana");
		});
	});

	it("pedir otro código no devuelve los intentos de la licencia", async () => {
		await conLicenciaActivada("reinicio", async ({ clave, licenseId }) => {
			for (let i = 0; i < OTP_FALLOS_AL_DIA; i++) {
				// El mismo equipo, pidiendo un código nuevo cada vez: eso reinicia los 5 del código,
				// pero no los de la licencia.
				await codigoConocido(licenseId, "equipo-b", "111111");
				await activar(clave, "equipo-b", PUB_B, "999999");
			}
			await codigoConocido(licenseId, "equipo-b", "222222");
			expect((await activar(clave, "equipo-b", PUB_B, "222222")).status).toBe(429);
		});
	});

	it("un dueño que se equivoca una vez y luego acierta mueve su licencia", async () => {
		await conLicenciaActivada("dueno", async ({ clave, licenseId }) => {
			await codigoConocido(licenseId, "equipo-b", "222222");
			expect((await activar(clave, "equipo-b", PUB_B, "999999")).body.error).toBe("invalid_code");
			const r = await activar(clave, "equipo-b", PUB_B, "222222");
			expect(r.status).toBe(200);
			expect(r.body.cambioDeEquipo).toBe(true);
		});
	});

	it("la purga diaria se lleva los eventos que ya no cuentan, y no los que sí", async () => {
		await conLicenciaActivada("purga", async ({ licenseId, sql }) => {
			const ahora = Date.now();
			sql.exec(
				`INSERT INTO license_otp_eventos (license_id, tipo, at_ms) VALUES (?, 'fallo', ?), (?, 'envio', ?);`,
				licenseId,
				ahora - OTP_VENTANA_MS - 1,
				licenseId,
				ahora - OTP_VENTANA_MS + 1000,
			);
			const purgado = await purgarBaseCentral(dbDePruebas as any, ahora);
			expect(purgado.eventosDeCodigo).toBe(1);
			expect(sql.exec(`SELECT tipo FROM license_otp_eventos;`).toArray()).toEqual([{ tipo: "envio" }]);
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
