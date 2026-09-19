// test/correoTopeDiario.test.ts
//
// REV-14 — el tope diario de correos por negocio.
//
// El filtro de destinatario (FABLE-C) no acotaba a quién se puede escribir: dar de alta un
// proveedor es una escritura de negocio corriente, así que con un token robado se creaba un
// proveedor con cualquier correo y se enviaba, sin límite, con el SPF/DKIM de nuestro dominio
// detrás. Acotaba el número de pasos, no el destinatario. Esto recupera el eje que faltaba.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { pasaDelTope, TOPE_DIARIO, VENTANA_MS } from "../src/domains/email/email.routes";

const TENANT = "tenant-1";

async function escenario<T>(
	nombre: string,
	fn: (e: { sql: any; env: any; enviar: (n: number, extra?: Record<string, unknown>) => void }) => Promise<T>,
): Promise<T> {
	return enElHub(`rev14-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		sql.exec(`DELETE FROM email_sends;`);

		return fn({
			sql,
			env: db,
			enviar(n, extra = {}) {
				const campos = { ok: 1, sent_at_ms: Date.now(), tenant_id: TENANT, ...extra } as any;
				for (let i = 0; i < n; i++) {
					sql.exec(
						`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, sent_at_ms)
						 VALUES (?, ?, 'dev', 'a@b.test', 'Prov', ?, ?);`,
						crypto.randomUUID(),
						campos.tenant_id,
						campos.ok,
						campos.sent_at_ms,
					);
				}
			},
		});
	});
}

describe("REV-14 · el cupo diario de correo", () => {
	it("por debajo del tope se envía", async () => {
		const r = await escenario("debajo", async (e) => {
			e.enviar(TOPE_DIARIO - 1);
			return pasaDelTope(e.env, TENANT);
		});
		expect(r).toBe(false);
	});

	it("alcanzado el tope se corta", async () => {
		const r = await escenario("tope", async (e) => {
			e.enviar(TOPE_DIARIO);
			return pasaDelTope(e.env, TENANT);
		});
		expect(r).toBe(true);
	});

	it("los de ayer no cuentan: la ventana es móvil, no el día natural", async () => {
		const r = await escenario("ventana", async (e) => {
			e.enviar(TOPE_DIARIO, { sent_at_ms: Date.now() - VENTANA_MS - 1000 });
			return pasaDelTope(e.env, TENANT);
		});
		expect(r).toBe(false);
	});

	it("los que NO salieron no gastan cupo", async () => {
		// Un proveedor con el buzón lleno, o una caída de nuestro proveedor de correo, no pueden
		// dejar a un bar sin poder pedir. Y lo que se protege —la reputación del dominio— sólo
		// sufre con lo que sale.
		const r = await escenario("fallidos", async (e) => {
			e.enviar(TOPE_DIARIO, { ok: 0 });
			return pasaDelTope(e.env, TENANT);
		});
		expect(r).toBe(false);
	});

	it("el cupo es de cada negocio, no de todos juntos", async () => {
		const r = await escenario("por-tenant", async (e) => {
			e.enviar(TOPE_DIARIO, { tenant_id: "otro-bar" });
			return pasaDelTope(e.env, TENANT);
		});
		expect(r).toBe(false);
	});

	it("si no se puede contar, se deja pasar", async () => {
		// Misma regla que el registro del envío: Turso caído no puede impedir que un bar mande su
		// pedido. Un tope que convierte una caída nuestra en «no puedes trabajar» cuesta más de lo
		// que evita.
		const r = await escenario("sin-base", async () =>
			pasaDelTope({ execute: async () => { throw new Error("turso caído"); } } as any, TENANT),
		);
		expect(r).toBe(false);
	});
});
