// test/recuperarPin.test.ts
//
// LOGIN-07: recuperar el PIN de un administrador con un código que llega al correo de la licencia.
//
// Se prueba la lógica (`recuperarPin.ts`) contra el esquema real del control-plane sobre el SQLite
// del Durable Object, igual que `adminLicenciaReversible.test.ts`. La ruta sólo le pone delante la
// autenticación de siempre (`tenantAuth`) y la comprobación de que quien pide es una Main.
//
// Lo que se fija es lo que haría que esto dejara de ser seguro sin que nada fallara a la vista:
// que un código valga dos veces, en otro equipo o para otro usuario; que los intentos no se agoten;
// que se guarde en algo reversible; y que el botón sirva para bombardear el buzón del titular.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import {
	solicitarCodigoPin,
	verificarCodigoPin,
	type ContextoRecuperacion,
} from "../src/domains/login/recuperarPin";
import {
	MAX_ENVIOS_POR_VENTANA,
	REENVIO_MIN_MS,
	VENTANA_ENVIOS_MS,
	type RespuestaCodigo,
} from "../src/domains/login/codigosPorCorreo";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "../src/domains/licensing/licensing.helpers";
import {
	activateLicenseFirstTime,
	ensureLicensingSchema,
	getEmailCode,
	issueLicense,
} from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const CORREO = "titular@bar.test";
const TENANT = "tenant-1";
const MAIN = "main-1";
const ADMIN = "admin-1";
const T0 = 1_800_000_000_000;
const CLAVE_PIN = { tenantId: TENANT, deviceId: MAIN, purpose: "recuperar_pin" as const };

type Correo = { to: string; subject: string; text: string };

type Escenario = {
	db: any;
	env: any;
	ctx: (extra?: Partial<ContextoRecuperacion>) => ContextoRecuperacion;
	correos: Correo[];
	/** El código que lleva el último correo enviado. */
	ultimoCodigo: () => string;
	verificar: (
		codigo: string,
		extra?: Partial<ContextoRecuperacion>,
	) => Promise<RespuestaCodigo>;
	avisos: Promise<unknown>[];
	romperCorreo: (roto: boolean) => void;
};

async function escenario(fn: (e: Escenario) => Promise<void>): Promise<void> {
	await enElHub("recuperar-pin", async (hub: any) => {
		const db = clienteSobre(hub.state.storage.sql);
		await ensureLicensingSchema(db);
		for (const tabla of ["licenses", "email_codes", "tenant_recovery_emails", "license_device_swaps"]) {
			hub.state.storage.sql.exec(`DELETE FROM ${tabla};`);
		}

		const correos: Correo[] = [];
		let correoRoto = false;
		const env = {
			LICENSE_JWT_SECRET: "secreto-de-pruebas",
			EMAIL_FROM_ADDRESS: "tpv@altaria.test",
			EMAIL: {
				send: async (m: any) => {
					if (correoRoto) throw new Error("el servicio de correo no contesta");
					correos.push({ to: m.to, subject: m.subject, text: m.text });
				},
			},
		};

		const { license } = await issueLicense(db, {
			storeKeyB64: STORE_KEY,
			termMonths: 12,
			origin: "manual",
			customerEmail: CORREO,
		});
		await activateLicenseFirstTime(db, {
			licenseId: license.license_id,
			tenantId: TENANT,
			deviceId: MAIN,
			termMonths: 12,
		});

		const ctx = (extra: Partial<ContextoRecuperacion> = {}): ContextoRecuperacion => ({
			tenantId: TENANT,
			deviceId: MAIN,
			licHash: license.license_key_hash,
			idUsuario: ADMIN,
			ahora: T0,
			...extra,
		});

		const avisos: Promise<unknown>[] = [];

		await fn({
			db,
			env,
			ctx,
			correos,
			ultimoCodigo: () => {
				const m = correos[correos.length - 1]?.text.match(/\b(\d{6})\b/);
				if (!m) throw new Error("el último correo no lleva ningún código");
				return m[1];
			},
			verificar: (codigo, extra = {}) =>
				verificarCodigoPin(db, env as any, { ...ctx(extra), codigo }, (p) => avisos.push(p)),
			avisos,
			romperCorreo: (roto) => (correoRoto = roto),
		});
	});
}

/** Un código de 6 cifras que seguro no es `bueno`. */
function otroCodigo(bueno: string): string {
	return bueno === "000000" ? "111111" : "000000";
}

describe("recuperar el PIN · el código", () => {
	it("llega al correo de la licencia, sin enseñar el correo entero, y vale una sola vez", async () => {
		await escenario(async (e) => {
			const r = await solicitarCodigoPin(e.db, e.env, e.ctx());
			expect(r.status).toBe(200);
			expect(r.body.emailHint).toMatch(/@bar\.test$/);
			expect(String(r.body.emailHint)).not.toContain("titular");

			expect(e.correos).toHaveLength(1);
			expect(e.correos[0].to).toBe(CORREO);

			const codigo = e.ultimoCodigo();
			expect((await e.verificar(codigo, { ahora: T0 + 1_000 })).status).toBe(200);
			expect((await e.verificar(codigo, { ahora: T0 + 2_000 })).status).toBe(400);
		});
	});

	it("al usarse, avisa al titular", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			await e.verificar(e.ultimoCodigo(), { ahora: T0 + 1_000 });

			expect(e.avisos).toHaveLength(1);
			await Promise.all(e.avisos);
			expect(e.correos).toHaveLength(2);
			expect(e.correos[1].to).toBe(CORREO);
			expect(e.correos[1].subject).toContain("PIN");
		});
	});

	it("no se guarda el código, ni un hash que se pueda reproducir sin el secreto", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			const codigo = e.ultimoCodigo();
			const fila = await getEmailCode(e.db, CLAVE_PIN);

			const sha = [
				...new Uint8Array(
					await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codigo)),
				),
			]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			expect(fila?.code_hash).toBeTruthy();
			expect(fila?.code_hash).not.toContain(codigo);
			expect(fila?.code_hash).not.toBe(sha);
		});
	});

	it("sólo vale en el equipo y para el usuario que lo pidieron", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			const codigo = e.ultimoCodigo();

			expect((await e.verificar(codigo, { deviceId: "otro-equipo" })).status).toBe(400);
			expect((await e.verificar(codigo, { idUsuario: "otro-admin" })).status).toBe(400);
			expect((await e.verificar(codigo, { tenantId: "otro-negocio" })).status).toBe(400);

			// Ninguno de los intentos anteriores ha gastado el código de verdad.
			expect((await e.verificar(codigo)).status).toBe(200);
		});
	});

	it("dice cuántos intentos quedan, y agotados ni el código bueno entra", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			const codigo = e.ultimoCodigo();
			const malo = otroCodigo(codigo);

			const primero = await e.verificar(malo);
			expect(primero.status).toBe(400);
			expect(String(primero.body.message)).toContain(String(OTP_MAX_ATTEMPTS - 1));

			for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) await e.verificar(malo);

			const bueno = await e.verificar(codigo);
			expect(bueno.status).toBe(429);
			expect(bueno.body.error).toBe("too_many_attempts");
		});
	});

	it("caduca", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			const r = await e.verificar(e.ultimoCodigo(), { ahora: T0 + OTP_TTL_MS + 1 });
			expect(r.status).toBe(400);
			expect(r.body.error).toBe("code_expired");
		});
	});

	it("pedir otro deja sin valor el anterior", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			const primero = e.ultimoCodigo();

			await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + REENVIO_MIN_MS }));
			const segundo = e.ultimoCodigo();

			// Uno entre un millón pueden coincidir: entonces no hay nada que comprobar.
			if (primero !== segundo) {
				expect((await e.verificar(primero, { ahora: T0 + REENVIO_MIN_MS + 1 })).status).toBe(400);
			}
			expect((await e.verificar(segundo, { ahora: T0 + REENVIO_MIN_MS + 2 })).status).toBe(200);
		});
	});

	it("no hay forma de meter en el código algo que no sean 6 cifras", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx());
			for (const raro of ["", "12345", "1234567", "abcdef", "12 456"]) {
				expect((await e.verificar(raro)).status).toBe(400);
			}
			// Y esas entradas no gastan intentos.
			expect((await e.verificar(e.ultimoCodigo())).status).toBe(200);
		});
	});
});

describe("recuperar el PIN · el buzón del titular no es un cañón", () => {
	it("no reenvía hasta pasados cinco minutos, y dice cuánto falta", async () => {
		await escenario(async (e) => {
			expect(REENVIO_MIN_MS).toBe(5 * 60_000);

			const primero = await solicitarCodigoPin(e.db, e.env, e.ctx());
			expect(primero.status).toBe(200);
			expect(primero.body.reenvioSegundos).toBe(300);

			const pronto = await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + REENVIO_MIN_MS - 1 }));
			expect(pronto.status).toBe(429);
			expect(String(pronto.body.message)).toContain("1 minuto");
			expect(e.correos).toHaveLength(1);

			const luego = await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + REENVIO_MIN_MS }));
			expect(luego.status).toBe(200);
			expect(e.correos).toHaveLength(2);
		});
	});

	it("tiene un tope de envíos por hora, que se renueva pasada la hora", async () => {
		await escenario(async (e) => {
			for (let i = 0; i < MAX_ENVIOS_POR_VENTANA; i++) {
				const r = await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + i * REENVIO_MIN_MS }));
				expect(r.status).toBe(200);
			}

			const pasado = await solicitarCodigoPin(
				e.db,
				e.env,
				e.ctx({ ahora: T0 + MAX_ENVIOS_POR_VENTANA * REENVIO_MIN_MS }),
			);
			expect(pasado.status).toBe(429);
			expect(pasado.body.error).toBe("demasiadas_solicitudes");

			const luego = await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + VENTANA_ENVIOS_MS }));
			expect(luego.status).toBe(200);
		});
	});

	it("pedirlo para otro usuario no esquiva el tope: el código es por equipo", async () => {
		await escenario(async (e) => {
			await solicitarCodigoPin(e.db, e.env, e.ctx({ idUsuario: "admin-1" }));
			const r = await solicitarCodigoPin(e.db, e.env, e.ctx({ idUsuario: "admin-2", ahora: T0 + 1_000 }));
			expect(r.status).toBe(429);
		});
	});

	it("si el correo no sale, lo dice y no deja un código vivo ni hace esperar", async () => {
		await escenario(async (e) => {
			e.romperCorreo(true);
			const r = await solicitarCodigoPin(e.db, e.env, e.ctx());
			expect(r.status).toBe(502);
			expect((await getEmailCode(e.db, CLAVE_PIN))?.consumed_at_ms).not.toBeNull();

			e.romperCorreo(false);
			const otra = await solicitarCodigoPin(e.db, e.env, e.ctx({ ahora: T0 + 1_000 }));
			expect(otra.status).toBe(200);
		});
	});
});

describe("recuperar el PIN · aislamiento entre negocios", () => {
	it("una licencia que no es de este negocio no manda nada a nadie", async () => {
		await escenario(async (e) => {
			const r = await solicitarCodigoPin(e.db, e.env, e.ctx({ tenantId: "otro-negocio" }));
			expect(r.status).toBe(404);
			expect(e.correos).toHaveLength(0);
		});
	});

	it("sin el secreto del worker falla cerrado", async () => {
		await escenario(async (e) => {
			const sinSecreto = { ...e.env, LICENSE_JWT_SECRET: "" };
			expect((await solicitarCodigoPin(e.db, sinSecreto, e.ctx())).status).toBe(500);
			expect(e.correos).toHaveLength(0);
		});
	});
});
