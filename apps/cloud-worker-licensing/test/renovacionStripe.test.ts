// test/renovacionStripe.test.ts
//
// REV-13 — una compra dice lo que es, y el worker deja de adivinarlo.
//
// El fallo: si el cliente de Stripe ya tenía una licencia viva, cualquier compra suya la EXTENDÍA.
// Comprar con los mismos datos era literalmente lo que disparaba la renovación. Un dueño que abría
// un segundo local pagaba y no recibía clave —se le alargaba la del primero— y quien compraba sin
// haber estrenado la anterior acababa con una sola clave de veinticuatro meses.
//
// Ahora hacen falta dos señales, y las dos vienen del pago: `metadata.intent = renewal` en el
// Price dice QUE es una renovación, y el `client_reference_id` del enlace dice CUÁL. Aquí se
// prueban las dos, y sobre todo lo que pasa cuando una falta: se emite una licencia nueva, que es
// la dirección en la que el error se puede deshacer.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { cumplir } from "../src/domains/stripe/stripe.routes";
import {
	activateLicenseFirstTime,
	addMonths,
	getLicenseById,
	type LicenseRow,
} from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

const CUSTOMER = "cus_el_mismo_de_siempre";
const CORREO = "bar@ejemplo.test";

/** Una compra normal: el Price no dice nada de renovar. */
const alta = (id: string, meses = 12, extra: Record<string, unknown> = {}) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: `pi_${id}`,
	customer_details: { email: CORREO, name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: String(meses) } } }] },
	...extra,
});

/** Una renovación: el Price marcado y la licencia nombrada en el enlace. */
const renovacion = (id: string, licenseId: string | null, extra: Record<string, unknown> = {}) => ({
	...alta(id),
	...(licenseId === null ? {} : { client_reference_id: licenseId }),
	line_items: {
		data: [{ price: { id: "price_renovacion", metadata: { term_months: "12", intent: "renewal" } } }],
	},
	...extra,
});

type Escenario = {
	db: any;
	sql: any;
	/** Compra y activa una licencia: la del primer local. */
	licenciaActivada: (sessionId?: string) => Promise<LicenseRow>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	contar: (tabla: string) => number;
};

async function escenario<T>(nombre: string, fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub(`rev13-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "license_payments", "admin_audit", "webhook_events"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}

		const e: Escenario = {
			db,
			sql,
			async licenciaActivada(sessionId = "cs_primer_local") {
				const r = await cumplir(ENV, db, alta(sessionId));
				if (r.accion !== "emitida") throw new Error(`alta inesperada: ${r.accion}`);
				await activateLicenseFirstTime(db, {
					licenseId: r.license_id,
					tenantId: `tenant-${sessionId}`,
					deviceId: `device-${sessionId}`,
					termMonths: 12,
				});
				return (await getLicenseById(db, r.license_id))!;
			},
			async leer(licenseId) {
				return (await getLicenseById(db, licenseId))!;
			},
			contar(tabla) {
				return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${tabla};`).toArray()[0].n);
			},
		};

		return fn(e);
	});
}

describe("REV-13 · el segundo local", () => {
	it("una compra normal del MISMO cliente emite otra licencia, no extiende la que tiene", async () => {
		// El corazón del bug. Antes esto devolvía «renovada» y el dueño del segundo bar se quedaba
		// sin clave que teclear, con un año de más en la licencia del primero.
		const r = await escenario("segundo-local", async (e) => {
			const primera = await e.licenciaActivada();
			const segunda = await cumplir(ENV, e.db, alta("cs_segundo_local"));
			return {
				primera,
				segunda,
				licencias: e.contar("licenses"),
				primeraFinal: await e.leer(primera.license_id),
			};
		});

		expect(r.segunda.accion).toBe("emitida");
		expect(r.licencias).toBe(2);
		// Y la del primer local se queda exactamente como estaba.
		expect(r.primeraFinal.expires_at_ms).toBe(r.primera.expires_at_ms);
	});

	it("una licencia comprada y nunca estrenada tampoco se extiende al comprar otra", async () => {
		// El otro extremo del mismo fallo: una `issued` sin activar entraba en la consulta de
		// «licencias vivas» porque no tiene caducidad, así que la segunda compra le ponía el reloj
		// en marcha y dejaba al cliente con una clave de 24 meses en vez de dos claves.
		const r = await escenario("sin-estrenar", async (e) => {
			const primera = await cumplir(ENV, e.db, alta("cs_uno"));
			const segunda = await cumplir(ENV, e.db, alta("cs_dos"));
			const fila = await e.leer((primera as any).license_id);
			return { primera, segunda, licencias: e.contar("licenses"), fila };
		});

		expect(r.primera.accion).toBe("emitida");
		expect(r.segunda.accion).toBe("emitida");
		expect(r.licencias).toBe(2);
		// La primera sigue sin estrenar: ni caducidad, ni reloj corriendo.
		expect(r.fila.status).toBe("issued");
		expect(r.fila.expires_at_ms).toBeNull();
	});
});

describe("REV-13 · la renovación de verdad", () => {
	it("marcada y con su licencia dentro, extiende esa y sólo esa", async () => {
		const r = await escenario("renueva-la-suya", async (e) => {
			const primera = await e.licenciaActivada("cs_local_a");
			const segunda = await e.licenciaActivada("cs_local_b");

			const hecho = await cumplir(ENV, e.db, renovacion("cs_renueva_a", primera.license_id));
			return {
				hecho,
				primera,
				segunda,
				finalA: await e.leer(primera.license_id),
				finalB: await e.leer(segunda.license_id),
				licencias: e.contar("licenses"),
			};
		});

		expect(r.hecho.accion).toBe("renovada");
		expect(r.licencias).toBe(2);
		expect(r.finalA.expires_at_ms).toBe(addMonths(r.primera.expires_at_ms!, 12));
		// La del otro local ni se entera: es justo lo que no sabía hacer la versión que adivinaba.
		expect(r.finalB.expires_at_ms).toBe(r.segunda.expires_at_ms);
	});

	it("una licencia CADUCADA se renueva y vuelve a estar activa", async () => {
		// El caso normal: te avisamos, la dejas pasar unos días y renuevas. Si `expired` no entrara,
		// el correo de aviso mandaría a un enlace que emite clave nueva justo cuando más molesta.
		const r = await escenario("caducada", async (e) => {
			const lic = await e.licenciaActivada();
			e.sql.exec(
				`UPDATE licenses SET status='expired', expires_at_ms=? WHERE license_id=?;`,
				Date.now() - 5 * 24 * 60 * 60 * 1000,
				lic.license_id,
			);
			const hecho = await cumplir(ENV, e.db, renovacion("cs_renueva", lic.license_id));
			return { hecho, final: await e.leer(lic.license_id), licencias: e.contar("licenses") };
		});

		expect(r.hecho.accion).toBe("renovada");
		expect(r.licencias).toBe(1);
		expect(r.final.status).toBe("active");
		expect(r.final.expires_at_ms).toBeGreaterThan(Date.now());
	});
});

describe("REV-13 · una renovación que no encuentra a quién renovar", () => {
	/** Todos acaban igual: se emite una licencia, y el motivo queda anotado. */
	const casos: Array<{ nombre: string; rechazo: string; preparar: (e: Escenario) => Promise<any> }> =
		[
			{
				nombre: "el enlace no lleva licencia (se compró por el enlace suelto)",
				rechazo: "sin_license_id",
				preparar: async (e) => {
					await e.licenciaActivada();
					return renovacion("cs_sin_ref", null);
				},
			},
			{
				nombre: "el enlace nombra una licencia que no existe",
				rechazo: "license_id_desconocido",
				preparar: async (e) => {
					await e.licenciaActivada();
					return renovacion("cs_fantasma", "lic-que-no-existe");
				},
			},
			{
				nombre: "la licencia está anulada",
				rechazo: "licencia_anulada",
				preparar: async (e) => {
					const lic = await e.licenciaActivada();
					e.sql.exec(
						`UPDATE licenses SET status='revoked', disabled=1 WHERE license_id=?;`,
						lic.license_id,
					);
					return renovacion("cs_anulada", lic.license_id);
				},
			},
			{
				nombre: "la licencia nunca se estrenó (no hay reloj que alargar)",
				rechazo: "licencia_sin_estrenar",
				preparar: async (e) => {
					const r: any = await cumplir(ENV, e.db, alta("cs_sin_activar"));
					return renovacion("cs_renueva_sin_estrenar", r.license_id);
				},
			},
			{
				nombre: "el enlace es de otro cliente",
				rechazo: "otro_cliente",
				preparar: async (e) => {
					const ajena = await e.licenciaActivada();
					e.sql.exec(
						`UPDATE licenses SET stripe_customer_id='cus_otro', customer_email='otro@ejemplo.test'
						 WHERE license_id=?;`,
						ajena.license_id,
					);
					return renovacion("cs_ajena", ajena.license_id);
				},
			},
		];

	for (const caso of casos) {
		it(`${caso.nombre} → emite licencia nueva y lo anota (${caso.rechazo})`, async () => {
			const r = await escenario(`rechazo-${caso.rechazo}`, async (e) => {
				const sesion = await caso.preparar(e);
				const antes = e.sql
					.exec(`SELECT license_id, expires_at_ms, status FROM licenses;`)
					.toArray();

				const hecho = await cumplir(ENV, e.db, sesion);
				const auditoria = e.sql
					.exec(`SELECT detail FROM admin_audit WHERE action='issue';`)
					.toArray();

				return { hecho, antes, auditoria, licencias: e.contar("licenses"), sql: e.sql };
			});

			// Quien ha pagado se lleva algo que funciona: es la única dirección en la que este
			// error se deshace (una clave de más se usa o se devuelve).
			expect(r.hecho.accion).toBe("emitida");
			expect(r.licencias).toBe(r.antes.length + 1);

			// Y queda el rastro, porque esto es un síntoma: o el correo manda enlaces caducados o
			// alguien está compartiendo el suyo.
			expect(r.auditoria).toHaveLength(1);
			const detalle = JSON.parse(String((r.auditoria[0] as any).detail));
			expect(detalle.motivo).toBe("renovacion_sin_destino");
			expect(detalle.rechazo).toBe(caso.rechazo);
		});
	}

	it("y ninguna de esas licencias se ha tocado", async () => {
		// La comprobación que de verdad importa del bloque de arriba: nadie le alarga la licencia
		// a un tercero por pagar con un enlace que no es suyo.
		const r = await escenario("ajena-intacta", async (e) => {
			const ajena = await e.licenciaActivada();
			e.sql.exec(
				`UPDATE licenses SET stripe_customer_id='cus_otro', customer_email='otro@ejemplo.test'
				 WHERE license_id=?;`,
				ajena.license_id,
			);
			await cumplir(ENV, e.db, renovacion("cs_ajena", ajena.license_id));
			return { antes: ajena, despues: await e.leer(ajena.license_id) };
		});

		expect(r.despues.expires_at_ms).toBe(r.antes.expires_at_ms);
	});

	it("el correo basta como prueba de propiedad aunque Stripe haya creado otro Customer", async () => {
		// Un checkout puede crear un Customer nuevo si el comprador escribe el correo con otra
		// grafía. Rechazar por eso una renovación legítima cambiaría un acierto raro por un fallo
		// frecuente: el cliente pagaría su renovación y recibiría una clave que no necesita.
		const r = await escenario("otro-customer", async (e) => {
			const lic = await e.licenciaActivada();
			e.sql.exec(
				`UPDATE licenses SET stripe_customer_id='cus_antiguo' WHERE license_id=?;`,
				lic.license_id,
			);
			const hecho = await cumplir(ENV, e.db, renovacion("cs_renueva", lic.license_id));
			return { hecho, antes: lic, final: await e.leer(lic.license_id) };
		});

		expect(r.hecho.accion).toBe("renovada");
		expect(r.final.expires_at_ms).toBe(addMonths(r.antes.expires_at_ms!, 12));
	});
});
