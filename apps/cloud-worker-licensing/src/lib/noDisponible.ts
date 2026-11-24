// src/lib/noDisponible.ts
//
// Cómo se contesta cuando un Durable Object no ha podido atender una petición: el de un negocio
// (`lib/enElHub.ts`) o el de la base central (`server/central/sinLaCentral.ts`).
//
// No es un fallo del programa: es un 503 `external`, que el cliente trata como la nube sin
// disponibilidad (una escritura la repite con su misma clave). Hay dos identificadores y nada más:
// `hub_overloaded`, el objeto está saturado y lleva `Retry-After` porque repetir en el acto sería más
// carga, y `hub_unavailable` para todo lo demás. El motivo exacto no viaja: queda en Axiom (y, si hay
// algo que arreglar, en Sentry), que es donde lo mira quien puede arreglarlo.

import type { Context } from "hono";

/** Cuánto se le dice al cliente que espere antes de repetir, con el objeto saturado. */
const ESPERA_SI_SATURADO_S = 2;

/** El 503 de un objeto que no ha podido atender: saturado o no. */
export function respuestaNoDisponible(c: Context, saturado: boolean): Response {
	return saturado
		? c.json({ ok: false, code: "external", error: "hub_overloaded" }, 503, {
				"Retry-After": String(ESPERA_SI_SATURADO_S),
			})
		: c.json({ ok: false, code: "external", error: "hub_unavailable" }, 503);
}
