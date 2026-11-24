// src/server/central/sinLaCentral.ts
//
// Lo que se contesta cuando la base central no ha podido atender una petición HTTP. Lo usan los sitios
// donde un error se convierte en respuesta: el `onError` de la `app`, el `/ws` (`app.ts`) y los
// `catch` que, si no, contestarían un código propio (la base del negocio que nace al activar). Lo que
// lanza la central en `tenantAuth` no es un rechazo de quien llama: sube al `onError`.
//
// Es lo mismo que cuando no atiende el objeto de un negocio (`lib/enElHub.ts::sinElObjeto`): el 503
// `external` de `lib/noDisponible.ts`.
//
//   · `CentralNoDisponible` (`cliente.ts`): saturada, `hub_overloaded` con `Retry-After`; un fallo
//     pasajero de la plataforma o un plazo vencido, `hub_unavailable`.
//   · `ErrorDeLaCentral` con 503: sin aprovisionar, una operación que el objeto no conoce (un
//     despliegue a medias) o una migración alterada o fallida. `hub_unavailable`, sin `Retry-After`.
//
// Cada vez queda un evento en Axiom (`central_no_disponible`) con el motivo exacto. Lo que no es carga
// ni un fallo pasajero de la plataforma (`esPasajeroDeLaCentral`: un plazo vencido, la central sin
// aprovisionar o averiada) va además a Sentry y al log: ahí hay algo que mirar.
//
// Lo demás que lanza la central (un error de SQL, una sentencia prohibida) no es «no puede atender»:
// sigue el camino de cualquier otro error.

import type { Context } from "hono";

import { enSegundoPlano } from "../../lib/enSegundoPlano";
import { respuestaNoDisponible } from "../../lib/noDisponible";
import { reportarCentralNoDisponible } from "../../observability/axiom";
import { capturarError } from "../../observability/errors";
import { scrub } from "../../observability/scrub";
import { acotar, MAX_FILTRADO } from "../../observability/tope";
import { CentralNoDisponible, ErrorDeLaCentral } from "./cliente";

/**
 * ¿La central saturada, o un fallo pasajero de la plataforma? Se pasa solo: no hay nada que arreglar
 * y no va a Sentry. Quien lo encuentra lo repite o sigue sin la central si puede.
 */
export function esPasajeroDeLaCentral(error: unknown): boolean {
	return error instanceof CentralNoDisponible && (error.motivo === "saturada" || error.motivo === "pasajera");
}

/** La respuesta si `error` es que la central no ha podido atender; `null` si es cualquier otra cosa. */
export function respuestaSinLaCentral(c: Context, error: unknown): Response | null {
	const motivo =
		error instanceof CentralNoDisponible
			? error.motivo
			: error instanceof ErrorDeLaCentral && error.status === 503
				? error.code
				: null;
	if (!motivo) return null;

	const ruta = new URL(c.req.url).pathname;
	if (!esPasajeroDeLaCentral(error)) {
		capturarError(error, `${c.req.method} ${c.req.routePath}`);
		// FABLE-B: el detalle se queda aquí y en Sentry; la respuesta no lo lleva.
		console.error(`[central] ${c.req.method} ${ruta} → ${(error as Error).message}`);
	}

	// Lo que dijo la plataforma, si fue ella; si no, lo que dijo el objeto.
	const causa = ((error as Error).cause ?? error) as { message?: unknown };
	const tenantId = (c as unknown as { get: (clave: "tenantId") => string | undefined }).get("tenantId");
	enSegundoPlano(
		c,
		reportarCentralNoDisponible(c.env, {
			motivo,
			metodo: c.req.method,
			// Como en `sinElObjeto` (AUD-32): el principio de la ruta, filtrado antes de recortarlo.
			ruta: acotar(ruta, scrub, { bytes: 256, filtrado: MAX_FILTRADO }),
			error: String(causa.message ?? error).slice(0, 300),
			...(tenantId ? { tenant_id: tenantId } : {}),
		}),
	);

	return respuestaNoDisponible(c, motivo === "saturada");
}
