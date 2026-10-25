// src/domains/reservas_web/cors.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.1): el CORS de las rutas públicas. Las
// pueden llamar desde el navegador las webs dadas de alta para el negocio de la clave
// (`reserva_web_dominios`, las mismas en las que se puede incrustar el widget) y ninguna otra. Es lo
// que usa el SDK (`packages/reservas-web-sdk`) cuando una web hace su propio formulario; el widget
// no lo necesita, porque va en el mismo origen que la API.
//
// No protege de quien automatiza: fuera del navegador, `Origin` es el que cada uno quiera mandar.
// De eso se ocupa la puerta (`puerta.ts`): los limitadores, Turnstile y los topes de la agenda. Esto
// sólo decide qué webs pueden leer la respuesta en el navegador de sus visitantes.
//
// Va en dos piezas porque el `OPTIONS` de todo el worker lo atiende `index.ts` antes que cualquier
// router: el preflight se registra allí, delante; lo demás, como middleware de las rutas públicas.

import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "../../env";
import { pasaElLimitador } from "../../lib/limitador";
import { getDb } from "../../server/db";
import { ipDeLaPeticion } from "../pairing/pairing.avisos";
import { dominiosCacheados, negocioCacheado, negocioDeLaClave } from "./claves";

/** Lo que manda el SDK: el cuerpo en JSON, el token de Turnstile y la clave de idempotencia del alta. */
const CABECERAS_PERMITIDAS = "Content-Type, X-Turnstile-Token, Idempotency-Key";
const METODOS = "GET, POST, OPTIONS";
/** Lo que el navegador se guarda el permiso del preflight. Corto: quitar una web se nota pronto. */
const PREFLIGHT_MAX_AGE_S = 600;

/** ¿Es `origen` una de las webs del negocio? */
async function esWebDelNegocio(env: Env, tenantId: string, origen: string): Promise<boolean> {
	return (await dominiosCacheados(getDb(env), tenantId)).includes(origen);
}

/**
 * El preflight de `/v1/publico/reservas/:clave/*`. Pasa por el limitador antes de mirar la clave,
 * como la puerta: sin él, un `OPTIONS` con claves inventadas llegaría a la base central. A una web
 * que no es del negocio se le contesta sin permiso, y el navegador no manda la petición.
 */
export async function preflightPublico(c: Context<{ Bindings: Env }>): Promise<Response> {
	const sinPermiso = (status = 204) => new Response(null, { status, headers: { Vary: "Origin" } });
	const origen = c.req.header("Origin");
	if (!origen) return sinPermiso();
	if (!(await pasaElLimitador(c.env.LIMITADOR_RESERVA_WEB, ipDeLaPeticion(c.req.raw), "reservas_web"))) {
		return sinPermiso(429);
	}
	const tenantId = await negocioDeLaClave(getDb(c.env), c.req.param("clave") ?? "");
	if (!tenantId || !(await esWebDelNegocio(c.env, tenantId, origen))) return sinPermiso();
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": origen,
			"Access-Control-Allow-Methods": METODOS,
			"Access-Control-Allow-Headers": CABECERAS_PERMITIDAS,
			"Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_S),
			Vary: "Origin",
		},
	});
}

/**
 * Las demás respuestas de las rutas públicas, también las de error: con el permiso si quien llama es
 * una web del negocio, para que el SDK lea el motivo (`reserva_web_no_disponible`, un 429) en vez de
 * un fallo de red. Después de la puerta, que ya ha resuelto la clave: aquí sólo se mira lo cacheado.
 */
export const corsPublico: MiddlewareHandler<{ Bindings: Env; Variables: { tenantId: string } }> = async (c, next) => {
	await next();
	// La respuesta cambia según quién pregunte: una caché no puede dársela a otra web.
	c.res.headers.append("Vary", "Origin");
	const origen = c.req.header("Origin");
	if (!origen) return;
	const tenantId = c.get("tenantId") ?? negocioCacheado(c.req.param("clave") ?? "");
	if (!tenantId || !(await esWebDelNegocio(c.env, tenantId, origen))) return;
	c.res.headers.set("Access-Control-Allow-Origin", origen);
};
