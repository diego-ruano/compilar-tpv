// test/reservasWebCors.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.1): el CORS de las rutas públicas
// (`domains/reservas_web/cors.ts`), contra una base central de verdad (`helpers/central.ts`). Lo que
// se fija:
//   · sólo las webs dadas de alta para el negocio de la clave reciben el permiso, en el preflight y
//     en la respuesta, también en la de un error;
//   · el preflight pasa por el limitador antes de mirar la clave;
//   · toda respuesta lleva `Vary: Origin`;
//   · en `app.ts`, el preflight de estas rutas va delante del `OPTIONS` de todo el worker.

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { centralDePrueba, centralQueApunta, filasDe, type CentralDePrueba } from "./helpers/central";
import indice from "../src/app.ts?raw";
import { claveDelNegocio, negocioDeLaClave, olvidarClavesCacheadas, ponerDominio } from "../src/domains/reservas_web/claves";
import { corsPublico, preflightPublico } from "../src/domains/reservas_web/cors";
import { getDb } from "../src/server/db";

const WEB = "https://www.barpepe.es";
const OTRA = "https://www.otra.es";

const rutas = new Hono<any>();
rutas.use("/:clave/*", corsPublico);
// Lo que hace la puerta: resolver la clave y dejar el negocio.
rutas.get("/:clave/negocio", async (c) => {
	const tenantId = await negocioDeLaClave(getDb(c.env), c.req.param("clave"));
	if (!tenantId) return c.json({ ok: false, error: "reserva_web_no_disponible" }, 404);
	c.set("tenantId", tenantId);
	return c.json({ ok: true });
});
// Una puerta que corta después de resolver la clave (la licencia, el interruptor), sin dejar el negocio.
rutas.get("/:clave/cortada", async (c) => {
	await negocioDeLaClave(getDb(c.env), c.req.param("clave"));
	return c.json({ ok: false, error: "reserva_web_no_disponible" }, 404);
});

const app = new Hono<any>();
app.options("/v1/publico/reservas/:clave/*", preflightPublico);
app.route("/v1/publico/reservas", rutas);

type Negocio = {
	clave: string;
	central: CentralDePrueba;
	/** Pide `ruta` a las rutas públicas, con la base central del negocio y lo que añada `env`. */
	pedir: (ruta: string, init?: RequestInit, env?: Record<string, unknown>) => Promise<Response>;
	/** El preflight del SDK desde `origen`, para la clave `clave`. */
	preflight: (clave: string, origen: string | null, env?: Record<string, unknown>) => Promise<Response>;
};

beforeEach(() => olvidarClavesCacheadas());

/** El negocio `t1`, con su clave y su web, y `t2` con la suya, en una base central propia. */
async function conNegocio(prueba: (n: Negocio) => Promise<void>) {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES ('t1'), ('t2');`);
	const clave = await claveDelNegocio(central.db, "t1", 1);
	await ponerDominio(central.db, "t1", WEB, 1);
	// La web de otro negocio no vale para éste.
	await ponerDominio(central.db, "t2", OTRA, 1);

	const pedir = async (ruta: string, init: RequestInit = {}, env: Record<string, unknown> = {}) =>
		app.request(`https://reservas-tpv.test/v1/publico/reservas${ruta}`, init, { ...central.entorno, ...env } as any);
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
	await prueba({ clave, central, pedir, preflight });
}

describe("el CORS de las rutas públicas de la reserva web", () => {
	it("el preflight da permiso a las webs del negocio, con lo que manda el SDK, y a ninguna otra", async () => {
		await conNegocio(async ({ clave, preflight }) => {
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
		await conNegocio(async ({ clave, central, preflight }) => {
			const espia = centralQueApunta(central);
			const lleno = { limit: async () => ({ success: false }) };
			const res = await preflight(clave, WEB, { LIMITADOR_RESERVA_WEB: lleno, ...espia.entorno });
			expect(res.status).toBe(429);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(espia.pedido).toEqual([]);
		});
	});

	it("la respuesta lleva el permiso para las webs del negocio, también la de un error", async () => {
		await conNegocio(async ({ clave, pedir }) => {
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
		await conNegocio(async ({ clave, pedir }) => {
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
