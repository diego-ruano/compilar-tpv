// test/correoRecuperacion.test.ts
//
// LOGIN-08: el correo de recuperación, a dónde llegan los códigos para recuperar el PIN.
//
// Contra el esquema real del control-plane sobre el SQLite del Durable Object, como
// `recuperarPin.test.ts`. Lo que se fija es lo que haría el cambio inservible o peligroso sin que
// nada fallara a la vista: cambiarlo sin demostrar el buzón nuevo, que el dueño no se entere, que el
// código de un propósito sirva para el otro, o que recuperar el PIN siga yendo al correo viejo.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import {
	confirmarCambioCorreo,
	estadoCorreoRecuperacion,
	solicitarCambioCorreo,
	usarCorreoDeLaCompra,
	type ContextoCorreo,
} from "../src/domains/login/correoRecuperacion";
import { solicitarCodigoPin, verificarCodigoPin } from "../src/domains/login/recuperarPin";
import {
	activateLicenseFirstTime,
	getTenantRecoveryEmail,
	issueLicense,
} from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const COMPRA = "compra@bar.test";
const NUEVO = "encargado@bar.test";
const TENANT = "tenant-1";
const MAIN = "main-1";
const T0 = 1_800_000_000_000;
const MINUTO = 60_000;

type Correo = { to: string; subject: string; text: string };

type Escenario = {
	db: any;
	env: any;
	ctx: (extra?: Partial<ContextoCorreo>) => ContextoCorreo;
	correos: Correo[];
	avisos: Promise<unknown>[];
	diferir: (p: Promise<unknown>) => void;
	ultimoCodigo: () => string;
	/** Cambia el correo de recuperación de punta a punta, en el instante `ahora`. */
	cambiarA: (correo: string, ahora: number) => Promise<void>;
};

async function escenario(fn: (e: Escenario) => Promise<void>): Promise<void> {
	await enElHub("correo-recuperacion", async (hub: any) => {
		const db = clienteSobre(hub.state.storage.sql);
		prepararPlanoDeControl(hub.state.storage.sql);
		for (const tabla of ["licenses", "email_codes", "tenant_recovery_emails", "license_device_swaps"]) {
			hub.state.storage.sql.exec(`DELETE FROM ${tabla};`);
		}

		const correos: Correo[] = [];
		const env = {
			LICENSE_JWT_SECRET: "secreto-de-pruebas",
			EMAIL_FROM_ADDRESS: "tpv@altaria.test",
			EMAIL: {
				send: async (m: any) => {
					correos.push({ to: m.to, subject: m.subject, text: m.text });
				},
			},
		};

		const { license } = await issueLicense(db, {
			claves: STORE_KEY,
			termMonths: 12,
			origin: "manual",
			customerEmail: COMPRA,
		});
		await activateLicenseFirstTime(db, {
			licenseId: license.license_id,
			tenantId: TENANT,
			deviceId: MAIN,
			termMonths: 12,
		});

		const ctx = (extra: Partial<ContextoCorreo> = {}): ContextoCorreo => ({
			tenantId: TENANT,
			deviceId: MAIN,
			licHash: license.license_key_hash,
			ahora: T0,
			...extra,
		});

		const avisos: Promise<unknown>[] = [];
		const diferir = (p: Promise<unknown>) => void avisos.push(p);

		const ultimoCodigo = () => {
			const m = correos[correos.length - 1]?.text.match(/\b(\d{6})\b/);
			if (!m) throw new Error("el último correo no lleva ningún código");
			return m[1];
		};

		await fn({
			db,
			env,
			ctx,
			correos,
			avisos,
			diferir,
			ultimoCodigo,
			cambiarA: async (correo, ahora) => {
				const s = await solicitarCambioCorreo(db, env as any, { ...ctx({ ahora }), correo });
				expect(s.status).toBe(200);
				const c = await confirmarCambioCorreo(
					db,
					env as any,
					{ ...ctx({ ahora: ahora + 1_000 }), codigo: ultimoCodigo() },
					diferir,
				);
				expect(c.status).toBe(200);
				await Promise.all(avisos);
			},
		});
	});
}

const cuerpo = (r: { body: Record<string, unknown> }) =>
	r.body as { emailHint: string; esElDeLaCompra: boolean };

describe("correo de recuperación · por defecto y al cambiarlo", () => {
	it("por defecto es el de la compra, y no se enseña entero", async () => {
		await escenario(async (e) => {
			const r = await estadoCorreoRecuperacion(e.db, e.ctx());
			expect(r.status).toBe(200);
			expect(cuerpo(r).esElDeLaCompra).toBe(true);
			expect(cuerpo(r).emailHint).toMatch(/@bar\.test$/);
			expect(cuerpo(r).emailHint).not.toContain("compra");
		});
	});

	it("cambiarlo exige un código enviado al correo NUEVO, y hasta confirmarlo no cambia nada", async () => {
		await escenario(async (e) => {
			const s = await solicitarCambioCorreo(e.db, e.env, { ...e.ctx(), correo: "  Encargado@Bar.TEST " });
			expect(s.status).toBe(200);
			expect(e.correos).toHaveLength(1);
			expect(e.correos[0].to).toBe(NUEVO);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();

			const c = await confirmarCambioCorreo(
				e.db,
				e.env,
				{ ...e.ctx({ ahora: T0 + 1_000 }), codigo: e.ultimoCodigo() },
				e.diferir,
			);
			expect(c.status).toBe(200);
			expect(cuerpo(c).esElDeLaCompra).toBe(false);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBe(NUEVO);
		});
	});

	it("avisa al correo que deja de recibir los códigos y al de la compra, sin repetir", async () => {
		await escenario(async (e) => {
			await e.cambiarA(NUEVO, T0);
			// El anterior ERA el de la compra: un solo aviso.
			const primeros = e.correos.slice(1);
			expect(primeros.map((c) => c.to)).toEqual([COMPRA]);
			expect(primeros[0].subject).toContain("recuperación");

			const antes = e.correos.length;
			await e.cambiarA("tercero@bar.test", T0 + 10 * MINUTO);
			const segundos = e.correos.slice(antes + 1).map((c) => c.to).sort();
			expect(segundos).toEqual([COMPRA, NUEVO].sort());
		});
	});

	it("recuperar el PIN pasa a mandar el código al correo nuevo", async () => {
		await escenario(async (e) => {
			await e.cambiarA(NUEVO, T0);

			const r = await solicitarCodigoPin(e.db, e.env, {
				...e.ctx({ ahora: T0 + 5 * MINUTO }),
				idUsuario: "admin",
			});
			expect(r.status).toBe(200);
			expect(e.correos[e.correos.length - 1].to).toBe(NUEVO);
		});
	});

	it("cambiarlo al de la compra no guarda uno propio: vuelve a seguir al de la compra", async () => {
		await escenario(async (e) => {
			await e.cambiarA(NUEVO, T0);
			await e.cambiarA(COMPRA, T0 + 10 * MINUTO);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();
			expect(cuerpo(await estadoCorreoRecuperacion(e.db, e.ctx())).esElDeLaCompra).toBe(true);
		});
	});

	it("volver al de la compra borra el propio y avisa al que había", async () => {
		await escenario(async (e) => {
			await e.cambiarA(NUEVO, T0);
			const antes = e.correos.length;

			const r = await usarCorreoDeLaCompra(e.db, e.env, e.ctx({ ahora: T0 + MINUTO }), e.diferir);
			await Promise.all(e.avisos);

			expect(r.status).toBe(200);
			expect(cuerpo(r).esElDeLaCompra).toBe(true);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();
			expect(e.correos.slice(antes).map((c) => c.to)).toEqual([NUEVO]);
		});
	});
});

describe("correo de recuperación · lo que no se puede", () => {
	it("sin un código pedido antes, no hay cambio", async () => {
		await escenario(async (e) => {
			const r = await confirmarCambioCorreo(e.db, e.env, { ...e.ctx(), codigo: "123456" }, e.diferir);
			expect(r.status).toBe(400);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();
		});
	});

	it("no acepta un correo mal escrito", async () => {
		await escenario(async (e) => {
			for (const malo of ["no-es-un-correo", "a@b", "con espacio@bar.test"]) {
				expect((await solicitarCambioCorreo(e.db, e.env, { ...e.ctx(), correo: malo })).status).toBe(400);
			}
			expect(e.correos).toHaveLength(0);
		});
	});

	it("pedir el que ya es no manda código ni pide confirmar", async () => {
		await escenario(async (e) => {
			const mismo = await solicitarCambioCorreo(e.db, e.env, { ...e.ctx(), correo: COMPRA.toUpperCase() });
			expect(mismo.status).toBe(200);
			expect(mismo.body.sinCambios).toBe(true);
			expect(e.correos).toHaveLength(0);
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();
		});
	});

	it("un código de cambio de correo no vale para el PIN, ni uno del PIN para el correo", async () => {
		await escenario(async (e) => {
			await solicitarCambioCorreo(e.db, e.env, { ...e.ctx(), correo: NUEVO });
			const deCorreo = e.ultimoCodigo();

			const pin = await verificarCodigoPin(
				e.db,
				e.env,
				{ ...e.ctx(), idUsuario: "admin", codigo: deCorreo },
				e.diferir,
			);
			expect(pin.status).toBe(400);

			await solicitarCodigoPin(e.db, e.env, { ...e.ctx(), idUsuario: "admin" });
			const dePin = e.ultimoCodigo();
			if (dePin !== deCorreo) {
				const correo = await confirmarCambioCorreo(e.db, e.env, { ...e.ctx(), codigo: dePin }, e.diferir);
				expect(correo.status).toBe(400);
			}
			expect(await getTenantRecoveryEmail(e.db, TENANT)).toBeNull();
		});
	});

	it("otro negocio ni lo ve ni lo toca", async () => {
		await escenario(async (e) => {
			const otro = e.ctx({ tenantId: "otro-negocio" });
			expect((await estadoCorreoRecuperacion(e.db, otro)).status).toBe(404);
			expect((await solicitarCambioCorreo(e.db, e.env, { ...otro, correo: NUEVO })).status).toBe(404);
			expect((await usarCorreoDeLaCompra(e.db, e.env, otro, e.diferir)).status).toBe(404);
			expect(e.correos).toHaveLength(0);
		});
	});
});
