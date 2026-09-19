// test/avisoDeCaducidad.test.ts
//
// REV-13 · La otra mitad: el correo que pone el enlace de renovación en manos del cliente.
//
// Sin esto, el camino correcto existe y no lo conoce nadie: el cliente vuelve al enlace de compra
// normal, y eso le emite una licencia nueva — que es justo lo que el arreglo viene a quitar. De
// ahí que el job se niegue a mandar nada si no hay enlace de renovación configurado: un aviso sin
// botón empuja al sitio equivocado.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { avisarDeCaducidades, enlaceDeRenovacion } from "../src/domains/licensing/avisosDeCaducidad";

const DIA = 24 * 60 * 60 * 1000;
const AHORA = 1_800_000_000_000;

type Correo = { to: string; subject: string; html: string; text: string };

function entorno(extra: Record<string, unknown> = {}) {
	const enviados: Correo[] = [];
	const env = {
		EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
		EMAIL_FROM_NAME: "TPV",
		RENEWAL_URL: "https://buy.stripe.com/renovacion",
		EMAIL: {
			send: async (msg: Correo) => {
				enviados.push(msg);
			},
		},
		...extra,
	} as any;
	return { env, enviados };
}

type Escenario = {
	db: any;
	sql: any;
	/** Una licencia activa que caduca dentro de `dias`. Devuelve su id. */
	licencia: (id: string, dias: number, extra?: Record<string, unknown>) => string;
	avisos: () => Array<{ license_id: string; kind: string; expires_at_ms: number }>;
};

async function escenario<T>(nombre: string, fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub(`rev13-avisos-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "license_notices"]) sql.exec(`DELETE FROM ${tabla};`);

		const e: Escenario = {
			db,
			sql,
			licencia(id, dias, extra = {}) {
				const campos = {
					status: "active",
					disabled: 0,
					expires_at_ms: AHORA + dias * DIA,
					...extra,
				} as any;
				sql.exec(
					`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months,
					   origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email, customer_name,
					   created_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, ?, 'standard', 12, 'stripe', ?, ?, ?, ?, 'Bar de pruebas', ?, ?);`,
					id,
					`hash-${id}`,
					campos.status,
					campos.disabled,
					AHORA - 300 * DIA,
					AHORA - 300 * DIA,
					campos.expires_at_ms,
					`${id}@ejemplo.test`,
					AHORA - 300 * DIA,
					AHORA - 300 * DIA,
				);
				return id;
			},
			avisos() {
				return sql
					.exec(`SELECT license_id, kind, expires_at_ms FROM license_notices ORDER BY kind;`)
					.toArray() as any;
			},
		};

		return fn(e);
	});
}

describe("REV-13 · a quién se avisa", () => {
	it("avisa a la que caduca dentro de 30 días y no a la que le quedan 60", async () => {
		const r = await escenario("ventana", async (e) => {
			e.licencia("lic-30", 25);
			e.licencia("lic-60", 60);
			const { env, enviados } = entorno();
			const resumen = await avisarDeCaducidades(env, e.db, AHORA);
			return { resumen, enviados, avisos: e.avisos() };
		});

		expect(r.resumen.enviados).toBe(1);
		expect(r.enviados[0].to).toBe("lic-30@ejemplo.test");
		expect(r.avisos).toEqual([
			{ license_id: "lic-30", kind: "expira_30", expires_at_ms: AHORA + 25 * DIA },
		]);
	});

	it("una que ya caducó no recibe nada: el aviso llega antes, no después", async () => {
		const r = await escenario("caducada", async (e) => {
			e.licencia("lic-vieja", -3, { status: "expired" });
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});

	it("una anulada no recibe nada", async () => {
		// Avisar de que va a caducar una licencia que le has revocado es ruido, y confuso.
		const r = await escenario("anulada", async (e) => {
			e.licencia("lic-anulada", 10, { status: "revoked", disabled: 1 });
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});

	it("una comprada y nunca estrenada no recibe nada: no tiene reloj corriendo", async () => {
		const r = await escenario("sin-estrenar", async (e) => {
			e.sql.exec(
				`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months,
				   origin, issued_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES ('lic-nueva', 'h', 'issued', 0, 'standard', 12, 'stripe', ?, 'a@b.test', ?, ?);`,
				AHORA,
				AHORA,
				AHORA,
			);
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});
});

describe("REV-13 · cuántas veces se avisa", () => {
	it("el mismo ciclo repetido no manda un segundo correo", async () => {
		const r = await escenario("idempotente", async (e) => {
			e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			const uno = await avisarDeCaducidades(env, e.db, AHORA);
			const dos = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { uno, dos, enviados };
		});

		expect(r.uno.enviados).toBe(1);
		expect(r.dos.enviados).toBe(0);
		expect(r.dos.yaAvisadas).toBe(1);
		expect(r.enviados).toHaveLength(1);
	});

	it("a una que entra ya con 5 días le llega UN correo, no los dos peldaños de golpe", async () => {
		const r = await escenario("un-peldano", async (e) => {
			e.licencia("lic-urgente", 5);
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados, avisos: e.avisos() };
		});

		expect(r.enviados).toHaveLength(1);
		expect(r.avisos).toHaveLength(1);
		expect(r.avisos[0].kind).toBe("expira_7");
		expect(r.enviados[0].subject).toContain("5 días");
	});

	it("la de 30 y luego la de 7 son dos avisos distintos", async () => {
		const r = await escenario("dos-peldanos", async (e) => {
			e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			const lejos = await avisarDeCaducidades(env, e.db, AHORA);
			// Veinte días después le quedan 5: toca el peldaño urgente.
			const cerca = await avisarDeCaducidades(env, e.db, AHORA + 20 * DIA);
			return { lejos, cerca, enviados, avisos: e.avisos() };
		});

		expect(r.lejos.enviados).toBe(1);
		expect(r.cerca.enviados).toBe(1);
		expect(r.avisos.map((a) => a.kind)).toEqual(["expira_30", "expira_7"]);
	});

	it("renovar vuelve a abrir el aviso del año que viene", async () => {
		// Es lo que justifica que `expires_at_ms` esté en la clave: sin él, la fila del año pasado
		// silenciaría para siempre a una licencia que se renueva todos los años.
		const r = await escenario("tras-renovar", async (e) => {
			e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			await avisarDeCaducidades(env, e.db, AHORA);

			e.sql.exec(`UPDATE licenses SET expires_at_ms=? WHERE license_id='lic-1';`, AHORA + 390 * DIA);
			const luego = await avisarDeCaducidades(env, e.db, AHORA + 365 * DIA);
			return { luego, enviados, avisos: e.avisos() };
		});

		expect(r.luego.enviados).toBe(1);
		expect(r.enviados).toHaveLength(2);
		expect(r.avisos).toHaveLength(2);
	});

	it("si el correo no sale, la marca se suelta y mañana se reintenta", async () => {
		const r = await escenario("reintento", async (e) => {
			e.licencia("lic-1", 25);
			let rota = true;
			const enviados: any[] = [];
			const env = {
				EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
				RENEWAL_URL: "https://buy.stripe.com/renovacion",
				EMAIL: {
					send: async (msg: any) => {
						if (rota) throw new Error("buzón caído");
						enviados.push(msg);
					},
				},
			} as any;

			const falla = await avisarDeCaducidades(env, e.db, AHORA);
			const avisosTrasFallo = e.avisos();
			rota = false;
			const bien = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { falla, avisosTrasFallo, bien, enviados };
		});

		expect(r.falla.fallidos).toBe(1);
		// Lo que no puede quedar: un aviso contado como enviado que nunca salió.
		expect(r.avisosTrasFallo).toHaveLength(0);
		expect(r.bien.enviados).toBe(1);
		expect(r.enviados).toHaveLength(1);
	});
});

describe("REV-13 · el enlace", () => {
	it("lleva dentro el license_id, que es lo que hace que la compra se reconozca como renovación", async () => {
		const { env } = entorno();
		const url = new URL(
			enlaceDeRenovacion(env, {
				license_id: "lic-abc",
				customer_email: "bar@ejemplo.test",
			} as any)!,
		);

		expect(url.origin + url.pathname).toBe("https://buy.stripe.com/renovacion");
		expect(url.searchParams.get("client_reference_id")).toBe("lic-abc");
		expect(url.searchParams.get("prefilled_email")).toBe("bar@ejemplo.test");
	});

	it("sin RENEWAL_URL no se manda ningún aviso", async () => {
		// Fallar callado es mejor que fallar enseñando el camino equivocado: un aviso sin botón
		// manda al cliente al enlace de compra, y eso le emite una clave nueva.
		const r = await escenario("sin-enlace", async (e) => {
			e.licencia("lic-1", 25);
			const { env, enviados } = entorno({ RENEWAL_URL: "" });
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados, avisos: e.avisos() };
		});

		expect(r.resumen.sinEnlace).toBe(true);
		expect(r.enviados).toHaveLength(0);
		expect(r.avisos).toHaveLength(0);
	});
});
