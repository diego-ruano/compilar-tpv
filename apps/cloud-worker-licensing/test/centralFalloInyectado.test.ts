// test/centralFalloInyectado.test.ts
//
// Una operación de la base central entra entera o no entra (`operaciones/registro.ts`). Aquí se le
// hace fallar a cada una justo después de cada una de sus sentencias, una vez por sentencia: tras
// la primera, tras la segunda… hasta que termina sin llegar al fallo. Cada vez, la central entera
// —todas sus tablas, fila a fila— tiene que quedar como estaba antes de pedirla.
//
// El fallo se mete por fuera del código de producción: la operación corre dentro del objeto, en su
// transacción, como en `BaseCentral.operar`, pero sobre una base que revienta tras la sentencia
// número k (`operarConFallo`, `helpers/central.ts`).

import { describe, expect, it } from "vitest";

import { centralDePrueba, filasDe, fotoDeLaCentral, operarConFallo, type CentralDePrueba } from "./helpers/central";
import { cumplir, revertir } from "../src/domains/stripe/stripe.routes";
import type { Operaciones } from "../src/server/central/operaciones/registro";
import { activateLicenseFirstTime, claveNueva, putDeviceOtp } from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

/** Una compra de Stripe de `unidades` licencias anuales: sus licencias. */
async function comprar(central: CentralDePrueba, sesion: string, unidades = 1, cliente = "cus_fallo"): Promise<string[]> {
	const r = await cumplir(ENV, central.db, {
		id: sesion,
		payment_status: "paid",
		customer: cliente,
		payment_intent: `pi_${sesion}`,
		customer_details: { email: "bar@ejemplo.test" },
		line_items: { data: [{ quantity: unidades, price: { id: "price_anual", metadata: { term_months: "12" } } }] },
	});
	if (r.accion !== "emitida") throw new Error(r.accion);
	return r.license_ids;
}

async function activar(central: CentralDePrueba, licenseId: string, deviceId = "equipo-del-bar") {
	await activateLicenseFirstTime(central.db, { licenseId, tenantId: "t-1", deviceId, termMonths: 12 });
}

/** Un evento de Stripe sobre el cargo de la sesión, como lo lee la operación. */
const evento = (sesion: string, tipo: string, objeto: Record<string, unknown>) => ({
	evento: {
		id: `evt_${tipo}_${sesion}`,
		tipo,
		objeto: {
			id: `du_${sesion}`,
			paymentIntent: `pi_${sesion}`,
			customer: "",
			status: "",
			amount: 0,
			amountRefunded: 0,
			...objeto,
		},
	},
	ahoraMs: Date.now(),
});

type Caso<N extends keyof Operaciones> = {
	que: string;
	nombre: N;
	/** Deja la central como la necesita el caso y devuelve los datos de la operación. */
	preparar: (central: CentralDePrueba) => Promise<Parameters<Operaciones[N]>[1]>;
	/**
	 * Cuántas sentencias ejecuta la operación en este caso, exactamente: una sentencia nueva obliga a
	 * mirar este test.
	 */
	sentencias: number;
};

const caso = <N extends keyof Operaciones>(c: Caso<N>) => c;

const CASOS = [
	caso({
		que: "el canje de una clave sobre la licencia viva del equipo",
		nombre: "canjearClave",
		sentencias: 5,
		async preparar(central) {
			const [viva] = await comprar(central, "cs_viva");
			await activar(central, viva);
			const [clave] = await comprar(central, "cs_clave");
			return { claveId: clave, licenciaId: viva, deviceId: "equipo-del-bar", meses: 12, ahoraMs: Date.now() };
		},
	}),
	caso({
		que: "el traslado de una licencia a otro equipo con el código del correo",
		nombre: "trasladarLicencia",
		sentencias: 7,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_traslado");
			await activar(central, lic);
			const codeHash = "huella-del-codigo";
			await putDeviceOtp(central.db, {
				licenseId: lic,
				newDeviceId: "equipo-nuevo",
				codeHash,
				expiresAtMs: Date.now() + 60_000,
			});
			return {
				licenciaId: lic,
				deDeviceId: "equipo-del-bar",
				aDeviceId: "equipo-nuevo",
				devicePubKey: "clave-del-equipo-nuevo",
				tenantId: "t-1",
				codeHash,
				swapId: crypto.randomUUID(),
				ahoraMs: Date.now(),
			};
		},
	}),
	caso({
		que: "la emisión de un cobro de tres licencias",
		nombre: "emitirCobro",
		sentencias: 7,
		async preparar() {
			const unidades = [];
			for (const termMonths of [12, 12, 3]) {
				const { keyPlain: _enClaro, ...clave } = await claveNueva(STORE_KEY);
				unidades.push({ ...clave, termMonths, licenseId: crypto.randomUUID(), paymentId: crypto.randomUUID() });
			}
			return {
				sessionId: "cs_pack",
				comprador: { customerEmail: "bar@ejemplo.test", customerName: "Bar", stripePaymentIntentId: "pi_cs_pack" },
				unidades,
				ahoraMs: Date.now(),
			};
		},
	}),
	caso({
		que: "el reembolso total de un pack de tres, con una ya revocada",
		nombre: "revertirCobro",
		sentencias: 12,
		async preparar(central) {
			const [primera] = await comprar(central, "cs_pack", 3);
			await activar(central, primera);
			await central.db.operar("revocarAMano", { licenseId: primera, ahoraMs: Date.now() });
			return evento("cs_pack", "charge.refunded", { amount: 36_000, amountRefunded: 36_000 });
		},
	}),
	caso({
		que: "el reembolso total de una renovación canjeada",
		nombre: "revertirCobro",
		sentencias: 6,
		async preparar(central) {
			const [base] = await comprar(central, "cs_base");
			await activar(central, base);
			const [renovacion] = await comprar(central, "cs_renovacion");
			await central.db.operar("canjearClave", {
				claveId: renovacion,
				licenciaId: base,
				deviceId: "equipo-del-bar",
				meses: 12,
				ahoraMs: Date.now(),
			});
			return evento("cs_renovacion", "charge.refunded", { amount: 12_000, amountRefunded: 12_000 });
		},
	}),
	caso({
		que: "la disputa ganada de un alta",
		nombre: "revertirCobro",
		sentencias: 9,
		async preparar(central) {
			const [primera] = await comprar(central, "cs_alta", 2);
			await activar(central, primera);
			await revertir(central.db, {
				id: "evt_abierta",
				type: "charge.dispute.created",
				data: { object: { id: "du_cs_alta", payment_intent: "pi_cs_alta", status: "needs_response" } },
			});
			return evento("cs_alta", "charge.dispute.closed", { status: "won" });
		},
	}),
	caso({
		que: "una consulta del banco que escala y se cierra perdida",
		nombre: "revertirCobro",
		sentencias: 12,
		async preparar(central) {
			const [primera] = await comprar(central, "cs_consulta", 2);
			await activar(central, primera);
			await revertir(central.db, {
				id: "evt_consulta",
				type: "charge.dispute.created",
				data: { object: { id: "du_cs_consulta", payment_intent: "pi_cs_consulta", status: "warning_needs_response" } },
			});
			return evento("cs_consulta", "charge.dispute.closed", { status: "lost" });
		},
	}),
	caso({
		que: "los fondos retirados de un pack de tres, con una ya revocada a mano",
		nombre: "revertirCobro",
		sentencias: 16,
		async preparar(central) {
			const [primera] = await comprar(central, "cs_fondos", 3);
			await activar(central, primera);
			await central.db.operar("revocarAMano", { licenseId: primera, ahoraMs: Date.now() });
			return evento("cs_fondos", "charge.dispute.funds_withdrawn", { status: "needs_response" });
		},
	}),
	caso({
		que: "un reembolso sin cobro registrado, atribuido por el cliente de Stripe",
		nombre: "revertirCobro",
		sentencias: 5,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_cliente", 1, "cus_unico");
			await activar(central, lic);
			// Una licencia de antes del historial de cobros (LIC-07): ni cobro ni cargo sellado.
			await filasDe(central, "DELETE FROM license_payments;");
			await filasDe(central, "UPDATE licenses SET stripe_payment_intent_id = NULL;");
			return evento("cs_otra", "charge.refunded", { customer: "cus_unico", amount: 12_000, amountRefunded: 12_000 });
		},
	}),
	caso({
		que: "la disputa ganada de una renovación canjeada",
		nombre: "revertirCobro",
		sentencias: 6,
		async preparar(central) {
			const [base] = await comprar(central, "cs_base");
			await activar(central, base);
			const [renovacion] = await comprar(central, "cs_renovacion");
			await central.db.operar("canjearClave", {
				claveId: renovacion,
				licenciaId: base,
				deviceId: "equipo-del-bar",
				meses: 12,
				ahoraMs: Date.now(),
			});
			await revertir(central.db, {
				id: "evt_abierta",
				type: "charge.dispute.created",
				data: { object: { id: "du_cs_renovacion", payment_intent: "pi_cs_renovacion", status: "needs_response" } },
			});
			return evento("cs_renovacion", "charge.dispute.closed", { status: "won" });
		},
	}),
	caso({
		que: "anular a mano una licencia que una disputa abierta ya anuló",
		nombre: "revocarAMano",
		sentencias: 2,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_disputa");
			await activar(central, lic);
			await revertir(central.db, {
				id: "evt_disputa",
				type: "charge.dispute.created",
				data: { object: { id: "du_cs_disputa", payment_intent: "pi_cs_disputa", status: "needs_response" } },
			});
			return { licenseId: lic, ahoraMs: Date.now() };
		},
	}),
	caso({
		que: "desanular a mano una licencia que anuló una disputa",
		nombre: "desrevocar",
		sentencias: 2,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_disputa");
			await activar(central, lic);
			await revertir(central.db, {
				id: "evt_disputa",
				type: "charge.dispute.created",
				data: { object: { id: "du_cs_disputa", payment_intent: "pi_cs_disputa", status: "needs_response" } },
			});
			return { licenseId: lic, ahoraMs: Date.now() };
		},
	}),
	caso({
		que: "extender a mano",
		nombre: "extenderAMano",
		sentencias: 2,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_extender");
			await activar(central, lic);
			return { licenseId: lic, meses: 3, ahoraMs: Date.now() };
		},
	}),
	caso({
		que: "acortar a mano",
		nombre: "acortarAMano",
		sentencias: 2,
		async preparar(central) {
			const [lic] = await comprar(central, "cs_acortar");
			await activar(central, lic);
			return { licenseId: lic, meses: 3, ahoraMs: Date.now() };
		},
	}),
];

describe("un fallo tras cualquier sentencia de una operación no deja nada escrito", () => {
	it.each(CASOS.map((c) => [`${c.nombre}: ${c.que}`, c] as const))("%s", async (_titulo, c) => {
		const central = await centralDePrueba();
		const datos = await c.preparar(central);
		const antes = await fotoDeLaCentral(central);

		let k = 1;
		for (;;) {
			const respuesta = await operarConFallo(central, c.nombre, datos as never, (_texto, n) => n === k);
			if (respuesta.ok) break;
			expect(respuesta, `tras la sentencia ${k}`).toEqual({
				ok: false,
				error: "central_operacion_fallida",
				detalle: "fallo_simulado",
			});
			expect(await fotoDeLaCentral(central), `tras la sentencia ${k}`).toEqual(antes);
			k++;
		}

		// Ha fallado tras cada una de sus sentencias y, la última vez, ha terminado (y ha escrito).
		expect(k - 1).toBe(c.sentencias);
		expect(await fotoDeLaCentral(central)).not.toEqual(antes);
	});
});
