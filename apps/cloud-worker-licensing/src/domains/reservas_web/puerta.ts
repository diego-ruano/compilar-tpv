// src/domains/reservas_web/puerta.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): la puerta de las rutas públicas.
//
// Estas rutas no llevan `tenantAuth`: las llama el widget, desde el navegador de cualquiera, sin
// dispositivo ni token. El negocio sale de la clave pública del camino (`:clave`), y todo lo que
// decide si se pasa va aquí, en middlewares DELANTE del validador del cuerpo (worker.md, «Cómo se
// escribe una ruta»):
//
//   1. el limitador por IP de las lecturas: el primero, porque es lo más barato y frena un barrido
//      de claves inventadas antes de que llegue a la base central;
//   2. la clave existe y no está revocada;
//   3. el negocio tiene una licencia en vigor;
//   4. el interruptor remoto `reservas_web` no está apagado;
//   5. en el alta, además, su limitador y Turnstile;
//   6. en lo que lleva cuerpo, un tope de tamaño (`topeDelCuerpo`): son rutas anónimas, y sin él
//      cualquiera haría al worker leer y parsear un JSON de megas.
//
// Por qué el rechazo de 2-4 es siempre el mismo `reserva_web_no_disponible`: quien llama no
// necesita saber si la clave no existe, si al negocio se le acabó la licencia o si soporte ha
// apagado la reserva web. Al widget le basta con «ahora no se puede reservar online»; el motivo
// queda en el log.

import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { Env } from "../../env";
import { estaApagado } from "../../lib/interruptores";
import { negocioConLicenciaEnVigor } from "../../lib/licenciaEnUso";
import { pasaElLimitador } from "../../lib/limitador";
import { getDb } from "../../server/db";
import { ipDeLaPeticion } from "../pairing/pairing.avisos";
import { negocioDeLaClave } from "./claves";

export type PublicoVars = { tenantId: string };
type Ctx = { Bindings: Env; Variables: PublicoVars };

function noDisponible(c: any, motivo: string) {
	console.warn(`[reservas-web] puerta cerrada: ${motivo}`);
	return c.json({ ok: false, error: "reserva_web_no_disponible" }, 404);
}

function demasiadas(c: any) {
	return c.json({ ok: false, error: "reserva_web_demasiadas" }, 429);
}

/** Pasos 1 a 4: el negocio de la clave, si puede atender reservas desde la web ahora. */
// (`c.req.param("clave")`: las rutas públicas se montan en `/v1/publico/reservas/:clave`.)
export const puertaPublica: MiddlewareHandler<Ctx> = async (c, next) => {
	if (!(await pasaElLimitador(c.env.LIMITADOR_RESERVA_WEB, ipDeLaPeticion(c.req.raw), "reservas_web"))) {
		return demasiadas(c);
	}
	const db = getDb(c.env);
	const tenantId = await negocioDeLaClave(db, c.req.param("clave") ?? "");
	if (!tenantId) return noDisponible(c, "clave inexistente o revocada");
	if (!(await negocioConLicenciaEnVigor(db, tenantId))) return noDisponible(c, `licencia (${tenantId})`);
	if (await estaApagado(() => db, tenantId, "reservas_web")) return noDisponible(c, `interruptor (${tenantId})`);
	c.set("tenantId", tenantId);
	await next();
};

/** El limitador por IP propio del alta: mucho más estrecho que el de las lecturas. */
export const limitadorAltas: MiddlewareHandler<Ctx> = async (c, next) => {
	if (!(await pasaElLimitador(c.env.LIMITADOR_RESERVA_WEB_ALTA, ipDeLaPeticion(c.req.raw), "reservas_web_alta"))) {
		return demasiadas(c);
	}
	await next();
};

/**
 * Paso 6: lo más largo que manda el widget es un alta, con la nota de 200 caracteres. 8 KB sobra
 * con mucho; lo que pase de ahí no es el widget.
 */
export const topeDelCuerpo = bodyLimit({
	maxSize: 8 * 1024,
	onError: (c) => c.json({ ok: false, error: "validation_error" }, 413),
});

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * ¿El token de Turnstile que manda el widget es bueno? Sin el secreto configurado no se deja pasar a
 * nadie (falla cerrado, como toda ruta que depende de un secreto). `fetcher` es para los tests.
 */
export async function turnstileValido(
	secreto: string | undefined,
	token: string,
	ip: string,
	fetcher: typeof fetch = fetch,
): Promise<"si" | "no" | "sin_secreto"> {
	if (!secreto) return "sin_secreto";
	if (!token || token.length > 2048) return "no";
	const cuerpo = new FormData();
	cuerpo.append("secret", secreto);
	cuerpo.append("response", token);
	if (ip && ip !== "unknown") cuerpo.append("remoteip", ip);
	try {
		const r = await fetcher(SITEVERIFY, { method: "POST", body: cuerpo });
		const datos = (await r.json()) as { success?: boolean };
		return datos.success === true ? "si" : "no";
	} catch (e: any) {
		// Si Turnstile no contesta, no se puede saber si es una persona: no pasa.
		console.warn("[reservas-web] Turnstile no contesta:", String(e?.message || e));
		return "no";
	}
}

/** Paso 5, sólo en el alta: que sea una persona. El token viaja en `X-Turnstile-Token`. */
export const verificacionHumana: MiddlewareHandler<Ctx> = async (c, next) => {
	const veredicto = await turnstileValido(
		c.env.TURNSTILE_SECRET_KEY,
		c.req.header("X-Turnstile-Token") ?? "",
		ipDeLaPeticion(c.req.raw),
	);
	if (veredicto === "sin_secreto") {
		console.error("[reservas-web] falta TURNSTILE_SECRET_KEY: el alta queda cerrada");
		return c.json({ ok: false, error: "reserva_web_no_disponible" }, 503);
	}
	if (veredicto === "no") return c.json({ ok: false, error: "verificacion_humana_fallida" }, 403);
	await next();
};
