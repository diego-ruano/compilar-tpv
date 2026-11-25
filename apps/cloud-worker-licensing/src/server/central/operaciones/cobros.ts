// src/server/central/operaciones/cobros.ts
//
// Lo que un cobro de Stripe escribe en la central (`domains/stripe/stripe.routes.ts`): emitirlo y
// revertirlo. Cada uno entra entero o no entra (REV-01): un fallo a mitad no deja nada escrito, y el
// reintento no repite lo que ya entró (ni vuelve a sumar o a restar los meses).
//
// Lo que no es la base (leer la sesión de Stripe, preparar las claves, mandar el correo, marcar el
// evento, avisar a los `TenantHub`) lo hace la ruta, antes o después.

import type { SqlSync } from "../../../lib/sql";
import type { LicensePaymentRow, LicenseRow } from "../../licenseStore";
import {
	DISPUTA_SIN_REVOCAR,
	INSERTAR_AUDITORIA,
	INSERTAR_LICENCIA,
	argumentosDeLaAuditoria,
	argumentosDeLaLicenciaNueva,
	estaAnulada,
	extendLicense,
	leerLicencia,
	reactivateLicense,
	revokeLicense,
	shortenLicense,
	type LicenciaNueva,
} from "./licencias";

/* ============================================================
   La emisión
============================================================ */

/** Lo que es de toda la compra: quién paga y con qué. */
type Comprador = Pick<
	LicenciaNueva,
	| "customerEmail"
	| "customerName"
	| "customerBusinessName"
	| "customerPhone"
	| "customerAddressJson"
	| "stripeCustomerId"
	| "stripePaymentIntentId"
	| "stripePriceId"
>;

/** Una licencia de la compra, con su clave ya preparada y los ids de su fila y de su cobro. */
type UnidadDelCobro = Pick<LicenciaNueva, "licenseId" | "licHash" | "keyEnc" | "keyShort" | "termMonths"> & {
	paymentId: string;
};

type DatosDelCobro = {
	sessionId: string;
	comprador: Comprador;
	/** Una por licencia, en el orden de la compra: la primera es la unidad 1 (RI-52). */
	unidades: UnidadDelCobro[];
	ahoraMs: number;
};

/**
 * `emitida`, o `ya_cumplida` si la sesión ya tenía sus cobros. En los dos casos, las licencias a las
 * que apuntan los cobros de la sesión, en el orden de sus unidades (una clave ya canjeada apunta a la
 * licencia que recibió su tiempo): con `ya_cumplida`, quien llama sabe así si son las que preparó él
 * (una llamada suya anterior llegó a confirmarse) o las de otra entrega.
 */
type CobroEmitido = { resultado: "emitida" | "ya_cumplida"; licenseIds: string[] };

/**
 * Las licencias a las que apuntan los cobros de una sesión de checkout, en el orden de sus unidades:
 * si hay alguna, la sesión ya se cumplió. La lee `emitirCobro` dentro de su transacción, y la ruta del
 * webhook antes de preparar las claves (`stripe.routes.ts::cumplir`).
 */
export const COBROS_DE_LA_SESION = `SELECT license_id FROM license_payments WHERE stripe_checkout_session_id = ? ORDER BY unidad;`;

/**
 * Convierte una sesión pagada en licencias: una por unidad, con su cobro (RI-52). Si esa clave suma
 * tiempo a un negocio o estrena uno se decide al activarla (REV-13).
 */
export function emitirCobro(sql: SqlSync, d: DatosDelCobro): CobroEmitido {
	// Idempotencia: esta sesión ya se cumplió. Si dos entregas se cruzaran igualmente, el índice único
	// de `license_payments` (`ux_license_payments_session_unidad`) rechaza la unidad 1 de la segunda,
	// y la operación entera se deshace.
	const previos = sql.execute({ sql: COBROS_DE_LA_SESION, args: [d.sessionId] }).rows;
	if (previos.length > 0) return { resultado: "ya_cumplida", licenseIds: previos.map((p) => String(p.license_id)) };

	// REV-13: aquí ya no se decide nada. Toda compra emite una clave, y lo que convierte esa clave en
	// tiempo añadido o en un negocio nuevo pasa al activarla, en `licensing.routes.ts`: si el equipo
	// que la teclea ya es la Main de una licencia, le suma sus meses; si no, estrena. Así el mismo
	// enlace de compra vale para las dos cosas y el cliente no tiene que acertar con nada.
	for (const [i, u] of d.unidades.entries()) {
		sql.execute({
			sql: INSERTAR_LICENCIA,
			args: argumentosDeLaLicenciaNueva({
				...d.comprador,
				licenseId: u.licenseId,
				licHash: u.licHash,
				keyEnc: u.keyEnc,
				keyShort: u.keyShort,
				termMonths: u.termMonths,
				origin: "stripe",
				stripeCheckoutSessionId: d.sessionId,
				ahoraMs: d.ahoraMs,
			}),
		});
		recordLicensePayment(sql, {
			paymentId: u.paymentId,
			licenseId: u.licenseId,
			termMonths: u.termMonths,
			sessionId: d.sessionId,
			paymentIntentId: d.comprador.stripePaymentIntentId ?? null,
			unidad: i + 1,
			ahoraMs: d.ahoraMs,
		});
	}
	return { resultado: "emitida", licenseIds: d.unidades.map((u) => u.licenseId) };
}

/**
 * LIC-07: registra el cobro de un alta para poder revertirlo después. Hay uno por licencia emitida:
 * una compra de varias unidades deja uno por unidad (RI-52).
 */
function recordLicensePayment(
	sql: SqlSync,
	a: {
		paymentId: string;
		licenseId: string;
		termMonths: number;
		sessionId: string;
		paymentIntentId: string | null;
		unidad: number;
		ahoraMs: number;
	},
): void {
	sql.execute({
		sql: `
    INSERT INTO license_payments
      (payment_id, license_id, kind, term_months, stripe_checkout_session_id,
       stripe_payment_intent_id, unidad, at_ms)
    VALUES (?, ?, 'issue', ?, ?, ?, ?, ?);
    `,
		args: [a.paymentId, a.licenseId, a.termMonths, a.sessionId, a.paymentIntentId, a.unidad, a.ahoraMs],
	});
}

/* ============================================================
   LIC-07 · La reversión
============================================================ */

/** Lo que la reversión necesita del evento de Stripe. El objeto es un cargo o una disputa. */
type EventoDeReversion = {
	/** El id del evento. */
	id: string;
	/** Su tipo (`charge.refunded`, `charge.dispute.*`). */
	tipo: string;
	objeto: {
		/** El id del cargo o de la disputa. */
		id: string;
		paymentIntent: string;
		/** El cliente de Stripe del cargo (una disputa no lo lleva). */
		customer: string;
		/** El estado de la disputa. */
		status: string;
		/** Lo cobrado y lo devuelto, en céntimos (un reembolso). */
		amount: number;
		amountRefunded: number;
	};
};

type DatosDeLaReversion = { evento: EventoDeReversion; ahoraMs: number };

/**
 * AUD-45 · Los estados de una disputa FORMAL, la que retira el dinero (docs.stripe.com/api/disputes/object,
 * `status`). Lista blanca a propósito: una consulta del banco (`warning_needs_response`,
 * `warning_under_review`, `warning_closed`), una disputa `prevented` (no llegó a contracargo) o un
 * estado que Stripe añada mañana no cortan el servicio. `lost` entra porque hay disputas que se abren
 * ya perdidas (las que no se pueden impugnar), y las de apelación porque vienen de una perdida.
 */
const ESTADOS_DE_DISPUTA_FORMAL = new Set([
	"needs_response",
	"under_review",
	"lost",
	"appeal_needs_response",
	"appeal_under_review",
]);

type Reversion = { reason: "refund" | "dispute"; eventUid: string };

type Cobro = { license: LicenseRow; pago: LicensePaymentRow | null };

/** Lo que pasa con una licencia y su cobro cuando se revierte o se restaura un cargo. */
type Contexto = { sql: SqlSync; objeto: EventoDeReversion["objeto"]; ahoraMs: number };

/**
 * Enruta cada evento de reversión: decide si revoca, resta meses, restaura o no toca nada, y lo
 * hace. Devuelve lo que ha hecho, que la ruta contesta a Stripe.
 */
export function revertirCobro(sql: SqlSync, { evento, ahoraMs }: DatosDeLaReversion): Record<string, unknown> {
	const c: Contexto = { sql, objeto: evento.objeto, ahoraMs };
	const obj = evento.objeto;
	const eventUid = evento.id;

	if (evento.tipo === "charge.refunded") {
		const total = obj.amount;
		const devuelto = obj.amountRefunded;

		// Parcial: no es una devolución de la compra sino un ajuste, así que la licencia no se
		// toca. Queda auditado para que se vea en el histórico del cliente.
		//
		// RI-52: con varias licencias en la compra, Stripe tampoco dice cuál se devuelve. Se audita
		// con todas, para que quien emitió el reembolso revoque o acorte la que toque desde
		// administración (licencias.md, «Reembolso parcial: lo que se hace a mano»).
		if (total > 0 && devuelto < total) {
			const cobros = localizarCobros(c);
			auditar(c, "refund", cobros[0]?.license.license_id ?? null, {
				event_uid: eventUid,
				accion: "parcial_sin_efecto",
				amount: total,
				amount_refunded: devuelto,
				licencias: cobros.map((x) => x.license.license_id),
			});
			return { reversed: false, reason: "partial_refund" };
		}

		return revertirCobros(c, { reason: "refund", eventUid });
	}

	const estado = obj.status;

	// AUD-45: una consulta del banco (inquiry) llega como una disputa `warning_*`: el dinero no sale
	// y, si no escala, se cierra `warning_closed`, sin «ganada» que deshaga nada
	// (docs.stripe.com/disputes/how-disputes-work#inquiries). Revocar ahí cortaba el servicio a quien
	// había pagado, para siempre. Sólo se revierte una disputa formal; si una consulta escala, es el
	// mismo objeto Dispute que pasa a `needs_response` y llega `funds_withdrawn`.
	if (evento.tipo === "charge.dispute.created" || evento.tipo === "charge.dispute.funds_withdrawn") {
		if (!ESTADOS_DE_DISPUTA_FORMAL.has(estado)) return auditarConsulta(c, eventUid);

		// Una disputa formal trae los dos eventos (se abre y salen los fondos), en cualquier orden y
		// con reintentos: lo que revirtió el primero no lo vuelve a revertir el segundo, ni resta
		// dos veces los meses de una renovación.
		if (evento.tipo === "charge.dispute.funds_withdrawn") {
			const cobros = localizarCobros(c);
			if (cobros.length > 0 && !quedaPorRevertir(cobros)) {
				return { reversed: false, reason: "already_reversed", license_id: cobros[0].license.license_id };
			}
		}
		return revertirCobros(c, { reason: "dispute", eventUid });
	}

	if (evento.tipo !== "charge.dispute.closed") return { reversed: false, reason: "ignored" };

	// charge.dispute.closed: ganada, se deshace lo que revirtió. Perdida, la reversión se queda, y se
	// revierte lo que siga pendiente: una consulta que escaló sin que llegara `funds_withdrawn`
	// (AUD-45). `warning_closed` es una consulta que no escaló: no hay nada que hacer.
	if (estado === "won") return restaurarCobros(c, eventUid);
	if (estado === "lost" && quedaPorRevertir(localizarCobros(c))) {
		return revertirCobros(c, { reason: "dispute", eventUid });
	}
	return { restored: false, reason: estado || "unknown" };
}

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
function localizarCobros({ sql, objeto }: Contexto): Cobro[] {
	const paymentIntentId = objeto.paymentIntent;

	if (paymentIntentId) {
		const cobros: Cobro[] = [];
		for (const pago of getLicensePaymentsByIntent(sql, paymentIntentId)) {
			const license = leerLicencia(sql, pago.license_id);
			if (license) cobros.push({ license, pago });
		}
		if (cobros.length > 0) return cobros;

		const license = getLicenseByStripeIntent(sql, paymentIntentId);
		if (license) return [{ license, pago: null }];
	}

	if (objeto.customer) {
		const license = getSoleLicenseByStripeCustomer(sql, objeto.customer);
		if (license) return [{ license, pago: null }];
	}

	return [];
}

/** Días que lleva activada la licencia, para ver de un vistazo si el reembolso entró en política. */
function diasActivada(license: LicenseRow, ahoraMs: number): number | null {
	if (!license.activated_at_ms) return null;
	return Math.floor((ahoraMs - license.activated_at_ms) / (24 * 60 * 60 * 1000));
}

/**
 * Deshace los cobros de un cargo: los de todas las licencias de la compra (RI-52). Una renovación
 * devuelta solo pierde los meses que añadió; un alta devuelta revoca la licencia (el cliente no se
 * queda con el producto), salvo que ya estuviera revocada (AUD-08).
 */
function revertirCobros(c: Contexto, rev: Reversion): Record<string, unknown> {
	const { sql, objeto, ahoraMs } = c;
	const cobros = localizarCobros(c);

	if (cobros.length === 0) {
		// Sin licencia atribuible no se toca nada: revocar a ojo sería peor. Queda en el registro
		// del evento y en el log para mirarlo a mano.
		console.warn("[stripe] reversión sin licencia atribuible:", rev.eventUid);
		auditar(c, rev.reason === "dispute" ? "dispute" : "refund", null, {
			event_uid: rev.eventUid,
			resultado: "sin_licencia_atribuible",
			payment_intent: objeto.paymentIntent || null,
		});
		return { reversed: false, reason: "unresolved_license" };
	}

	// Idempotencia: una disputa que se abre y luego se pierde puede traer dos eventos, y Stripe
	// reintenta. Cada cobro solo se revierte una vez.
	const pendientes = cobros.filter((x) => !x.pago?.reversed_at_ms);
	if (pendientes.length === 0) {
		return { reversed: false, reason: "already_reversed", license_id: cobros[0].license.license_id };
	}

	const licencias: { license_id: string; accion: "shortened" | "revoked" | "already_revoked" }[] = [];
	for (const { license, pago } of pendientes) {
		const esRenovacion = pago?.kind === "renewal";
		// AUD-08: un alta que ya estaba revocada (a mano, o tras el reembolso parcial de una compra
		// de varias) no la revoca esta reversión, y su cobro no se marca como revocado por la
		// disputa: si no, ganarla la resucitaría.
		const yaRevocada = !esRenovacion && estaAnulada(license);
		let expiresAtMs: number | null = null;

		if (esRenovacion) {
			expiresAtMs = shortenLicense(sql, license.license_id, pago!.term_months, ahoraMs);
		} else if (!yaRevocada) {
			revokeLicense(sql, license.license_id, ahoraMs);
		}

		if (pago) {
			markLicensePaymentReversed(sql, pago.payment_id, {
				reason: yaRevocada && rev.reason === "dispute" ? DISPUTA_SIN_REVOCAR : rev.reason,
				eventUid: rev.eventUid,
				ahoraMs,
			});
		}

		auditar(c, rev.reason === "dispute" ? "dispute" : "refund", license.license_id, {
			event_uid: rev.eventUid,
			accion: esRenovacion ? "meses_restados" : yaRevocada ? "ya_revocada" : "revocada",
			term_months: pago?.term_months ?? null,
			expires_at_ms: expiresAtMs,
			// Si esto sale alto, el reembolso se emitió fuera de la política de 7 días.
			dias_activada: diasActivada(license, ahoraMs),
			payment_intent: objeto.paymentIntent || null,
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
function restaurarCobros(c: Contexto, eventUid: string): Record<string, unknown> {
	const { sql, ahoraMs } = c;
	const cobros = localizarCobros(c);
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
			clearLicensePaymentReversal(sql, pago.payment_id);
		}
	}
	const aRestaurar = cobros.filter((x) => x.pago?.reversed_reason === "dispute");
	if (aRestaurar.length === 0) return { restored: false, reason: "not_reversed_by_dispute" };

	const restauradas: string[] = [];
	for (const { license, pago } of aRestaurar) {
		if (pago?.kind === "renewal") {
			extendLicense(sql, license.license_id, pago.term_months, ahoraMs);
		} else {
			reactivateLicense(sql, license.license_id, ahoraMs);
		}

		if (pago) clearLicensePaymentReversal(sql, pago.payment_id);

		auditar(c, "reactivate", license.license_id, {
			event_uid: eventUid,
			motivo: "disputa_ganada",
		});
		restauradas.push(license.license_id);
	}

	return { restored: true, license_id: restauradas[0], license_ids: restauradas };
}

/**
 * AUD-45 · ¿Queda algún cobro del cargo sin revertir? Uno con su cobro registrado, si no lleva la
 * marca; una licencia anterior a LIC-07 (sin cobro), si no está revocada.
 */
function quedaPorRevertir(cobros: Cobro[]): boolean {
	return cobros.some(({ license, pago }) => (pago ? !pago.reversed_at_ms : !estaAnulada(license)));
}

/**
 * AUD-45 · Una consulta del banco, o una disputa que no llegó a contracargo (`prevented`), no toca
 * ninguna licencia: queda constancia, como un reembolso parcial, con todas las de la compra.
 */
function auditarConsulta(c: Contexto, eventUid: string): Record<string, unknown> {
	const { objeto } = c;
	const estado = objeto.status;
	const cobros = localizarCobros(c);
	auditar(c, "dispute", cobros[0]?.license.license_id ?? null, {
		event_uid: eventUid,
		accion: "consulta_sin_efecto",
		status: estado || null,
		dispute: objeto.id || null,
		licencias: cobros.map((x) => x.license.license_id),
		payment_intent: objeto.paymentIntent || null,
	});
	return { reversed: false, reason: "not_a_chargeback", status: estado || null };
}

/** Una entrada de la auditoría, con la hora de la operación. */
function auditar(
	{ sql, ahoraMs }: Contexto,
	accion: "refund" | "dispute" | "reactivate",
	licenseId: string | null,
	detalle: Record<string, unknown>,
): void {
	sql.execute({
		sql: INSERTAR_AUDITORIA,
		args: argumentosDeLaAuditoria({ auditId: crypto.randomUUID(), accion, licenseId, detalle, ahoraMs }),
	});
}

/**
 * LIC-07: los cobros a los que apunta un cargo de Stripe (por su PaymentIntent). Uno por licencia
 * de la compra (RI-52): un reembolso total o una disputa los revierte todos.
 */
function getLicensePaymentsByIntent(sql: SqlSync, paymentIntentId: string): LicensePaymentRow[] {
	const r = sql.execute({
		sql: `
    SELECT * FROM license_payments
    WHERE stripe_payment_intent_id = ?
    ORDER BY unidad ASC, at_ms ASC;
    `,
		args: [paymentIntentId],
	});
	return r.rows as unknown as LicensePaymentRow[];
}

/** LIC-07: la licencia sellada con ese PaymentIntent (el último cobro que la tocó). */
function getLicenseByStripeIntent(sql: SqlSync, paymentIntentId: string): LicenseRow | null {
	const r = sql.execute({
		sql: `SELECT * FROM licenses WHERE stripe_payment_intent_id = ? LIMIT 1;`,
		args: [paymentIntentId],
	});
	return (r.rows[0] as unknown as LicenseRow | undefined) ?? null;
}

/**
 * LIC-07: la única licencia de un cliente de Stripe, o `null` si no hay exactamente una.
 *
 * Último recurso para atribuir un reembolso cuyo cargo no está en `license_payments` (una
 * licencia anterior a esa tabla). Se exige unicidad a propósito: revocar a ojo la licencia
 * equivocada de un cliente con varias sería peor que no hacer nada y avisar.
 */
function getSoleLicenseByStripeCustomer(sql: SqlSync, stripeCustomerId: string): LicenseRow | null {
	const r = sql.execute({
		sql: `SELECT * FROM licenses WHERE stripe_customer_id = ? LIMIT 2;`,
		args: [stripeCustomerId],
	});
	const filas = r.rows as unknown as LicenseRow[];
	return filas.length === 1 ? filas[0] : null;
}

/** LIC-07: marca un cobro como devuelto. Impide que dos eventos de Stripe lo reviertan dos veces. */
function markLicensePaymentReversed(
	sql: SqlSync,
	paymentId: string,
	a: { reason: string; eventUid: string; ahoraMs: number },
): void {
	sql.execute({
		sql: `
    UPDATE license_payments
    SET reversed_at_ms=?, reversed_reason=?, reversed_event_uid=?
    WHERE payment_id=? AND reversed_at_ms IS NULL;
    `,
		args: [a.ahoraMs, a.reason, a.eventUid, paymentId],
	});
}

/**
 * LIC-07: deshace la marca de devolución (disputa ganada). Sin esto el cobro quedaría marcado
 * como revertido para siempre y un reembolso posterior del mismo cargo no haría nada.
 */
function clearLicensePaymentReversal(sql: SqlSync, paymentId: string): void {
	sql.execute({
		sql: `
    UPDATE license_payments
    SET reversed_at_ms=NULL, reversed_reason=NULL, reversed_event_uid=NULL
    WHERE payment_id=?;
    `,
		args: [paymentId],
	});
}
