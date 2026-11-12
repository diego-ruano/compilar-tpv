// test/reservasWebCors.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.1): el CORS de las rutas públicas
// (`domains/reservas_web/cors.ts`), contra la estructura de verdad de la base central. Lo que se fija:
//   · sólo las webs dadas de alta para el negocio de la clave reciben el permiso, en el preflight y
//     en la respuesta, también en la de un error;
//   · el preflight pasa por el limitador antes de mirar la clave;
//   · toda respuesta lleva `Vary: Origin`;
//   · en `app.ts`, el preflight de estas rutas va delante del `OPTIONS` de todo el worker.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import indice from "../src/app.ts?raw";

let dbDePruebas: any = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { claveDelNegocio, negocioDeLaClave, olvidarClavesCacheadas, ponerDominio } = await import("../src/domains/reservas_web/claves");
const { corsPublico, preflightPublico } = await import("../src/domains/reservas_web/cors");

const WEB = "https://www.barpepe.es";
const OTRA = "https://www.otra.es";

const rutas = new Hono<any>();
rutas.use("/:clave/*", corsPublico);
// Lo que hace la puerta: resolver la clave y dejar el negocio.
rutas.get("/:clave/negocio", async (c) => {
	const tenantId = await negocioDeLaClave(dbDePruebas, c.req.param("clave"));
	if (!tenantId) return c.json({ ok: false, error: "reserva_web_no_disponible" }, 404);
	c.set("tenantId", tenantId);
	return c.json({ ok: true });
});
// Una puerta que corta después de resolver la clave (la licencia, el interruptor), sin dejar el negocio.
rutas.get("/:clave/cortada", async (c) => {
	await negocioDeLaClave(dbDePruebas, c.req.param("clave"));
	return c.json({ ok: false, error: "reserva_web_no_disponible" }, 404);
});

const app = new Hono<any>();
app.options("/v1/publico/reservas/:clave/*", preflightPublico);
app.route("/v1/publico/reservas", rutas);

function pedir(ruta: string, init: RequestInit = {}, env: Record<string, unknown> = {}) {
	return app.request(`https://reservas-tpv.test/v1/publico/reservas${ruta}`, init, env as any);
}

const preflight = (clave: string, origen: string | null, env: Record<string, unknown> = {}) =>
	pedir(
		`/${clave}/reservas`,
		{
			method: "OPTIONS",
			headers: {
				...(origen ? { Origin: origen } : {}),
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type, x-turnstile-token, idempotency-key",
			},
		},
		env,
	);

beforeEach(() => olvidarClavesCacheadas());

async function conNegocio(nombre: string, prueba: (clave: string) => Promise<void>) {
	await enElHub(`rw-cors-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		dbDePruebas = clienteSobre(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('t1'), ('t2');`);
		const clave = await claveDelNegocio(dbDePruebas, "t1", 1);
		await ponerDominio(dbDePruebas, "t1", WEB, 1);
		// La web de otro negocio no vale para éste.
		await ponerDominio(dbDePruebas, "t2", OTRA, 1);
		try {
			await prueba(clave);
		} finally {
			dbDePruebas = null;
		}
	});
}

describe("el CORS de las rutas públicas de la reserva web", () => {
	it("el preflight da permiso a las webs del negocio, con lo que manda el SDK, y a ninguna otra", async () => {
		await conNegocio("preflight", async (clave) => {
			const bien = await preflight(clave, WEB);
			expect(bien.status).toBe(204);
			expect(bien.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
			expect(bien.headers.get("Access-Control-Allow-Methods")).toContain("POST");
			const cabeceras = (bien.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
			for (const h of ["content-type", "x-turnstile-token", "idempotency-key"]) expect(cabeceras).toContain(h);
			expect(bien.headers.get("Access-Control-Allow-Credentials")).toBeNull();
			expect(bien.headers.get("Vary")).toContain("Origin");

			for (const [quien, res] of [
				["otra web", await preflight(clave, OTRA)],
				["sin origen", await preflight(clave, null)],
				["clave inventada", await preflight("rw_AAAAAAAAAAAAAAAAAAAAAA", WEB)],
			] as const) {
				expect(res.headers.get("Access-Control-Allow-Origin"), quien).toBeNull();
			}
		});
	});

	it("el preflight pasa por el limitador antes de mirar la clave", async () => {
		await conNegocio("limitador", async (clave) => {
			let preguntas = 0;
			const espiaDeLaBase = dbDePruebas;
			dbDePruebas = { execute: (...a: any[]) => (preguntas++, espiaDeLaBase.execute(...a)) };
			const lleno = { limit: async () => ({ success: false }) };
			const res = await preflight(clave, WEB, { LIMITADOR_RESERVA_WEB: lleno });
			expect(res.status).toBe(429);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(preguntas).toBe(0);
		});
	});

	it("la respuesta lleva el permiso para las webs del negocio, también la de un error", async () => {
		await conNegocio("respuesta", async (clave) => {
			const desde = (origen: string, ruta = "negocio") => pedir(`/${clave}/${ruta}`, { headers: { Origin: origen } });

			const bien = await desde(WEB);
			expect(bien.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
			expect(bien.headers.get("Vary")).toContain("Origin");

			const otra = await desde(OTRA);
			expect(otra.status).toBe(200);
			expect(otra.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(otra.headers.get("Vary")).toContain("Origin");

			// La puerta ha cortado, pero la clave ya está resuelta en este isolate: el SDK lee el motivo.
			const cortada = await desde(WEB, "cortada");
			expect(cortada.status).toBe(404);
			expect(cortada.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
		});
	});

	it("sin `Origin` (el widget, en el mismo origen) no se añade nada más que `Vary`", async () => {
		await conNegocio("mismo-origen", async (clave) => {
			const res = await pedir(`/${clave}/negocio`);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(res.headers.get("Vary")).toContain("Origin");
		});
	});

	it("en app.ts el preflight de las rutas públicas va delante del de todo el worker", () => {
		const suyo = indice.indexOf(`app.options("/v1/publico/reservas/:clave/*", preflightPublico)`);
		const general = indice.indexOf(`app.options("*"`);
		expect(suyo, "falta el preflight de las rutas públicas").toBeGreaterThan(-1);
		expect(suyo).toBeLessThan(general);
	});
});
