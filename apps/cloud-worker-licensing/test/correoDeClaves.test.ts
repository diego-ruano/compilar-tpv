// test/correoDeClaves.test.ts
//
// CLAVES-SIN-CORREO (G7) · El correo con las claves de una compra que no consta como entregado se
// reenvía solo, en el cron diario: el mismo correo que `pnpm license:resend`, uno por licencia. Lo
// peor es que lleguen dos; mejor eso que un comprador sin sus claves. Sólo las de Stripe: una manual
// se emite sin `--send-key` a propósito, y su correo no consta nunca.
//
// Corre contra una base central de verdad (`helpers/central.ts`). Las compras entran por `cumplir`,
// como las del webhook, con el correo caído: así quedan sin `key_email_sent_at_ms`.

import { createExecutionContext, createScheduledController, env as entornoDePruebas, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import { CORREO_DE_CLAVES_MAX_MS, reenviarClavesSinCorreo } from "../src/domains/licensing/correoDeClaves";
import { cumplir } from "../src/domains/stripe/stripe.routes";
import { descifrar } from "../src/server/crypto";
import { activateLicenseFirstTime, issueLicense } from "../src/server/licenseStore";

const worker = (await import("../src/index")).default as ExportedHandler<any>;

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

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** Sin `EMAIL_FROM_ADDRESS` el correo no sale: así entra una compra sin su correo apuntado. */
const SIN_CORREO = { LICENSE_STORE_KEY: STORE_KEY } as any;

type Correo = { to: string; subject: string; text: string };

/** Con el correo funcionando: lo que sale, en `correos`; con `roto`, el buzón falla. */
function conCorreo() {
	const correos: Correo[] = [];
	const estado = { roto: false };
	const env = {
		LICENSE_STORE_KEY: STORE_KEY,
		EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
		EMAIL: {
			send: async (m: Correo) => {
				if (estado.roto) throw new Error("buzón caído");
				correos.push({ to: m.to, subject: m.subject, text: m.text });
			},
		},
	} as any;
	return { env, correos, estado };
}

/** Una sesión de checkout pagada del comprador `correo`. */
const sesion = (id: string, correo: string) => ({
	id,
	object: "checkout.session",
	payment_status: "paid",
	customer: "cus_de_pruebas",
	payment_intent: `pi_${id}`,
	customer_details: { email: correo, name: "Bar de pruebas" },
	line_items: { data: [{ price: { id: "price_anual", metadata: { term_months: "12" } } }] },
});

/** Una compra por Stripe cuyo correo de claves no salió, cobrada hace `haceMs`. Devuelve su licencia. */
async function compraSinCorreo(central: CentralDePrueba, id: string, haceMs = 10 * 60_000): Promise<string> {
	const r = await cumplir(SIN_CORREO, central.db, sesion(id, `${id}@ejemplo.test`));
	if (r.accion !== "emitida") throw new Error(`compra inesperada: ${r.accion}`);
	const [licencia] = r.license_ids;
	await envejecer(central, licencia, haceMs);
	return licencia;
}

/** Lleva la emisión y el cobro de la licencia `haceMs` atrás. */
async function envejecer(central: CentralDePrueba, licencia: string, haceMs: number) {
	await filasDe(central, "UPDATE licenses SET issued_at_ms = issued_at_ms - ? WHERE license_id = ?;", haceMs, licencia);
	await filasDe(central, "UPDATE license_payments SET at_ms = at_ms - ? WHERE license_id = ?;", haceMs, licencia);
}

const apuntado = async (central: CentralDePrueba, licencia: string) =>
	(await filasDe(central, "SELECT key_email_sent_at_ms AS en FROM licenses WHERE license_id = ?;", licencia))[0].en;

describe("CLAVES-SIN-CORREO · el cron reenvía el correo de claves que no consta", () => {
	it("el de una compra de Stripe de hace más del plazo, una vez; no el de una manual, una recién cobrada, una activada ni una anulada", async () => {
		const central = await centralDePrueba();
		const pendiente = await compraSinCorreo(central, "cs_pendiente");
		await compraSinCorreo(central, "cs_reciente", CORREO_DE_CLAVES_MAX_MS / 2);
		const activada = await compraSinCorreo(central, "cs_activada");
		await activateLicenseFirstTime(central.db, { licenseId: activada, tenantId: "t-1", deviceId: "d-1", termMonths: 12 });
		const anulada = await compraSinCorreo(central, "cs_anulada");
		await filasDe(central, "UPDATE licenses SET status = 'revoked', disabled = 1 WHERE license_id = ?;", anulada);
		const { license: manual } = await issueLicense(central.db, {
			claves: SIN_CORREO,
			termMonths: 12,
			origin: "manual",
			customerEmail: "manual@ejemplo.test",
			customerName: null,
		});
		await filasDe(central, "UPDATE licenses SET issued_at_ms = issued_at_ms - 3600000 WHERE license_id = ?;", manual.license_id);
		// Con un cobro antiguo, como una de Stripe: así sólo la deja fuera su origen.
		await filasDe(
			central,
			`INSERT INTO license_payments (payment_id, license_id, kind, term_months, at_ms)
			 VALUES ('pago-de-la-manual', ?, 'purchase', 12, ?);`,
			manual.license_id,
			Date.now() - 3600_000,
		);

		const { env, correos } = conCorreo();
		const hoy = await reenviarClavesSinCorreo(env, central.db, Date.now());
		const deHoy = correos.splice(0);
		const manana = await reenviarClavesSinCorreo(env, central.db, Date.now() + 24 * 3600_000);

		expect(hoy).toMatchObject({ reenviados: 1, fallidos: 0 });
		// El correo de `pnpm license:resend`, al de la compra, con su clave; y queda apuntado.
		expect(deHoy.map((c) => [c.to, c.subject])).toEqual([["cs_pendiente@ejemplo.test", "Tu licencia del TPV"]]);
		const [{ license_key_enc }] = await filasDe(central, "SELECT license_key_enc FROM licenses WHERE license_id = ?;", pendiente);
		expect(deHoy[0].text).toContain((await descifrar(SIN_CORREO, license_key_enc as string)).texto);
		expect(typeof (await apuntado(central, pendiente))).toBe("number");
		// Al día siguiente, la que ya consta no se repite, y la recién cobrada de ayer ya pasa del plazo.
		expect(manana).toMatchObject({ reenviados: 1, fallidos: 0 });
		expect(correos.map((c) => c.to)).toEqual(["cs_reciente@ejemplo.test"]);
		expect(await apuntado(central, manual.license_id)).toBeNull();
		expect(capturados.filter((c) => c.operacion !== "license_email.send")).toEqual([]);
	});

	it("con un tope por día: las más recientes primero, y las que no caben, al día siguiente", async () => {
		const central = await centralDePrueba();
		await compraSinCorreo(central, "cs_vieja", 3 * 3600_000);
		await compraSinCorreo(central, "cs_media", 2 * 3600_000);
		await compraSinCorreo(central, "cs_nueva", 3600_000);

		const { env, correos } = conCorreo();
		const hoy = await reenviarClavesSinCorreo(env, central.db, Date.now(), undefined, 2);
		const deHoy = correos.splice(0).map((c) => c.to);
		const manana = await reenviarClavesSinCorreo(env, central.db, Date.now() + 24 * 3600_000, undefined, 2);

		expect(hoy).toMatchObject({ reenviados: 2 });
		expect(deHoy).toEqual(["cs_nueva@ejemplo.test", "cs_media@ejemplo.test"]);
		expect(manana).toMatchObject({ reenviados: 1 });
		expect(correos.map((c) => c.to)).toEqual(["cs_vieja@ejemplo.test"]);
	});

	it("si el reenvío no sale, lo avisa en Sentry con la licencia, no lo apunta, y el día siguiente lo repite", async () => {
		const central = await centralDePrueba();
		const licencia = await compraSinCorreo(central, "cs_buzon_caido");
		capturados.length = 0;

		const { env, correos, estado } = conCorreo();
		estado.roto = true;
		const hoy = await reenviarClavesSinCorreo(env, central.db, Date.now());
		const avisos = capturados.splice(0).filter((c) => c.operacion === "stripe.correo_de_claves");
		const sinApuntar = await apuntado(central, licencia);
		estado.roto = false;
		const manana = await reenviarClavesSinCorreo(env, central.db, Date.now() + 24 * 3600_000);

		expect(hoy).toMatchObject({ reenviados: 0, fallidos: 1 });
		expect(avisos).toHaveLength(1);
		expect(avisos[0].mensaje).toContain(licencia);
		expect(avisos[0].mensaje).toContain("pnpm license:resend");
		expect(sinApuntar).toBeNull();
		expect(manana).toMatchObject({ reenviados: 1, fallidos: 0 });
		expect(correos.map((c) => c.to)).toEqual(["cs_buzon_caido@ejemplo.test"]);
	});

	it("si el correo sale y no se llega a apuntar, cuenta como reenviado y no avisa de que no ha salido", async () => {
		const central = await centralDePrueba();
		const licencia = await compraSinCorreo(central, "cs_sin_marca");
		capturados.length = 0;
		// La central no atiende la marca: un fallo pasajero de la plataforma.
		const sinMarca = centralInterceptada(central, (metodo, [sentencia], llamar) => {
			if (metodo === "ejecutar" && /SET key_email_sent_at_ms/.test((sentencia as { sql: string }).sql)) {
				throw Object.assign(new Error("Network connection lost."), { retryable: true });
			}
			return llamar();
		});

		const { env, correos } = conCorreo();
		const hoy = await reenviarClavesSinCorreo(env, sinMarca.db, Date.now());

		expect(correos.map((c) => c.to)).toEqual(["cs_sin_marca@ejemplo.test"]);
		expect(hoy).toMatchObject({ reenviados: 1, fallidos: 0, sinApuntar: 1 });
		// El comprador tiene su clave: nada de «su reenvío no ha salido». Sin la marca, mañana se repite.
		expect(capturados.filter((c) => c.operacion === "stripe.correo_de_claves")).toEqual([]);
		expect(await apuntado(central, licencia)).toBeNull();
	});

	it("lo hace el cron diario del worker", async () => {
		const central = await centralDePrueba();
		await compraSinCorreo(central, "cs_del_cron");
		const interceptada = centralInterceptada(central, (metodo, _argumentos, llamar) => {
			// La copia no llega a R2: aquí sólo se mira el correo de claves.
			if (metodo === "copiar") return Promise.resolve({ ok: false, error: "central_copia_fallida", detalle: "no en este test" });
			return llamar();
		});
		const { env, correos } = conCorreo();
		const ctx = createExecutionContext();
		await worker.scheduled!(
			createScheduledController({ scheduledTime: Date.now(), cron: "0 7 * * *" }),
			{ ...(entornoDePruebas as any), ...env, CHECKOUT_URL: "", ...interceptada.entorno },
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(correos.map((c) => c.to)).toEqual(["cs_del_cron@ejemplo.test"]);
	});
});
