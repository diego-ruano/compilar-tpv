// src/domains/reservas_web/widget.routes.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.6): el widget, servido por este mismo
// worker. Lo compilado de `apps/reservas-web/` está en Workers Static Assets (`ASSETS`, ver
// `wrangler.json`) con `run_worker_first`, así que pasa todo por aquí y cada cosa sale con sus
// cabeceras:
//
//   GET /reservas-web/v1/embed.js      el script que se pega en la web. Caché corta (5 min): es lo
//                                      que hace que un cambio llegue a todas las webs
//   GET /reservas-web/v1/w/:clave      el widget (y `…/cancelar`, la página del enlace del correo),
//                                      sin caché y con su CSP
//   GET /reservas-web/assets/*         JS y CSS con huella en el nombre: inmutables
//
// La CSP del widget no deja cargar nada de fuera salvo Turnstile, ni hablar con otro origen que el
// suyo (la API es éste), y **`frame-ancestors` son las webs dadas de alta para ese negocio**
// (`reserva_web_dominios`): sin ninguna, `'none'`, y el widget no se puede incrustar en ningún sitio.
// La página de cancelar no se incrusta nunca: se abre desde el correo.

import { Hono } from "hono";

import type { Env } from "../../env";
import { pasaElLimitador } from "../../lib/limitador";
import { getDb } from "../../server/db";
import { ipDeLaPeticion } from "../pairing/pairing.avisos";
import { dominiosCacheados, negocioDeLaClave } from "./claves";

export const reservasWebWidgetRoutes = new Hono<{ Bindings: Env }>();

const CSP_COMUN = [
	"default-src 'self'",
	"script-src 'self' https://challenges.cloudflare.com",
	"frame-src https://challenges.cloudflare.com",
	"style-src 'self'",
	// El logo del negocio llega como `data:`.
	"img-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"object-src 'none'",
];

/** La CSP del widget, con las webs donde se puede incrustar. */
export function cspDelWidget(dominios: string[]): string {
	return [...CSP_COMUN, `frame-ancestors ${dominios.length ? dominios.join(" ") : "'none'"}`].join("; ");
}

const NOSNIFF = { "X-Content-Type-Options": "nosniff" };

function noEncontrado() {
	return new Response("No encontrado", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...NOSNIFF } });
}

/** Un fichero de lo compilado, por su ruta pública. */
function delAlmacen(c: { env: Env; req: { url: string } }, ruta: string): Promise<Response> {
	return c.env.ASSETS.fetch(new Request(new URL(ruta, c.req.url)));
}

reservasWebWidgetRoutes.get("/v1/embed.js", async (c) => {
	const r = await delAlmacen(c, "/reservas-web/v1/embed.js");
	if (!r.ok) return noEncontrado();
	return new Response(r.body, {
		headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", ...NOSNIFF },
	});
});

reservasWebWidgetRoutes.get("/assets/*", async (c) => {
	const r = await delAlmacen(c, new URL(c.req.url).pathname);
	if (!r.ok) return noEncontrado();
	const cabeceras = new Headers(r.headers);
	cabeceras.set("Cache-Control", "public, max-age=31536000, immutable");
	cabeceras.set("X-Content-Type-Options", "nosniff");
	return new Response(r.body, { status: r.status, headers: cabeceras });
});

function pagina(vista: "reservar" | "cancelar") {
	return async (c: any) => {
		if (!(await pasaElLimitador(c.env.LIMITADOR_RESERVA_WEB, ipDeLaPeticion(c.req.raw), "reservas_web"))) {
			return new Response("Demasiadas peticiones seguidas. Espera un minuto.", {
				status: 429,
				headers: { "Content-Type": "text/plain; charset=utf-8", ...NOSNIFF },
			});
		}
		// Una clave que no existe da el widget igual, que dice «Reservas no disponibles» al no
		// encontrar el negocio; pero no se puede incrustar en ningún sitio.
		let dominios: string[] = [];
		if (vista === "reservar") {
			const db = getDb(c.env);
			const tenantId = await negocioDeLaClave(db, c.req.param("clave") ?? "");
			if (tenantId) dominios = await dominiosCacheados(db, tenantId);
		}
		const r = await delAlmacen(c, "/reservas-web/index.html");
		if (!r.ok) {
			console.error("[reservas-web] falta el widget compilado (apps/reservas-web/dist)");
			return new Response("Reservas no disponibles", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
		}
		return new Response(r.body, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": cspDelWidget(dominios),
				// El token del enlace de cancelar va en el fragmento, que no viaja; esto es por lo demás.
				"Referrer-Policy": "no-referrer",
				...NOSNIFF,
			},
		});
	};
}

reservasWebWidgetRoutes.get("/v1/w/:clave", pagina("reservar"));
reservasWebWidgetRoutes.get("/v1/w/:clave/cancelar", pagina("cancelar"));

// Lo demás bajo `/reservas-web/` (el `index.html` suelto, rutas inventadas) no existe.
reservasWebWidgetRoutes.all("*", () => noEncontrado());
