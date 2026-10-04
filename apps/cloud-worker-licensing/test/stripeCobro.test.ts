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
import { cumplir, revertir } from "../src/domains/stripe/stripe.routes";
import { MAX_LICENCIAS_POR_COMPRA } from "../src/domains/stripe/stripe.helpers";
import {
	activateLicenseFirstTime,
	canjearLicencia,
	extendLicense,
	getLicenseById,
	reasignarCobrosDeLaClave,
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
				const [licenseId] = r.license_ids;
				await activateLicenseFirstTime(db, {
					licenseId,
					tenantId: "tenant-1",
					deviceId: "device-main",
					termMonths: 12,
				});
				return (await getLicenseById(db, licenseId))!;
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


/* ============================================================
   RI-52 · Una compra de varias unidades
============================================================ */

/** Una sesión con varias líneas: `[meses, cantidad]` por línea, como la devuelve Stripe. */
const sesionVarias = (id: string, lineas: [number, number][]) => ({
	...sesion(id),
	line_items: {
		data: lineas.map(([meses, quantity], i) => ({
			quantity,
			price: { id: `price_${i}`, metadata: { term_months: String(meses) } },
		})),
	},
});

const reembolso = (paymentIntent: string, total = 36000, devuelto = 36000) => ({
	type: "charge.refunded",
	id: `evt_reembolso_${paymentIntent}_${devuelto}`,
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

const disputa = (paymentIntent: string, tipo: "created" | "closed", status = "needs_response") => ({
	type: `charge.dispute.${tipo}`,
	id: `evt_disputa_${tipo}_${paymentIntent}`,
	data: { object: { object: "dispute", payment_intent: paymentIntent, customer: CUSTOMER, status } },
});

async function emitidas(e: Escenario, id: string, lineas: [number, number][]): Promise<string[]> {
	const r = await cumplir(ENV, e.db, sesionVarias(id, lineas));
	if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
	return r.license_ids;
}

describe("RI-52 · una licencia por unidad", () => {
	it("comprar 3 emite 3 licencias distintas, cada una con su cobro, y repetirla no emite más", async () => {
		const r = await escenario(async (e) => {
			const primera = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			const segunda = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			const unidades = e.sql
				.exec("SELECT unidad FROM license_payments ORDER BY unidad;")
				.toArray()
				.map((f: any) => Number(f.unidad));
			const meses = e.sql
				.exec("SELECT term_months FROM licenses;")
				.toArray()
				.map((f: any) => Number(f.term_months));
			return { primera, segunda, unidades, meses, licencias: e.contar("licenses") };
		});

		expect(r.primera.accion).toBe("emitida");
		const ids = r.primera.accion === "emitida" ? r.primera.license_ids : [];
		expect(new Set(ids).size).toBe(3);
		// Tres licencias de un año, no una de tres: quien compra varias puede querer varios locales.
		expect(r.meses).toEqual([12, 12, 12]);
		expect(r.unidades).toEqual([1, 2, 3]);
		expect(r.segunda.accion).toBe("ya_cumplida");
		expect(r.licencias).toBe(3);
	});

	it("con varias líneas, cada unidad lleva la duración de la suya", async () => {
		const meses = await escenario(async (e) => {
			await emitidas(e, "cs_mixta", [
				[12, 2],
				[3, 1],
			]);
			return e.sql
				.exec("SELECT term_months FROM licenses ORDER BY term_months;")
				.toArray()
				.map((f: any) => Number(f.term_months));
		});
		expect(meses).toEqual([3, 12, 12]);
	});

	it("fail-closed: una línea sin duración, una cantidad rara o demasiadas no emiten nada", async () => {
		const r = await escenario(async (e) => {
			const sinDuracion = {
				...sesionVarias("cs_mala", [[12, 2]]),
				line_items: {
					data: [
						{ quantity: 2, price: { id: "price_anual", metadata: { term_months: "12" } } },
						{ quantity: 1, price: { id: "price_sin_meses", metadata: {} } },
					],
				},
			};
			const errores = [
				await cumplir(ENV, e.db, sinDuracion).catch((err) => String(err?.message)),
				await cumplir(ENV, e.db, sesionVarias("cs_cero", [[12, 0]])).catch((err) => String(err?.message)),
				await cumplir(ENV, e.db, sesionVarias("cs_mucho", [[12, MAX_LICENCIAS_POR_COMPRA + 1]])).catch(
					(err) => String(err?.message),
				),
			];
			return { errores, licencias: e.contar("licenses"), cobros: e.contar("license_payments") };
		});

		expect(r.errores[0]).toMatch(/missing_term_months_metadata/);
		expect(r.errores[1]).toMatch(/cantidad_invalida/);
		expect(r.errores[2]).toMatch(/demasiadas_licencias/);
		expect(r.licencias).toBe(0);
		expect(r.cobros).toBe(0);
	});

	it("si falla a mitad no queda ninguna, y el reintento emite todas", async () => {
		const r = await escenario(async (e) => {
			const conFallo = conFalloSimulado(e.db, /INSERT INTO license_payments/);
			const error = await cumplir(ENV, conFallo, sesionVarias("cs_pack", [[12, 3]])).catch((err) => err);
			const trasFallo = e.contar("licenses");
			const reintento = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			return { error, trasFallo, reintento, licencias: e.contar("licenses") };
		});

		expect(String(r.error?.message)).toBe("fallo_simulado");
		expect(r.trasFallo).toBe(0);
		expect(r.reintento.accion).toBe("emitida");
		expect(r.licencias).toBe(3);
	});

	it("la base admite varias unidades de una sesión, pero no la misma dos veces", async () => {
		await escenario(async (e) => {
			const insertar = (id: string, unidad: number) =>
				e.sql.exec(
					`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
					   stripe_checkout_session_id, stripe_payment_intent_id, unidad, at_ms)
					 VALUES (?, 'lic', 'issue', 12, 'cs_dup', 'pi_dup', ?, 0);`,
					id,
					unidad,
				);
			insertar("p1", 1);
			insertar("p2", 2);
			expect(() => insertar("p3", 1)).toThrow(/UNIQUE/i);
		});
	});
});

describe("RI-52 · deshacer una compra de varias unidades", () => {
	it("un reembolso total revoca todas las licencias de la compra", async () => {
		const estados = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			await revertir(e.db, reembolso("pi_cs_pack"));
			return Promise.all(ids.map(async (id) => (await e.leer(id)).status));
		});
		expect(estados).toEqual(["revoked", "revoked", "revoked"]);
	});

	it("una clave del pack ya canjeada en otro local pierde allí sus meses; las demás se revocan", async () => {
		const r = await escenario(async (e) => {
			const otroLocal = await e.licenciaActivada();
			const [canjeada, sinUsar] = await emitidas(e, "cs_pack", [[12, 2]]);
			// Lo que hace la activación al teclear una clave nueva en un equipo con licencia (REV-13).
			await canjearLicencia(e.db, canjeada, otroLocal.license_id);
			const conCanje = await extendLicense(e.db, otroLocal.license_id, 12);
			await reasignarCobrosDeLaClave(e.db, canjeada, otroLocal.license_id);

			const resultado = await revertir(e.db, reembolso("pi_cs_pack", 24000, 24000));
			return {
				resultado,
				otroLocal: await e.leer(otroLocal.license_id),
				antes: otroLocal.expires_at_ms,
				conCanje,
				sinUsar: await e.leer(sinUsar),
			};
		});

		expect(r.resultado.reversed).toBe(true);
		// El otro local sigue vivo, con la fecha que tenía antes del canje.
		expect(r.otroLocal.status).toBe("active");
		expect(r.otroLocal.expires_at_ms).toBe(r.antes);
		expect(r.sinUsar.status).toBe("revoked");
	});

	it("un reembolso parcial no toca ninguna y deja dicho cuáles eran", async () => {
		const r = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			const resultado = await revertir(e.db, reembolso("pi_cs_pack", 36000, 12000));
			const auditoria = JSON.parse(
				String(e.sql.exec("SELECT detail FROM admin_audit WHERE action = 'refund';").toArray()[0].detail),
			);
			return {
				ids,
				resultado,
				auditoria,
				estados: await Promise.all(ids.map(async (id) => (await e.leer(id)).status)),
			};
		});

		expect(r.resultado.reason).toBe("partial_refund");
		expect(r.estados).toEqual(["issued", "issued", "issued"]);
		expect([...r.auditoria.licencias].sort()).toEqual([...r.ids].sort());
	});

	it("abrir una disputa las corta todas y ganarla las devuelve todas, una sola vez", async () => {
		const r = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			await revertir(e.db, disputa("pi_cs_pack", "created"));
			const cortadas = await Promise.all(ids.map(async (id) => (await e.leer(id)).status));
			const repetida = await revertir(e.db, { ...disputa("pi_cs_pack", "created"), id: "evt_otra" });
			await revertir(e.db, disputa("pi_cs_pack", "closed", "won"));
			const devueltas = await Promise.all(ids.map(async (id) => (await e.leer(id)).status));
			return { cortadas, repetida, devueltas };
		});

		expect(r.cortadas).toEqual(["revoked", "revoked", "revoked"]);
		expect(r.repetida.reason).toBe("already_reversed");
		expect(r.devueltas).toEqual(["issued", "issued", "issued"]);
	});
});
