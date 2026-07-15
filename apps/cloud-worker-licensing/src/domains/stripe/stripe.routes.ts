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

import { Hono } from "hono";

import type { Env } from "../../env";
import { ensureLicensingSchemaMw } from "../../middleware/ensureSchema";
import { getDb } from "../../server/db";
import { sha256Hex } from "../../server/crypto";
import {
	attachStripeSession,
	extendLicense,
	getLicenseByStripeSession,
	getRenewableLicenseByStripeCustomer,
	issueLicense,
	markWebhookProcessed,
	upsertWebhookEvent,
} from "../../server/licenseStore";
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

stripeRoutes.use("*", ensureLicensingSchemaMw);

/** Los eventos que nos importan. Un pago diferido (SEPA, etc.) llega por el segundo. */
const EVENTOS_DE_PAGO = new Set([
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
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
		resource_type: "checkout.session",
		resource_id: String(event?.data?.object?.id || "") || null,
		sig_hex: null,
		body_sha256: await sha256Hex(raw),
		payload_json: raw,
	});
	if (idemp.already) {
		return c.json({ ok: true, received: true, idempotent: true });
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

	await sendLicenseKeyEmail(env, {
		to: license.customer_email,
		name: license.customer_name,
		key: keyPlain,
		termMonths,
	});
}
