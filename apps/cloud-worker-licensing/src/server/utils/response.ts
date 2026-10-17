// src/server/utils/response.ts

import { wireToCode } from "../../lib/errorCodes";

export type HeaderBag = Record<string, string>;

export function corsHeaders(req?: Request): HeaderBag {
	const origin = req?.headers.get("origin") || "";

	const allowed = new Set([
		"http://localhost:1420",
		"tauri://localhost",
		"http://tauri.localhost",
	]);

	if (!origin || !allowed.has(origin)) {
		return { Vary: "Origin" };
	}

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
		"Access-Control-Allow-Headers":
			"content-type,authorization,x-device-ts,x-device-sig,x-idempotency-key,x-command-name",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

export function json(data: any, status = 200, req?: Request) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...corsHeaders(req),
		},
	});
}

// ARCH-05: toda respuesta de error lleva `code` del catálogo compartido, además del
// `error` de siempre. Se ramifica por `code`; `error` queda como diagnóstico.
//
// FABLE-B: estas tres no aceptan detalles. Lo que cuenta por dentro un fallo (la traza, el texto de
// Turso, que lleva la URL de la base) le servía a quien quisiera saber cómo está hecho el worker, no
// al cliente, que ramifica por `code`. El detalle se registra donde se captura el error
// (`capturarError` y `console.error`), y la firma impide volver a mandarlo.

export function unauthorized(req: Request, error: string) {
	return json({ ok: false, code: wireToCode(error, 401), error }, 401, req);
}

export function forbidden(req: Request, error: string) {
	return json({ ok: false, code: wireToCode(error, 403), error }, 403, req);
}

export function serverError(req: Request, error: string) {
	return json({ ok: false, code: wireToCode(error, 500), error }, 500, req);
}

/**
 * Error de validación de una ruta de dominio (400). Estaba duplicado **literalmente**
 * en los 12 `*.routes.ts`; ahora vive aquí para que el `code` se añada en un solo sitio.
 */
export function badRequest(c: any, error: string, err?: { issues?: unknown }) {
	return c.json(
		{ ok: false, code: wireToCode(error, 400), error, issues: err?.issues },
		400,
	);
}