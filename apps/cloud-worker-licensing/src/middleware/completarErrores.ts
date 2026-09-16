// src/middleware/completarErrores.ts
//
// Toda respuesta de error del worker sale con `code` del catálogo y, si su identificador tiene
// frase, con `message` (ver `lib/errorCodes.ts`).
//
// Se hace aquí, en la frontera HTTP, y no en cada ruta. Hay unas cien respuestas de error escritas
// a mano repartidas por dominios, endpoints antiguos y el `onError`, y la mayoría no llevaba ni
// `code` ni `message`: arreglarlas una a una cubría las de hoy y dejaba fuera la próxima que
// alguien escribiera. Lo que una ruta ya trae se respeta.
//
// Sólo mira respuestas de error en JSON; un 2xx, un upgrade de WebSocket o un binario salen tal
// cual y sin leerse.

import type { MiddlewareHandler } from "hono";

import { completarCuerpoDeError } from "../lib/errorCodes";

export const completarErrores: MiddlewareHandler = async (c, next) => {
	await next();

	const res = c.res;
	if (res.status < 400) return;
	if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;

	let cuerpo: unknown;
	try {
		cuerpo = await res.clone().json();
	} catch {
		return;
	}
	if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return;

	const completo = completarCuerpoDeError(cuerpo as Record<string, unknown>, res.status);
	if (completo === cuerpo) return;

	const headers = new Headers(res.headers);
	headers.delete("content-length");
	c.res = undefined;
	c.res = new Response(JSON.stringify(completo), { status: res.status, headers });
};
