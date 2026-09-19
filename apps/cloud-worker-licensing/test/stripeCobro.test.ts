// test/stripeCobro.test.ts
//
// REV-01 — un pago de Stripe se convierte en licencia UNA vez, aunque haya que reintentarlo.
//
// El fallo: un webhook que fallaba contestaba 500 para que Stripe reintentara, pero el reintento
// encontraba el evento ya registrado y contestaba «ya procesado» sin hacer nada. El cliente había
// pagado y no tenía clave. Arreglarlo sólo ahí abría el problema contrario: las escrituras del
// cobro iban sueltas, y un reintento tras un fallo a mitad sumaba los meses dos veces. Aquí se
// prueban las dos mitades: que el reintento se procesa y que lo hace exactamente una vez.
//
// Corre contra el esquema real del control-plane (`helpers/planoDeControl.ts`), índice único de
// `license_payments` incluido. Lo que NO cubre: la firma de Stripe ni la lectura de la sesión por
// HTTP, que viven en el handler; `cumplir` recibe la sesión ya leída.

import { describe, it, expect } from "vitest";

import { clienteSobre, conFalloSimulado } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { cumplir } from "../src/domains/stripe/stripe.routes";
import {
	activateLicenseFirstTime,
	getLicenseById,
	markWebhookProcessed,
	upsertWebhookEvent,
	type LicenseRow,
} from "../src/server/licenseStore";

/** Clave AES de pruebas (32 bytes) para el cifrado de la clave de licencia. */
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** Sin `EMAIL_FROM_ADDRESS` el correo no sale: devuelve `false` y el cobro sigue, como en producción. */
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

const CUSTOMER = "cus_de_pruebas";

/** Una sesión de checkout pagada, con la forma que devuelve la API de Stripe. */
const sesion = (id: string, meses = 12) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: `pi_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: String(meses) } } }] },
});

/**
 * Una sesión de RENOVACIÓN (REV-13). Se distingue de la de alta en dos cosas, y hacen falta las
 * dos: el Price lleva `metadata.intent = renewal` —QUE es una renovación— y el enlace lleva el
 * `license_id` en `client_reference_id` —CUÁL renueva—. Antes no hacía falta ninguna: bastaba con
 * que el cliente de Stripe ya tuviera una licencia viva, que es el bug.
 */
const sesionRenovacion = (id: string, licenseId: string, meses = 12) => ({
	...sesion(id, meses),
	client_reference_id: licenseId,
	line_items: {
		data: [
			{
				price: {
					id: "price_renovacion",
					metadata: { term_months: String(meses), intent: "renewal" },
				},
			},
		],
	},
});

type Escenario = {
	db: any;
	sql: any;
	/** Compra y activa la licencia del cliente (el alta por Stripe, cumplida). */
	licenciaActivada: () => Promise<LicenseRow>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	contar: (tabla: string) => number;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("rev01-cobro", async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "license_payments", "admin_audit", "webhook_events"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}

		const e: Escenario = {
			db,
			sql,
			async licenciaActivada() {
				const r = await cumplir(ENV, db, sesion("cs_alta"));
				if (r.accion !== "emitida") throw new Error(`alta inesperada: ${r.accion}`);
				await activateLicenseFirstTime(db, {
					licenseId: r.license_id,
					tenantId: "tenant-1",
					deviceId: "device-main",
					termMonths: 12,
				});
				return (await getLicenseById(db, r.license_id))!;
			},
			async leer(licenseId) {
				return (await getLicenseById(db, licenseId))!;
			},
			contar(tabla) {
				return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).toArray()[0].n);
			},
		};

		return fn(e);
	});
}

const evento = (id: string) => ({
	event_uid: id,
	event_name: "checkout.session.completed",
	resource_type: "checkout.session",
	resource_id: "cs_x",
	sig_hex: null,
	body_sha256: "0",
	payload_json: "{}",
});

describe("REV-01 · el reintento de un evento", () => {
	it("un evento nuevo se procesa", async () => {
		const r = await escenario((e) => upsertWebhookEvent(e.db, evento("evt_1")));
		expect(r.already).toBe(false);
	});

	it("un evento que FALLÓ se vuelve a procesar cuando Stripe lo reintenta", async () => {
		const r = await escenario(async (e) => {
			await upsertWebhookEvent(e.db, evento("evt_1"));
			await markWebhookProcessed(e.db, "evt_1", false, "turso caído");
			return upsertWebhookEvent(e.db, evento("evt_1"));
		});
		expect(r.already).toBe(false);
	});

	it("un evento que salió bien no se repite", async () => {
		const r = await escenario(async (e) => {
			await upsertWebhookEvent(e.db, evento("evt_1"));
			await markWebhookProcessed(e.db, "evt_1", true);
			return upsertWebhookEvent(e.db, evento("evt_1"));
		});
		expect(r.already).toBe(true);
	});
});

describe("REV-01 · una sesión se cumple una sola vez", () => {
	it("el alta emite una licencia y repetirla no emite otra", async () => {
		const r = await escenario(async (e) => {
			const primera = await cumplir(ENV, e.db, sesion("cs_alta"));
			const segunda = await cumplir(ENV, e.db, sesion("cs_alta"));
			return { primera, segunda, licencias: e.contar("licenses"), cobros: e.contar("license_payments") };
		});

		expect(r.primera.accion).toBe("emitida");
		expect(r.segunda.accion).toBe("ya_cumplida");
		expect(r.licencias).toBe(1);
		expect(r.cobros).toBe(1);
	});

	it("una segunda compra del mismo cliente emite OTRA clave (REV-13)", async () => {
		// Antes el webhook adivinaba: si ese cliente de Stripe ya tenía una licencia viva, la
		// compra nueva se la EXTENDÍA. O sea que comprar con los mismos datos era lo que disparaba
		// la renovación, y el dueño de un segundo local pagaba y no recibía clave. Ahora el
		// webhook no decide nada: emite. Lo que convierte una clave en tiempo añadido es
		// teclearla en un equipo que ya tiene licencia, y eso pasa al activar.
		const r = await escenario(async (e) => {
			const primera = await e.licenciaActivada();
			const segunda = await cumplir(ENV, e.db, sesion("cs_segundo_local"));
			return {
				primera,
				segunda,
				licencias: e.contar("licenses"),
				primeraFinal: await e.leer(primera.license_id),
			};
		});

		expect(r.segunda.accion).toBe("emitida");
		expect(r.licencias).toBe(2);
		// Y a la del primer local no se le ha tocado ni un día.
		expect(r.primeraFinal.expires_at_ms).toBe(r.primera.expires_at_ms);
	});

	it("la base rechaza dos cobros con la misma sesión", async () => {
		// Si dos entregas se cruzan y las dos pasan la comprobación, la segunda revienta aquí y su
		// transacción entera se deshace.
		await escenario(async (e) => {
			const insertar = (id: string) =>
				e.sql.exec(
					`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
					   stripe_checkout_session_id, stripe_payment_intent_id, at_ms)
					 VALUES (?, 'lic', 'renewal', 12, 'cs_dup', 'pi_dup', 0);`,
					id,
				);
			insertar("p1");
			expect(() => insertar("p2")).toThrow(/UNIQUE/i);
		});
	});
});

describe("REV-01 · un fallo a mitad no deja nada a medias", () => {
	it("alta: si falla el registro del cobro no queda licencia, y el reintento emite una", async () => {
		const r = await escenario(async (e) => {
			const conFallo = conFalloSimulado(e.db, /INSERT INTO license_payments/);
			const error = await cumplir(ENV, conFallo, sesion("cs_alta")).catch((err) => err);
			const licenciasTrasFallo = e.contar("licenses");

			const reintento = await cumplir(ENV, e.db, sesion("cs_alta"));
			return {
				error,
				licenciasTrasFallo,
				reintento,
				licencias: e.contar("licenses"),
				cobros: e.contar("license_payments"),
			};
		});

		expect(String(r.error?.message)).toBe("fallo_simulado");
		// Sin esto, el reintento vería la sesión sellada en `licenses` y saldría sin registrar el
		// cobro: un reembolso posterior no sabría qué fue y revocaría a ciegas.
		expect(r.licenciasTrasFallo).toBe(0);
		expect(r.reintento.accion).toBe("emitida");
		expect(r.licencias).toBe(1);
		expect(r.cobros).toBe(1);
	});
});
