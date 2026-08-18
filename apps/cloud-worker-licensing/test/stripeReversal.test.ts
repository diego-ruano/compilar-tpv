// test/stripeReversal.test.ts
//
// LIC-07 — qué le pasa a una licencia cuando el dinero se va.
//
// Un reembolso lo emite el vendedor a mano y un chargeback lo pide el cliente a su banco; en
// ambos casos el cobro deja de existir y la licencia no puede seguir viva hasta caducar. Lo
// delicado no es revocar, es distinguir QUÉ se devolvió: el alta (la licencia entera se cae) o
// una renovación (solo se pierden los meses que esa compra añadió, no el año anterior que el
// cliente pagó y usó).
//
// Los casos se ejecutan contra el esquema real del control-plane, sobre el SQLite del Durable
// Object: `ensureLicensingSchema` crea las tablas de verdad y el SQL es el mismo que corre en
// Turso. Lo que NO cubre: la verificación de la firma de Stripe y el enrutado HTTP, que viven en
// el handler del webhook (y que dependen de qué eventos estén suscritos en el Dashboard).

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { revertir } from "../src/domains/stripe/stripe.routes";
import {
	activateLicenseFirstTime,
	ensureLicensingSchema,
	extendLicense,
	getLicenseById,
	issueLicense,
	recordLicensePayment,
	type LicenseRow,
} from "../src/server/licenseStore";

/** Clave AES de pruebas (32 bytes) para el cifrado de la clave de licencia. */
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const PI_ALTA = "pi_alta";
const PI_RENOVACION = "pi_renovacion";
const CUSTOMER = "cus_de_pruebas";

const cargoDevuelto = (paymentIntent: string, total = 12000, devuelto = 12000) => ({
	type: "charge.refunded",
	id: `evt_${paymentIntent}`,
	data: {
		object: {
			object: "charge",
			payment_intent: paymentIntent,
			customer: CUSTOMER,
			amount: total,
			amount_refunded: devuelto,
		},
	},
});

const disputa = (paymentIntent: string, tipo: "created" | "closed", status = "warning_needs_response") => ({
	type: `charge.dispute.${tipo}`,
	id: `evt_disputa_${tipo}_${paymentIntent}`,
	data: {
		object: {
			object: "dispute",
			payment_intent: paymentIntent,
			customer: CUSTOMER,
			status,
		},
	},
});

type Escenario = {
	/** Licencia recién comprada y activada, con su cobro de alta registrado. */
	licenciaActivada: () => Promise<LicenseRow>;
	/** Le añade una renovación de 12 meses (cobro aparte). */
	renovar: (licenseId: string) => Promise<number>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	db: any;
};

/**
 * Todos los escenarios comparten un mismo Durable Object y se limpian las filas entre casos.
 *
 * No es capricho: `ensureLicensingSchema` recuerda en una variable de módulo que ya creó las
 * tablas (una vez por isolate, que en producción es lo correcto porque el control-plane es uno
 * solo). Con un DO por test, el segundo se encontraría el flag puesto y la base vacía.
 */
async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("lic07", async (hub: any) => {
		const db = clienteSobre(hub.state.storage.sql);
		await ensureLicensingSchema(db);
		for (const tabla of ["licenses", "license_payments", "admin_audit"]) {
			hub.state.storage.sql.exec(`DELETE FROM ${tabla};`);
		}

		const e: Escenario = {
			db,
			async licenciaActivada() {
				const { license } = await issueLicense(db, {
					storeKeyB64: STORE_KEY,
					termMonths: 12,
					origin: "stripe",
					customerEmail: "bar@ejemplo.test",
					stripeCustomerId: CUSTOMER,
					stripeCheckoutSessionId: "cs_alta",
					stripePaymentIntentId: PI_ALTA,
				});
				await recordLicensePayment(db, {
					licenseId: license.license_id,
					kind: "issue",
					termMonths: 12,
					sessionId: "cs_alta",
					paymentIntentId: PI_ALTA,
				});
				await activateLicenseFirstTime(db, {
					licenseId: license.license_id,
					tenantId: "tenant-1",
					deviceId: "device-main",
					termMonths: 12,
				});
				return (await getLicenseById(db, license.license_id))!;
			},
			async renovar(licenseId: string) {
				const expiresAt = await extendLicense(db, licenseId, 12);
				await recordLicensePayment(db, {
					licenseId,
					kind: "renewal",
					termMonths: 12,
					sessionId: "cs_renovacion",
					paymentIntentId: PI_RENOVACION,
				});
				return expiresAt;
			},
			async leer(licenseId: string) {
				return (await getLicenseById(db, licenseId))!;
			},
		};

		return fn(e);
	});
}

describe("LIC-07 · reembolsos", () => {
	it("devolver el alta revoca la licencia", async () => {
		const estado = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			await revertir(e.db, cargoDevuelto(PI_ALTA));
			return e.leer(lic.license_id);
		});

		expect(estado.status).toBe("revoked");
		expect(estado.disabled).toBe(1);
	});

	it("devolver una renovación solo quita los meses que añadió", async () => {
		const { antes, despues, estado } = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			const antes = lic.expires_at_ms!;
			await e.renovar(lic.license_id);

			await revertir(e.db, cargoDevuelto(PI_RENOVACION));

			const final = await e.leer(lic.license_id);
			return { antes, despues: final.expires_at_ms!, estado: final };
		});

		// Vuelve a la caducidad que tenía antes de renovar, y sigue trabajando.
		expect(despues).toBe(antes);
		expect(estado.status).toBe("active");
		expect(estado.disabled).toBe(0);
	});

	it("un reembolso parcial no toca la licencia", async () => {
		const { estado, resultado } = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			const resultado = await revertir(e.db, cargoDevuelto(PI_ALTA, 12000, 3000));
			return { estado: await e.leer(lic.license_id), resultado };
		});

		expect(resultado.reason).toBe("partial_refund");
		expect(estado.status).toBe("active");
	});

	it("un cargo que no se puede atribuir no revoca nada", async () => {
		const { estado, resultado } = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			// Otro PaymentIntent y otro cliente: no hay a quién imputarlo.
			const evento = cargoDevuelto("pi_desconocido");
			(evento.data.object as any).customer = "cus_otro";

			const resultado = await revertir(e.db, evento);
			return { estado: await e.leer(lic.license_id), resultado };
		});

		expect(resultado.reversed).toBe(false);
		expect(resultado.reason).toBe("unresolved_license");
		expect(estado.status).toBe("active");
	});

	it("no se revierte dos veces el mismo cobro", async () => {
		const segundo = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			await e.renovar(lic.license_id);

			await revertir(e.db, cargoDevuelto(PI_RENOVACION));
			const trasPrimero = (await e.leer(lic.license_id)).expires_at_ms;

			// Stripe reintenta y la disputa puede traer un segundo evento del mismo cargo.
			const resultado = await revertir(e.db, cargoDevuelto(PI_RENOVACION));

			return { resultado, trasPrimero, trasSegundo: (await e.leer(lic.license_id)).expires_at_ms };
		});

		expect(segundo.resultado.reason).toBe("already_reversed");
		expect(segundo.trasSegundo).toBe(segundo.trasPrimero);
	});
});

describe("LIC-07 · chargebacks", () => {
	it("abrir la disputa corta el servicio", async () => {
		const estado = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			await revertir(e.db, disputa(PI_ALTA, "created"));
			return e.leer(lic.license_id);
		});

		expect(estado.status).toBe("revoked");
	});

	it("ganar la disputa lo devuelve todo", async () => {
		const estado = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			await revertir(e.db, disputa(PI_ALTA, "created"));
			await revertir(e.db, disputa(PI_ALTA, "closed", "won"));
			return e.leer(lic.license_id);
		});

		expect(estado.status).toBe("active");
		expect(estado.disabled).toBe(0);
	});

	it("perder la disputa deja la licencia revocada", async () => {
		const estado = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			await revertir(e.db, disputa(PI_ALTA, "created"));
			await revertir(e.db, disputa(PI_ALTA, "closed", "lost"));
			return e.leer(lic.license_id);
		});

		expect(estado.status).toBe("revoked");
	});

	it("ganar la disputa de una renovación devuelve sus meses", async () => {
		const { conRenovacion, final } = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			const conRenovacion = await e.renovar(lic.license_id);

			await revertir(e.db, disputa(PI_RENOVACION, "created"));
			await revertir(e.db, disputa(PI_RENOVACION, "closed", "won"));

			return { conRenovacion, final: (await e.leer(lic.license_id)).expires_at_ms! };
		});

		expect(final).toBe(conRenovacion);
	});
});
