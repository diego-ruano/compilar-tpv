// test/reservasWebWidget.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.6): el widget servido por el worker. Lo
// que se fija:
//   · el widget sólo se puede incrustar en las webs dadas de alta para su negocio
//     (`frame-ancestors`), y en ninguna si no hay ninguna, si la clave no existe o si es la página
//     de cancelar;
//   · la CSP no deja cargar nada de fuera salvo Turnstile ni hablar con otro origen;
//   · cada fichero sale con su caché: el script de la web, corta; los de huella, inmutables; el
//     widget, ninguna;
//   · el HTML suelto y lo inventado no se sirven;
//   · la casilla de Turnstile del SDK sólo se da a una web del negocio, que es la única que la puede
//     incrustar, y lleva la clave pública que pone el worker;
//   · el SDK servido se puede importar como módulo desde cualquier web.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

let dbDePruebas: any = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { reservasWebWidgetRoutes } = await import("../src/domains/reservas_web/widget.routes");
const { claveDelNegocio, olvidarClavesCacheadas, ponerDominio } = await import("../src/domains/reservas_web/claves");

const app = new Hono();
app.route("/reservas-web", reservasWebWidgetRoutes);

/** Lo compilado del widget, como lo daría Workers Static Assets. */
function almacen(conWidget = true) {
	const ficheros: Record<string, [string, string]> = {
		"/reservas-web/v1/embed.js": ["(function(){})();", "application/javascript"],
		"/reservas-web/assets/index-abc123.js": ["console.log(1)", "text/javascript"],
		"/reservas-web/v1/sdk.js": ["export function reservasWeb() {}", "text/javascript"],
		"/reservas-web/verificar.html": [
			'<!doctype html><head><meta name="turnstile" content=""></head><body><div id="casilla"></div></body>',
			"text/html",
		],
	};
	if (conWidget) ficheros["/reservas-web/index.html"] = ["<!doctype html><title>Reservar mesa</title>", "text/html"];
	return {
		fetch: async (req: Request) => {
			const f = ficheros[new URL(req.url).pathname];
			return f ? new Response(f[0], { headers: { "content-type": f[1], etag: '"x"' } }) : new Response("nf", { status: 404 });
		},
	};
}

async function pedir(ruta: string, env: Record<string, unknown> = {}) {
	return app.request(`https://tpv-api.test/reservas-web${ruta}`, {}, { ASSETS: almacen(), ...env } as any);
}

const ancestros = (res: Response) => /frame-ancestors ([^;]+)/.exec(res.headers.get("Content-Security-Policy") ?? "")?.[1];

async function conNegocio(nombre: string, prueba: (clave: string) => Promise<void>) {
	await enElHub(`rw-widget-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		dbDePruebas = clienteSobre(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('t1');`);
		await prueba(await claveDelNegocio(dbDePruebas, "t1", 1));
	});
}

beforeEach(() => olvidarClavesCacheadas());

describe("el widget servido por el worker", () => {
	it("se puede incrustar sólo en las webs dadas de alta para su negocio", async () => {
		await conNegocio("dominios", async (clave) => {
			const sinWebs = await pedir(`/v1/w/${clave}`);
			expect(sinWebs.status).toBe(200);
			expect(ancestros(sinWebs)).toBe("'none'");

			await ponerDominio(dbDePruebas, "t1", "https://www.barpepe.es", 1);
			await ponerDominio(dbDePruebas, "t1", "http://localhost:5173", 2);
			const conWebs = await pedir(`/v1/w/${clave}`);
			expect(ancestros(conWebs)).toBe("http://localhost:5173 https://www.barpepe.es");
			expect(conWebs.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
			expect(conWebs.headers.get("Cache-Control")).toBe("no-store");
			expect(await conWebs.text()).toContain("Reservar mesa");
		});
	});

	it("la página de cancelar no se incrusta nunca, ni con webs dadas de alta", async () => {
		await conNegocio("cancelar", async (clave) => {
			await ponerDominio(dbDePruebas, "t1", "https://www.barpepe.es", 1);
			const res = await pedir(`/v1/w/${clave}/cancelar`);
			expect(res.status).toBe(200);
			expect(ancestros(res)).toBe("'none'");
		});
	});

	it("una clave que no existe da el widget (que dirá que no está disponible), sin poder incrustarse", async () => {
		await conNegocio("sin-clave", async () => {
			for (const clave of ["rw_AAAAAAAAAAAAAAAAAAAAAA", "cualquiera"]) {
				const res = await pedir(`/v1/w/${clave}`);
				expect(res.status, clave).toBe(200);
				expect(ancestros(res), clave).toBe("'none'");
			}
		});
	});

	it("la CSP no deja cargar nada de fuera salvo Turnstile ni hablar con otro origen", async () => {
		await conNegocio("csp", async (clave) => {
			const csp = (await pedir(`/v1/w/${clave}`)).headers.get("Content-Security-Policy") ?? "";
			for (const directiva of [
				"default-src 'self'",
				"script-src 'self' https://challenges.cloudflare.com",
				"frame-src https://challenges.cloudflare.com",
				"style-src 'self'",
				"img-src 'self' data:",
				"connect-src 'self'",
				"object-src 'none'",
				"base-uri 'none'",
			]) {
				expect(csp).toContain(directiva);
			}
			expect(csp).not.toContain("unsafe-inline");
			expect(csp).not.toContain("unsafe-eval");
		});
	});

	it("el script de la web va con caché corta y los ficheros con huella, inmutables", async () => {
		const embed = await pedir("/v1/embed.js");
		expect(embed.status).toBe(200);
		expect(embed.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(embed.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");

		const asset = await pedir("/assets/index-abc123.js");
		expect(asset.status).toBe(200);
		expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect((await pedir("/assets/no-existe.js")).status).toBe(404);
	});

	it("el HTML suelto y lo inventado no se sirven", async () => {
		for (const ruta of ["/index.html", "/", "/v1/w", "/otra/cosa"]) {
			expect((await pedir(ruta)).status, ruta).toBe(404);
		}
	});

	it("sin el widget compilado, dice que no está disponible", async () => {
		await conNegocio("sin-compilar", async (clave) => {
			const res = await app.request(`https://tpv-api.test/reservas-web/v1/w/${clave}`, {}, { ASSETS: almacen(false) } as any);
			expect(res.status).toBe(503);
		});
	});

	it("el limitador de las lecturas también frena el widget", async () => {
		const lleno = { limit: async () => ({ success: false }) };
		expect((await pedir("/v1/w/rw_AAAAAAAAAAAAAAAAAAAAAA", { LIMITADOR_RESERVA_WEB: lleno })).status).toBe(429);
	});

	it("la casilla de Turnstile del SDK: sólo para una web del negocio, que es la única que puede incrustarla", async () => {
		await conNegocio("verificar", async (clave) => {
			await ponerDominio(dbDePruebas, "t1", "https://www.barpepe.es", 1);
			const env = { TURNSTILE_SITE_KEY: "0xPRUEBA" };
			const res = await pedir(`/v1/w/${clave}/verificar?origen=${encodeURIComponent("https://www.barpepe.es")}`, env);
			expect(res.status).toBe(200);
			expect(ancestros(res)).toBe("https://www.barpepe.es");
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' https://challenges.cloudflare.com");
			// La clave pública de Turnstile, puesta por el worker (con su escape: es un atributo).
			expect(await res.text()).toContain('<meta name="turnstile" content="0xPRUEBA">');

			for (const [quien, ruta] of [
				["otra web", `/v1/w/${clave}/verificar?origen=${encodeURIComponent("https://www.otra.es")}`],
				["sin origen", `/v1/w/${clave}/verificar`],
				["clave inventada", `/v1/w/rw_AAAAAAAAAAAAAAAAAAAAAA/verificar?origen=${encodeURIComponent("https://www.barpepe.es")}`],
			] as const) {
				expect((await pedir(ruta, env)).status, quien).toBe(403);
			}
			// Sin la clave de Turnstile no hay casilla que enseñar.
			expect((await pedir(`/v1/w/${clave}/verificar?origen=${encodeURIComponent("https://www.barpepe.es")}`)).status).toBe(503);
		});
	});

	it("el SDK servido va con caché corta y se puede importar como módulo desde cualquier web", async () => {
		const sdk = await pedir("/v1/sdk.js");
		expect(sdk.status).toBe(200);
		expect(sdk.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(sdk.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(sdk.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect((await pedir("/verificar.html")).status).toBe(404);
	});
});
