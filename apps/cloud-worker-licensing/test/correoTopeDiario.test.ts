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

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
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
	nombre: string,
	fn: (e: { sql: any; db: any; apuntar: (n: number, extra?: Apunte) => void }) => Promise<T>,
): Promise<T> {
	return enElHub(`rev14-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		sql.exec(`DELETE FROM email_sends;`);

		return fn({
			sql,
			db,
			apuntar(n, extra = {}) {
				const f = { ok: 1, error_code: null, sent_at_ms: Date.now(), tenant_id: TENANT, tipo: "pedido", ...extra };
				for (let i = 0; i < n; i++) {
					sql.exec(
						`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
						 VALUES (?, ?, 'dev', 'a@b.test', 'Prov', ?, ?, ?, ?);`,
						crypto.randomUUID(),
						f.tenant_id,
						f.ok,
						f.error_code,
						f.sent_at_ms,
						f.tipo,
					);
				}
			},
		});
	});
}

/** Las filas de los pedidos del negocio de la prueba. */
const filas = (sql: any) =>
	sql.exec(`SELECT COUNT(*) AS n FROM email_sends WHERE tenant_id = ? AND tipo = 'pedido';`, TENANT).one().n;

describe("REV-14 · el cupo diario de correo", () => {
	it("por debajo del tope se reserva, con la fila «enviando» del pedido", async () => {
		const r = await escenario("debajo", async (e) => {
			e.apuntar(TOPE_DIARIO - 1);
			const reserva = await reservarCupo(e.db, envio("este"));
			const fila = e.sql.exec(`SELECT * FROM email_sends WHERE id = 'este';`).toArray()[0];
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
		const r = await escenario("tope", async (e) => {
			e.apuntar(TOPE_DIARIO);
			return { reserva: await reservarCupo(e.db, envio()), filas: filas(e.sql) };
		});
		expect(r).toEqual({ reserva: "tope", filas: TOPE_DIARIO });
	});

	it("lo que está saliendo ocupa sitio (AUD-41)", async () => {
		const r = await escenario("enviando", async (e) => {
			e.apuntar(TOPE_DIARIO - 1);
			e.apuntar(1, { ok: 0, error_code: "enviando" });
			return reservarCupo(e.db, envio());
		});
		expect(r).toBe("tope");
	});

	it("una reserva que se quedó a medias cuenta hasta que sale de la ventana, como lo entregado", async () => {
		// El worker murió entre la reserva y apuntar cómo acabó: no se sabe si salió, y contarla es lo
		// prudente. Pero no cuenta para siempre: a las 24 h sale de la ventana como cualquier otra.
		const r = await escenario("a-medias", async (e) => {
			e.apuntar(TOPE_DIARIO, { ok: 0, error_code: "enviando", sent_at_ms: Date.now() - VENTANA_MS + 60_000 });
			const hoy = await reservarCupo(e.db, envio());
			e.sql.exec(`UPDATE email_sends SET sent_at_ms = ?;`, Date.now() - VENTANA_MS - 1000);
			const pasada = await reservarCupo(e.db, envio());
			return { hoy, pasada };
		});
		expect(r).toEqual({ hoy: "tope", pasada: "reservado" });
	});

	it("los de ayer no cuentan: la ventana es móvil, no el día natural", async () => {
		const r = await escenario("ventana", async (e) => {
			e.apuntar(TOPE_DIARIO, { sent_at_ms: Date.now() - VENTANA_MS - 1000 });
			return reservarCupo(e.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("los que NO salieron no gastan cupo", async () => {
		// Un proveedor con el buzón lleno, o una caída de nuestro proveedor de correo, no pueden
		// dejar a un bar sin poder pedir. Y lo que se protege —la reputación del dominio— sólo
		// sufre con lo que sale.
		const r = await escenario("fallidos", async (e) => {
			e.apuntar(TOPE_DIARIO / 2, { ok: 0 });
			e.apuntar(TOPE_DIARIO / 2, { ok: 0, error_code: "E_RATE_LIMIT_EXCEEDED" });
			return reservarCupo(e.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("el cupo es de cada negocio, no de todos juntos", async () => {
		const r = await escenario("por-tenant", async (e) => {
			e.apuntar(TOPE_DIARIO, { tenant_id: "otro-bar" });
			e.apuntar(TOPE_DIARIO, { tenant_id: "otro-bar", ok: 0, error_code: "enviando" });
			return reservarCupo(e.db, envio());
		});
		expect(r).toBe("reservado");
	});

	it("si no se puede reservar, se deja pasar", async () => {
		// Misma regla que el registro del envío: Turso caído no puede impedir que un bar mande su
		// pedido. Un tope que convierte una caída nuestra en «no puedes trabajar» cuesta más de lo
		// que evita.
		const r = await escenario("sin-base", async () =>
			reservarCupo({ execute: async () => { throw new Error("turso caído"); } } as any, envio()),
		);
		expect(r).toBe("sin_base");
	});
});
