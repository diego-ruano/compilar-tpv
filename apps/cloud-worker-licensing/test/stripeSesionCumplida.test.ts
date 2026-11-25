// test/stripeSesionCumplida.test.ts
//
// REV-01 · Una entrega de una sesión de Stripe que ya se cumplió sale como siempre, sin preparar
// claves.
//
// Stripe vuelve a entregar un evento que contestó 500, o entrega otro de la misma sesión. Si la sesión
// ya se cumplió, `cumplir` lo mira antes de nada, con la misma consulta que `emitirCobro`
// (`COBROS_DE_LA_SESION`), y la entrega contesta 200 sin tocar la central. Preparar y cifrar las
// claves de una sesión que no las va a usar podía fallar, con `LICENSE_STORE_KEY` presente pero
// inservible, y convertir esa entrega en un 500 que Stripe reintentaría sin que hubiera nada que
// hacer. Una sesión nueva con esa clave sí falla, como siempre: sin cifrar la clave no se emite. Que
// dos entregas de la misma sesión a la vez emitan una sola vez lo decide `emitirCobro` dentro de su
// transacción (`centralCarreras.test.ts`).
//
// Por la ruta de verdad (`POST /v1/stripe/webhook`, firmada con HMAC como la firma Stripe), con la
// sesión que devolvería la API de Stripe (el `fetch` sustituido) y la base central de verdad
// (`helpers/central.ts`).

import { afterEach, describe, expect, it, vi } from "vitest";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { cumplir, stripeRoutes } from "../src/domains/stripe/stripe.routes";

/** Clave AES de pruebas (32 bytes), con la que se cumple la primera entrega. */
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
/** Presente, pero no da 32 bytes: con ella no se cifra nada. */
const CLAVE_INSERVIBLE = "AAAA";
const WHSEC = "whsec_de_pruebas_sesion_cumplida";

/** Una sesión de checkout pagada, con la forma que devuelve la API de Stripe. */
const sesion = (id: string) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: "cus_sesion_cumplida",
	payment_intent: `pi_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: "12" } } }] },
});

/** El evento de un pago completado de `sesionId`, como lo entrega Stripe. */
const pagoCompletado = (eventId: string, sesionId: string) => ({
	id: eventId,
	object: "event",
	type: "checkout.session.completed",
	data: { object: { id: sesionId, object: "checkout.session" } },
});

/** Cabecera `stripe-signature` como la calcula Stripe: HMAC-SHA256 de `t.cuerpo`. */
async function firmar(raw: string): Promise<string> {
	const t = Math.floor(Date.now() / 1000);
	const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(WHSEC), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${raw}`));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `t=${t},v1=${hex}`;
}

/** La API de Stripe: devuelve la sesión que se le pide, si la conoce. */
function conLaApiDeStripe(sesiones: Record<string, unknown>): void {
	vi.stubGlobal("fetch", async (url: string) => {
		const s = sesiones[new URL(url).pathname.split("/").at(-1) ?? ""];
		return s ? Response.json(s) : new Response("{}", { status: 404 });
	});
}

/** Entrega `evento` al webhook, firmado, con la central `central` y `LICENSE_STORE_KEY` inservible. */
async function entregar(central: CentralDePrueba, evento: unknown) {
	const raw = JSON.stringify(evento);
	const res = await stripeRoutes.fetch(
		new Request("https://api/webhook", {
			method: "POST",
			headers: { "stripe-signature": await firmar(raw), "content-type": "application/json" },
			body: raw,
		}),
		{
			...central.entorno,
			LICENSE_STORE_KEY: CLAVE_INSERVIBLE,
			STRIPE_SECRET_KEY: "sk_test_ficticia",
			STRIPE_WEBHOOK_SECRET: WHSEC,
		} as any,
	);
	return { status: res.status, body: await res.json() };
}

const marcaDelEvento = (central: CentralDePrueba, eventId: string) =>
	filasDe(central, "SELECT processed_ok, error_text FROM webhook_events WHERE event_uid = ?;", eventId);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("REV-01 · con `LICENSE_STORE_KEY` presente pero inservible", () => {
	it("una sesión ya cumplida: 200, como siempre, sin tocar sus licencias, y el evento queda hecho", async () => {
		const central = await centralDePrueba();
		const primera = await cumplir({ LICENSE_STORE_KEY: STORE_KEY } as any, central.db, sesion("cs_cumplida"));
		if (primera.accion !== "emitida") throw new Error(`alta inesperada: ${primera.accion}`);
		const licencias = await filasDe(central, "SELECT * FROM licenses ORDER BY rowid;");
		conLaApiDeStripe({ cs_cumplida: sesion("cs_cumplida") });

		const r = await entregar(central, pagoCompletado("evt_otra_vez", "cs_cumplida"));

		expect(r).toEqual({ status: 200, body: { ok: true, received: true } });
		expect(await filasDe(central, "SELECT * FROM licenses ORDER BY rowid;")).toEqual(licencias);
		expect(await marcaDelEvento(central, "evt_otra_vez")).toEqual([{ processed_ok: 1, error_text: null }]);
		// Y lo que contesta `cumplir` son las licencias de la primera.
		expect(await cumplir({ LICENSE_STORE_KEY: CLAVE_INSERVIBLE } as any, central.db, sesion("cs_cumplida"))).toEqual({
			accion: "ya_cumplida",
			license_ids: primera.license_ids,
		});
	});

	it("una sesión nueva sigue fallando: 500, sin licencias, y el evento queda para que Stripe lo repita", async () => {
		const central = await centralDePrueba();
		conLaApiDeStripe({ cs_nueva: sesion("cs_nueva") });

		const r = await entregar(central, pagoCompletado("evt_nuevo", "cs_nueva"));

		expect(r).toEqual({ status: 500, body: { ok: false, error: "fulfillment_failed" } });
		expect(await filasDe(central, "SELECT COUNT(*) AS n FROM licenses;")).toEqual([{ n: 0 }]);
		expect(await marcaDelEvento(central, "evt_nuevo")).toEqual([
			{ processed_ok: 0, error_text: "LICENSE_STORE_KEY must decode to 32 bytes" },
		]);
	});
});
