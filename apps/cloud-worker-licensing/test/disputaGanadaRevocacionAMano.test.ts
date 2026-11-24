// test/disputaGanadaRevocacionAMano.test.ts
//
// AUD-08 — una disputa ganada deshace lo que revirtió esa disputa, y sólo eso: una licencia que el
// operador revocó a mano no vuelve a trabajar porque se gane una disputa sobre su cargo.
//
// Antes, revocar a mano no dejaba rastro en el cobro. Al abrirse una disputa, la reversión
// «revocaba» la licencia ya revocada y marcaba su cobro `dispute`; al ganarla, la restauración la
// dejaba `active` (o `issued`) y el TPV volvía a trabajar. Igual si se revocaba con la disputa
// abierta o la licencia no tenía cobro registrado. Y tras el reembolso parcial de una compra de
// varias, la clave devuelta y revocada a mano volvía a `issued` y se podía canjear.
//
// Recorre las rutas de verdad: la revocación por `POST /v1/admin/licenses/:id/revoke` (con su
// token) y los eventos por `POST /v1/stripe/webhook`, firmados con HMAC como los firma Stripe. La
// compra la cumple `cumplir` con la sesión ya leída, igual que el webhook de pago tras pedírsela a
// Stripe, así que no se llama a su API. La base es la central de verdad (`helpers/central.ts`), a la
// que las dos rutas llegan por `getDb`, como en producción. El `TenantHub` al que la revocación avisa
// es un doble, y sin `EMAIL_FROM_ADDRESS` el correo de las claves no sale.

import { describe, it, expect } from "vitest";

import { centralDePrueba, conFalloEnLasOperaciones, filasDe } from "./helpers/central";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { cumplir, stripeRoutes } from "../src/domains/stripe/stripe.routes";
import { computeLicenseState } from "../src/domains/licensing/licensing.helpers";
import type { ClienteCentral } from "../src/server/central/cliente";
import { activateLicenseFirstTime, getLicenseById, issueLicense, type LicenseRow } from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ADMIN_TOKEN = "token-admin-de-pruebas-aud08";
const WHSEC = "whsec_de_pruebas_aud08";
const CUSTOMER = "cus_aud08";

/** El TenantHub al que la revocación le pide cerrar el socket de la Main: aquí no hace nada. */
const hubFalso = {
	idFromName: (nombre: string) => ({ nombre }),
	get: () => ({ revocarDispositivo: async () => {} }),
};

/** El `Env` que ven las rutas, sin la central: cada escenario le pone la suya. */
const ENV = {
	ADMIN_API_TOKEN: ADMIN_TOKEN,
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-aud08",
	STRIPE_SECRET_KEY: "sk_test_ficticia",
	STRIPE_WEBHOOK_SECRET: WHSEC,
	TenantHub: hubFalso,
} as any;

/** Cabecera `stripe-signature` como la calcula Stripe: HMAC-SHA256 de `t.cuerpo`. */
async function firmar(raw: string): Promise<string> {
	const t = Math.floor(Date.now() / 1000);
	const clave = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(WHSEC),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${raw}`));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `t=${t},v1=${hex}`;
}

let siguienteEvento = 0;
const idEvento = () => `evt_aud08_${++siguienteEvento}`;

/**
 * Un evento de disputa con la forma del objeto Dispute de la API de Stripe: lleva `charge` y
 * `payment_intent`, y NO lleva `customer` (https://docs.stripe.com/api/disputes/object).
 */
const disputa = (pi: string, tipo: "created" | "closed", status = "needs_response") => ({
	id: idEvento(),
	object: "event",
	type: `charge.dispute.${tipo}`,
	data: {
		object: {
			id: `du_${pi}`,
			object: "dispute",
			charge: `ch_${pi}`,
			payment_intent: pi,
			amount: 12000,
			status,
		},
	},
});

/** `charge.refunded`: el objeto es el cargo, con lo cobrado y lo devuelto en céntimos. */
const reembolso = (pi: string, total: number, devuelto: number) => ({
	id: idEvento(),
	object: "event",
	type: "charge.refunded",
	data: {
		object: {
			id: `ch_${pi}`,
			object: "charge",
			payment_intent: pi,
			customer: CUSTOMER,
			amount: total,
			amount_refunded: devuelto,
		},
	},
});

/** Una sesión de checkout pagada con `unidades` licencias anuales (RI-52), como la devuelve Stripe. */
const sesion = (id: string, unidades: number) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: `pi_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: {
		data: [{ quantity: unidades, price: { id: "price_anual", metadata: { term_months: "12" } } }],
	},
});

type Escenario = {
	db: ClienteCentral;
	/** El `Env` con el que llegan las rutas a la central del escenario. */
	env: any;
	/** Compra por Stripe con `cumplir`: una licencia (y un cobro) por unidad. Devuelve sus ids. */
	comprar: (sesionId: string, unidades?: number) => Promise<string[]>;
	activar: (licenseId: string, deviceId: string) => Promise<void>;
	/** `POST /v1/admin/licenses/:id/revoke` con el token de administración. */
	revocarAMano: (licenseId: string) => Promise<number>;
	/** `POST /v1/admin/licenses/:id/unrevoke` con el token de administración. */
	desrevocarAMano: (licenseId: string) => Promise<number>;
	/** `POST /v1/stripe/webhook` firmado. Devuelve el estado HTTP y el JSON. */
	webhook: (evento: unknown) => Promise<{ status: number; body: any }>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	cobros: (licenseId: string) => Promise<any[]>;
	auditoria: (licenseId: string) => Promise<{ action: string; detail: any }[]>;
	/**
	 * A partir de aquí, las operaciones que piden las rutas fallan tras la primera sentencia que case
	 * con `patron` (para simular un fallo a mitad); con `null`, ya no.
	 */
	conFallo: (patron: RegExp | null) => void;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const db = central.db;
	let env = { ...ENV, ...central.entorno };
	const admin = async (ruta: string) =>
		await adminRoutes.fetch(
			new Request(`https://api${ruta}`, {
				method: "POST",
				headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
				body: "{}",
			}),
			env,
		);

	{
		const e: Escenario = {
			db,
			get env() {
				return env;
			},
			async comprar(sesionId, unidades = 1) {
				const r = await cumplir(ENV, db, sesion(sesionId, unidades));
				if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
				return r.license_ids;
			},
			async activar(licenseId, deviceId) {
				const ok = await activateLicenseFirstTime(db, {
					licenseId,
					tenantId: `tenant-${deviceId}`,
					deviceId,
					termMonths: 12,
				});
				if (ok === null) throw new Error("no se activó");
			},
			async revocarAMano(licenseId) {
				return (await admin(`/licenses/${licenseId}/revoke`)).status;
			},
			async desrevocarAMano(licenseId) {
				return (await admin(`/licenses/${licenseId}/unrevoke`)).status;
			},
			async webhook(evento) {
				const raw = JSON.stringify(evento);
				const res = await stripeRoutes.fetch(
					new Request("https://api/webhook", {
						method: "POST",
						headers: { "stripe-signature": await firmar(raw), "content-type": "application/json" },
						body: raw,
					}),
					env,
				);
				return { status: res.status, body: await res.json() };
			},
			async leer(licenseId) {
				return (await getLicenseById(db, licenseId))!;
			},
			cobros(licenseId) {
				return filasDe(
					central,
					`SELECT kind, unidad, reversed_reason, reversed_at_ms FROM license_payments
					 WHERE license_id = ? ORDER BY unidad;`,
					licenseId,
				);
			},
			async auditoria(licenseId) {
				const filas = await filasDe(
					central,
					`SELECT action, detail FROM admin_audit WHERE license_id = ? ORDER BY at_ms, rowid;`,
					licenseId,
				);
				return filas.map((f) => ({ action: String(f.action), detail: JSON.parse(String(f.detail)) }));
			},
			conFallo(patron) {
				env = { ...ENV, ...(patron ? conFalloEnLasOperaciones(central, patron) : central).entorno };
			},
		};

		return fn(e);
	}
}

/** Lo que decide si el TPV trabaja: el estado de la fila y lo que firma `/status`. */
const estado = (l: LicenseRow, deviceId: string) => ({
	status: l.status,
	disabled: Number(l.disabled),
	gate: computeLicenseState(l, deviceId, Date.now()),
});

const REVOCADA = { status: "revoked", disabled: 1, gate: "revoked" };
const ACTIVA = { status: "active", disabled: 0, gate: "active" };

/* ── Los escenarios ─────────────────────────────────────────────────────────────────────────── */

/** (1) Revocada a mano ANTES de la disputa (abuso, error, o la licencia del reembolso parcial). */
async function revocadaAntes(e: Escenario) {
	const [lic] = await e.comprar("cs_uno");
	await e.activar(lic, "device-main");
	const revocar = await e.revocarAMano(lic);

	const abrir = await e.webhook(disputa("pi_cs_uno", "created"));
	const cobroTrasAbrir = (await e.cobros(lic))[0];
	const ganar = await e.webhook(disputa("pi_cs_uno", "closed", "won"));

	return {
		lic,
		revocar,
		abrir,
		cobroTrasAbrir,
		ganar,
		cobroTrasGanar: (await e.cobros(lic))[0],
		final: estado(await e.leer(lic), "device-main"),
		auditoria: await e.auditoria(lic),
	};
}

/** (2) Revocada a mano MIENTRAS la disputa está abierta. */
async function revocadaDurante(e: Escenario) {
	const [lic] = await e.comprar("cs_dos");
	await e.activar(lic, "device-main");
	const abrir = await e.webhook(disputa("pi_cs_dos", "created"));
	const cobroTrasAbrir = (await e.cobros(lic))[0];
	const revocar = await e.revocarAMano(lic);
	const cobroTrasRevocar = (await e.cobros(lic))[0];
	const ganar = await e.webhook(disputa("pi_cs_dos", "closed", "won"));
	return {
		abrir,
		cobroTrasAbrir,
		revocar,
		cobroTrasRevocar,
		ganar,
		cobroTrasGanar: (await e.cobros(lic))[0],
		final: estado(await e.leer(lic), "device-main"),
	};
}

/**
 * (3) RI-52 y el procedimiento de `licencias.md`: compra de 2 licencias, reembolso PARCIAL de una
 * (sin efecto en el worker) y revocación a mano de esa. Después se disputa el cargo y se gana.
 */
async function reembolsoParcialYDisputa(e: Escenario) {
	const [primera, segunda] = await e.comprar("cs_ri52", 2);
	const parcial = await e.webhook(reembolso("pi_cs_ri52", 24000, 12000));
	const revocar = await e.revocarAMano(segunda);

	const abrir = await e.webhook(disputa("pi_cs_ri52", "created"));
	const ganar = await e.webhook(disputa("pi_cs_ri52", "closed", "won"));

	const primeraFinal = await e.leer(primera);
	const segundaFinal = await e.leer(segunda);

	// ¿Se puede gastar la clave reembolsada? El canje (REV-13) la exige `issued`, sin Main y viva.
	await e.activar(primera, "device-bar");
	const canje = await e.db.operar("canjearClave", {
		claveId: segunda,
		licenciaId: primera,
		deviceId: "device-bar",
		meses: 12,
		ahoraMs: Date.now(),
	});

	return {
		parcial,
		revocar,
		abrir,
		ganar,
		primera: estado(primeraFinal, ""),
		segunda: estado(segundaFinal, ""),
		segundaCanjeable: canje.resultado === "sumado",
	};
}

/**
 * (4) Licencia de Stripe sin fila en `license_payments` (anterior a LIC-07), atribuida por
 * `licenses.stripe_payment_intent_id`.
 */
async function sinCobroRegistrado(e: Escenario) {
	const { license } = await issueLicense(e.db, {
		claves: STORE_KEY,
		termMonths: 12,
		origin: "stripe",
		customerEmail: "bar@ejemplo.test",
		stripeCustomerId: CUSTOMER,
		stripeCheckoutSessionId: "cs_legado",
		stripePaymentIntentId: "pi_legado",
	});
	await e.activar(license.license_id, "device-main");
	const revocar = await e.revocarAMano(license.license_id);
	const abrir = await e.webhook(disputa("pi_legado", "created"));
	const ganar = await e.webhook(disputa("pi_legado", "closed", "won"));
	return { revocar, abrir, ganar, final: estado(await e.leer(license.license_id), "device-main") };
}

/** Una licencia viva que la disputa revoca: al ganarla vuelve a trabajar (LIC-07). */
async function viva(e: Escenario) {
	const [lic] = await e.comprar("cs_viva");
	await e.activar(lic, "device-main");
	const abrir = await e.webhook(disputa("pi_cs_viva", "created"));
	const tras = estado(await e.leer(lic), "device-main");
	const ganar = await e.webhook(disputa("pi_cs_viva", "closed", "won"));
	return { abrir, tras, ganar, cobro: (await e.cobros(lic))[0], final: estado(await e.leer(lic), "device-main") };
}

/** La disputa de una RENOVACIÓN de una licencia revocada a mano sólo mueve meses. */
async function renovacionDisputada(e: Escenario) {
	const [lic] = await e.comprar("cs_base");
	await e.activar(lic, "device-main");
	// La renovación: otra compra, canjeada sobre ella. Su cobro pasa a la licencia como renovación.
	const [renovacion] = await e.comprar("cs_renovacion");
	const canje = await e.db.operar("canjearClave", {
		claveId: renovacion,
		licenciaId: lic,
		deviceId: "device-main",
		meses: 12,
		ahoraMs: Date.now(),
	});
	if (canje.resultado !== "sumado") throw new Error(`canje inesperado: ${canje.resultado}`);
	const conRenovacion = canje.expiresAtMs;
	await e.revocarAMano(lic);
	await e.webhook(disputa("pi_cs_renovacion", "created"));
	const ganar = await e.webhook(disputa("pi_cs_renovacion", "closed", "won"));
	const l = await e.leer(lic);
	return { ganar, conRenovacion, expira: l.expires_at_ms, final: estado(l, "device-main") };
}

/* ── Lo que promete la documentación ────────────────────────────────────────────────────────── */

describe("AUD-08 · una disputa ganada no deshace una revocación a mano", () => {
	it("(1) revocada a mano antes de la disputa: no resucita al ganarla", async () => {
		const r = await escenario(revocadaAntes);
		expect(r.revocar).toBe(200);
		expect(r.final).toEqual(REVOCADA);
	});

	it("(2) revocada a mano con la disputa abierta: no resucita al ganarla", async () => {
		const r = await escenario(revocadaDurante);
		expect(r.revocar).toBe(200);
		expect(r.final).toEqual(REVOCADA);
	});

	it("(3) RI-52: ganar la disputa devuelve la licencia pagada y no la reembolsada", async () => {
		const r = await escenario(reembolsoParcialYDisputa);
		expect(r.parcial.body).toMatchObject({ reversed: false, reason: "partial_refund" });
		expect(r.revocar).toBe(200);
		expect({ primera: r.primera, segunda: r.segunda, segundaCanjeable: r.segundaCanjeable }).toEqual({
			primera: { status: "issued", disabled: 0, gate: "active" },
			segunda: REVOCADA,
			segundaCanjeable: false,
		});
	});

	it("(4) sin cobro registrado: una disputa ganada no deshace la revocación a mano", async () => {
		const r = await escenario(sinCobroRegistrado);
		expect(r.revocar).toBe(200);
		expect(r.ganar.body).toMatchObject({ restored: false, reason: "not_reversed_by_dispute" });
		expect(r.final).toEqual(REVOCADA);
	});
});

describe("AUD-08 · cómo queda el cobro", () => {
	it("abrir la disputa sobre una licencia ya revocada no se atribuye la revocación", async () => {
		const r = await escenario(revocadaAntes);
		expect(r.abrir.body).toMatchObject({ reversed: true, accion: "already_revoked" });
		expect(r.cobroTrasAbrir.reversed_reason).toBe("dispute_ya_revocada");
		expect(r.ganar.body).toMatchObject({ restored: false, reason: "not_reversed_by_dispute" });
		// Ganarla le quita la marca: el dinero ha vuelto.
		expect(r.cobroTrasGanar).toMatchObject({ reversed_reason: null, reversed_at_ms: null });
		expect(r.auditoria.map((a) => a.action)).toEqual(["revoke", "dispute"]);
		expect(r.auditoria[1].detail.accion).toBe("ya_revocada");
	});

	it("revocar a mano con la disputa abierta hace suya la revocación", async () => {
		const r = await escenario(revocadaDurante);
		expect(r.abrir.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.cobroTrasAbrir.reversed_reason).toBe("dispute");
		expect(r.cobroTrasRevocar.reversed_reason).toBe("dispute_ya_revocada");
		expect(r.ganar.body).toMatchObject({ restored: false, reason: "not_reversed_by_dispute" });
		expect(r.cobroTrasGanar).toMatchObject({ reversed_reason: null, reversed_at_ms: null });
	});

	it("tras ganarla, desrevocar a mano y devolver el cargo entero la vuelve a revocar", async () => {
		const r = await escenario(async (e) => {
			const base = await revocadaAntes(e);
			const id = base.lic;
			const desrevocar = await e.desrevocarAMano(id);
			const trasDesrevocar = estado(await e.leer(id), "device-main");
			const devolver = await e.webhook(reembolso("pi_cs_uno", 12000, 12000));
			return { desrevocar, trasDesrevocar, devolver, final: estado(await e.leer(id), "device-main") };
		});
		expect(r.desrevocar).toBe(200);
		expect(r.trasDesrevocar).toEqual(ACTIVA);
		expect(r.devolver.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.final).toEqual(REVOCADA);
	});

	it("si falla a mitad, la revocación a mano no queda hecha ni el cobro cambiado", async () => {
		const r = await escenario(async (e) => {
			const [lic] = await e.comprar("cs_fallo");
			await e.activar(lic, "device-main");
			await e.webhook(disputa("pi_cs_fallo", "created"));
			await e.desrevocarAMano(lic);

			// Revocar escribe la licencia y luego el cobro: falla lo segundo.
			e.conFallo(/UPDATE license_payments/);
			const revocar = await e.revocarAMano(lic);
			e.conFallo(null);

			return { revocar, cobro: (await e.cobros(lic))[0], final: estado(await e.leer(lic), "device-main") };
		});
		expect(r.revocar).toBe(500);
		// Sin marca: se la quitó desrevocar (AUD-45), y la revocación fallida no le ha puesto ninguna.
		expect(r.cobro.reversed_reason).toBeNull();
		expect(r.final).toEqual(ACTIVA);
	});
});

/* ── Lo que no cambia ───────────────────────────────────────────────────────────────────────── */

describe("AUD-08 · lo que la disputa sí revirtió vuelve (LIC-07)", () => {
	it("una licencia viva que la disputa revoca vuelve a trabajar al ganarla", async () => {
		const r = await escenario(viva);
		expect(r.abrir.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.tras).toEqual(REVOCADA);
		expect(r.ganar.body).toMatchObject({ restored: true });
		expect(r.cobro.reversed_reason).toBeNull();
		expect(r.final).toEqual(ACTIVA);
	});

	it("perder la disputa deja revocada la licencia que revocó", async () => {
		const r = await escenario(async (e) => {
			const [lic] = await e.comprar("cs_perdida");
			await e.activar(lic, "device-main");
			await e.webhook(disputa("pi_cs_perdida", "created"));
			const perder = await e.webhook(disputa("pi_cs_perdida", "closed", "lost"));
			return { perder, final: estado(await e.leer(lic), "device-main") };
		});
		expect(r.perder.body).toMatchObject({ restored: false, reason: "lost" });
		expect(r.final).toEqual(REVOCADA);
	});

	it("un reembolso total revoca todas las licencias de la compra", async () => {
		const r = await escenario(async (e) => {
			const ids = await e.comprar("cs_total", 2);
			const devolver = await e.webhook(reembolso("pi_cs_total", 24000, 24000));
			return { devolver, finales: await Promise.all(ids.map(async (id) => estado(await e.leer(id), ""))) };
		});
		expect(r.devolver.body).toMatchObject({ reversed: true });
		expect(r.finales).toEqual([REVOCADA, REVOCADA]);
	});

	it("la disputa de una renovación de una licencia revocada a mano sólo mueve meses", async () => {
		const r = await escenario(renovacionDisputada);
		expect(r.ganar.body).toMatchObject({ restored: true });
		expect(r.expira).toBe(r.conRenovacion);
		expect(r.final).toEqual(REVOCADA);
	});

	it("sin `charge.dispute.created` procesado, un `closed won` no toca una licencia revocada a mano", async () => {
		const r = await escenario(async (e) => {
			const [lic] = await e.comprar("cs_solo_cierre");
			await e.activar(lic, "device-main");
			await e.revocarAMano(lic);
			const ganar = await e.webhook(disputa("pi_cs_solo_cierre", "closed", "won"));
			return { ganar, final: estado(await e.leer(lic), "device-main") };
		});
		expect(r.ganar.body).toMatchObject({ restored: false, reason: "not_reversed_by_dispute" });
		expect(r.final).toEqual(REVOCADA);
	});

	it("una firma que no es la de Stripe no llega a revertir nada", async () => {
		const r = await escenario(async (e) => {
			const [lic] = await e.comprar("cs_firma");
			await e.activar(lic, "device-main");
			const raw = JSON.stringify(disputa("pi_cs_firma", "created"));
			const res = await stripeRoutes.fetch(
				new Request("https://api/webhook", {
					method: "POST",
					headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
					body: raw,
				}),
				e.env,
			);
			return { status: res.status, cobro: (await e.cobros(lic))[0], final: estado(await e.leer(lic), "device-main") };
		});
		expect(r.status).toBe(400);
		expect(r.cobro.reversed_reason).toBeNull();
		expect(r.final).toEqual(ACTIVA);
	});
});
