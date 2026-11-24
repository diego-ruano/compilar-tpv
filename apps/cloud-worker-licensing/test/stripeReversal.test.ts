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
// Los casos se ejecutan contra la base central de verdad (`helpers/central.ts`): la compra la emite
// `cumplir` y la renovación es el canje de una segunda clave, como en producción. Lo que NO cubre: la
// verificación de la firma de Stripe y el enrutado HTTP, que viven en el handler del webhook (y que
// dependen de qué eventos estén suscritos en el Dashboard).

import { describe, it, expect } from "vitest";

import { centralDePrueba, conFalloEnLasOperaciones, type CentralDePrueba } from "./helpers/central";
import { cumplir, revertir } from "../src/domains/stripe/stripe.routes";
import type { ClienteCentral } from "../src/server/central/cliente";
import { activateLicenseFirstTime, getLicenseById, type LicenseRow } from "../src/server/licenseStore";

/** Clave AES de pruebas (32 bytes) para el cifrado de la clave de licencia. */
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const PI_ALTA = "pi_alta";
const PI_RENOVACION = "pi_renovacion";
const CUSTOMER = "cus_de_pruebas";

/** Sin `EMAIL_FROM_ADDRESS` el correo no sale: el cobro sigue igual. */
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

/** Una sesión de checkout pagada de una licencia anual, cobrada con `paymentIntent`. */
const sesion = (id: string, paymentIntent: string) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: paymentIntent,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: "12" } } }] },
});

/** Compra una licencia anual y devuelve su id. */
async function comprar(db: ClienteCentral, id: string, paymentIntent: string): Promise<string> {
	const r = await cumplir(ENV, db, sesion(id, paymentIntent));
	if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
	return r.license_ids[0];
}

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

// Una disputa FORMAL: una consulta del banco (`warning_*`) no toca la licencia (AUD-45).
const disputa = (paymentIntent: string, tipo: "created" | "closed", status = "needs_response") => ({
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
	/** Le añade una renovación de 12 meses: otra compra, canjeada sobre ella (su cobro pasa a renovación). */
	renovar: (licenseId: string) => Promise<number>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	central: CentralDePrueba;
	db: ClienteCentral;
};

/** Cada escenario, con una base central nueva. */
async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const db = central.db;

	const e: Escenario = {
		central,
		db,
		async licenciaActivada() {
			const licenseId = await comprar(db, "cs_alta", PI_ALTA);
			await activateLicenseFirstTime(db, {
				licenseId,
				tenantId: "tenant-1",
				deviceId: "device-main",
				termMonths: 12,
			});
			return (await getLicenseById(db, licenseId))!;
		},
		async renovar(licenseId: string) {
			const clave = await comprar(db, "cs_renovacion", PI_RENOVACION);
			const canje = await db.operar("canjearClave", {
				claveId: clave,
				licenciaId: licenseId,
				deviceId: "device-main",
				meses: 12,
				ahoraMs: Date.now(),
			});
			if (canje.resultado !== "sumado") throw new Error(`canje inesperado: ${canje.resultado}`);
			return canje.expiresAtMs;
		},
		async leer(licenseId: string) {
			return (await getLicenseById(db, licenseId))!;
		},
	};

	return fn(e);
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

describe("REV-01 · un fallo a mitad de una reversión no la aplica dos veces", () => {
	it("devolver una renovación: si falla marcar el cobro no se restan meses, y el reintento los resta una vez", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			const antes = lic.expires_at_ms!;
			const conRenovacion = await e.renovar(lic.license_id);

			const conFallo = conFalloEnLasOperaciones(e.central, /UPDATE license_payments/).db;
			const error = await revertir(conFallo, cargoDevuelto(PI_RENOVACION)).catch((err) => err);
			const trasFallo = (await e.leer(lic.license_id)).expires_at_ms;

			await revertir(e.db, cargoDevuelto(PI_RENOVACION));
			return { antes, conRenovacion, error, trasFallo, final: (await e.leer(lic.license_id)).expires_at_ms };
		});

		expect(String(r.error?.message)).toMatch(/fallo_simulado/);
		expect(r.trasFallo).toBe(r.conRenovacion);
		expect(r.final).toBe(r.antes);
	});

	it("ganar la disputa de una renovación: si falla limpiar la marca no se suman meses, y el reintento los suma una vez", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.licenciaActivada();
			const conRenovacion = await e.renovar(lic.license_id);
			await revertir(e.db, disputa(PI_RENOVACION, "created"));
			const recortada = (await e.leer(lic.license_id)).expires_at_ms;

			const conFallo = conFalloEnLasOperaciones(e.central, /UPDATE license_payments/).db;
			const error = await revertir(conFallo, disputa(PI_RENOVACION, "closed", "won")).catch((err) => err);
			const trasFallo = (await e.leer(lic.license_id)).expires_at_ms;

			await revertir(e.db, disputa(PI_RENOVACION, "closed", "won"));
			return { conRenovacion, recortada, error, trasFallo, final: (await e.leer(lic.license_id)).expires_at_ms };
		});

		expect(String(r.error?.message)).toMatch(/fallo_simulado/);
		expect(r.trasFallo).toBe(r.recortada);
		expect(r.final).toBe(r.conRenovacion);
	});
});
