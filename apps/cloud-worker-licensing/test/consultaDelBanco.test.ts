// test/consultaDelBanco.test.ts
//
// AUD-45 — una consulta del banco no es una disputa.
//
// Stripe entrega como disputa (`charge.dispute.created`) la petición de información que algunas
// redes (sobre todo American Express, Discover y Klarna) abren antes de un contracargo: su estado es
// `warning_needs_response`, `warning_under_review` o `warning_closed`, y el dinero no sale
// (docs.stripe.com/disputes/how-disputes-work#inquiries). El webhook la revocaba como una disputa, y
// como una consulta que no escala se cierra `warning_closed` y no `won`, la licencia se quedaba
// revocada para siempre. Si escala, es el mismo objeto Dispute que pasa a `needs_response`, y Stripe
// avisa con `charge.dispute.funds_withdrawn` (docs.stripe.com/payments/klarna/disputes).
//
// Recorre las rutas de verdad, como `disputaGanadaRevocacionAMano.test.ts`: los eventos por
// `POST /v1/stripe/webhook`, firmados con HMAC como los firma Stripe, y la desrevocación por
// `POST /v1/admin/licenses/:id/unrevoke` con su token. La compra la cumple `cumplir` con la sesión
// ya leída, y una renovación es otra compra canjeada sobre la licencia, como en producción. La base es
// la central de verdad (`helpers/central.ts`), a la que las dos rutas llegan por `getDb`. El
// `TenantHub` al que se avisa al anular un alta es un doble que anota los avisos.

import { describe, it, expect } from "vitest";

import { centralDePrueba, filasDe } from "./helpers/central";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { cumplir, stripeRoutes } from "../src/domains/stripe/stripe.routes";
import { computeLicenseState } from "../src/domains/licensing/licensing.helpers";
import type { ClienteCentral } from "../src/server/central/cliente";
import { activateLicenseFirstTime, getLicenseById, type LicenseRow } from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ADMIN_TOKEN = "token-admin-de-pruebas-aud45";
const WHSEC = "whsec_de_pruebas_aud45";
const CUSTOMER = "cus_aud45";

/** Los avisos al `TenantHub` (anular un alta le hace releer quién es la Main). */
const avisos: string[] = [];
const hubFalso = {
	idFromName: (nombre: string) => ({ nombre }),
	get: () => ({
		releerMain: async (tenantId: string) => {
			avisos.push(tenantId);
		},
		revocarDispositivo: async () => {},
	}),
};

/** El `Env` que ven las rutas, sin la central: cada escenario le pone la suya. */
const ENV = {
	ADMIN_API_TOKEN: ADMIN_TOKEN,
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-aud45",
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
const idEvento = () => `evt_aud45_${++siguienteEvento}`;

type TipoDeDisputa = "created" | "funds_withdrawn" | "closed";

/**
 * Un evento de disputa con la forma del objeto Dispute de la API de Stripe
 * (https://docs.stripe.com/api/disputes/object). Una consulta y el contracargo en que escala son el
 * mismo objeto (`du_…`): sólo cambia `status`.
 */
const disputa = (pi: string, tipo: TipoDeDisputa, status: string) => ({
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

const reembolsoTotal = (pi: string) => ({
	id: idEvento(),
	object: "event",
	type: "charge.refunded",
	data: {
		object: {
			id: `ch_${pi}`,
			object: "charge",
			payment_intent: pi,
			customer: CUSTOMER,
			amount: 12000,
			amount_refunded: 12000,
		},
	},
});

const sesion = (id: string) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: `pi_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: {
		data: [{ quantity: 1, price: { id: "price_anual", metadata: { term_months: "12" } } }],
	},
});

/**
 * La consulta de `licencias.md` («Reparar lo que revocó una consulta del banco»): las reversiones de
 * una disputa cuyo evento llegó con estado `warning_*`. Se prueba aquí para que la documentación no
 * se quede con una consulta que no encuentra nada.
 */
const CONSULTA_DE_REPARACION = `
SELECT a.license_id,
       json_extract(a.detail, '$.accion')                AS accion,
       json_extract(w.payload_json, '$.data.object.id')  AS dispute_id,
       l.status
FROM admin_audit a
JOIN webhook_events w ON w.event_uid = json_extract(a.detail, '$.event_uid')
JOIN licenses l       ON l.license_id = a.license_id
WHERE a.action = 'dispute'
  AND json_extract(a.detail, '$.accion') IN ('revocada', 'meses_restados')
  AND substr(json_extract(w.payload_json, '$.data.object.status'), 1, 8) = 'warning_'
ORDER BY a.at_ms;`;

type Escenario = {
	db: ClienteCentral;
	/** Compra por Stripe con `cumplir` y activación. Devuelve la licencia. */
	comprarYActivar: (sesionId: string) => Promise<string>;
	/**
	 * Le añade a la licencia una renovación de 12 meses pagada con `pi_renovacion`: otra compra,
	 * canjeada sobre ella.
	 */
	renovar: (licenseId: string) => Promise<number>;
	webhook: (evento: unknown) => Promise<{ status: number; body: any }>;
	desrevocarAMano: (licenseId: string) => Promise<number>;
	revocarAMano: (licenseId: string) => Promise<number>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	cobros: (licenseId: string) => Promise<{ kind: string; reversed_reason: string | null; reversed_at_ms: number | null }[]>;
	/** Lo que el webhook dejó en `admin_audit` con `action = 'dispute'`, por `accion`. */
	accionesDeDisputa: (licenseId: string) => Promise<string[]>;
	consultaDeReparacion: () => Promise<any[]>;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const db = central.db;
	const env = { ...ENV, ...central.entorno };
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
		avisos.length = 0;

		const e: Escenario = {
			db,
			async comprarYActivar(sesionId) {
				const r = await cumplir(env, db, sesion(sesionId));
				if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
				const [lic] = r.license_ids;
				const ok = await activateLicenseFirstTime(db, {
					licenseId: lic,
					tenantId: "tenant-aud45",
					deviceId: "device-main",
					termMonths: 12,
				});
				if (ok === null) throw new Error("no se activó");
				return lic;
			},
			async renovar(licenseId) {
				const compra = await cumplir(env, db, sesion("renovacion"));
				if (compra.accion !== "emitida") throw new Error(`compra inesperada: ${compra.accion}`);
				const canje = await db.operar("canjearClave", {
					claveId: compra.license_ids[0],
					licenciaId: licenseId,
					deviceId: "device-main",
					meses: 12,
					ahoraMs: Date.now(),
				});
				if (canje.resultado !== "sumado") throw new Error(`canje inesperado: ${canje.resultado}`);
				return canje.expiresAtMs;
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
			async desrevocarAMano(licenseId) {
				return (await admin(`/licenses/${licenseId}/unrevoke`)).status;
			},
			async revocarAMano(licenseId) {
				return (await admin(`/licenses/${licenseId}/revoke`)).status;
			},
			async leer(licenseId) {
				return (await getLicenseById(db, licenseId))!;
			},
			cobros(licenseId) {
				return filasDe(
					central,
					`SELECT kind, reversed_reason, reversed_at_ms FROM license_payments
					 WHERE license_id = ? ORDER BY at_ms, rowid;`,
					licenseId,
				) as Promise<any[]>;
			},
			async accionesDeDisputa(licenseId) {
				const filas = await filasDe(
					central,
					`SELECT detail FROM admin_audit WHERE action = 'dispute' AND license_id = ?
					 ORDER BY at_ms, rowid;`,
					licenseId,
				);
				return filas.map((f) => String(JSON.parse(String(f.detail)).accion));
			},
			consultaDeReparacion() {
				return filasDe(central, CONSULTA_DE_REPARACION);
			},
		};

		return fn(e);
	}
}

/** Lo que decide si el TPV trabaja: el estado de la fila y lo que firma `/status`. */
const estado = (l: LicenseRow) => ({
	status: l.status,
	disabled: Number(l.disabled),
	gate: computeLicenseState(l, "device-main", Date.now()),
});

const REVOCADA = { status: "revoked", disabled: 1, gate: "revoked" };
const ACTIVA = { status: "active", disabled: 0, gate: "active" };
const SIN_MARCA = { reversed_reason: null, reversed_at_ms: null };

describe("AUD-45 · una consulta del banco no corta el servicio", () => {
	it("abrirse (`warning_needs_response`) no revoca, no marca el cobro y no avisa al TenantHub: sólo se audita", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_consulta");
			const abrir = await e.webhook(disputa("pi_cs_consulta", "created", "warning_needs_response"));
			return {
				abrir,
				final: estado(await e.leer(lic)),
				cobro: (await e.cobros(lic))[0],
				acciones: await e.accionesDeDisputa(lic),
				avisos: [...avisos],
			};
		});
		expect(r.abrir.status).toBe(200);
		expect(r.abrir.body).toMatchObject({ reversed: false, reason: "not_a_chargeback", status: "warning_needs_response" });
		expect(r.final).toEqual(ACTIVA);
		expect(r.cobro).toMatchObject(SIN_MARCA);
		expect(r.acciones).toEqual(["consulta_sin_efecto"]);
		expect(r.avisos).toEqual([]);
	});

	it("cerrarse sin escalar (`warning_closed`) no hace nada", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_cerrada");
			await e.webhook(disputa("pi_cs_cerrada", "created", "warning_needs_response"));
			await e.webhook(disputa("pi_cs_cerrada", "created", "warning_under_review"));
			const cerrar = await e.webhook(disputa("pi_cs_cerrada", "closed", "warning_closed"));
			return { cerrar, final: estado(await e.leer(lic)), cobro: (await e.cobros(lic))[0] };
		});
		expect(r.cerrar.body).toMatchObject({ restored: false, reason: "warning_closed" });
		expect(r.final).toEqual(ACTIVA);
		expect(r.cobro).toMatchObject(SIN_MARCA);
	});

	it("una disputa `prevented` (no llegó a contracargo) no revoca", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_prevenida");
			const abrir = await e.webhook(disputa("pi_cs_prevenida", "created", "prevented"));
			return { abrir, final: estado(await e.leer(lic)), cobro: (await e.cobros(lic))[0] };
		});
		expect(r.abrir.body).toMatchObject({ reversed: false, reason: "not_a_chargeback", status: "prevented" });
		expect(r.final).toEqual(ACTIVA);
		expect(r.cobro).toMatchObject(SIN_MARCA);
	});

	it("si escala, se revoca al salir los fondos, una sola vez, y vuelve si se gana", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_escala");
			const pi = "pi_cs_escala";
			await e.webhook(disputa(pi, "created", "warning_needs_response"));
			const trasConsulta = estado(await e.leer(lic));
			const fondos = await e.webhook(disputa(pi, "funds_withdrawn", "needs_response"));
			const trasEscalar = estado(await e.leer(lic));
			const cobroTrasEscalar = (await e.cobros(lic))[0];
			const avisosTrasEscalar = avisos.length;
			// Otra entrega del mismo hecho (Stripe manda un evento nuevo con el mismo objeto).
			const otraVez = await e.webhook(disputa(pi, "funds_withdrawn", "needs_response"));
			const ganar = await e.webhook(disputa(pi, "closed", "won"));
			return {
				trasConsulta,
				fondos,
				trasEscalar,
				cobroTrasEscalar,
				avisosTrasEscalar,
				otraVez,
				ganar,
				acciones: await e.accionesDeDisputa(lic),
				final: estado(await e.leer(lic)),
			};
		});
		expect(r.trasConsulta).toEqual(ACTIVA);
		expect(r.fondos.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.trasEscalar).toEqual(REVOCADA);
		expect(r.cobroTrasEscalar.reversed_reason).toBe("dispute");
		expect(r.avisosTrasEscalar).toBe(1);
		expect(r.otraVez.body).toMatchObject({ reversed: false, reason: "already_reversed" });
		expect(r.acciones).toEqual(["consulta_sin_efecto", "revocada"]);
		expect(r.ganar.body).toMatchObject({ restored: true });
		expect(r.final).toEqual(ACTIVA);
	});

	it("si escala y se pierde sin que llegue `funds_withdrawn`, se revoca al cerrarse `lost`", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_perdida");
			await e.webhook(disputa("pi_cs_perdida", "created", "warning_needs_response"));
			const trasConsulta = estado(await e.leer(lic));
			const perder = await e.webhook(disputa("pi_cs_perdida", "closed", "lost"));
			return { trasConsulta, perder, final: estado(await e.leer(lic)), cobro: (await e.cobros(lic))[0] };
		});
		expect(r.trasConsulta).toEqual(ACTIVA);
		expect(r.perder.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.final).toEqual(REVOCADA);
		expect(r.cobro.reversed_reason).toBe("dispute");
	});
});

describe("AUD-45 · una disputa formal revierte una vez, llegue por donde llegue", () => {
	it("abrirse y salir los fondos: un solo efecto, en cualquier orden", async () => {
		const r = await escenario(async (e) => {
			const a = await e.comprarYActivar("cs_orden_a");
			await e.webhook(disputa("pi_cs_orden_a", "created", "needs_response"));
			const fondosDespues = await e.webhook(disputa("pi_cs_orden_a", "funds_withdrawn", "needs_response"));

			const b = await e.comprarYActivar("cs_orden_b");
			await e.webhook(disputa("pi_cs_orden_b", "funds_withdrawn", "needs_response"));
			const abrirDespues = await e.webhook(disputa("pi_cs_orden_b", "created", "needs_response"));

			return {
				fondosDespues,
				abrirDespues,
				a: { final: estado(await e.leer(a)), acciones: await e.accionesDeDisputa(a) },
				b: { final: estado(await e.leer(b)), acciones: await e.accionesDeDisputa(b) },
				avisos: avisos.length,
			};
		});
		expect(r.fondosDespues.body).toMatchObject({ reversed: false, reason: "already_reversed" });
		expect(r.abrirDespues.body).toMatchObject({ reversed: false, reason: "already_reversed" });
		expect(r.a).toEqual({ final: REVOCADA, acciones: ["revocada"] });
		expect(r.b).toEqual({ final: REVOCADA, acciones: ["revocada"] });
		expect(r.avisos).toBe(2);
	});

	it("ganada, se restaura", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_ganada");
			await e.webhook(disputa("pi_cs_ganada", "created", "needs_response"));
			await e.webhook(disputa("pi_cs_ganada", "funds_withdrawn", "needs_response"));
			await e.webhook(disputa("pi_cs_ganada", "created", "under_review"));
			const ganar = await e.webhook(disputa("pi_cs_ganada", "closed", "won"));
			return { ganar, final: estado(await e.leer(lic)), cobro: (await e.cobros(lic))[0] };
		});
		expect(r.ganar.body).toMatchObject({ restored: true });
		expect(r.final).toEqual(ACTIVA);
		expect(r.cobro).toMatchObject(SIN_MARCA);
	});

	it("perdida, se queda revocada sin revertir otra vez", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_formal_perdida");
			await e.webhook(disputa("pi_cs_formal_perdida", "created", "needs_response"));
			const perder = await e.webhook(disputa("pi_cs_formal_perdida", "closed", "lost"));
			return { perder, final: estado(await e.leer(lic)), acciones: await e.accionesDeDisputa(lic) };
		});
		expect(r.perder.body).toMatchObject({ restored: false, reason: "lost" });
		expect(r.final).toEqual(REVOCADA);
		expect(r.acciones).toEqual(["revocada"]);
	});
});

describe("AUD-45 · renovaciones", () => {
	it("una consulta no resta meses; si escala, los resta una vez; ganada, los devuelve", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_base");
			const antes = (await e.leer(lic)).expires_at_ms;
			const conRenovacion = await e.renovar(lic);

			await e.webhook(disputa("pi_renovacion", "created", "warning_needs_response"));
			const trasConsulta = (await e.leer(lic)).expires_at_ms;

			await e.webhook(disputa("pi_renovacion", "funds_withdrawn", "needs_response"));
			const trasEscalar = (await e.leer(lic)).expires_at_ms;
			await e.webhook(disputa("pi_renovacion", "created", "needs_response"));
			await e.webhook(disputa("pi_renovacion", "funds_withdrawn", "needs_response"));
			const trasRepetir = (await e.leer(lic)).expires_at_ms;

			await e.webhook(disputa("pi_renovacion", "closed", "won"));
			return {
				antes,
				conRenovacion,
				trasConsulta,
				trasEscalar,
				trasRepetir,
				final: (await e.leer(lic)).expires_at_ms,
				status: (await e.leer(lic)).status,
			};
		});
		expect(r.trasConsulta).toBe(r.conRenovacion);
		expect(r.trasEscalar).toBe(r.antes);
		expect(r.trasRepetir).toBe(r.antes);
		expect(r.final).toBe(r.conRenovacion);
		expect(r.status).toBe("active");
	});

	it("una disputa formal de la renovación resta sus meses una sola vez", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_base_formal");
			const antes = (await e.leer(lic)).expires_at_ms;
			await e.renovar(lic);
			await e.webhook(disputa("pi_renovacion", "created", "needs_response"));
			await e.webhook(disputa("pi_renovacion", "funds_withdrawn", "needs_response"));
			await e.webhook(disputa("pi_renovacion", "closed", "lost"));
			return { antes, final: await e.leer(lic) };
		});
		expect(r.final.expires_at_ms).toBe(r.antes);
		expect(r.final.status).toBe("active");
	});
});

describe("AUD-45 · desrevocar a mano quita la marca de la disputa", () => {
	it("tras una disputa formal abierta, desrevocar y devolver el cargo entero la vuelve a revocar", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_desrevocar");
			await e.webhook(disputa("pi_cs_desrevocar", "created", "needs_response"));
			const cobroTrasDisputa = (await e.cobros(lic))[0];
			const desrevocar = await e.desrevocarAMano(lic);
			const cobroTrasDesrevocar = (await e.cobros(lic))[0];
			const trasDesrevocar = estado(await e.leer(lic));
			const devolver = await e.webhook(reembolsoTotal("pi_cs_desrevocar"));
			return {
				cobroTrasDisputa,
				desrevocar,
				cobroTrasDesrevocar,
				trasDesrevocar,
				devolver,
				final: estado(await e.leer(lic)),
				cobroFinal: (await e.cobros(lic))[0],
			};
		});
		expect(r.cobroTrasDisputa.reversed_reason).toBe("dispute");
		expect(r.desrevocar).toBe(200);
		expect(r.cobroTrasDesrevocar).toMatchObject(SIN_MARCA);
		expect(r.trasDesrevocar).toEqual(ACTIVA);
		expect(r.devolver.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.final).toEqual(REVOCADA);
		expect(r.cobroFinal.reversed_reason).toBe("refund");
	});

	it("la reparación de `licencias.md`: encontrar lo que revocó una consulta, desrevocarlo y que un reembolso posterior revoque", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_reparar");
			const otra = await e.comprarYActivar("cs_formal_de_verdad");

			// Lo que hacía el webhook antes de AUD-45 con una consulta: revocar el alta, marcar el cobro
			// `dispute` con el evento de la consulta y auditarlo como `revocada`.
			const consulta = disputa("pi_cs_reparar", "created", "warning_needs_response");
			await e.webhook(consulta);
			await e.db.execute({
				sql: "UPDATE licenses SET status = 'revoked', disabled = 1, updated_at_ms = ? WHERE license_id = ?;",
				args: [Date.now(), lic],
			});
			await e.db.execute({
				sql: `UPDATE license_payments SET reversed_at_ms = ?, reversed_reason = 'dispute', reversed_event_uid = ?
				       WHERE license_id = ?;`,
				args: [Date.now(), consulta.id, lic],
			});
			await e.db.execute({
				sql: `INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, 'dispute', ?, ?, ?);`,
				args: [crypto.randomUUID(), lic, JSON.stringify({ event_uid: consulta.id, accion: "revocada" }), Date.now()],
			});

			// Una disputa formal de verdad sobre otra licencia: la consulta no tiene que encontrarla.
			await e.webhook(disputa("pi_cs_formal_de_verdad", "created", "needs_response"));

			const encontradas = await e.consultaDeReparacion();
			const desrevocar = await e.desrevocarAMano(lic);
			const trasReparar = { final: estado(await e.leer(lic)), cobro: (await e.cobros(lic))[0] };
			const devolver = await e.webhook(reembolsoTotal("pi_cs_reparar"));
			return {
				encontradas: encontradas.map((f: any) => ({ license_id: f.license_id, accion: f.accion, dispute_id: f.dispute_id })),
				lic,
				otra,
				desrevocar,
				trasReparar,
				devolver,
				final: estado(await e.leer(lic)),
				otraFinal: estado(await e.leer(otra)),
			};
		});
		expect(r.encontradas).toEqual([{ license_id: r.lic, accion: "revocada", dispute_id: "du_pi_cs_reparar" }]);
		expect(r.desrevocar).toBe(200);
		expect(r.trasReparar).toEqual({ final: ACTIVA, cobro: expect.objectContaining(SIN_MARCA) });
		expect(r.devolver.body).toMatchObject({ reversed: true, accion: "revoked" });
		expect(r.final).toEqual(REVOCADA);
		expect(r.otraFinal).toEqual(REVOCADA);
	});

	it("la marca de una renovación se queda: desrevocar no devuelve sus meses, y ganarla los devuelve una vez", async () => {
		const r = await escenario(async (e) => {
			const lic = await e.comprarYActivar("cs_base_desrevocar");
			const conRenovacion = await e.renovar(lic);
			await e.webhook(disputa("pi_renovacion", "created", "needs_response"));
			const recortada = (await e.leer(lic)).expires_at_ms;
			await e.revocarAMano(lic);
			const desrevocar = await e.desrevocarAMano(lic);
			const cobros = await e.cobros(lic);
			const trasDesrevocar = (await e.leer(lic)).expires_at_ms;
			const ganar = await e.webhook(disputa("pi_renovacion", "closed", "won"));
			return { conRenovacion, recortada, desrevocar, cobros, trasDesrevocar, ganar, final: await e.leer(lic) };
		});
		expect(r.desrevocar).toBe(200);
		expect(r.cobros.map((c) => [c.kind, c.reversed_reason])).toEqual([
			["issue", null],
			["renewal", "dispute"],
		]);
		expect(r.trasDesrevocar).toBe(r.recortada);
		expect(r.ganar.body).toMatchObject({ restored: true });
		expect(r.final.expires_at_ms).toBe(r.conRenovacion);
		expect(estado(r.final)).toEqual(ACTIVA);
	});
});
