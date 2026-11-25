// test/stripeCobro.test.ts
//
// REV-01 — un pago de Stripe se convierte en licencia UNA vez, aunque haya que reintentarlo.
//
// El fallo: un webhook que fallaba contestaba 500 para que Stripe reintentara, pero el reintento
// encontraba el evento ya registrado y contestaba «ya procesado» sin hacer nada. El cliente había
// pagado y no tenía clave. Arreglarlo sólo ahí abría el problema contrario: las escrituras del
// cobro iban sueltas, y un reintento tras un fallo a mitad sumaba los meses dos veces. Aquí se
// prueban las dos mitades: que el reintento se procesa y que lo hace exactamente una vez.
//
// Corre contra la base central de verdad (`helpers/central.ts`), índice único de `license_payments`
// incluido. Lo que NO cubre: la firma de Stripe ni la lectura de la sesión por HTTP, que viven en el
// handler; `cumplir` recibe la sesión ya leída.

import { describe, it, expect, vi } from "vitest";

import {
	centralDePrueba,
	conFalloEnLasOperaciones,
	filasDe,
	interceptar,
	type CentralDePrueba,
} from "./helpers/central";
import { cumplir, revertir } from "../src/domains/stripe/stripe.routes";
import { MAX_LICENCIAS_POR_COMPRA } from "../src/domains/stripe/stripe.helpers";
import { CentralNoDisponible, clienteCentral, type ClienteCentral } from "../src/server/central/cliente";
import { descifrar } from "../src/server/crypto";
import {
	activateLicenseFirstTime,
	getLicenseById,
	listLicenses,
	markWebhookProcessed,
	upsertWebhookEvent,
	type LicenseRow,
} from "../src/server/licenseStore";

/** Lo que se manda a Sentry: la operación y el mensaje. */
const { capturados } = vi.hoisted(() => ({ capturados: [] as { operacion: string; mensaje: string }[] }));

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			if (!original.esRechazoEsperado(error)) capturados.push({ operacion, mensaje: String((error as Error)?.message ?? error) });
			original.capturarError(error, operacion);
		},
	};
});

/** Clave AES de pruebas (32 bytes) para el cifrado de la clave de licencia. */
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** Sin `EMAIL_FROM_ADDRESS` el correo no sale: devuelve `false` y el cobro sigue, como en producción. */
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

const CUSTOMER = "cus_de_pruebas";

/** Una sesión de checkout pagada, con la forma que devuelve la API de Stripe. */
const sesion = (id: string, meses = 12) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: CUSTOMER,
	payment_intent: `pi_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: String(meses) } } }] },
});

type Escenario = {
	central: CentralDePrueba;
	db: ClienteCentral;
	/** Compra y activa la licencia del cliente (el alta por Stripe, cumplida). */
	licenciaActivada: () => Promise<LicenseRow>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	contar: (tabla: string) => Promise<number>;
	/** Una sentencia directa en el SQLite de la central (`filasDe`). */
	filas: (texto: string, ...args: unknown[]) => Promise<Record<string, any>[]>;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const db = central.db;

	const e: Escenario = {
		central,
		db,
		async licenciaActivada() {
			const r = await cumplir(ENV, db, sesion("cs_alta"));
			if (r.accion !== "emitida") throw new Error(`alta inesperada: ${r.accion}`);
			const [licenseId] = r.license_ids;
			await activateLicenseFirstTime(db, {
				licenseId,
				tenantId: "tenant-1",
				deviceId: "device-main",
				termMonths: 12,
			});
			return (await getLicenseById(db, licenseId))!;
		},
		async leer(licenseId) {
			return (await getLicenseById(db, licenseId))!;
		},
		async contar(tabla) {
			return Number((await filasDe(central, `SELECT COUNT(*) AS n FROM ${tabla};`))[0].n);
		},
		filas: (texto, ...args) => filasDe(central, texto, ...args),
	};

	return fn(e);
}

const evento = (id: string) => ({
	event_uid: id,
	event_name: "checkout.session.completed",
	resource_type: "checkout.session",
	resource_id: "cs_x",
	sig_hex: null,
	body_sha256: "0",
	payload_json: "{}",
});

describe("REV-01 · el reintento de un evento", () => {
	it("un evento nuevo se procesa", async () => {
		const r = await escenario((e) => upsertWebhookEvent(e.db, evento("evt_1")));
		expect(r.already).toBe(false);
	});

	it("un evento que FALLÓ se vuelve a procesar cuando Stripe lo reintenta", async () => {
		const r = await escenario(async (e) => {
			await upsertWebhookEvent(e.db, evento("evt_1"));
			await markWebhookProcessed(e.db, "evt_1", false, "la central no contesta");
			return upsertWebhookEvent(e.db, evento("evt_1"));
		});
		expect(r.already).toBe(false);
	});

	it("un evento que salió bien no se repite", async () => {
		const r = await escenario(async (e) => {
			await upsertWebhookEvent(e.db, evento("evt_1"));
			await markWebhookProcessed(e.db, "evt_1", true);
			return upsertWebhookEvent(e.db, evento("evt_1"));
		});
		expect(r.already).toBe(true);
	});
});

describe("REV-01 · una sesión se cumple una sola vez", () => {
	it("el alta emite una licencia y repetirla no emite otra", async () => {
		const r = await escenario(async (e) => {
			const primera = await cumplir(ENV, e.db, sesion("cs_alta"));
			const segunda = await cumplir(ENV, e.db, sesion("cs_alta"));
			return { primera, segunda, licencias: await e.contar("licenses"), cobros: await e.contar("license_payments") };
		});

		expect(r.primera.accion).toBe("emitida");
		expect(r.segunda.accion).toBe("ya_cumplida");
		// Con las licencias de la primera: la central dice cuáles son.
		expect(r.segunda).toEqual({ accion: "ya_cumplida", license_ids: (r.primera as { license_ids: string[] }).license_ids });
		expect(r.licencias).toBe(1);
		expect(r.cobros).toBe(1);
	});

	it("una segunda compra del mismo cliente emite OTRA clave (REV-13)", async () => {
		// Antes el webhook adivinaba: si ese cliente de Stripe ya tenía una licencia viva, la
		// compra nueva se la EXTENDÍA. O sea que comprar con los mismos datos era lo que disparaba
		// la renovación, y el dueño de un segundo local pagaba y no recibía clave. Ahora el
		// webhook no decide nada: emite. Lo que convierte una clave en tiempo añadido es
		// teclearla en un equipo que ya tiene licencia, y eso pasa al activar.
		const r = await escenario(async (e) => {
			const primera = await e.licenciaActivada();
			const segunda = await cumplir(ENV, e.db, sesion("cs_segundo_local"));
			return {
				primera,
				segunda,
				licencias: await e.contar("licenses"),
				primeraFinal: await e.leer(primera.license_id),
			};
		});

		expect(r.segunda.accion).toBe("emitida");
		expect(r.licencias).toBe(2);
		// Y a la del primer local no se le ha tocado ni un día.
		expect(r.primeraFinal.expires_at_ms).toBe(r.primera.expires_at_ms);
	});

	it("la base rechaza dos cobros con la misma sesión", async () => {
		// Si dos entregas se cruzan y las dos pasan la comprobación, la segunda revienta aquí y su
		// operación entera se deshace.
		await escenario(async (e) => {
			const insertar = (id: string) =>
				e.filas(
					`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
					   stripe_checkout_session_id, stripe_payment_intent_id, at_ms)
					 VALUES (?, 'lic', 'renewal', 12, 'cs_dup', 'pi_dup', 0);`,
					id,
				);
			await insertar("p1");
			await expect(insertar("p2")).rejects.toThrow(/UNIQUE/i);
		});
	});
});

describe("REV-01 · un fallo a mitad no deja nada a medias", () => {
	it("alta: si falla el registro del cobro no queda licencia, y el reintento emite una", async () => {
		const r = await escenario(async (e) => {
			const conFallo = conFalloEnLasOperaciones(e.central, /INSERT INTO license_payments/).db;
			const error = await cumplir(ENV, conFallo, sesion("cs_alta")).catch((err) => err);
			const licenciasTrasFallo = await e.contar("licenses");

			const reintento = await cumplir(ENV, e.db, sesion("cs_alta"));
			return {
				error,
				licenciasTrasFallo,
				reintento,
				licencias: await e.contar("licenses"),
				cobros: await e.contar("license_payments"),
			};
		});

		expect(r.error).toMatchObject({ code: "central_operacion_fallida" });
		expect(String(r.error?.message)).toMatch(/fallo_simulado/);
		// Sin esto, el reintento vería la sesión sellada en `licenses` y saldría sin registrar el
		// cobro: un reembolso posterior no sabría qué fue y revocaría a ciegas.
		expect(r.licenciasTrasFallo).toBe(0);
		expect(r.reintento.accion).toBe("emitida");
		expect(r.licencias).toBe(1);
		expect(r.cobros).toBe(1);
	});
});

describe("REV-01 · la plataforma corta la llamada que emite el cobro", () => {
	/** Los correos que manda `cumplir` con el correo configurado. */
	let correos: { to: string; text: string }[] = [];
	const CON_CORREO = {
		...ENV,
		EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
		EMAIL: {
			send: async (m: { to: string; text: string }) => {
				correos.push({ to: m.to, text: m.text });
			},
		},
	} as any;

	/**
	 * El cliente de la central, pero la plataforma corta la primera llamada a `operar` con `marca`
	 * (lo que pone Cloudflare en el error: `retryable`, un fallo pasajero; `overloaded`, saturada). Si
	 * `confirma`, el objeto llega a hacer la operación antes del corte, y quien llama no lo sabe.
	 */
	function conCorteEnLaPrimera(central: CentralDePrueba, { confirma, marca }: { confirma: boolean; marca: object }) {
		let llamadas = 0;
		const stub = interceptar(central.stub, async (metodo, _argumentos, llamar) => {
			if (metodo !== "operar" || ++llamadas > 1) return await llamar();
			if (confirma) await llamar();
			throw Object.assign(new Error("Network connection lost."), marca);
		});
		return { db: clienteCentral(() => stub), llamadas: () => llamadas };
	}

	const enviadas = async (e: Escenario) =>
		Number((await e.filas("SELECT COUNT(*) AS n FROM licenses WHERE key_email_sent_at_ms IS NOT NULL;"))[0].n);

	it("pasajera y ya confirmada: se repite una vez, la central contesta con estas licencias y la emisión sigue", async () => {
		correos = [];
		const r = await escenario(async (e) => {
			const cortada = conCorteEnLaPrimera(e.central, { confirma: true, marca: { retryable: true } });
			const resultado = await cumplir(CON_CORREO, cortada.db, sesionVarias("cs_cortada", [[12, 2]]));
			return { resultado, llamadas: cortada.llamadas(), licencias: await e.contar("licenses"), enviadas: await enviadas(e) };
		});

		// La primera llamada llegó a emitir; el reintento lo ve (`ya_cumplida` con las mismas
		// licencias) y sigue como si la hubiera emitido él: el correo con las claves y sus marcas.
		expect(r.llamadas).toBe(2);
		expect(r.resultado.accion).toBe("emitida");
		expect(r.licencias).toBe(2);
		expect(correos).toHaveLength(1);
		expect(r.enviadas).toBe(2);
	});

	it("pasajera y sin confirmar: se repite una vez y emite", async () => {
		correos = [];
		const r = await escenario(async (e) => {
			const cortada = conCorteEnLaPrimera(e.central, { confirma: false, marca: { retryable: true } });
			const resultado = await cumplir(CON_CORREO, cortada.db, sesion("cs_sin_confirmar"));
			return { resultado, llamadas: cortada.llamadas(), licencias: await e.contar("licenses") };
		});

		expect(r.llamadas).toBe(2);
		expect(r.resultado.accion).toBe("emitida");
		expect(r.licencias).toBe(1);
		expect(correos).toHaveLength(1);
	});

	it("saturada: no se repite; falla, y la entrega siguiente de Stripe la encuentra cumplida por otra", async () => {
		correos = [];
		const r = await escenario(async (e) => {
			const cortada = conCorteEnLaPrimera(e.central, { confirma: true, marca: { overloaded: true } });
			const error = await cumplir(CON_CORREO, cortada.db, sesion("cs_saturada")).catch((err) => err);
			const llamadas = cortada.llamadas();
			// Stripe reintenta el evento: es otra entrega, con sus claves y sus ids.
			const reintento = await cumplir(CON_CORREO, e.db, sesion("cs_saturada"));
			return { error, llamadas, reintento, licencias: await e.contar("licenses") };
		});

		expect(r.llamadas).toBe(1);
		expect(r.error).toBeInstanceOf(CentralNoDisponible);
		expect(r.error).toMatchObject({ motivo: "saturada", code: "hub_overloaded" });
		// Lo que emitió la primera se queda, y la segunda entrega no manda otro correo: no son suyas.
		expect(r.reintento.accion).toBe("ya_cumplida");
		expect(r.licencias).toBe(1);
		expect(correos).toHaveLength(0);
	});

	// CLAVES-SIN-CORREO (G7): la entrega que encuentra la sesión cumplida sin el correo de claves
	// apuntado lo reenvía ella, si el cobro no es de ahora. Lo peor es que lleguen dos correos.
	it("la entrega que la encuentra cumplida sin el correo de claves apuntado lo reenvía, si el cobro no es de ahora", async () => {
		correos = [];
		const r = await escenario(async (e) => {
			const cortada = conCorteEnLaPrimera(e.central, { confirma: true, marca: { overloaded: true } });
			await cumplir(CON_CORREO, cortada.db, sesionVarias("cs_sin_correo", [[12, 2]])).catch(() => {});
			capturados.length = 0;
			// Recién cobrada, puede ser otra entrega que está mandando el correo ahora mismo: no se reenvía.
			const enseguida = await cumplir(CON_CORREO, e.db, sesionVarias("cs_sin_correo", [[12, 2]]));
			const correosEnseguida = correos.splice(0);
			// La entrega de Stripe de más tarde: nadie va a mandar ya ese correo, así que lo manda ella.
			await e.filas("UPDATE license_payments SET at_ms = at_ms - 10 * 60 * 1000;");
			let viajes = 0;
			const contada = interceptar(e.central.stub, (_metodo, _argumentos, llamar) => {
				viajes++;
				return llamar();
			});
			const despues = await cumplir(CON_CORREO, clienteCentral(() => contada), sesionVarias("cs_sin_correo", [[12, 2]]));
			const reenviados = correos.splice(0);
			// Y queda apuntado: otra entrega más no lo repite.
			await cumplir(CON_CORREO, e.db, sesionVarias("cs_sin_correo", [[12, 2]]));
			const licencias = await e.filas("SELECT license_key_enc, key_email_sent_at_ms FROM licenses ORDER BY rowid;");
			const claves = await Promise.all(licencias.map(async (l) => (await descifrar(CON_CORREO, l.license_key_enc)).texto));
			return { enseguida, correosEnseguida, despues, reenviados, viajes, otra: correos.splice(0), licencias, claves, avisos: capturados.splice(0) };
		});

		expect([r.enseguida.accion, r.despues.accion]).toEqual(["ya_cumplida", "ya_cumplida"]);
		expect(r.correosEnseguida).toEqual([]);
		// El correo de la compra: uno solo con todas las claves que faltan, al correo de la compra.
		expect(r.reenviados.map((c) => c.to)).toEqual(["bar@ejemplo.test"]);
		expect(r.claves.map((clave) => r.reenviados[0].text.includes(clave))).toEqual([true, true]);
		// Y los viajes a la central no crecen con las licencias de la compra: ver que está cumplida, leer
		// las que faltan y apuntarlas.
		expect(r.viajes).toBe(3);
		expect(r.licencias.every((l) => typeof l.key_email_sent_at_ms === "number")).toBe(true);
		expect(r.otra).toEqual([]);
		// Ha salido: no hay nada que avisar.
		expect(r.avisos).toEqual([]);
	});

	it("si el reenvío no sale, lo avisa en Sentry con las licencias, y la entrega no falla", async () => {
		const r = await escenario(async (e) => {
			const cortada = conCorteEnLaPrimera(e.central, { confirma: true, marca: { overloaded: true } });
			await cumplir(ENV, cortada.db, sesion("cs_sin_buzon")).catch(() => {});
			await e.filas("UPDATE license_payments SET at_ms = at_ms - 10 * 60 * 1000;");
			capturados.length = 0;
			// Sin `EMAIL_FROM_ADDRESS`, el correo no sale.
			const despues = await cumplir(ENV, e.db, sesion("cs_sin_buzon"));
			const [licencia] = await e.filas("SELECT license_id, key_email_sent_at_ms FROM licenses;");
			return { despues, licencia, avisos: capturados.splice(0) };
		});

		expect(r.despues.accion).toBe("ya_cumplida");
		expect(r.licencia.key_email_sent_at_ms).toBeNull();
		const aviso = r.avisos.find((a) => a.operacion === "stripe.correo_de_claves");
		expect(aviso?.mensaje).toContain("pnpm license:resend");
		expect(aviso?.mensaje).toContain(r.licencia.license_id);
	});

	it("con el correo de claves apuntado, una entrega repetida más tarde no avisa de nada", async () => {
		correos = [];
		const avisos = await escenario(async (e) => {
			expect((await cumplir(CON_CORREO, e.db, sesion("cs_con_correo"))).accion).toBe("emitida");
			await e.filas("UPDATE license_payments SET at_ms = at_ms - 10 * 60 * 1000;");
			capturados.length = 0;
			expect((await cumplir(CON_CORREO, e.db, sesion("cs_con_correo"))).accion).toBe("ya_cumplida");
			return capturados.splice(0);
		});

		expect(correos).toHaveLength(1);
		expect(avisos).toEqual([]);
	});

	it("dos cortes seguidos: se repite una sola vez y falla", async () => {
		const r = await escenario(async (e) => {
			let llamadas = 0;
			const stub = interceptar(e.central.stub, async (metodo, _argumentos, llamar) => {
				if (metodo !== "operar") return await llamar();
				llamadas++;
				throw Object.assign(new Error("Network connection lost."), { retryable: true });
			});
			const error = await cumplir(ENV, clienteCentral(() => stub), sesion("cs_dos_cortes")).catch((err) => err);
			return { error, llamadas, licencias: await e.contar("licenses") };
		});

		expect(r.llamadas).toBe(2);
		expect(r.error).toMatchObject({ motivo: "pasajera", code: "hub_unavailable" });
		expect(r.licencias).toBe(0);
	});
});


/* ============================================================
   RI-52 · Una compra de varias unidades
============================================================ */

/** Una sesión con varias líneas: `[meses, cantidad]` por línea, como la devuelve Stripe. */
const sesionVarias = (id: string, lineas: [number, number][]) => ({
	...sesion(id),
	line_items: {
		data: lineas.map(([meses, quantity], i) => ({
			quantity,
			price: { id: `price_${i}`, metadata: { term_months: String(meses) } },
		})),
	},
});

const reembolso = (paymentIntent: string, total = 36000, devuelto = 36000) => ({
	type: "charge.refunded",
	id: `evt_reembolso_${paymentIntent}_${devuelto}`,
	data: {
		object: {
			object: "charge",
			payment_intent: paymentIntent,
			customer: CUSTOMER,
			amount: total,
			amount_refunded: devuelto,
		},
	},
});

const disputa = (paymentIntent: string, tipo: "created" | "closed", status = "needs_response") => ({
	type: `charge.dispute.${tipo}`,
	id: `evt_disputa_${tipo}_${paymentIntent}`,
	data: { object: { object: "dispute", payment_intent: paymentIntent, customer: CUSTOMER, status } },
});

async function emitidas(e: Escenario, id: string, lineas: [number, number][]): Promise<string[]> {
	const r = await cumplir(ENV, e.db, sesionVarias(id, lineas));
	if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
	return r.license_ids;
}

describe("RI-52 · una licencia por unidad", () => {
	it("comprar 3 emite 3 licencias distintas, cada una con su cobro, y repetirla no emite más", async () => {
		const r = await escenario(async (e) => {
			const primera = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			const segunda = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			const unidades = (await e.filas("SELECT unidad FROM license_payments ORDER BY unidad;")).map((f) => Number(f.unidad));
			const meses = (await e.filas("SELECT term_months FROM licenses;")).map((f) => Number(f.term_months));
			const listadas = (await listLicenses(e.db)).map((l) => l.license_id);
			return { primera, segunda, unidades, meses, listadas, licencias: await e.contar("licenses") };
		});

		expect(r.primera.accion).toBe("emitida");
		const ids = r.primera.accion === "emitida" ? r.primera.license_ids : [];
		expect(new Set(ids).size).toBe(3);
		// Tres licencias de un año, no una de tres: quien compra varias puede querer varios locales.
		expect(r.meses).toEqual([12, 12, 12]);
		expect(r.unidades).toEqual([1, 2, 3]);
		expect(r.segunda).toEqual({ accion: "ya_cumplida", license_ids: ids });
		expect(r.licencias).toBe(3);
		// Nacen en el mismo instante: en la lista de la administración, la última unidad va primero.
		expect(r.listadas).toEqual([...ids].reverse());
	});

	it("con varias líneas, cada unidad lleva la duración de la suya", async () => {
		const meses = await escenario(async (e) => {
			await emitidas(e, "cs_mixta", [
				[12, 2],
				[3, 1],
			]);
			return (await e.filas("SELECT term_months FROM licenses ORDER BY term_months;")).map((f) => Number(f.term_months));
		});
		expect(meses).toEqual([3, 12, 12]);
	});

	it("fail-closed: una línea sin duración, una cantidad rara o demasiadas no emiten nada", async () => {
		const r = await escenario(async (e) => {
			const sinDuracion = {
				...sesionVarias("cs_mala", [[12, 2]]),
				line_items: {
					data: [
						{ quantity: 2, price: { id: "price_anual", metadata: { term_months: "12" } } },
						{ quantity: 1, price: { id: "price_sin_meses", metadata: {} } },
					],
				},
			};
			const errores = [
				await cumplir(ENV, e.db, sinDuracion).catch((err) => String(err?.message)),
				await cumplir(ENV, e.db, sesionVarias("cs_cero", [[12, 0]])).catch((err) => String(err?.message)),
				await cumplir(ENV, e.db, sesionVarias("cs_mucho", [[12, MAX_LICENCIAS_POR_COMPRA + 1]])).catch(
					(err) => String(err?.message),
				),
			];
			return { errores, licencias: await e.contar("licenses"), cobros: await e.contar("license_payments") };
		});

		expect(r.errores[0]).toMatch(/missing_term_months_metadata/);
		expect(r.errores[1]).toMatch(/cantidad_invalida/);
		expect(r.errores[2]).toMatch(/demasiadas_licencias/);
		expect(r.licencias).toBe(0);
		expect(r.cobros).toBe(0);
	});

	it("si falla a mitad no queda ninguna, y el reintento emite todas", async () => {
		const r = await escenario(async (e) => {
			const conFallo = conFalloEnLasOperaciones(e.central, /INSERT INTO license_payments/).db;
			const error = await cumplir(ENV, conFallo, sesionVarias("cs_pack", [[12, 3]])).catch((err) => err);
			const trasFallo = await e.contar("licenses");
			const reintento = await cumplir(ENV, e.db, sesionVarias("cs_pack", [[12, 3]]));
			return { error, trasFallo, reintento, licencias: await e.contar("licenses") };
		});

		expect(String(r.error?.message)).toMatch(/fallo_simulado/);
		expect(r.trasFallo).toBe(0);
		expect(r.reintento.accion).toBe("emitida");
		expect(r.licencias).toBe(3);
	});

	it("la base admite varias unidades de una sesión, pero no la misma dos veces", async () => {
		await escenario(async (e) => {
			const insertar = (id: string, unidad: number) =>
				e.filas(
					`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
					   stripe_checkout_session_id, stripe_payment_intent_id, unidad, at_ms)
					 VALUES (?, 'lic', 'issue', 12, 'cs_dup', 'pi_dup', ?, 0);`,
					id,
					unidad,
				);
			await insertar("p1", 1);
			await insertar("p2", 2);
			await expect(insertar("p3", 1)).rejects.toThrow(/UNIQUE/i);
		});
	});
});

describe("RI-52 · deshacer una compra de varias unidades", () => {
	it("un reembolso total revoca todas las licencias de la compra", async () => {
		const estados = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			await revertir(e.db, reembolso("pi_cs_pack"));
			return Promise.all(ids.map(async (id) => (await e.leer(id)).status));
		});
		expect(estados).toEqual(["revoked", "revoked", "revoked"]);
	});

	it("una clave del pack ya canjeada en otro local pierde allí sus meses; las demás se revocan", async () => {
		const r = await escenario(async (e) => {
			const otroLocal = await e.licenciaActivada();
			const [canjeada, sinUsar] = await emitidas(e, "cs_pack", [[12, 2]]);
			// Lo que hace la activación al teclear una clave nueva en un equipo con licencia (REV-13).
			const canje = await e.db.operar("canjearClave", {
				claveId: canjeada,
				licenciaId: otroLocal.license_id,
				deviceId: "device-main",
				meses: 12,
				ahoraMs: Date.now(),
			});

			const resultado = await revertir(e.db, reembolso("pi_cs_pack", 24000, 24000));
			return {
				canje,
				resultado,
				otroLocal: await e.leer(otroLocal.license_id),
				antes: otroLocal.expires_at_ms,
				sinUsar: await e.leer(sinUsar),
			};
		});

		expect(r.canje.resultado).toBe("sumado");
		expect(r.resultado.reversed).toBe(true);
		// El otro local sigue vivo, con la fecha que tenía antes del canje.
		expect(r.otroLocal.status).toBe("active");
		expect(r.otroLocal.expires_at_ms).toBe(r.antes);
		expect(r.sinUsar.status).toBe("revoked");
	});

	it("un reembolso parcial no toca ninguna y deja dicho cuáles eran", async () => {
		const r = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			const resultado = await revertir(e.db, reembolso("pi_cs_pack", 36000, 12000));
			const auditoria = JSON.parse(String((await e.filas("SELECT detail FROM admin_audit WHERE action = 'refund';"))[0].detail));
			return {
				ids,
				resultado,
				auditoria,
				estados: await Promise.all(ids.map(async (id) => (await e.leer(id)).status)),
			};
		});

		expect(r.resultado.reason).toBe("partial_refund");
		expect(r.estados).toEqual(["issued", "issued", "issued"]);
		expect([...r.auditoria.licencias].sort()).toEqual([...r.ids].sort());
	});

	it("abrir una disputa las corta todas y ganarla las devuelve todas, una sola vez", async () => {
		const r = await escenario(async (e) => {
			const ids = await emitidas(e, "cs_pack", [[12, 3]]);
			await revertir(e.db, disputa("pi_cs_pack", "created"));
			const cortadas = await Promise.all(ids.map(async (id) => (await e.leer(id)).status));
			const repetida = await revertir(e.db, { ...disputa("pi_cs_pack", "created"), id: "evt_otra" });
			await revertir(e.db, disputa("pi_cs_pack", "closed", "won"));
			const devueltas = await Promise.all(ids.map(async (id) => (await e.leer(id)).status));
			return { cortadas, repetida, devueltas };
		});

		expect(r.cortadas).toEqual(["revoked", "revoked", "revoked"]);
		expect(r.repetida.reason).toBe("already_reversed");
		expect(r.devueltas).toEqual(["issued", "issued", "issued"]);
	});
});
