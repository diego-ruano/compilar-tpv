// test/trasladoCierraSocket.test.ts
//
// AUD-02 · Quitarle la licencia a una Main se lo dice también al `TenantHub`.
//
// El traslado de la licencia a otro equipo sólo cambiaba `licenses.main_device_id`, y el reembolso
// o la disputa de un alta sólo anulaban la licencia: en los dos casos REST ya rechazaba al equipo,
// pero nadie avisaba al `TenantHub`, y por el socket que tenía abierto seguía siendo la Main del
// negocio. Ahora las tres rutas que cambian la licencia (estas dos y la anulación desde la
// administración, `adminLicenciaReversible.test.ts`) le piden que vuelva a leer quién es la Main
// (`releerMain`), sin nombrar a quién echar, y después de cambiarla. Aquí se fija eso, y lo que
// contesta la consulta con la que el `TenantHub` sabe quién es la Main (`mainDeLaLicencia`),
// contra el esquema de producción de la base central.
//
// Mismo arnés que `licenciaTraslado.test.ts`: el plano de control real sobre el SQLite de un DO, el
// aprovisionamiento y los correos sustituidos, y un `TenantHub` de mentira que anota lo que se le
// pide. Lo que el DO hace con ese aviso está en `mainDesplazadaSocket.test.ts`.

import { describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { mainDeLaLicencia } from "../src/durableObjects/tenantHub.identidad";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { otpHash } from "../src/domains/licensing/licensing.helpers";
import { licenseKeyHash, normalizeLicenseKey } from "../src/domains/licensing/licenseKey";
import { stripeRoutes } from "../src/domains/stripe/stripe.routes";
import { vetoDeLicencia } from "../src/lib/licenciaEnUso";
import {
	activateLicenseFirstTime,
	extendLicense,
	getLicenseById,
	issueLicense,
	putDeviceOtp,
	reactivateLicense,
	recordLicensePayment,
	revokeLicense,
} from "../src/server/licenseStore";

let dbDePruebas: unknown = null;

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
		sendDeviceChangeCodeEmail: async () => {},
		sendDeviceChangedNoticeEmail: async () => {},
	};
});

/**
 * Un aviso al `TenantHub`, con lo que leería el DO en ese momento de la base central: quién es la
 * Main de la licencia viva del negocio (`mainDeLaLicencia`).
 */
type Llamada = {
	nombreDO: string;
	aviso: "releerMain" | "revocarDispositivo";
	/** El argumento del RPC: el negocio en `releerMain`, el dispositivo en `revocarDispositivo`. */
	arg: string;
	mainEntonces: string | null;
};

/**
 * Un `TenantHub` de mentira que anota lo que se le pide, como el de
 * `adminLicenciaReversible.test.ts`. Anota además lo que la base central dice ya de la licencia: el
 * aviso tiene que ir después del cambio, o el DO leería lo de antes.
 */
function hubDeMentira() {
	const llamadas: Llamada[] = [];
	let roto = false;
	const anotar = async (nombre: string, aviso: Llamada["aviso"], arg: string) => {
		if (roto) throw new Error("el DO no contesta");
		llamadas.push({ nombreDO: nombre, aviso, arg, mainEntonces: await mainDeLaLicencia(dbDePruebas as any, nombre) });
	};
	const ns = {
		idFromName: (nombre: string) => ({ nombre }),
		get: ({ nombre }: { nombre: string }) => ({
			releerMain: (tenantId: string) => anotar(nombre, "releerMain", tenantId),
			revocarDispositivo: (deviceId: string) => anotar(nombre, "revocarDispositivo", deviceId),
		}),
	};
	return { ns, llamadas, romper: () => (roto = true) };
}

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const PUB_A = await clavePublica(1);
const PUB_B = await clavePublica(2);
const CONTEXTO = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
const SECRETO_DEL_WEBHOOK = "whsec_de_pruebas";

type Escenario = {
	sql: any;
	env: any;
	hub: ReturnType<typeof hubDeMentira>;
};

async function escenario<T>(nombre: string, prueba: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub(`aud02-rutas-${nombre}`, async (do_: any) => {
		const sql = do_.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of [
			"licenses",
			"license_payments",
			"devices",
			"tenants",
			"license_device_otp",
			"license_device_swaps",
			"webhook_events",
			"admin_audit",
		]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}
		dbDePruebas = clienteSobre(sql, do_.state.storage);

		const hub = hubDeMentira();
		const env = {
			LICENSE_JWT_SECRET: "secreto-de-pruebas",
			LICENSE_STORE_KEY: STORE_KEY,
			TURSO_DATABASE_URL: "libsql://no-se-usa",
			TURSO_AUTH_TOKEN: "no-se-usa",
			STRIPE_SECRET_KEY: "sk_de_pruebas",
			STRIPE_WEBHOOK_SECRET: SECRETO_DEL_WEBHOOK,
			TenantHub: hub.ns,
		};
		return prueba({ sql, env, hub });
	});
}

/**
 * La única llamada a `/v1/license/activate` de este fichero: lo que cambie en lo que exige la ruta
 * (AUD-01) se adapta aquí.
 */
async function activar(env: any, clave: string, deviceId: string, devicePubKey: string, deviceChangeCode?: string) {
	const res = await licenseRoutes.request(
		"/activate",
		await activacionFirmada({
			activationKey: clave,
			deviceId,
			devicePubKey,
			deviceChangeCode,
			tenantInfo: { displayName: "Bar de Pruebas" },
		}),
		env,
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

/** Emite una licencia, la activa en `equipo-a` y deja pedido el código para trasladarla a `equipo-b`. */
async function licenciaEnEquipoA(e: Escenario) {
	const { license, keyPlain } = await issueLicense(dbDePruebas as any, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "manual",
		customerEmail: "bar@ejemplo.test",
	});

	const a = await activar(e.env, keyPlain, "equipo-a", PUB_A);
	expect(a.status).toBe(200);

	await putDeviceOtp(dbDePruebas as any, {
		licenseId: license.license_id,
		newDeviceId: "equipo-b",
		codeHash: await otpHash("654321"),
		expiresAtMs: Date.now() + 10 * 60 * 1000,
	});
	return { licenseId: license.license_id, clave: keyPlain, tenantId: a.body.tenantId as string };
}

describe("AUD-02 · el traslado retira al equipo anterior del TenantHub", () => {
	it("pide al TenantHub de su negocio que relea quién es la Main, con la licencia ya cambiada", async () => {
		await escenario("traslado", async (e) => {
			const { licenseId, clave, tenantId } = await licenciaEnEquipoA(e);
			// Activar por primera vez no avisa: no había Main anterior.
			expect(e.hub.llamadas).toEqual([]);

			const b = await activar(e.env, clave, "equipo-b", PUB_B, "654321");
			expect(b.status).toBe(200);
			expect(b.body.cambioDeEquipo).toBe(true);
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.main_device_id).toBe("equipo-b");

			// No nombra a quién echar: el hub lee la Main de ahora y echa a la que no lo sea.
			expect(e.hub.llamadas).toEqual([{ nombreDO: tenantId, aviso: "releerMain", arg: tenantId, mainEntonces: "equipo-b" }]);

			// REST (tenantAuth → vetoDeLicencia) lo rechaza como Main desplazada, también el ticket
			// con el que reconectaría, y el TenantHub ve lo mismo cuando lee quién es la Main.
			const licHash = await licenseKeyHash(normalizeLicenseKey(clave)!);
			const contexto = (deviceId: string) => ({
				env: e.env,
				get: (k: "tenantId" | "deviceId" | "licHash") => ({ tenantId, deviceId, licHash })[k],
			});
			expect(await vetoDeLicencia(contexto("equipo-a"), { sinCache: true })).toBe("device_replaced");
			expect(await vetoDeLicencia(contexto("equipo-b"), { sinCache: true })).toBeNull();
			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBe("equipo-b");
		});
	});

	it("volver a activar en el mismo equipo no avisa", async () => {
		await escenario("mismo-equipo", async (e) => {
			const { clave } = await licenciaEnEquipoA(e);

			const otraVez = await activar(e.env, clave, "equipo-a", PUB_A);
			expect(otraVez.status).toBe(200);
			expect(otraVez.body.cambioDeEquipo).toBe(false);
			expect(e.hub.llamadas).toEqual([]);
		});
	});

	it("un código incorrecto no traslada ni avisa", async () => {
		await escenario("codigo-malo", async (e) => {
			const { licenseId, clave } = await licenciaEnEquipoA(e);

			const b = await activar(e.env, clave, "equipo-b", PUB_B, "000000");
			expect(b.status).toBe(401);
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.main_device_id).toBe("equipo-a");
			expect(e.hub.llamadas).toEqual([]);
		});
	});

	it("si el TenantHub no contesta, el traslado se completa igual", async () => {
		// El aviso es best-effort: lo que manda es la licencia. El TenantHub echa al equipo anterior
		// cuando salude el nuevo o en cuanto haya actividad en el negocio.
		await escenario("hub-roto", async (e) => {
			const { licenseId, clave } = await licenciaEnEquipoA(e);
			e.hub.romper();

			const b = await activar(e.env, clave, "equipo-b", PUB_B, "654321");
			expect(b.status).toBe(200);
			expect(b.body.cambioDeEquipo).toBe(true);
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.main_device_id).toBe("equipo-b");
		});
	});
});

describe("AUD-02 · quién es la Main de un negocio para el TenantHub", () => {
	it("la de una licencia anulada no lo es, y vuelve a serlo si se deshace la anulación", async () => {
		await escenario("anulada", async (e) => {
			const { licenseId, tenantId } = await licenciaEnEquipoA(e);
			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBe("equipo-a");

			await revokeLicense(dbDePruebas as any, licenseId);
			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBeNull();

			await reactivateLicense(dbDePruebas as any, licenseId);
			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBe("equipo-a");
		});
	});

	it("la caducidad no cuenta: caducar no cierra el socket", async () => {
		await escenario("caducada", async (e) => {
			const { licenseId, tenantId } = await licenciaEnEquipoA(e);
			e.sql.exec("UPDATE licenses SET expires_at_ms = ? WHERE license_id = ?;", Date.now() - 30 * 86_400_000, licenseId);

			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBe("equipo-a");
		});
	});

	it("la Main de otro negocio no lo es de éste", async () => {
		await escenario("ajena", async (e) => {
			const { tenantId } = await licenciaEnEquipoA(e);

			expect(await mainDeLaLicencia(dbDePruebas as any, tenantId)).toBe("equipo-a");
			expect(await mainDeLaLicencia(dbDePruebas as any, "otro-negocio")).toBeNull();
		});
	});
});

// ── Stripe ────────────────────────────────────────────────────────────────────

const PI_ALTA = "pi_alta";
const PI_RENOVACION = "pi_renovacion";

/** El webhook tal y como lo manda Stripe: el cuerpo crudo y su firma HMAC-SHA256. */
async function webhook(env: any, evento: unknown) {
	const crudo = JSON.stringify(evento);
	const t = Math.floor(Date.now() / 1000);
	const clave = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRETO_DEL_WEBHOOK),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${crudo}`));
	const v1 = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

	const res = await stripeRoutes.request(
		"/webhook",
		{ method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body: crudo },
		env,
		CONTEXTO as any,
	);
	return { status: res.status, body: (await res.json()) as any };
}

const cargoDevuelto = (paymentIntent: string) => ({
	type: "charge.refunded",
	id: `evt_devuelto_${paymentIntent}`,
	data: { object: { object: "charge", id: "ch_1", payment_intent: paymentIntent, amount: 12000, amount_refunded: 12000 } },
});

const disputaAbierta = (paymentIntent: string) => ({
	type: "charge.dispute.created",
	id: `evt_disputa_${paymentIntent}`,
	data: { object: { object: "dispute", id: "dp_1", payment_intent: paymentIntent, status: "warning_needs_response" } },
});

/** Una licencia comprada por Stripe, con su cobro de alta, activada o no. */
async function licenciaDeStripe(e: Escenario, activada: boolean) {
	const { license } = await issueLicense(dbDePruebas as any, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "stripe",
		customerEmail: "bar@ejemplo.test",
		stripeCheckoutSessionId: "cs_alta",
		stripePaymentIntentId: PI_ALTA,
	});
	await recordLicensePayment(dbDePruebas as any, {
		licenseId: license.license_id,
		kind: "issue",
		termMonths: 12,
		sessionId: "cs_alta",
		paymentIntentId: PI_ALTA,
	});
	if (activada) {
		await activateLicenseFirstTime(dbDePruebas as any, {
			licenseId: license.license_id,
			tenantId: "negocio-1",
			deviceId: "device-main",
			termMonths: 12,
		});
	}
	return license.license_id;
}

describe("AUD-02 · el reembolso o la disputa de un alta avisan al TenantHub", () => {
	it("devolver el alta anula la licencia y pide al TenantHub que relea quién es la Main", async () => {
		await escenario("reembolso", async (e) => {
			const licenseId = await licenciaDeStripe(e, true);

			const r = await webhook(e.env, cargoDevuelto(PI_ALTA));
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ ok: true, reversed: true, accion: "revoked" });
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.status).toBe("revoked");
			// Con la licencia ya anulada: lo que lea el hub es que no hay Main.
			expect(e.hub.llamadas).toEqual([{ nombreDO: "negocio-1", aviso: "releerMain", arg: "negocio-1", mainEntonces: null }]);

			// El reintento de Stripe no vuelve a pedirlo.
			const otraVez = await webhook(e.env, cargoDevuelto(PI_ALTA));
			expect(otraVez.status).toBe(200);
			expect(e.hub.llamadas.length).toBe(1);
		});
	});

	it("abrir una disputa sobre el alta, igual", async () => {
		await escenario("disputa", async (e) => {
			await licenciaDeStripe(e, true);

			const r = await webhook(e.env, disputaAbierta(PI_ALTA));
			expect(r.status).toBe(200);
			// Con la licencia ya anulada: lo que lea el hub es que no hay Main.
			expect(e.hub.llamadas).toEqual([{ nombreDO: "negocio-1", aviso: "releerMain", arg: "negocio-1", mainEntonces: null }]);
		});
	});

	it("devolver una renovación no avisa: la licencia sigue valiendo", async () => {
		await escenario("renovacion", async (e) => {
			const licenseId = await licenciaDeStripe(e, true);
			await extendLicense(dbDePruebas as any, licenseId, 12);
			await recordLicensePayment(dbDePruebas as any, {
				licenseId,
				kind: "renewal",
				termMonths: 12,
				sessionId: "cs_renovacion",
				paymentIntentId: PI_RENOVACION,
			});

			const r = await webhook(e.env, cargoDevuelto(PI_RENOVACION));
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ reversed: true, accion: "shortened" });
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.status).toBe("active");
			expect(e.hub.llamadas).toEqual([]);
		});
	});

	it("una licencia que no llegó a activarse no tiene negocio al que avisar", async () => {
		await escenario("sin-activar", async (e) => {
			const licenseId = await licenciaDeStripe(e, false);

			const r = await webhook(e.env, cargoDevuelto(PI_ALTA));
			expect(r.status).toBe(200);
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.status).toBe("revoked");
			expect(e.hub.llamadas).toEqual([]);
		});
	});

	it("si el TenantHub no contesta, la reversión queda hecha y Stripe recibe su 200", async () => {
		await escenario("stripe-hub-roto", async (e) => {
			const licenseId = await licenciaDeStripe(e, true);
			e.hub.romper();

			const r = await webhook(e.env, cargoDevuelto(PI_ALTA));
			expect(r.status).toBe(200);
			expect((await getLicenseById(dbDePruebas as any, licenseId))?.status).toBe("revoked");
			const evento = e.sql.exec("SELECT processed_ok FROM webhook_events;").toArray();
			expect(evento).toEqual([{ processed_ok: 1 }]);
		});
	});
});
