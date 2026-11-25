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
//      unidad): si esa sesión ya se cumplió, se sale. Se mira antes de preparar las claves, y la
//      barrera de verdad, la que vale para dos entregas a la vez, se comprueba dentro de la
//      operación que emite el cobro.
//   5. Fail-closed en la duración: sin `metadata.term_months` no se emite NADA.
//
// RI-52 — una licencia por unidad: comprar 4 son 4 claves, todas en el mismo correo, y no 4 años
// en una. Quien quiera todo el tiempo en un equipo canjea las claves una tras otra (REV-13).
//
// REV-01 — todo lo que escribe un cobro, o una reversión, va en UNA operación de la base central,
// que entra entera o no entra (`emitirCobro` y `revertirCobro`, `server/central/operaciones/cobros.ts`).
// Lo que no es la base va fuera: leer la sesión de Stripe y preparar las claves antes; el correo, las
// marcas del evento y el aviso a los `TenantHub` después.
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
//   · disputa FORMAL    → se revierte en cuanto se abre o salen los fondos (`funds_withdrawn`), una
//                         sola vez: el dinero ya no está
//   · consulta del banco (inquiry: disputa `warning_*`) o disputa `prevented` → no se toca ninguna
//                         licencia, sólo se audita: no sale dinero y casi siempre se cierra sin más
//                         (`warning_closed`). Si escala a contracargo, es el mismo objeto Dispute con
//                         estado formal y llega `funds_withdrawn`; si ese evento falta, la revierte el
//                         cierre `lost` (AUD-45)
//   · disputa GANADA    → se deshace la reversión que hizo ella, y sólo ésa (AUD-08)

import { Hono } from "hono";
import { capturarError } from "../../observability/errors";

import type { Env } from "../../env";
import { avisarCambioDeLicencia } from "../../lib/hub";
import { topeAnonimo } from "../../lib/validacion";
import { getDb } from "../../server/db";
import { CentralNoDisponible, type ClienteCentral } from "../../server/central/cliente";
import type { Operaciones } from "../../server/central/operaciones/registro";
import { sha256Hex } from "../../server/crypto";
import {
	claveNueva,
	getLicenseById,
	licenciasDeUnaSesionCumplida,
	markKeyEmailSent,
	markWebhookProcessed,
	negocioActivadoDe,
	upsertWebhookEvent,
} from "../../server/licenseStore";
import { sendLicenseKeysEmail } from "../licensing/licenseEmails";
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
	// AUD-45: es el que avisa de que una consulta del banco ha escalado a contracargo
	// (docs.stripe.com/payments/klarna/disputes, «Use the charge.dispute.funds_withdrawn event to
	// track when an inquiry dispute escalates to a chargeback dispute»).
	"charge.dispute.funds_withdrawn",
	"charge.dispute.closed",
]);

stripeRoutes.post("/webhook", async (c) => {
	const env = c.env;
	const miss = assertEnv(env, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "LICENSE_STORE_KEY"]);
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
		// 500 → Stripe reintenta. Es lo que queremos si el fallo es nuestro (la base central no
		// contesta, etc.).
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
	db: ClienteCentral,
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
			// Una licencia que no llegó a activarse no tiene Main: no hay a quién avisar, aunque
			// tenga reservado el negocio en el que iba a nacer (AUD-09).
			await avisarCambioDeLicencia(env, negocioActivadoDe(lic));
		} catch (e) {
			capturarError(e, "stripe.notify_hub");
		}
	}
}

/**
 * Qué ha hecho `cumplir` con una sesión, con las licencias de la sesión en el orden de sus unidades.
 * Lo leen los tests.
 */
export type Cumplimiento =
	| { accion: "sin_pagar" }
	| { accion: "ya_cumplida"; license_ids: string[] }
	| { accion: "emitida"; license_ids: string[] };

/**
 * Convierte una sesión pagada en licencia: siempre emite una clave nueva y se la manda por correo.
 * Si esa clave suma tiempo a un negocio o estrena uno se decide al activarla (REV-13).
 *
 * Recibe la sesión ya leída de Stripe para que la llamada de red quede fuera de la operación
 * (y para que los tests puedan pasarle una sin salir a internet).
 */
export async function cumplir(env: Env, db: ClienteCentral, session: any): Promise<Cumplimiento> {
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
	const name = customerNameFromSession(session);

	// Idempotencia (4), antes de preparar nada: una sesión que ya se cumplió sale aquí, con sus
	// licencias, como saldría de `emitirCobro` y con su misma consulta. Preparar y cifrar unas claves
	// que no se van a usar sólo podía fallar (con `LICENSE_STORE_KEY` inservible) y convertir una
	// entrega repetida en un 500. La comprobación que vale para dos entregas a la vez sigue siendo la
	// de `emitirCobro`, dentro de su transacción.
	const yaEmitidas = await licenciasDeUnaSesionCumplida(db, sessionId);
	if (yaEmitidas.length > 0) return { accion: "ya_cumplida", license_ids: yaEmitidas };

	// Lo que el cobro escribe se prepara aquí: la clave de cada unidad (en claro, sólo para el correo),
	// su huella, su forma corta y su cifrado, y los ids de su licencia y de su cobro. A la central no
	// llega la clave en claro. Si otra entrega cumple la sesión entretanto, lo preparado se tira: lo
	// dice `emitirCobro`. Con `LICENSE_STORE_KEY` inservible, cifrar falla aquí (y `/health` ya está en
	// 503 por su canario).
	const enClaro: string[] = [];
	const preparadas = [];
	for (const termMonths of unidades.termMonths) {
		const { keyPlain, ...clave } = await claveNueva(env);
		enClaro.push(keyPlain);
		preparadas.push({ ...clave, termMonths, licenseId: crypto.randomUUID(), paymentId: crypto.randomUUID() });
	}

	// Todo lo que escribe el cobro, junto (REV-01). El correo sale después: mandar la clave de una
	// licencia que luego se deshace sería entregar algo que no existe.
	const hecho = await emitirEnLaCentral(db, {
		sessionId,
		comprador: {
			customerEmail: email,
			customerName: name,
			customerBusinessName: customerBusinessNameFromSession(session),
			customerPhone: customerPhoneFromSession(session),
			customerAddressJson: customerAddressJsonFromSession(session),
			stripeCustomerId: customerIdFromSession(session),
			stripePaymentIntentId: paymentIntentIdFromSession(session),
			stripePriceId: priceIdFromSession(session),
		},
		unidades: preparadas,
		ahoraMs: Date.now(),
	});

	// Con `ya_cumplida`, las licencias son las de otra entrega, salvo que sean exactamente las que se
	// han preparado aquí: entonces la primera llamada llegó a confirmarse antes de cortarse
	// (`emitirEnLaCentral`), y la emisión es ésta.
	const ids = preparadas.map((u) => u.licenseId);
	const deEstaEntrega = hecho.licenseIds.length === ids.length && hecho.licenseIds.every((id, i) => id === ids[i]);
	if (!deEstaEntrega) return { accion: "ya_cumplida", license_ids: hecho.licenseIds };

	const emailSent = await sendLicenseKeysEmail(env, {
		to: email,
		name,
		claves: preparadas.map((u, i) => ({ key: enClaro[i], termMonths: u.termMonths })),
	});

	// Si el correo falla NO reventamos el webhook (la venta es lo importante y las claves siguen
	// recuperables cifradas): dejamos `key_email_sent_at_ms` a NULL para que las licencias salgan
	// en `pnpm license:list` como pendientes y se reenvíen con `pnpm license:resend`.
	if (emailSent) {
		for (const id of ids) await markKeyEmailSent(db, id);
	}

	return { accion: "emitida", license_ids: ids };
}

/**
 * El cobro, entero, en la central. Si la plataforma corta la llamada por un fallo pasajero, no se
 * sabe si llegó a confirmarse: se repite UNA vez con los mismos datos, y si la primera había entrado,
 * la central contesta `ya_cumplida` con estas mismas licencias. Una central saturada no se repite:
 * sólo le añadiría carga, y Stripe reintenta el evento más tarde.
 */
async function emitirEnLaCentral(
	db: ClienteCentral,
	datos: Parameters<Operaciones["emitirCobro"]>[1],
) {
	try {
		return await db.operar("emitirCobro", datos);
	} catch (e) {
		if (!(e instanceof CentralNoDisponible && e.motivo === "pasajera")) throw e;
		return await db.operar("emitirCobro", datos);
	}
}

/**
 * LIC-07 · Revierte (o restaura) los cobros de un cargo según el evento, en una sola operación de la
 * central (`revertirCobro`): comprobar si el cobro ya se revirtió, tocar la licencia y marcar el
 * cobro van juntos. Sueltos, un fallo al marcar dejaba la licencia ya recortada y el cobro sin marca,
 * y el reintento volvía a restar los meses (o a sumarlos, al ganar una disputa).
 *
 * Exportada para que los tests puedan ejercitar la decisión (revocar / restar meses / no tocar)
 * contra la central de verdad, sin tener que falsificar la firma HMAC de Stripe.
 */
export async function revertir(db: ClienteCentral, event: any): Promise<Record<string, unknown>> {
	const obj = event?.data?.object ?? {};
	return await db.operar("revertirCobro", {
		evento: {
			id: String(event?.id || ""),
			tipo: String(event?.type ?? ""),
			objeto: {
				id: String(obj?.id || ""),
				paymentIntent: String(obj?.payment_intent || ""),
				customer: typeof obj?.customer === "string" ? obj.customer : String(obj?.customer?.id || ""),
				status: String(obj?.status || ""),
				amount: Number(obj?.amount ?? 0),
				amountRefunded: Number(obj?.amount_refunded ?? 0),
			},
		},
		ahoraMs: Date.now(),
	});
}
