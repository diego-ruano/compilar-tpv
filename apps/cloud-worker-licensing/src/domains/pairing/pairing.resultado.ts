// src/domains/pairing/pairing.resultado.ts
//
// Lo que decide una operación de emparejamiento: un status y un cuerpo, sin `Request` ni
// `Response` de por medio.
//
// Los handlers de antes construían la respuesta HTTP dentro de la lógica (`json(cuerpo, 409, req)`
// repartido por todo el fichero), y eso obligaba a los tests a fabricar una `Request` y a
// deshacer una `Response` para comprobar una decisión. Es el mismo corte que ARQ-04 hizo en el
// Durable Object: la decisión por un lado, el transporte por otro.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type Resultado = {
	status: ContentfulStatusCode;
	cuerpo: Record<string, unknown>;
};

/** Pasa un `Resultado` a la respuesta HTTP. Es lo único que hacen las rutas de pairing. */
export function responder(c: Context<any, any>, r: Resultado): Response {
	return c.json(r.cuerpo, r.status);
}

export const ok = (cuerpo: Record<string, unknown> = {}): Resultado => ({
	status: 200,
	cuerpo: { ok: true, ...cuerpo },
});

export const fallo = (status: ContentfulStatusCode, error: string, extra: Record<string, unknown> = {}): Resultado => ({
	status,
	cuerpo: { ok: false, error, ...extra },
});
