// src/middleware/requireAdmin.ts
//
// Autenticación de las rutas de administración del worker (emisión de licencias, publicación
// de releases). `Authorization: Bearer <token>` contra un secreto del worker.
//
// Dos reglas:
//   · **Fail-closed**: si el secreto no está configurado, la ruta queda deshabilitada (503).
//     Nunca "sin secreto → pasa todo".
//   · **Comparación timing-safe**: comparar tokens con `!==` filtra por tiempo cuántos
//     caracteres iniciales acertaste, y eso permite adivinar el secreto byte a byte.

import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";

/** Comparación en tiempo constante. Compara el hash para no filtrar ni la longitud. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);

	const va = new Uint8Array(ha);
	const vb = new Uint8Array(hb);

	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}

function bearer(header: string | undefined): string {
	const m = String(header || "").match(/^Bearer\s+(.+)$/i);
	return (m?.[1] || "").trim();
}

/**
 * Comprueba un token admin. Devuelve el error listo para responder, o `null` si pasa.
 * Se expone aparte del middleware para las rutas que ya tienen su propio flujo (updates).
 */
export async function checkAdminToken(
	presented: string | undefined,
	expected: string | undefined,
): Promise<{ status: 401 | 503; error: string } | null> {
	const secret = String(expected || "").trim();
	if (!secret) return { status: 503, error: "admin_disabled" };

	const token = bearer(presented);
	if (!token) return { status: 401, error: "unauthorized" };

	return (await timingSafeEqual(token, secret)) ? null : { status: 401, error: "unauthorized" };
}

/** Middleware para el dominio admin de licencias (`ADMIN_API_TOKEN`). */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const fail = await checkAdminToken(c.req.header("authorization"), c.env.ADMIN_API_TOKEN);
	if (fail) return c.json({ ok: false, error: fail.error }, fail.status);
	await next();
};
