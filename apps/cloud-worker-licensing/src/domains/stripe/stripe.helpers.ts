// src/domains/stripe/stripe.helpers.ts
//
// Verificación de la firma del webhook y lectura de la sesión de checkout. Sin SDK: son dos
// llamadas y un HMAC, y el SDK de Stripe en Workers obliga a usar `constructEventAsync` con un
// `SubtleCryptoProvider` — más dependencia y más filo que hacerlo a mano.

import type { Env } from "../../env";
import { timingSafeEqualHex } from "../../server/utils/crypto";

/**
 * Fijada explícitamente: así los campos de la sesión no cambian bajo nuestros pies.
 * `2025-09-30.clover` (o posterior) es OBLIGATORIA para leer `customer_details.business_name`:
 * el nombre empresarial se añadió en esa versión y con `basil` el campo NO viaja en la respuesta.
 */
const STRIPE_API_VERSION = "2025-09-30.clover";

/** Tolerancia de reloj del webhook (la que recomienda Stripe). Nunca 0: los relojes derivan. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verifica la cabecera `Stripe-Signature: t=<unix>,v1=<hmac_hex>[,v1=…]`.
 *
 * El cuerpo tiene que ser el **crudo**, tal cual llegó: si se reparsea y se vuelve a serializar,
 * un espacio de más cambia el HMAC y la firma deja de cuadrar.
 */
export async function verifyStripeSignature(
	rawBody: string,
	header: string,
	secret: string,
	nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (!secret) return { ok: false, error: "missing_webhook_secret" };
	if (!header) return { ok: false, error: "missing_signature" };

	let t = "";
	const firmas: string[] = [];

	for (const parte of header.split(",")) {
		const [k, v] = parte.split("=", 2);
		if (k?.trim() === "t") t = (v || "").trim();
		if (k?.trim() === "v1") firmas.push((v || "").trim().toLowerCase());
	}

	if (!t || firmas.length === 0) return { ok: false, error: "malformed_signature" };

	// Anti-replay: una firma válida capturada ayer no sirve hoy.
	const tsMs = Number(t) * 1000;
	if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > SIGNATURE_TOLERANCE_MS) {
		return { ok: false, error: "signature_timestamp_out_of_range" };
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${t}.${rawBody}`),
	);
	const esperada = [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Stripe puede mandar varias `v1` durante una rotación del secreto: vale con que una cuadre.
	for (const f of firmas) {
		if (timingSafeEqualHex(esperada, f)) return { ok: true };
	}

	return { ok: false, error: "invalid_signature" };
}

/**
 * Relee la sesión desde la API de Stripe en vez de fiarnos del cuerpo del webhook. Es la
 * recomendación de Stripe para el fulfillment: el evento puede venir recortado, y así además
 * traemos los `line_items` con su `price` (donde vive `metadata.term_months`).
 */
export async function retrieveCheckoutSession(env: Env, sessionId: string): Promise<any> {
	const url = new URL(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`);
	url.searchParams.append("expand[]", "line_items");

	const r = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
			"Stripe-Version": STRIPE_API_VERSION,
		},
	});

	const text = await r.text();
	if (!r.ok) throw new Error(`stripe_retrieve_failed_${r.status}: ${text}`);

	return JSON.parse(text);
}

/**
 * Duración comprada, leída de `metadata.term_months` del Price (decisión §0: se pueden crear
 * precios nuevos sin desplegar el worker).
 *
 * **Fail-closed**: si el Price no la trae, o no es 1/3/12, devolvemos `null` y NO se emite nada.
 * Antes emitir una licencia sin saber cuánto dura que regalar un año por un descuido en Stripe.
 */
export function termMonthsFromSession(session: any): number | null {
	const items: any[] = session?.line_items?.data ?? [];

	for (const item of items) {
		const raw =
			item?.price?.metadata?.term_months ?? item?.price?.product?.metadata?.term_months;
		const n = Number(raw);
		if (n === 1 || n === 3 || n === 12) return n;
	}

	return null;
}

/**
 * Qué es esta compra (REV-13).
 *
 * **Una compra tiene que decir lo que es.** Antes no lo decía y el worker lo adivinaba: si el
 * cliente de Stripe ya tenía una licencia viva, la compra nueva la extendía. Un dueño que abría un
 * segundo local pagaba y no recibía clave — se le alargaba la del primero —, y quien compraba sin
 * haber estrenado la anterior acababa con una sola clave de veinticuatro meses. No era un caso
 * raro: era todo el que compra dos veces.
 *
 * Sale del `metadata.intent` del Price, por el mismo camino que `term_months`: así se pueden crear
 * precios nuevos sin desplegar el worker. Un Price marcado `intent=renewal` renueva; cualquier
 * otro, incluido el que no traiga nada, es un **alta**.
 *
 * **El defecto es «alta» a propósito, y es la mitad importante de esta función.** Un Price al que
 * se le olvide el metadata vende una licencia de más: molesto, visible y con arreglo (se usa o se
 * devuelve). Al revés —dar por renovación lo que no lo es— es lo que ya pasaba: alguien paga y no
 * recibe nada, y eso no lo arregla ningún correo.
 */
export type IntencionDeCompra = "alta" | "renovacion";

export function intencionDeLaCompra(session: any): IntencionDeCompra {
	const items: any[] = session?.line_items?.data ?? [];

	for (const item of items) {
		const raw = item?.price?.metadata?.intent ?? item?.price?.product?.metadata?.intent;
		if (String(raw ?? "").trim().toLowerCase() === "renewal") return "renovacion";
	}

	return "alta";
}

/**
 * QUÉ licencia renueva esta compra (REV-13): el `license_id` que el enlace de renovación lleva en
 * `client_reference_id`.
 *
 * Sin esto, «renovación» seguiría siendo una adivinanza en cuanto alguien tenga dos locales: hay
 * que saber cuál de las dos licencias se alarga. Lo pone `enlaceDeRenovacion` al construir la URL
 * que va en el correo de aviso, y Stripe lo devuelve tal cual en la sesión.
 *
 * Se filtra contra el alfabeto que Stripe acepta en ese campo (alfanuméricos, `-` y `_`, 200
 * caracteres) para no arrastrar basura hasta una consulta.
 */
export function licenseIdFromSession(session: any): string | null {
	const raw = String(session?.client_reference_id ?? "").trim();
	if (!raw || raw.length > 200) return null;
	return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

export function customerEmailFromSession(session: any): string | null {
	const email =
		session?.customer_details?.email ?? session?.customer_email ?? null;
	return email ? String(email).trim().toLowerCase() : null;
}

export function customerNameFromSession(session: any): string | null {
	const d = session?.customer_details;
	// `name` es el campo clásico; `individual_name` / `collected_information` cubren la recogida
	// granular de nombres (name_collection, API clover), por si `name` no viniera relleno.
	const name =
		d?.name ?? d?.individual_name ?? session?.collected_information?.individual_name ?? null;
	return name ? String(name).trim() : null;
}

/** Nombre empresarial (checkbox "Recopilar nombres empresariales"). Nuevo en la API clover. */
export function customerBusinessNameFromSession(session: any): string | null {
	const bn =
		session?.customer_details?.business_name ??
		session?.collected_information?.business_name ??
		null;
	return bn ? String(bn).trim() : null;
}

/** Teléfono (checkbox "Solicitar número de teléfono"). */
export function customerPhoneFromSession(session: any): string | null {
	const p = session?.customer_details?.phone ?? null;
	return p ? String(p).trim() : null;
}

/**
 * Dirección de facturación como JSON (checkbox "Recolecta las direcciones"). Se guarda entera
 * para la factura que el negocio emite luego a mano; `null` si Stripe no mandó ningún campo.
 */
export function customerAddressJsonFromSession(session: any): string | null {
	const a = session?.customer_details?.address ?? null;
	if (!a) return null;
	const addr = {
		line1: a.line1 ?? null,
		line2: a.line2 ?? null,
		city: a.city ?? null,
		state: a.state ?? null,
		postal_code: a.postal_code ?? null,
		country: a.country ?? null,
	};
	const tieneAlgo = Object.values(addr).some((v) => v != null && String(v).trim() !== "");
	return tieneAlgo ? JSON.stringify(addr) : null;
}

/** El `customer` puede venir como id o como objeto expandido. */
export function customerIdFromSession(session: any): string | null {
	const c = session?.customer;
	if (!c) return null;
	return typeof c === "string" ? c : String(c.id || "") || null;
}

export function paymentIntentIdFromSession(session: any): string | null {
	const p = session?.payment_intent;
	if (!p) return null;
	return typeof p === "string" ? p : String(p.id || "") || null;
}

export function priceIdFromSession(session: any): string | null {
	const items: any[] = session?.line_items?.data ?? [];
	const id = items[0]?.price?.id;
	return id ? String(id) : null;
}
