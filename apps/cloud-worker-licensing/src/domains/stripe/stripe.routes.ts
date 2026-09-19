// src/domains/stripe/stripe.routes.ts
//
// POST /v1/stripe/webhook — el único punto por el que una compra se convierte en licencia.
//
// Barreras, en orden (cada una asume que la anterior pudo no bastar):
//   1. Firma HMAC-SHA256 de Stripe, verificada sobre el cuerpo CRUDO, comparación timing-safe.
//   2. Anti-replay: el timestamp de la firma no puede desviarse más de 5 minutos.
//   3. Idempotencia por `event.id` en `webhook_events`: un evento que salió bien no se repite. Uno
//      que falló SÍ se reprocesa — para eso se contestó 500 (REV-01).
//   4. Idempotencia por sesión de checkout en `license_payments` (índice único): si esa sesión ya
//      se cumplió, se sale. Es la barrera de verdad, y se comprueba dentro de la transacción.
//   5. Fail-closed en la duración: sin `metadata.term_months` no se emite NADA.
//
// REV-01 — todo lo que escribe un cobro, o una reversión, va en UNA transacción. Antes eran
// sentencias sueltas: si fallaba la tercera, las dos primeras se quedaban, y el reintento —que no
// sabía dónde se había parado— volvía a sumar (o a restar) los meses.
//
// Se responde 2xx en cuanto lo escrito está confirmado: un 5xx hace que Stripe reintente, y no
// queremos reintentos por un fallo nuestro de correo.
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
import { enTransaccion, getDb, type Sql } from "../../server/db";
import { sha256Hex } from "../../server/crypto";
import {
	attachStripeSession,
	auditAdmin,
	clearLicensePaymentReversal,
	extendLicense,
	getLicenseById,
	getLicenseByStripeIntent,
	getLicensePaymentByIntent,
	getLicensePaymentBySession,
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
	intencionDeLaCompra,
	licenseIdFromSession,
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

	// Idempotencia (3): si ya lo procesamos BIEN, 200 y a otra cosa. Si falló, se vuelve a
	// intentar: la barrera por sesión (4) es la que impide aplicar dos veces el mismo pago.
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
		const sessionId = String(event?.data?.object?.id || "");
		if (!sessionId) throw new Error("missing_session_id");
		// Se relee la sesión de Stripe en vez de fiarse del cuerpo del webhook (recomendación oficial).
		const session = await retrieveCheckoutSession(env, sessionId);
		await cumplir(env, db, session);
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

/** Qué ha hecho `cumplir` con una sesión. Lo leen los tests. */
export type Cumplimiento =
	| { accion: "sin_pagar" }
	| { accion: "ya_cumplida"; license_id: string }
	| { accion: "renovada"; license_id: string; expires_at_ms: number }
	| { accion: "emitida"; license_id: string };

/**
 * Convierte una sesión pagada en licencia: extiende la del cliente si ya tenía una viva, o le
 * minta una nueva y se la manda por correo.
 *
 * Recibe la sesión ya leída de Stripe para que la llamada de red quede fuera de la transacción
 * (y para que los tests puedan pasarle una sin salir a internet).
 */
/**
 * A QUÉ licencia se aplica una renovación (REV-13), o por qué a ninguna.
 *
 * La pregunta ya no es «¿este cliente tiene alguna licencia viva?» —que era la adivinanza— sino
 * «¿el enlace por el que ha pagado nombra una licencia que se pueda renovar, y es suya?».
 *
 * Los rechazos son informativos: quien llama emite una licencia nueva igualmente (quien paga se
 * lleva algo que funciona) y deja el motivo anotado. Cada uno dice una cosa distinta al mirar el
 * historial, y por eso no se colapsan en un booleano.
 */
async function licenciaQueRenueva(
	tx: Sql,
	session: any,
	email: string,
	customerId: string | null,
): Promise<{ license: LicenseRow } | { rechazo: string }> {
	const licenseId = licenseIdFromSession(session);
	// Un Price marcado como renovación cuyo enlace no lleva licencia: casi siempre, el enlace de
	// pago suelto en vez del que genera el correo de aviso.
	if (!licenseId) return { rechazo: "sin_license_id" };

	const license = await getLicenseById(tx, licenseId);
	if (!license) return { rechazo: "license_id_desconocido" };

	// Anulada o deshabilitada: renovarla la resucitaría por la puerta de atrás, sin pasar por
	// administración. Si de verdad hay que devolverle el servicio, eso es un `reactivate`.
	if (license.status === "revoked" || Number(license.disabled) === 1) {
		return { rechazo: "licencia_anulada" };
	}

	// Emitida y nunca estrenada: no hay reloj corriendo, así que no hay nada que alargar —
	// extenderla le pondría caducidad a una clave que el cliente todavía no ha instalado, que es
	// justo uno de los dos casos que REV-13 describe. `expired` sí se renueva: es EL caso normal.
	if (!license.expires_at_ms || license.status === "issued") {
		return { rechazo: "licencia_sin_estrenar" };
	}

	// Que el enlace sea suyo. No es una frontera de seguridad —renovar la licencia de otro es
	// pagarle el año, no robarle nada—: es una comprobación de que el pago va donde el cliente
	// cree. Vale el cliente de Stripe O el correo, porque un checkout puede crear un Customer
	// nuevo si el comprador escribe el correo con otra grafía, y rechazar por eso una renovación
	// legítima sería cambiar un acierto raro por un fallo frecuente.
	const mismoCliente = !!customerId && license.stripe_customer_id === customerId;
	const mismoCorreo =
		String(license.customer_email || "").trim().toLowerCase() === email.trim().toLowerCase();
	if (!mismoCliente && !mismoCorreo) return { rechazo: "otro_cliente" };

	return { license };
}

export async function cumplir(
	env: Env,
	db: ReturnType<typeof getDb>,
	session: any,
): Promise<Cumplimiento> {
	const sessionId = String(session?.id || "");
	if (!sessionId) throw new Error("missing_session_id");

	// Un checkout puede completarse con el pago aún pendiente (métodos diferidos): entonces no se
	// emite nada todavía. Ya llegará `async_payment_succeeded`.
	const paymentStatus = String(session?.payment_status || "");
	if (paymentStatus === "unpaid") {
		console.log("[stripe] sesión sin pagar todavía, no se emite:", sessionId);
		return { accion: "sin_pagar" };
	}

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

	// Todo lo que escribe el cobro, junto (REV-01). El correo sale después del COMMIT: mandar la
	// clave de una licencia que luego se deshace sería entregar algo que no existe.
	const hecho = await enTransaccion(db, async (tx) => {
		// Idempotencia (4): esta sesión ya se cumplió. Se mira DENTRO de la transacción, y si dos
		// entregas se cruzan igualmente, el índice único de `license_payments` rechaza la segunda
		// y su transacción entera se deshace.
		const yaCumplida = await getLicensePaymentBySession(tx, sessionId);
		if (yaCumplida) return { tipo: "ya_cumplida" as const, license_id: yaCumplida.license_id };

		// REV-13: renovar o dar de alta lo dice la COMPRA, no lo adivina el worker.
		//
		// Antes se miraba si ese cliente de Stripe ya tenía una licencia viva y, si la tenía, se le
		// extendía. El que abría un segundo local pagaba y no recibía clave. Ahora hay dos
		// preguntas separadas y las dos las contesta el pago: `intent=renewal` en el Price dice
		// QUE es una renovación, y el `client_reference_id` del enlace dice CUÁL.
		const objetivo =
			intencionDeLaCompra(session) === "renovacion"
				? await licenciaQueRenueva(tx, session, email, customerId)
				: null;

		if (objetivo && "license" in objetivo) {
			const renovable = objetivo.license;
			const expiresAtMs = await extendLicense(tx, renovable.license_id, termMonths);
			await attachStripeSession(tx, renovable.license_id, {
				sessionId,
				customerId,
				paymentIntentId,
				priceId,
			});

			// LIC-07: `attachStripeSession` sobrescribe el cobro anterior en `licenses`, así que el
			// historial es lo único que permite atribuir después un reembolso de ESTA renovación y
			// saber cuántos meses hay que quitar.
			await recordLicensePayment(tx, {
				licenseId: renovable.license_id,
				kind: "renewal",
				termMonths,
				sessionId,
				paymentIntentId,
			});

			return { tipo: "renovada" as const, license: renovable, expiresAtMs };
		}

		// Se pagó una renovación y no hay a qué aplicarla: enlace viejo, licencia anulada, o el
		// `license_id` de otro cliente. **Se emite una licencia nueva**, que es la dirección en la
		// que este error se puede deshacer: quien ha pagado se queda con algo que funciona, y una
		// clave de más se usa o se devuelve. La alternativa —no entregar nada, o alargarle la
		// licencia a un tercero— deja al cliente sin producto y sin forma de saber por qué.
		//
		// Queda anotado en `admin_audit` porque es un síntoma, no un caso normal: si empieza a
		// salir, o el correo manda un enlace caducado o alguien está compartiendo el suyo.
		const anomalia = objetivo && "rechazo" in objetivo ? objetivo.rechazo : null;

		const { license, keyPlain } = await issueLicense(tx, {
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

		await recordLicensePayment(tx, {
			licenseId: license.license_id,
			kind: "issue",
			termMonths,
			sessionId,
			paymentIntentId,
		});

		if (anomalia) {
			console.warn(
				`[stripe] renovación sin destino (${anomalia}): se emitió la licencia ${license.license_id} ` +
					`para la sesión ${sessionId}`,
			);
			await auditAdmin(tx, "issue", license.license_id, {
				motivo: "renovacion_sin_destino",
				rechazo: anomalia,
				session_id: sessionId,
				license_id_pedido: licenseIdFromSession(session),
			});
		}

		return { tipo: "emitida" as const, license, keyPlain };
	});

	if (hecho.tipo === "ya_cumplida") {
		return { accion: "ya_cumplida", license_id: hecho.license_id };
	}

	if (hecho.tipo === "renovada") {
		await sendLicenseRenewedEmail(env, {
			to: hecho.license.customer_email,
			name: hecho.license.customer_name,
			termMonths,
			expiresAtMs: hecho.expiresAtMs,
		});
		return {
			accion: "renovada",
			license_id: hecho.license.license_id,
			expires_at_ms: hecho.expiresAtMs,
		};
	}

	const { license, keyPlain } = hecho;
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

	return { accion: "emitida", license_id: license.license_id };
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
	db: Sql,
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
	db: Sql,
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
	db: Sql,
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
	// REV-01: comprobar si el cobro ya se revirtió, tocar la licencia y marcar el cobro van juntos.
	// Sueltos, un fallo al marcar dejaba la licencia ya recortada y el cobro sin marca, y el
	// reintento volvía a restar los meses (o a sumarlos, al ganar una disputa).
	return enTransaccion(db, (tx) => decidirReversion(tx, event));
}

async function decidirReversion(db: Sql, event: any): Promise<Record<string, unknown>> {
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
