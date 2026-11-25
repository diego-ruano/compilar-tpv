// test/correoTopeDiario.test.ts
//
// REV-14 — el tope diario de correos por negocio.
//
// El filtro de destinatario (FABLE-C) no acotaba a quién se puede escribir: dar de alta un
// proveedor es una escritura de negocio corriente, así que con un token robado se creaba un
// proveedor con cualquier correo y se enviaba, sin límite, con el SPF/DKIM de nuestro dominio
// detrás. Acotaba el número de pasos, no el destinatario. Esto recupera el eje que faltaba.
//
// AUD-41: el sitio se reserva con la fila del envío, en una sola sentencia (`reservarCupo`), y
// cuenta lo entregado y lo que está saliendo. Lo que pasa con peticiones a la vez está en
// `correoTopeDiarioConcurrente.test.ts`.
//
// Cada caso, contra su propia base central de verdad (`helpers/central.ts`).

import { describe, it, expect } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import { reservarCupo, TOPE_DIARIO, VENTANA_MS, type Envio } from "../src/domains/email/email.routes";

const TENANT = "tenant-1";

const envio = (id = crypto.randomUUID()): Envio => ({
	id,
	tenantId: TENANT,
	deviceId: "dev",
	toEmail: "prov@prueba.test",
	proveedor: "Prov",
});

type Apunte = { ok?: number; error_code?: string | null; sent_at_ms?: number; tenant_id?: string; tipo?: string };

async function escenario<T>(
	fn: (e: { central: CentralDePrueba; apuntar: (n: number, extra?: Apunte) => Promise<void> }) => Promise<T>,
): Promise<T> {
	const central = await centralDePrueba();
	return fn({
		central,
		// `n` envíos (al menos uno), en una sola sentencia: cien, uno a uno, serían cien viajes.
		async apuntar(n, extra = {}) {
			const f = { ok: 1, error_code: null, sent_at_ms: Date.now(), tenant_id: TENANT, tipo: "pedido", ...extra };
			await filasDe(
				central,
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				 INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
				 SELECT ? || '-' || i, ?, 'dev', 'a@b.test', 'Prov', ?, ?, ?, ? FROM n;`,
				n,
				crypto.randomUUID(),
				f.tenant_id,
				f.ok,
				f.error_code,
				f.sent_at_ms,
				f.tipo,
			);
		},
	});
}

/** Las filas de los pedidos del negocio de la prueba. */
const filas = async (central: CentralDePrueba) =>
	(await filasDe(central, `SELECT COUNT(*) AS n FROM email_sends WHERE tenant_id = ? AND tipo = 'pedido';`, TENANT))[0].n;

describe("REV-14 · el cupo diario de correo", () => {
	it("por debajo del tope se reserva, con la fila «enviando» del pedido", async () => {
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO - 1);
			const reserva = await reservarCupo(e.central.db, envio("este"));
			const [fila] = await filasDe(e.central, `SELECT * FROM email_sends WHERE id = 'este';`);
			return { reserva, fila };
		});
		expect(r.reserva).toBe("reservado");
		expect(r.fila).toMatchObject({
			tenant_id: TENANT,
			device_id: "dev",
			to_email: "prov@prueba.test",
			proveedor: "Prov",
			ok: 0,
			error_code: "enviando",
			tipo: "pedido",
		});
	});

	it("alcanzado el tope se corta, y no deja fila", async () => {
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO);
			return { reserva: await reservarCupo(e.central.db, envio()), filas: await filas(e.central) };
		});
		expect(r).toEqual({ reserva: "tope", filas: TOPE_DIARIO });
	});

	it("lo que está saliendo ocupa sitio (AUD-41)", async () => {
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO - 1);
			await e.apuntar(1, { ok: 0, error_code: "enviando" });
			return reservarCupo(e.central.db, envio());
		});
		expect(r).toBe("tope");
	});

	it("una reserva que se quedó a medias cuenta hasta que sale de la ventana, como lo entregado", async () => {
		// El worker murió entre la reserva y apuntar cómo acabó: no se sabe si salió, y contarla es lo
		// prudente. Pero no cuenta para siempre: a las 24 h sale de la ventana como cualquier otra.
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO, { ok: 0, error_code: "enviando", sent_at_ms: Date.now() - VENTANA_MS + 60_000 });
			const hoy = await reservarCupo(e.central.db, envio());
			await filasDe(e.central, `UPDATE email_sends SET sent_at_ms = ?;`, Date.now() - VENTANA_MS - 1000);
			const pasada = await reservarCupo(e.central.db, envio());
			return { hoy, pasada };
		});
		expect(r).toEqual({ hoy: "tope", pasada: "reservado" });
	});

	it("los de ayer no cuentan: la ventana es móvil, no el día natural", async () => {
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO, { sent_at_ms: Date.now() - VENTANA_MS - 1000 });
			return reservarCupo(e.central.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("los que NO salieron no gastan cupo", async () => {
		// Un proveedor con el buzón lleno, o una caída de nuestro proveedor de correo, no pueden
		// dejar a un bar sin poder pedir. Y lo que se protege —la reputación del dominio— sólo
		// sufre con lo que sale.
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO / 2, { ok: 0 });
			await e.apuntar(TOPE_DIARIO / 2, { ok: 0, error_code: "E_RATE_LIMIT_EXCEEDED" });
			return reservarCupo(e.central.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("el cupo es de cada negocio, no de todos juntos", async () => {
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO, { tenant_id: "otro-bar" });
			await e.apuntar(TOPE_DIARIO, { tenant_id: "otro-bar", ok: 0, error_code: "enviando" });
			return reservarCupo(e.central.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("si no se puede reservar, se deja pasar", async () => {
		// Misma regla que el registro del envío: la base central caída no puede impedir que un bar
		// mande su pedido. Un tope que convierte una caída nuestra en «no puedes trabajar» cuesta más
		// de lo que evita.
		const r = await escenario(async (e) => {
			const caida = centralInterceptada(e.central, () => Promise.reject(new Error("la base central no contesta")));
			return { reserva: await reservarCupo(caida.db, envio()), filas: await filas(e.central) };
		});
		expect(r).toEqual({ reserva: "sin_base", filas: 0 });
	});

	it("con la central saturada, también: con el cupo lleno, el pedido sale sin contar", async () => {
		// La central es un único objeto, y la carga la satura (`overloaded`): para el cupo es lo mismo
		// que una caída. Es lo que dice `reservarCupo`; si eso cambia, cambian los dos.
		const r = await escenario(async (e) => {
			await e.apuntar(TOPE_DIARIO);
			const saturada = centralInterceptada(e.central, () =>
				Promise.reject(Object.assign(new Error("Durable Object is overloaded. Too many requests queued."), { overloaded: true })),
			);
			return { reserva: await reservarCupo(saturada.db, envio()), filas: await filas(e.central) };
		});
		expect(r).toEqual({ reserva: "sin_base", filas: TOPE_DIARIO });
	});
});
