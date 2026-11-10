// src/domains/stripe/stripe.routes.ts
//
// POST /v1/stripe/webhook — el único punto por el que una compra se convierte en licencia.
//
// Barreras, en orden (cada una asume que la anterior pudo no bastar):
//   1. Firma HMAC-SHA256 de Stripe, verificada sobre el cuerpo CRUDO, comparación timing-safe.
//   2. Anti-replay: el timestamp de la firma no puede desviarse más de 5 minutos.
//   3. Idempotencia por `event.id` en `webhook_events`: un evento que salió bien no se repite. Uno
//      que falló SÍ se reprocesa — para eso se contestó 500 (REV-01).
//   4. Idempotencia por sesión de checkout en `license_payments` (índice único por sesión y
//      unidad): si esa sesión ya se cumplió, se sale. Es la barrera de verdad, y se comprueba
//      dentro de la transacción.
//   5. Fail-closed en la duración: sin `metadata.term_months` no se emite NADA.
//
// RI-52 — una licencia por unidad: comprar 4 son 4 claves, todas en el mismo correo, y no 4 años
// en una. Quien quiera todo el tiempo en un equipo canjea las claves una tras otra (REV-13).
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
//   · reembolso TOTAL   → se revierten los cobros (revoca cada alta, o resta los meses de cada
//                         renovación): todas las licencias de la compra
//   · reembolso PARCIAL → no toca ninguna licencia; queda auditado (es un ajuste, no una
//                         devolución: Stripe no dice de cuál de las licencias, y eso se decide a mano)
//   · disputa abierta   → se revierte ya, que el dinero ya no está
//   · disputa GANADA    → se deshace la reversión que hizo ella, y sólo ésa (AUD-08)

import { Hono } from "hono";
import { capturarError } from "../../observability/errors";

import type { Env } from "../../env";
import { avisarCambioDeLicencia } from "../../lib/hub";
import { topeAnonimo } from "../../lib/validacion";
import { enTransaccion, getDb, type Sql } from "../../server/db";
import { sha256Hex } from "../../server/crypto";
import {
	attachStripeSession,
	auditAdmin,
	clearLicensePaymentReversal,
	DISPUTA_SIN_REVOCAR,
	extendLicense,
	getLicenseById,
	getLicenseByStripeIntent,
	getLicensePaymentsByIntent,
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
import { sendLicenseKeysEmail } from "../licensing/licenseEmails";
import { assertEnv, toBool01 } from "../licensing/licensing.helpers";
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
	licenciasDeLaSesion,
	verifyStripeSignature,
} from "./stripe.helpers";

export const stripeRoutes = new Hono<{ Bindings: Env }>();

// AUD-34: el cuerpo se lee y pasa por el HMAC antes de saber si lo manda Stripe; la forma y la hora
// de la cabecera las escribe quien llama. 4 MiB: el evento más grande de los suscritos es una disputa
// cerrada con sus pruebas al máximo (150 000 caracteres) y 50 metadatos al máximo (clave de 40 y valor
// de 500); con cada carácter fuera del plano básico y escapado en `\uXXXX\uXXXX` (12 bytes) son unos
// 2,1 MB más el resto del evento. Lo vigila `test/topeAnonimo.test.ts`.
stripeRoutes.use("/webhook", topeAnonimo(4 * 1024 * 1024));

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
			await avisarDeLasAnuladas(env, db, resultado);
			return c.json({ ok: true, received: true, ...resultado });
		} catch (e: any) {
			capturarError(e, "stripe.reversal");
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
		capturarError(e, "stripe.fulfillment");
		const detalle = String(e?.message || e);
		await markWebhookProcessed(db, eventId, false, detalle);
		console.error("[stripe] fulfillment fallido:", detalle);
		// 500 → Stripe reintenta. Es lo que queremos si el fallo es nuestro (Turso caído, etc.).
		return c.json({ ok: false, error: "fulfillment_failed" }, 500);
	}
});

/**
 * AUD-02 · Un alta devuelta deja la licencia anulada: se avisa al `TenantHub` del negocio, que vuelve
 * a leer quién es la Main y le cierra el socket a la que ya no lo es, igual que al anularla desde la
 * administración (`admin.routes.ts`). Sin esto seguía replicando hasta que se cayera su conexión o
 * lo notara el job `licencia`, hasta seis horas después.
 *
 * Va con la reversión ya confirmada y nunca la hace fallar: es best-effort, y un 500 aquí haría que
 * Stripe reintentara un evento ya aplicado. Si el aviso no llega, el `TenantHub` lo corrige en cuanto
 * haya actividad en el negocio, como mucho un minuto después de su última lectura de la licencia.
 * Una renovación devuelta no avisa: caducar no empuja.
 */
async function avisarDeLasAnuladas(
	env: Env,
	db: ReturnType<typeof getDb>,
	resultado: Record<string, unknown>,
): Promise<void> {
	const licencias = Array.isArray(resultado.licencias)
		? (resultado.licencias as { license_id: string; accion: string }[])
		: [];

	for (const { license_id, accion } of licencias) {
		if (accion !== "revoked") continue;
		try {
			const lic = await getLicenseById(db, license_id);
			if (!lic) continue;
			// Una licencia que no llegó a activarse no tiene negocio ni Main: no hay a quién avisar.
			await avisarCambioDeLicencia(env.TenantHub, String(lic.tenant_id || ""));
		} catch (e) {
			capturarError(e, "stripe.notify_hub");
		}
	}
}

/** Qué ha hecho `cumplir` con una sesión. Lo leen los tests. */
export type Cumplimiento =
	| { accion: "sin_pagar" }
	| { accion: "ya_cumplida"; license_id: string }
	| { accion: "emitida"; license_ids: string[] };

/**
 * Convierte una sesión pagada en licencia: siempre emite una clave nueva y se la manda por correo.
 * Si esa clave suma tiempo a un negocio o estrena uno se decide al activarla (REV-13).
 *
 * Recibe la sesión ya leída de Stripe para que la llamada de red quede fuera de la transacción
 * (y para que los tests puedan pasarle una sin salir a internet).
 */
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

	// Fail-closed (5): sin duración conocida, o con una cantidad que no se entiende, no se emite.
	// Se registra para que se vea en el log del evento (queda `processed_ok = 0` con este mensaje).
	const unidades = licenciasDeLaSesion(session);
	if ("error" in unidades) throw new Error(`${unidades.error}: ${sessionId}`);

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

		// REV-13: aquí ya no se decide nada. Toda compra emite una clave, y lo que convierte esa
		// clave en tiempo añadido o en un negocio nuevo pasa al activarla, en
		// `licensing.routes.ts`: si el equipo que la teclea ya es la Main de una licencia, le suma
		// sus meses; si no, estrena. Así el mismo enlace de compra vale para las dos cosas y el
		// cliente no tiene que acertar con nada — que era el problema: antes se adivinaba por el
		// cliente de Stripe, así que comprar con los mismos datos extendía la licencia que había y
		// el dueño de un segundo local pagaba y no recibía clave.

		// RI-52: una licencia (y su cobro) por unidad. Todas en esta transacción: o la compra
		// entera, o nada. Y si otra entrega se cruza, la unidad 1 de la segunda choca con el índice
		// único y su transacción se deshace entera.
		const emitidas: { license: LicenseRow; keyPlain: string; termMonths: number }[] = [];
		for (const [i, termMonths] of unidades.termMonths.entries()) {
			const { license, keyPlain } = await issueLicense(tx, {
				claves: env,
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
				unidad: i + 1,
			});

			emitidas.push({ license, keyPlain, termMonths });
		}

		return { tipo: "emitida" as const, emitidas };
	});

	if (hecho.tipo === "ya_cumplida") {
		return { accion: "ya_cumplida", license_id: hecho.license_id };
	}

	const { emitidas } = hecho;
	const emailSent = await sendLicenseKeysEmail(env, {
		to: emitidas[0].license.customer_email,
		name: emitidas[0].license.customer_name,
		claves: emitidas.map((e) => ({ key: e.keyPlain, termMonths: e.termMonths })),
	});

	// Si el correo falla NO reventamos el webhook (la venta es lo importante y las claves siguen
	// recuperables cifradas): dejamos `key_email_sent_at_ms` a NULL para que las licencias salgan
	// en `pnpm license:list` como pendientes y se reenvíen con `pnpm license:resend`.
	if (emailSent) {
		for (const e of emitidas) await markKeyEmailSent(db, e.license.license_id);
	}

	return { accion: "emitida", license_ids: emitidas.map((e) => e.license.license_id) };
}

/* ============================================================
   LIC-07 · Reversión de un cobro
============================================================ */

type Reversion = { reason: "refund" | "dispute"; eventUid: string };

type Cobro = { license: LicenseRow; pago: LicensePaymentRow | null };

/**
 * Localiza las licencias afectadas por un cargo, de lo más preciso a lo más flojo:
 *   1. el historial de cobros (sabe además si fue alta o renovación y cuántos meses aportó). Un
 *      cargo puede tener varios: uno por licencia de la compra (RI-52);
 *   2. el último cobro sellado en la propia licencia (cubre las anteriores al historial);
 *   3. el cliente de Stripe, y SOLO si tiene exactamente una licencia.
 *
 * Devuelve también el cobro cuando se conoce: sin él no se puede distinguir un alta de una
 * renovación y hay que asumir lo primero. Lista vacía: no hay nada atribuible.
 */
async function localizarCobros(db: Sql, obj: any): Promise<Cobro[]> {
	const paymentIntentId = String(obj?.payment_intent || "");

	if (paymentIntentId) {
		const cobros: Cobro[] = [];
		for (const pago of await getLicensePaymentsByIntent(db, paymentIntentId)) {
			const license = await getLicenseById(db, pago.license_id);
			if (license) cobros.push({ license, pago });
		}
		if (cobros.length > 0) return cobros;

		const license = await getLicenseByStripeIntent(db, paymentIntentId);
		if (license) return [{ license, pago: null }];
	}

	const customerId =
		typeof obj?.customer === "string" ? obj.customer : String(obj?.customer?.id || "");
	if (customerId) {
		const license = await getSoleLicenseByStripeCustomer(db, customerId);
		if (license) return [{ license, pago: null }];
	}

	return [];
}

/** Días que lleva activada la licencia, para ver de un vistazo si el reembolso entró en política. */
function diasActivada(license: LicenseRow): number | null {
	if (!license.activated_at_ms) return null;
	return Math.floor((Date.now() - license.activated_at_ms) / (24 * 60 * 60 * 1000));
}



/**
 * Deshace los cobros de un cargo: los de todas las licencias de la compra (RI-52). Una renovación
 * devuelta solo pierde los meses que añadió; un alta devuelta revoca la licencia (el cliente no se
 * queda con el producto), salvo que ya estuviera revocada (AUD-08).
 */
async function revertirCobros(
	db: Sql,
	obj: any,
	rev: Reversion,
): Promise<Record<string, unknown>> {
	const cobros = await localizarCobros(db, obj);

	if (cobros.length === 0) {
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

	// Idempotencia: una disputa que se abre y luego se pierde puede traer dos eventos, y Stripe
	// reintenta. Cada cobro solo se revierte una vez.
	const pendientes = cobros.filter((c) => !c.pago?.reversed_at_ms);
	if (pendientes.length === 0) {
		return { reversed: false, reason: "already_reversed", license_id: cobros[0].license.license_id };
	}

	const licencias: { license_id: string; accion: "shortened" | "revoked" | "already_revoked" }[] = [];
	for (const { license, pago } of pendientes) {
		const esRenovacion = pago?.kind === "renewal";
		// AUD-08: un alta que ya estaba revocada (a mano, o tras el reembolso parcial de una compra
		// de varias) no la revoca esta reversión, y su cobro no se marca como revocado por la
		// disputa: si no, ganarla la resucitaría.
		const yaRevocada = !esRenovacion && (license.status === "revoked" || toBool01(license.disabled));
		let expiresAtMs: number | null = null;

		if (esRenovacion) {
			expiresAtMs = await shortenLicense(db, license.license_id, pago!.term_months);
		} else if (!yaRevocada) {
			await revokeLicense(db, license.license_id);
		}

		if (pago) {
			await markLicensePaymentReversed(db, pago.payment_id, {
				reason: yaRevocada && rev.reason === "dispute" ? DISPUTA_SIN_REVOCAR : rev.reason,
				eventUid: rev.eventUid,
			});
		}

		await auditAdmin(db, rev.reason === "dispute" ? "dispute" : "refund", license.license_id, {
			event_uid: rev.eventUid,
			accion: esRenovacion ? "meses_restados" : yaRevocada ? "ya_revocada" : "revocada",
			term_months: pago?.term_months ?? null,
			expires_at_ms: expiresAtMs,
			// Si esto sale alto, el reembolso se emitió fuera de la política de 7 días.
			dias_activada: diasActivada(license),
			payment_intent: String(obj?.payment_intent || "") || null,
		});

		licencias.push({
			license_id: license.license_id,
			accion: esRenovacion ? "shortened" : yaRevocada ? "already_revoked" : "revoked",
		});
	}

	return {
		reversed: true,
		// El primero, como antes de RI-52: con una sola licencia es lo único que hay.
		license_id: licencias[0].license_id,
		accion: licencias[0].accion,
		licencias,
	};
}

/**
 * Deshace la reversión de una disputa ganada: el dinero vuelve, el servicio también. A todas las
 * licencias de la compra que revirtió esa disputa (RI-52).
 */
async function restaurarCobros(
	db: Sql,
	obj: any,
	eventUid: string,
): Promise<Record<string, unknown>> {
	const cobros = await localizarCobros(db, obj);
	if (cobros.length === 0) return { restored: false, reason: "unresolved_license" };

	// Solo se deshace lo que revirtió ESTA disputa. Si una licencia se revocó a mano por otro
	// motivo, ganar la disputa no es razón para resucitarla.
	//
	// AUD-08: por eso sólo vuelve lo marcado `dispute`. Lo que ya estaba revocado al abrirse, o se
	// revocó a mano mientras seguía abierta (`DISPUTA_SIN_REVOCAR`), sólo pierde la marca: el dinero
	// ha vuelto, pero la revocación es del operador. Y una licencia sin cobro registrado (anterior a
	// LIC-07) no se toca: sin él no se sabe quién la revocó; si fue la disputa, se desrevoca a mano.
	for (const { pago } of cobros) {
		if (pago?.reversed_reason === DISPUTA_SIN_REVOCAR) {
			await clearLicensePaymentReversal(db, pago.payment_id);
		}
	}
	const aRestaurar = cobros.filter((c) => c.pago?.reversed_reason === "dispute");
	if (aRestaurar.length === 0) return { restored: false, reason: "not_reversed_by_dispute" };

	const restauradas: string[] = [];
	for (const { license, pago } of aRestaurar) {
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
		restauradas.push(license.license_id);
	}

	return { restored: true, license_id: restauradas[0], license_ids: restauradas };
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
		//
		// RI-52: con varias licencias en la compra, Stripe tampoco dice cuál se devuelve. Se audita
		// con todas, para que quien emitió el reembolso revoque o acorte la que toque desde
		// administración (licencias.md, «Reembolso parcial: lo que se hace a mano»).
		if (total > 0 && devuelto < total) {
			const cobros = await localizarCobros(db, obj);
			await auditAdmin(db, "refund", cobros[0]?.license.license_id ?? null, {
				event_uid: eventUid,
				accion: "parcial_sin_efecto",
				amount: total,
				amount_refunded: devuelto,
				licencias: cobros.map((c) => c.license.license_id),
			});
			return { reversed: false, reason: "partial_refund" };
		}

		return revertirCobros(db, obj, { reason: "refund", eventUid });
	}

	if (event?.type === "charge.dispute.created") {
		return revertirCobros(db, obj, { reason: "dispute", eventUid });
	}

	// charge.dispute.closed: solo importa haberla ganado. Perdida o aceptada, la reversión de la
	// apertura se queda como está.
	if (String(obj?.status || "") !== "won") {
		return { restored: false, reason: String(obj?.status || "unknown") };
	}

	return restaurarCobros(db, obj, eventUid);
}
