// test/topeAnonimo.test.ts
//
// AUD-34 · Las rutas anónimas con cuerpo leían el cuerpo entero, de cualquier tamaño, antes de saber
// quién llamaba: el webhook de Stripe lo pasaba además por el HMAC con una firma inventada, y el
// emparejamiento y las licencias lo parseaban antes de validar. Ahora llevan un tope delante
// (`lib/validacion.ts::topeAnonimo`): 8 KiB, y 4 MiB el webhook.
//
// Por la entrada real del worker (`src/index.ts`), con el cuerpo servido como un ReadableStream que
// cuenta lo que se le ha pedido: así se ve cuánto lee de verdad el worker, no sólo qué contesta. La
// firma de Stripe es la real (envuelta para anotar cuántos caracteres le llegan). La base central no
// se toca: una consulta queda anotada y lanza.
//
// Y que el tope no rompe lo legítimo: la activación más grande que acepta el schema, firmada como la
// manda la Main (AUD-01); un cuerpo justo del tamaño del tope en cada ruta; y el evento más grande
// que manda Stripe a los suscritos, una disputa con las pruebas y los metadatos al máximo.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

import { activacionFirmada, clavePublica } from "./helpers/activar";

const { tamanos, consultas } = vi.hoisted(() => ({ tamanos: [] as number[], consultas: [] as string[] }));

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return {
		...original,
		getDb: () => ({
			execute: (q: any) => {
				consultas.push(String(q?.sql ?? q));
				throw new Error("no debe tocar la base");
			},
		}),
	};
});

vi.mock("../src/domains/stripe/stripe.helpers", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/domains/stripe/stripe.helpers")>();
	return {
		...real,
		verifyStripeSignature: (raw: string, h: string, s: string, now?: number) => {
			tamanos.push(raw.length);
			return real.verifyStripeSignature(raw, h, s, now);
		},
	};
});

const { default: worker } = await import("../src/index");
const { TOPE_ANONIMO } = await import("../src/lib/validacion");
const { activarSchema } = await import("../src/domains/licensing/licensing.schemas");

const KiB = 1024;
const MiB = 1024 * KiB;
const TRES_MIB = 3 * MiB;
const TOPE_WEBHOOK = 4 * MiB;
/** Lo que entrega el stream de una vez: sin `Content-Length`, el tope deja de leer al pasarse. */
const TROZO = 64 * KiB;

/** Un limitador por IP que deja pasar (lo normal para la primera petición de una IP). */
const dejaPasar = { limit: async () => ({ success: true }) };

const ENV = {
	STRIPE_SECRET_KEY: "sk_test_ficticia",
	STRIPE_WEBHOOK_SECRET: "whsec_ficticio",
	LICENSE_STORE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	TURSO_DATABASE_URL: "libsql://ficticia.invalid",
	TURSO_AUTH_TOKEN: "ficticio",
	EMAIL_FROM_ADDRESS: "licencias@ejemplo.test",
	LIMITADOR_CLAIM: dejaPasar,
	LIMITADOR_LICENCIA: dejaPasar,
} as any;

/** Bytes servidos en trozos, contando cuántos ha pedido quien lee. */
function cuerpoContado(bytes: Uint8Array) {
	let pos = 0;
	const contador = { leidos: 0 };
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(ctrl) {
				if (pos >= bytes.length) {
					ctrl.close();
					return;
				}
				const fin = Math.min(pos + TROZO, bytes.length);
				ctrl.enqueue(bytes.slice(pos, fin));
				contador.leidos = fin;
				pos = fin;
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, contador };
}

const bytes = (s: string) => new TextEncoder().encode(s);
/** Un JSON de exactamente `n` bytes (n ≥ 14). */
const jsonDe = (n: number) => bytes(JSON.stringify({ relleno: "x".repeat(n - 14) }));

/** Una cabecera con la forma de la de Stripe y la hora de ahora: lo único que se mira antes del HMAC. */
const firmaConForma = () => `t=${Math.floor(Date.now() / 1000)},v1=00`;

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Un JWT con la firma vacía: `/refresh` lee sus claims sin verificarlo. */
const JWT_SIN_FIRMA =
	`${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.` +
	`${b64url(JSON.stringify({ tenantId: "t", deviceId: "d", licHash: "h" }))}.`;

/** Por la entrada real del worker, con o sin `Content-Length`. */
async function pedir(ruta: string, cuerpo: Uint8Array, cabeceras: Record<string, string> = {}, conLongitud = false) {
	const { stream, contador } = cuerpoContado(cuerpo);
	const headers = { ...cabeceras, ...(conLongitud ? { "content-length": String(cuerpo.length) } : {}) };
	const req = new Request(`https://tpv-api.test${ruta}`, { method: "POST", headers, body: stream, duplex: "half" } as any);
	expect(req.headers.has("content-length")).toBe(conLongitud);
	const ctx = createExecutionContext();
	const res = await worker.fetch!(req as any, ENV, ctx);
	await waitOnExecutionContext(ctx);
	return { status: res.status, cuerpo: (await res.json()) as any, leidos: contador.leidos };
}

beforeEach(() => {
	tamanos.length = 0;
	consultas.length = 0;
});

const JSON_CT = { "Content-Type": "application/json" };

/**
 * Cada ruta anónima con lo que contesta a un cuerpo pequeño que su validador rechaza: lo que se ve
 * cuando el tope deja pasar. Ninguna de esas respuestas toca la base.
 */
const FAMILIAS: { ruta: string; tope: number; cabeceras: Record<string, string>; siPasa: { status: number; error: string } }[] = [
	{ ruta: "/v1/pair/claim", tope: TOPE_ANONIMO, cabeceras: JSON_CT, siPasa: { status: 400, error: "invalid_pair_code" } },
	{ ruta: "/v1/pair/fetch-token", tope: TOPE_ANONIMO, cabeceras: JSON_CT, siPasa: { status: 400, error: "missing_pairCode" } },
	{ ruta: "/v1/pair/cancel", tope: TOPE_ANONIMO, cabeceras: JSON_CT, siPasa: { status: 400, error: "missing_pairCode" } },
	// Sin las cabeceras de la firma (AUD-01) no se lee el cuerpo, pero el tope va antes.
	{ ruta: "/v1/license/activate", tope: TOPE_ANONIMO, cabeceras: JSON_CT, siPasa: { status: 401, error: "missing_device_proof" } },
	{ ruta: "/v1/license/device-change/request", tope: TOPE_ANONIMO, cabeceras: JSON_CT, siPasa: { status: 400, error: "validation_error" } },
	{
		ruta: "/v1/license/refresh",
		tope: TOPE_ANONIMO,
		cabeceras: { authorization: `Bearer ${JWT_SIN_FIRMA}` },
		siPasa: { status: 401, error: "missing_device_proof" },
	},
	{ ruta: "/v1/stripe/webhook", tope: TOPE_WEBHOOK, cabeceras: { "stripe-signature": "t=1,v1=00" }, siPasa: { status: 400, error: "signature_timestamp_out_of_range" } },
];

describe("AUD-34 · una ruta anónima no lee un cuerpo que pasa de su tope", () => {
	for (const f of FAMILIAS) {
		/** Muy por encima de su tope: 3 MiB, o el doble del tope del webhook. */
		const grande = Math.max(TRES_MIB, 2 * f.tope);

		it(`${f.ruta}: ${grande / MiB} MiB → 413 sin leer nada con Content-Length, y sin él deja de leer al pasarse`, async () => {
			const con = await pedir(f.ruta, jsonDe(grande), f.cabeceras, true);
			expect(con.status).toBe(413);
			expect(con.cuerpo.error).toBe("payload_too_large");
			expect(con.leidos).toBe(0);

			const sin = await pedir(f.ruta, jsonDe(grande), f.cabeceras);
			expect(sin.status).toBe(413);
			expect(sin.cuerpo.error).toBe("payload_too_large");
			expect(sin.leidos).toBeLessThanOrEqual(f.tope + TROZO);

			expect(tamanos).toEqual([]);
			expect(consultas).toEqual([]);
		});

		it(`${f.ruta}: un cuerpo justo del tamaño del tope pasa; uno de un byte más, no`, async () => {
			for (const conLongitud of [true, false]) {
				const justo = await pedir(f.ruta, jsonDe(f.tope), f.cabeceras, conLongitud);
				expect({ status: justo.status, error: justo.cuerpo.error }).toEqual(f.siPasa);
				const pasado = await pedir(f.ruta, jsonDe(f.tope + 1), f.cabeceras, conLongitud);
				expect(pasado.status).toBe(413);
			}
			expect(consultas).toEqual([]);
		});
	}

	it("/v1/license/refresh sin cuerpo, como lo manda el cliente, sigue a la prueba del equipo", async () => {
		const req = new Request("https://tpv-api.test/v1/license/refresh", {
			method: "POST",
			headers: { authorization: `Bearer ${JWT_SIN_FIRMA}` },
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch!(req as any, ENV, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(401);
		expect(((await res.json()) as any).error).toBe("missing_device_proof");
	});
});

/**
 * El `charge.dispute.closed` más grande con campos válidos: las pruebas de la disputa, que Stripe
 * limita a 150 000 caracteres entre todos sus campos, y 50 metadatos con la clave de 40 caracteres y
 * el valor de 500. En el peor caso cada carácter está fuera del plano básico y viaja escapado como un
 * par de suplentes, doce bytes. Alrededor, el resto del objeto: lo que tiene una disputa, con sus dos
 * movimientos de saldo.
 */
function disputaMasGrande(): string {
	/** Un emoji (U+1F600) escapado en JSON: doce bytes de texto. */
	const EMOJI = "\\ud83d\\ude00";
	const texto = (n: number) => EMOJI.repeat(n);
	// Claves distintas: la última, otro emoji de la misma tanda (U+1F600 + i).
	const clave = (i: number) => texto(39) + "\\ud83d\\ude" + i.toString(16).padStart(2, "0");
	const metadatos = `{${Array.from({ length: 50 }, (_, i) => `"${clave(i)}":"${texto(500)}"`).join(",")}}`;

	const movimiento = (id: string, importe: number) => ({
		id,
		object: "balance_transaction",
		amount: importe,
		available_on: 1767225600,
		created: 1767225600,
		currency: "eur",
		description: "Chargeback withdrawal for ch_3QaUd34AbCdEfGhIjKlMnOpQ",
		exchange_rate: null,
		fee: 1500,
		fee_details: [{ amount: 1500, application: null, currency: "eur", description: "Dispute fee", type: "stripe_fee" }],
		net: importe - 1500,
		reporting_category: "dispute",
		source: "dp_1QaUd34AbCdEfGhIjKlMnOpQ",
		status: "available",
		type: "adjustment",
	});
	const pruebasVacias = Object.fromEntries(
		[
			"access_activity_log", "billing_address", "cancellation_policy", "cancellation_policy_disclosure",
			"cancellation_rebuttal", "customer_communication", "customer_email_address", "customer_name",
			"customer_purchase_ip", "customer_signature", "duplicate_charge_documentation",
			"duplicate_charge_explanation", "duplicate_charge_id", "product_description", "receipt",
			"refund_policy", "refund_policy_disclosure", "refund_refusal_explanation", "service_date",
			"service_documentation", "shipping_address", "shipping_carrier", "shipping_date",
			"shipping_documentation", "shipping_tracking_number", "uncategorized_file",
		].map((k) => [k, null]),
	);
	const evento = {
		id: "evt_1QaUd34AbCdEfGhIjKlMnOpQ",
		object: "event",
		api_version: "2026-10-28.clover",
		created: 1767225600,
		data: {
			object: {
				id: "dp_1QaUd34AbCdEfGhIjKlMnOpQ",
				object: "dispute",
				amount: 39900,
				balance_transactions: [movimiento("txn_1QaUd34Retirada", -39900), movimiento("txn_1QaUd34Devuelta", 39900)],
				charge: "ch_3QaUd34AbCdEfGhIjKlMnOpQ",
				created: 1767225600,
				currency: "eur",
				enhanced_eligibility_types: [],
				evidence: { ...pruebasVacias, enhanced_evidence: {}, uncategorized_text: "__PRUEBAS__" },
				evidence_details: { due_by: 1768089600, enhanced_eligibility: {}, has_evidence: true, past_due: false, submission_count: 1 },
				is_charge_refundable: false,
				livemode: true,
				metadata: "__METADATOS__",
				payment_intent: "pi_3QaUd34AbCdEfGhIjKlMnOpQ",
				payment_method_details: { card: { brand: "visa", case_type: "chargeback", network_reason_code: "10.4" }, type: "card" },
				reason: "fraudulent",
				status: "won",
			},
		},
		livemode: true,
		pending_webhooks: 1,
		request: { id: null, idempotency_key: null },
		type: "charge.dispute.closed",
	};
	return JSON.stringify(evento)
		.replace('"__PRUEBAS__"', `"${texto(150_000)}"`)
		.replace('"__METADATOS__"', metadatos);
}

describe("AUD-34 · el tope no corta nada legítimo", () => {
	it("la activación más grande que acepta el schema, firmada, llega entera a la ruta", async () => {
		// Todos los campos en su tope y en caracteres de tres bytes («€»).
		const largo = (n: number) => "€".repeat(n);
		const datos = {
			activationKey: largo(256),
			deviceId: largo(200),
			devicePubKey: await clavePublica(41),
			instanceName: largo(200),
			tenantInfo: { displayName: largo(200), legalName: largo(200), phone: largo(50), country: largo(100) },
			deviceChangeCode: "123456",
			soloSumar: true,
			tenantActual: largo(200),
		};
		expect(activarSchema.safeParse(datos).success).toBe(true);
		const peticion = await activacionFirmada(datos);
		const cuerpo = bytes(peticion.body);
		expect(cuerpo.length).toBeLessThan(5 * KiB);

		for (const conLongitud of [true, false]) {
			const r = await pedir("/v1/license/activate", cuerpo, peticion.headers, conLongitud);
			// Pasa el tope, la firma (que cubre esos mismos bytes) y el validador: la clave no tiene la
			// forma de una de verdad y la ruta contesta antes de leer ninguna fila.
			expect({ status: r.status, error: r.cuerpo.error }).toEqual({ status: 404, error: "license_not_found" });
		}
		expect(consultas).toEqual([]);
	});

	it("lo que manda la Handy al emparejarse no pasa de medio KB", () => {
		const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(200)));
		const deviceId = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
		const cuerpos = [
			{ pairCode: "123456", pairSecret: b64(32), deviceId, devicePubKey: b64(32), deviceName: "" },
			{ pairCode: "123456", deviceId, nonceB64: b64(32), ts: Date.now(), sigB64: b64(64) },
		];
		for (const c of cuerpos) expect(bytes(JSON.stringify(c)).length).toBeLessThan(512);
	});

	it("webhook: un evento de 16 KiB llega a la firma", async () => {
		const r = await pedir("/v1/stripe/webhook", bytes("x".repeat(16 * KiB)), { "stripe-signature": firmaConForma() });
		expect(r.status).toBe(400);
		expect(r.cuerpo.error).toBe("invalid_signature");
		expect(tamanos).toEqual([16 * KiB]);
	});

	it("webhook: la disputa cerrada más grande que puede mandar Stripe llega a la firma", async () => {
		const evento = disputaMasGrande();
		const cuerpo = bytes(evento);

		// Es un evento válido, con las pruebas y los metadatos en sus máximos.
		const disputa = JSON.parse(evento).data.object;
		expect([...disputa.evidence.uncategorized_text]).toHaveLength(150_000);
		expect(Object.keys(disputa.metadata)).toHaveLength(50);
		for (const [k, v] of Object.entries(disputa.metadata)) {
			expect([...k]).toHaveLength(40);
			expect([...(v as string)]).toHaveLength(500);
		}
		// Unos 2,1 MB: no cabía en 1 MiB, y en el tope sobra casi otro tanto.
		expect(cuerpo.length).toBeGreaterThan(2_100_000);
		expect(cuerpo.length).toBeLessThan(TOPE_WEBHOOK);

		for (const conLongitud of [true, false]) {
			tamanos.length = 0;
			const r = await pedir("/v1/stripe/webhook", cuerpo, { "stripe-signature": firmaConForma() }, conLongitud);
			expect(r.status).toBe(400);
			expect(r.cuerpo.error).toBe("invalid_signature");
			expect(tamanos).toEqual([cuerpo.length]);
		}
	});
});
