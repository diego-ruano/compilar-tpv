// test/centralCarreras.test.ts
//
// Las operaciones de la base central, pedidas a la vez: N llamadas por RPC al mismo objeto
// (`ClienteCentral.operar`), sin esperar unas a otras. El objeto las atiende de una en una y cada
// operación lee, decide y escribe dentro de su transacción sin esperas (`operaciones/registro.ts`),
// así que ninguna ve a medias lo que escribe otra:
//
//   · el mismo canje: lo gana una, y la clave suma sus meses una sola vez;
//   · la misma sesión de Stripe: la emite una, y las demás contestan con sus licencias;
//   · el mismo cargo revertido N veces: se revierte una vez;
//   · extender y acortar a la vez: no se pierde ninguno de los cambios;
//   · anular y desanular a la vez: la licencia y la marca de su cobro quedan coherentes.

import { describe, expect, it } from "vitest";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { revertir, cumplir } from "../src/domains/stripe/stripe.routes";
import { addMonths } from "../src/server/central/operaciones/licencias";
import { claveNueva, getLicenseById } from "../src/server/licenseStore";

const N = 8;
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;
const DIA = 24 * 60 * 60 * 1000;
/**
 * Una caducidad dentro de tres años, en un día 2: sumar y restar meses desde ahí conmutan (no hay
 * recorte a fin de mes).
 */
const HOY = new Date();
const CADUCIDAD = Date.UTC(HOY.getUTCFullYear() + 3, HOY.getUTCMonth(), 2, 12, 0, 0);

/** Una licencia viva de `equipo`, con la caducidad dada, y una clave sin estrenar de 12 meses. */
async function licenciaYClave(central: CentralDePrueba, equipo: string) {
	const ahora = Date.now();
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months, origin, issued_at_ms,
		   tenant_id, main_device_id, activated_at_ms, expires_at_ms, customer_email, created_at_ms, updated_at_ms)
		 VALUES ('viva', 'hash-viva', 'active', 0, 'standard', 12, 'manual', ?1, 't-1', ?2, ?1, ?3, 'bar@ejemplo.test', ?1, ?1),
		        ('clave', 'hash-clave', 'issued', 0, 'standard', 12, 'stripe', ?1, NULL, NULL, NULL, NULL, 'bar@ejemplo.test', ?1, ?1);`,
		ahora,
		equipo,
		CADUCIDAD,
	);
	await filasDe(
		central,
		`INSERT INTO license_payments (payment_id, license_id, kind, term_months, stripe_checkout_session_id,
		   stripe_payment_intent_id, unidad, at_ms)
		 VALUES ('pago-clave', 'clave', 'issue', 12, 'cs_clave', 'pi_clave', 1, ?);`,
		ahora,
	);
}

/** Lo que se repite en las respuestas: cuántas veces sale cada resultado. */
const cuantas = (resultados: unknown[]) =>
	resultados.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r)]: (acc[String(r)] ?? 0) + 1 }), {});

describe("N operaciones a la vez sobre la misma central", () => {
	it("el mismo canje: exactamente uno lo gana, y los meses se suman una vez", async () => {
		const central = await centralDePrueba();
		await licenciaYClave(central, "equipo-del-bar");

		const respuestas = await Promise.all(
			Array.from({ length: N }, () =>
				central.db.operar("canjearClave", {
					claveId: "clave",
					licenciaId: "viva",
					deviceId: "equipo-del-bar",
					meses: 12,
					ahoraMs: Date.now(),
				}),
			),
		);

		expect(cuantas(respuestas.map((r) => r.resultado))).toEqual({ sumado: 1, usada: N - 1 });
		const viva = (await getLicenseById(central.db, "viva"))!;
		expect(viva.expires_at_ms).toBe(addMonths(CADUCIDAD, 12));
		expect(respuestas.find((r) => r.resultado === "sumado")).toEqual({ resultado: "sumado", expiresAtMs: viva.expires_at_ms });
		expect(await filasDe(central, `SELECT license_id, kind FROM license_payments;`)).toEqual([
			{ license_id: "viva", kind: "renewal" },
		]);
	});

	it("la misma sesión de Stripe: exactamente una la emite, y las demás contestan con sus licencias", async () => {
		const central = await centralDePrueba();
		/** Lo que prepararía cada entrega de la misma sesión: sus claves y sus ids, distintos. */
		const preparar = async () => {
			const unidades = [];
			for (const termMonths of [12, 12, 3]) {
				const { keyPlain: _enClaro, ...clave } = await claveNueva(STORE_KEY);
				unidades.push({ ...clave, termMonths, licenseId: crypto.randomUUID(), paymentId: crypto.randomUUID() });
			}
			return {
				sessionId: "cs_a_la_vez",
				comprador: { customerEmail: "bar@ejemplo.test", stripePaymentIntentId: "pi_a_la_vez" },
				unidades,
				ahoraMs: Date.now(),
			};
		};
		const entregas = await Promise.all(Array.from({ length: N }, preparar));

		const respuestas = await Promise.all(entregas.map((datos) => central.db.operar("emitirCobro", datos)));

		expect(cuantas(respuestas.map((r) => r.resultado))).toEqual({ emitida: 1, ya_cumplida: N - 1 });
		const ganadora = respuestas.findIndex((r) => r.resultado === "emitida");
		const suyas = entregas[ganadora].unidades.map((u) => u.licenseId);
		// Todas contestan con las licencias de la que ganó, en el orden de sus unidades.
		for (const r of respuestas) expect(r.licenseIds).toEqual(suyas);
		expect(await filasDe(central, `SELECT license_id FROM licenses ORDER BY rowid;`)).toEqual(suyas.map((id) => ({ license_id: id })));
		expect(await filasDe(central, `SELECT license_id, unidad FROM license_payments ORDER BY unidad;`)).toEqual(
			suyas.map((id, i) => ({ license_id: id, unidad: i + 1 })),
		);
	});

	it("el mismo cargo revertido N veces: se revierte una vez", async () => {
		const central = await centralDePrueba();
		const compra = await cumplir(ENV, central.db, {
			id: "cs_devuelta",
			payment_status: "paid",
			payment_intent: "pi_devuelta",
			customer_details: { email: "bar@ejemplo.test" },
			line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: "12" } } }] },
		});
		if (compra.accion !== "emitida") throw new Error(compra.accion);
		const evento = {
			id: "evt_devuelto",
			type: "charge.refunded",
			data: { object: { object: "charge", payment_intent: "pi_devuelta", amount: 12000, amount_refunded: 12000 } },
		};

		// Stripe entrega el mismo evento varias veces, y cada entrega llega con su propio id.
		const respuestas = await Promise.all(
			Array.from({ length: N }, (_, i) => revertir(central.db, { ...evento, id: `${evento.id}_${i}` })),
		);

		expect(cuantas(respuestas.map((r) => `${r.reversed}:${r.reason ?? r.accion}`))).toEqual({
			"true:revoked": 1,
			"false:already_reversed": N - 1,
		});
		const [licenseId] = compra.license_ids;
		expect((await getLicenseById(central.db, licenseId))!.status).toBe("revoked");
		expect(await filasDe(central, `SELECT action FROM admin_audit;`)).toEqual([{ action: "refund" }]);
		expect(await filasDe(central, `SELECT reversed_reason FROM license_payments;`)).toEqual([{ reversed_reason: "refund" }]);
	});

	it("extender y acortar a la vez: no se pierde ningún cambio", async () => {
		const central = await centralDePrueba();
		await licenciaYClave(central, "equipo-del-bar");
		const EXTENDER = N;
		const ACORTAR = N / 2;

		const respuestas = await Promise.all([
			...Array.from({ length: EXTENDER }, () =>
				central.db.operar("extenderAMano", { licenseId: "viva", meses: 1, ahoraMs: Date.now() }),
			),
			...Array.from({ length: ACORTAR }, () =>
				central.db.operar("acortarAMano", { licenseId: "viva", meses: 1, ahoraMs: Date.now() }),
			),
		]);

		// Cada una partió de lo que dejó la anterior: con una leída a destiempo, alguna se perdería.
		const final = (await getLicenseById(central.db, "viva"))!.expires_at_ms;
		expect(final).toBe(addMonths(CADUCIDAD, EXTENDER - ACORTAR));
		// Y cada una contestó con una caducidad de las que hubo por el camino, a un mes de la de partida
		// por cada cambio como mucho.
		for (const r of respuestas) {
			expect(r).not.toBeNull();
			expect(Math.abs(r! - CADUCIDAD)).toBeLessThanOrEqual(addMonths(CADUCIDAD, EXTENDER) - CADUCIDAD);
		}
	});

	it("anular y desanular a la vez: la licencia y la marca de su cobro quedan coherentes", async () => {
		const central = await centralDePrueba();
		const compra = await cumplir(ENV, central.db, {
			id: "cs_disputada",
			payment_status: "paid",
			payment_intent: "pi_disputada",
			customer_details: { email: "bar@ejemplo.test" },
			line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: "12" } } }] },
		});
		if (compra.accion !== "emitida") throw new Error(compra.accion);
		const [licenseId] = compra.license_ids;
		// Una disputa abierta la ha anulado y ha marcado su cobro.
		await revertir(central.db, {
			id: "evt_disputa",
			type: "charge.dispute.created",
			data: { object: { object: "dispute", id: "du_1", payment_intent: "pi_disputada", status: "needs_response" } },
		});

		const pedidas: ("revocarAMano" | "desrevocar")[] = Array.from({ length: N }, (_, i) =>
			i % 2 === 0 ? "revocarAMano" : "desrevocar",
		);
		await Promise.all(pedidas.map((nombre) => central.db.operar(nombre, { licenseId, ahoraMs: Date.now() })));

		const [lic] = await filasDe(central, `SELECT status, disabled FROM licenses WHERE license_id = ?;`, licenseId);
		const [pago] = await filasDe(central, `SELECT reversed_reason, reversed_at_ms FROM license_payments;`);
		// Anulada si y sólo si está desactivada.
		expect(lic.disabled === 1).toBe(lic.status === "revoked");
		if (lic.status === "revoked") {
			// La anuló a mano la última: si la marca de la disputa seguía, es ya suya.
			expect([null, "dispute_ya_revocada"]).toContain(pago.reversed_reason);
		} else {
			// La desanuló la última: la marca de la disputa ya no está, y la licencia vuelve a donde estaba.
			expect(lic.status).toBe("issued");
			expect(pago).toEqual({ reversed_reason: null, reversed_at_ms: null });
		}
		// Ninguna dejó la marca de la disputa tal cual: todas tocaron el mismo cobro, una tras otra.
		expect(pago.reversed_reason).not.toBe("dispute");
	});
});

describe("lo que se prepara para la carrera", () => {
	it("la caducidad de partida está lejos de hoy: extender suma sobre ella", () => {
		expect(CADUCIDAD - Date.now()).toBeGreaterThan(365 * DIA);
	});

	it("la carrera es de verdad: leyendo y escribiendo en dos viajes, sí se pierden cambios", async () => {
		// Leer la caducidad en un viaje y escribir la nueva en otro: las N llamadas a la vez se cruzan
		// entre los dos, que es lo que las operaciones de arriba no pueden hacer. Que se crucen no se deja
		// a la planificación (en serie, leer₁ → escribir₁ → leer₂…, no se perdería nada): ninguna escribe
		// hasta que han leído todas, así que todas leen la misma caducidad y escriben la misma.
		const central = await centralDePrueba();
		await licenciaYClave(central, "equipo-del-bar");
		let leidas = 0;
		let soltar!: () => void;
		const hanLeidoTodas = new Promise<void>((resolver) => (soltar = resolver));
		await Promise.all(
			Array.from({ length: N }, async () => {
				const leida = await central.db.execute({ sql: "SELECT expires_at_ms FROM licenses WHERE license_id = 'viva';" });
				if (++leidas === N) soltar();
				await hanLeidoTodas;
				await central.db.execute({
					sql: "UPDATE licenses SET expires_at_ms = ?1 WHERE license_id = 'viva';",
					args: [addMonths(Number(leida.rows[0].expires_at_ms), 1)],
				});
			}),
		);
		// De los N meses se queda uno: los demás se han perdido.
		const final = (await getLicenseById(central.db, "viva"))!.expires_at_ms!;
		expect(final).toBe(addMonths(CADUCIDAD, 1));
	});
});
