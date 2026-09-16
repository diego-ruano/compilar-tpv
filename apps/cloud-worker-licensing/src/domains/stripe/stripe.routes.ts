// src/domains/stripe/stripe.routes.ts
//
// POST /v1/stripe/webhook — el único punto por el que una compra se convierte en licencia.
//
// Barreras, en orden (cada una asume que la anterior pudo no bastar):
//   1. Firma HMAC-SHA256 de Stripe, verificada sobre el cuerpo CRUDO, comparación timing-safe.
//   2. Anti-replay: el timestamp de la firma no puede desviarse más de 5 minutos.
//   3. Idempotencia por `event.id` en `webhook_events` (Stripe reintenta; puede duplicar).
//   4. Idempotencia por sesión de checkout: si esa sesión ya materializó una licencia, se sale.
//   5. Fail-closed en la duración: sin `metadata.term_months` no se emite NADA.
//
// Se responde 2xx rápido y siempre que el evento quede registrado: un 5xx hace que Stripe
// reintente, y no queremos reintentos por un fallo nuestro de correo.
//
// LIC-07 — la otra mitad: un pago puede DESHACERSE. Reembolso (lo emites tú desde Stripe, nunca
// automático) o chargeback (lo pide el cliente a su banco y el dinero se va al instante). Hasta
// ahora esos eventos se descartaban y la licencia seguía viva hasta caducar. Ahora:
//   · reembolso TOTAL   → se revierte el cobro (revoca el alta, o resta los meses de la renovación)
//   · reembolso PARCIAL → no toca la licencia; queda auditado (es un ajuste, no una devolución)
//   · disputa abierta   → se revierte ya, que el dinero ya no está
//   · disputa GANADA    → se deshace la reversión

import { Hono } from "hono";

import type { Env } from "../../env";
import { getDb } from "../../server/db";
import { sha256Hex } from "../../server/crypto";
import {
	attachStripeSession,
	auditAdmin,
	clearLicensePaymentReversal,
	extendLicense,
	getLicenseById,
	getLicenseByStripeIntent,
	getLicenseByStripeSession,
	getLicensePaymentByIntent,
	getRenewableLicenseByStripeCustomer,
	getSoleLicenseByStripeCustomer,
	issueLicense,
	markKeyEmailSent,
	markLicensePaymentReversed,
	markWebhookProcessed,
	reactivateLicense,
	recordLicensePayment,
	revokeLicense,
	shortenLicense,
	upsertWebhookEvent,
} from "../../server/licenseStore";
import type { LicenseRow, LicensePaymentRow } from "../../server/licenseStore";
import { sendLicenseKeyEmail, sendLicenseRenewedEmail } from "../licensing/licenseEmails";
import { assertEnv } from "../licensing/licensing.helpers";
import {
	customerAddressJsonFromSession,
	customerBusinessNameFromSession,
	customerEmailFromSession,
	customerIdFromSession,
	customerNameFromSession,
	customerPhoneFromSession,
	paymentIntentIdFromSession,
	priceIdFromSession,
	retrieveCheckoutSession,
	termMonthsFromSession,
	verifyStripeSignature,
} from "./stripe.helpers";

export const stripeRoutes = new Hono<{ Bindings: Env }>();

/** Los eventos que nos importan. Un pago diferido (SEPA, etc.) llega por el segundo. */
const EVENTOS_DE_PAGO = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
]);

/**
 * LIC-07: los que deshacen un pago. Hay que suscribirlos en el endpoint de webhook del Dashboard
 * de Stripe: el worker solo recibe lo que allí esté marcado, así que sin eso este código no llega
 * a ejecutarse nunca.
 */
const EVENTOS_DE_REVERSION = new Set([
	"charge.refunded",
	"charge.dispute.created",
	"charge.dispute.closed",
]);

stripeRoutes.post("/webhook", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, [
		"STRIPE_SECRET_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"LICENSE_STORE_KEY",
		"TURSO_DATABASE_URL",
		"TURSO_AUTH_TOKEN",
	]);
	if (miss) return c.json({ ok: false, error: miss }, 500);

	// El cuerpo se lee UNA vez y en crudo: la firma es sobre estos bytes exactos.
	const raw = await c.req.raw.text();
	const sigHeader = c.req.header("stripe-signature") || "";

	const firma = await verifyStripeSignature(raw, sigHeader, env.STRIPE_WEBHOOK_SECRET!);
	if (!firma.ok) {
		console.warn("[stripe] firma rechazada:", firma.error);
		return c.json({ ok: false, error: firma.error }, 400);
	}

	let event: any;
	try {
		event = JSON.parse(raw);
	} catch {
		return c.json({ ok: false, error: "invalid_json" }, 400);
	}

	const eventId = String(event?.id || "");
	const eventName = String(event?.type || "unknown");
	if (!eventId) return c.json({ ok: false, error: "missing_event_id" }, 400);

	const db = getDb(env);

	// Idempotencia (3): si ya lo procesamos, 200 y a otra cosa. Stripe reintenta ante cualquier
	// duda, y procesar dos veces el mismo pago emitiría dos licencias.
	const idemp = await upsertWebhookEvent(db, {
		event_uid: eventId,
		event_name: eventName,
		// Lo que Stripe llama al objeto del evento ("checkout.session", "charge", "dispute"…).
		resource_type: String(event?.data?.object?.object || "checkout.session"),
		resource_id: String(event?.data?.object?.id || "") || null,
		sig_hex: null,
		body_sha256: await sha256Hex(raw),
		payload_json: raw,
	});
	if (idemp.already) {
		return c.json({ ok: true, received: true, idempotent: true });
	}

	if (EVENTOS_DE_REVERSION.has(eventName)) {
		try {
			const resultado = await revertir(db, event);
			await markWebhookProcessed(db, eventId, true);
			return c.json({ ok: true, received: true, ...resultado });
		} catch (e: any) {
			const detalle = String(e?.message || e);
			await markWebhookProcessed(db, eventId, false, detalle);
			console.error("[stripe] reversión fallida:", detalle);
			return c.json({ ok: false, error: "reversal_failed" }, 500);
		}
	}

	if (!EVENTOS_DE_PAGO.has(eventName)) {
		await markWebhookProcessed(db, eventId, true);
		return c.json({ ok: true, received: true, ignored: eventName });
	}

	try {
		await cumplir(env, db, String(event?.data?.object?.id || ""));
		await markWebhookProcessed(db, eventId, true);
		return c.json({ ok: true, received: true });
	} catch (e: any) {
		const detalle = String(e?.message || e);
		await markWebhookProcessed(db, eventId, false, detalle);
		console.error("[stripe] fulfillment fallido:", detalle);
		// 500 → Stripe reintenta. Es lo que queremos si el fallo es nuestro (Turso caído, etc.).
		return c.json({ ok: false, error: "fulfillment_failed" }, 500);
	}
});

/**
 * Convierte una sesión pagada en licencia: extiende la del cliente si ya tenía una viva, o le
 * minta una nueva y se la manda por correo.
 */
async function cumplir(env: Env, db: ReturnType<typeof getDb>, sessionId: string): Promise<void> {
	if (!sessionId) throw new Error("missing_session_id");

	// Se relee la sesión de Stripe en vez de fiarse del cuerpo del webhook (recomendación oficial).
	const session = await retrieveCheckoutSession(env, sessionId);

	// Un checkout puede completarse con el pago aún pendiente (métodos diferidos): entonces no se
	// emite nada todavía. Ya llegará `async_payment_succeeded`.
	const paymentStatus = String(session?.payment_status || "");
	if (paymentStatus === "unpaid") {
		console.log("[stripe] sesión sin pagar todavía, no se emite:", sessionId);
		return;
	}

	// Idempotencia (4): esta sesión ya se convirtió en licencia.
	const yaCumplida = await getLicenseByStripeSession(db, sessionId);
	if (yaCumplida) return;

	// Fail-closed (5): sin duración conocida no se emite. Se registra para que se vea en el log
	// del evento (queda `processed_ok = 0` con este mensaje).
	const termMonths = termMonthsFromSession(session);
	if (!termMonths) {
		throw new Error(`missing_term_months_metadata (price sin metadata.term_months): ${sessionId}`);
	}

	const email = customerEmailFromSession(session);
	if (!email) throw new Error(`missing_customer_email: ${sessionId}`);

	const customerId = customerIdFromSession(session);
	const name = customerNameFromSession(session);
	const businessName = customerBusinessNameFromSession(session);
	const phone = customerPhoneFromSession(session);
	const addressJson = customerAddressJsonFromSession(session);
	const priceId = priceIdFromSession(session);
	const paymentIntentId = paymentIntentIdFromSession(session);

	// ¿Renovación? Si el cliente ya tiene una licencia viva, se le EXTIENDE: nada de mandarle una
	// clave nueva que tendría que teclear en un TPV que ya funciona.
	const renovable = customerId
		? await getRenewableLicenseByStripeCustomer(db, customerId, Date.now())
		: null;

	if (renovable) {
		const expiresAtMs = await extendLicense(db, renovable.license_id, termMonths);
		await attachStripeSession(db, renovable.license_id, {
			sessionId,
			customerId,
			paymentIntentId,
			priceId,
		});

		// LIC-07: `attachStripeSession` sobrescribe el cobro anterior en `licenses`, así que el
		// historial es lo único que permite atribuir después un reembolso de ESTA renovación y
		// saber cuántos meses hay que quitar.
		await recordLicensePayment(db, {
			licenseId: renovable.license_id,
			kind: "renewal",
			termMonths,
			sessionId,
			paymentIntentId,
		});

		await sendLicenseRenewedEmail(env, {
			to: renovable.customer_email,
			name: renovable.customer_name,
			termMonths,
			expiresAtMs,
		});
		return;
	}

	const { license, keyPlain } = await issueLicense(db, {
		storeKeyB64: env.LICENSE_STORE_KEY,
		termMonths,
		origin: "stripe",
		customerEmail: email,
		customerName: name,
		customerBusinessName: businessName,
		customerPhone: phone,
		customerAddressJson: addressJson,
		stripeCustomerId: customerId,
		stripeCheckoutSessionId: sessionId,
		stripePaymentIntentId: paymentIntentId,
		stripePriceId: priceId,
	});

	await recordLicensePayment(db, {
		licenseId: license.license_id,
		kind: "issue",
		termMonths,
		sessionId,
		paymentIntentId,
	});

	const emailSent = await sendLicenseKeyEmail(env, {
		to: license.customer_email,
		name: license.customer_name,
		key: keyPlain,
		termMonths,
	});

	// Si el correo falla NO reventamos el webhook (la venta es lo importante y la clave sigue
	// recuperable cifrada): dejamos `key_email_sent_at_ms` a NULL para que la licencia salga en
	// `pnpm license:list` como pendiente y se reenvíe con `pnpm license:resend`.
	if (emailSent) await markKeyEmailSent(db, license.license_id);
}

/* ============================================================
   LIC-07 · Reversión de un cobro
============================================================ */

type Reversion = { reason: "refund" | "dispute"; eventUid: string };

/**
 * Localiza la licencia afectada por un cargo, de lo más preciso a lo más flojo:
 *   1. el historial de cobros (sabe además si fue alta o renovación y cuántos meses aportó),
 *   2. el último cobro sellado en la propia licencia (cubre las anteriores al historial),
 *   3. el cliente de Stripe, y SOLO si tiene exactamente una licencia.
 *
 * Devuelve también el cobro cuando se conoce: sin él no se puede distinguir un alta de una
 * renovación y hay que asumir lo primero.
 */
async function localizarCobro(
	db: ReturnType<typeof getDb>,
	obj: any,
): Promise<{ license: LicenseRow; pago: LicensePaymentRow | null } | null> {
	const paymentIntentId = String(obj?.payment_intent || "");

	const pago = paymentIntentId ? await getLicensePaymentByIntent(db, paymentIntentId) : null;
	if (pago) {
		const license = await getLicenseById(db, pago.license_id);
		if (license) return { license, pago };
	}

	if (paymentIntentId) {
		const license = await getLicenseByStripeIntent(db, paymentIntentId);
		if (license) return { license, pago: null };
	}

	const customerId =
		typeof obj?.customer === "string" ? obj.customer : String(obj?.customer?.id || "");
	if (customerId) {
		const license = await getSoleLicenseByStripeCustomer(db, customerId);
		if (license) return { license, pago: null };
	}

	return null;
}

/** Días que lleva activada la licencia, para ver de un vistazo si el reembolso entró en política. */
function diasActivada(license: LicenseRow): number | null {
	if (!license.activated_at_ms) return null;
	return Math.floor((Date.now() - license.activated_at_ms) / (24 * 60 * 60 * 1000));
}

/**
 * Deshace un cobro. Una renovación devuelta solo pierde los meses que añadió; un alta devuelta
 * revoca la licencia (el cliente no se queda con el producto).
 */
async function revertirCobro(
	db: ReturnType<typeof getDb>,
	obj: any,
	rev: Reversion,
): Promise<Record<string, unknown>> {
	const encontrado = await localizarCobro(db, obj);

	if (!encontrado) {
		// Sin licencia atribuible no se toca nada: revocar a ojo sería peor. Queda en el registro
		// del evento y en el log para mirarlo a mano.
		console.warn("[stripe] reversión sin licencia atribuible:", rev.eventUid);
		await auditAdmin(db, rev.reason === "dispute" ? "dispute" : "refund", null, {
			event_uid: rev.eventUid,
			resultado: "sin_licencia_atribuible",
			payment_intent: String(obj?.payment_intent || "") || null,
		});
		return { reversed: false, reason: "unresolved_license" };
	}

	const { license, pago } = encontrado;

	// Idempotencia: una disputa que se abre y luego se pierde puede traer dos eventos, y Stripe
	// reintenta. El cobro solo se revierte una vez.
	if (pago?.reversed_at_ms) {
		return { reversed: false, reason: "already_reversed", license_id: license.license_id };
	}

	const esRenovacion = pago?.kind === "renewal";
	let expiresAtMs: number | null = null;

	if (esRenovacion) {
		expiresAtMs = await shortenLicense(db, license.license_id, pago!.term_months);
	} else {
		await revokeLicense(db, license.license_id);
	}

	if (pago) {
		await markLicensePaymentReversed(db, pago.payment_id, {
			reason: rev.reason,
			eventUid: rev.eventUid,
		});
	}

	await auditAdmin(db, rev.reason === "dispute" ? "dispute" : "refund", license.license_id, {
		event_uid: rev.eventUid,
		accion: esRenovacion ? "meses_restados" : "revocada",
		term_months: pago?.term_months ?? null,
		expires_at_ms: expiresAtMs,
		// Si esto sale alto, el reembolso se emitió fuera de la política de 7 días.
		dias_activada: diasActivada(license),
		payment_intent: String(obj?.payment_intent || "") || null,
	});

	return {
		reversed: true,
		license_id: license.license_id,
		accion: esRenovacion ? "shortened" : "revoked",
	};
}

/** Deshace la reversión de una disputa ganada: el dinero vuelve, el servicio también. */
async function restaurarCobro(
	db: ReturnType<typeof getDb>,
	obj: any,
	eventUid: string,
): Promise<Record<string, unknown>> {
	const encontrado = await localizarCobro(db, obj);
	if (!encontrado) return { restored: false, reason: "unresolved_license" };

	const { license, pago } = encontrado;

	// Solo se deshace lo que revirtió ESTA disputa. Si la licencia se revocó a mano por otro
	// motivo, ganar la disputa no es razón para resucitarla.
	if (pago && pago.reversed_reason !== "dispute") {
		return { restored: false, reason: "not_reversed_by_dispute" };
	}

	if (pago?.kind === "renewal") {
		await extendLicense(db, license.license_id, pago.term_months);
	} else {
		await reactivateLicense(db, license.license_id);
	}

	if (pago) await clearLicensePaymentReversal(db, pago.payment_id);

	await auditAdmin(db, "reactivate", license.license_id, {
		event_uid: eventUid,
		motivo: "disputa_ganada",
	});

	return { restored: true, license_id: license.license_id };
}

/**
 * Enruta cada evento de reversión. El objeto del evento es un cargo o una disputa.
 *
 * Exportada para que los tests puedan ejercitar la decisión (revocar / restar meses / no tocar)
 * contra una base de datos real, sin tener que falsificar la firma HMAC de Stripe ni el cliente
 * de Turso que el handler HTTP construye por su cuenta.
 */
export async function revertir(
	db: ReturnType<typeof getDb>,
	event: any,
): Promise<Record<string, unknown>> {
	const obj = event?.data?.object ?? {};
	const eventUid = String(event?.id || "");

	if (event?.type === "charge.refunded") {
		const total = Number(obj?.amount ?? 0);
		const devuelto = Number(obj?.amount_refunded ?? 0);

		// Parcial: no es una devolución de la compra sino un ajuste, así que la licencia no se
		// toca. Queda auditado para que se vea en el histórico del cliente.
		if (total > 0 && devuelto < total) {
			const encontrado = await localizarCobro(db, obj);
			await auditAdmin(db, "refund", encontrado?.license.license_id ?? null, {
				event_uid: eventUid,
				accion: "parcial_sin_efecto",
				amount: total,
				amount_refunded: devuelto,
			});
			return { reversed: false, reason: "partial_refund" };
		}

		return revertirCobro(db, obj, { reason: "refund", eventUid });
	}

	if (event?.type === "charge.dispute.created") {
		return revertirCobro(db, obj, { reason: "dispute", eventUid });
	}

	// charge.dispute.closed: solo importa haberla ganado. Perdida o aceptada, la reversión de la
	// apertura se queda como está.
	if (String(obj?.status || "") !== "won") {
		return { restored: false, reason: String(obj?.status || "unknown") };
	}

	return restaurarCobro(db, obj, eventUid);
}
