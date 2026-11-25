// src/server/central/sinLaCentral.ts
//
// Lo que se contesta cuando la base central no ha podido atender una petición HTTP. Lo usan los sitios
// donde un error se convierte en respuesta: el `onError` de la `app`, el `/ws` (`app.ts`) y los
// `catch` que, si no, contestarían un código propio (la base del negocio que nace al activar). Lo que
// lanza la central en `tenantAuth` no es un rechazo de quien llama: sube al `onError`. Y un `catch` que
// sigue sin la central si la lectura falla (el piloto del feed de actualizaciones) deja subir esto
// (`laCentralNoAtiende`): seguir sería contestar como si la central hubiera dicho que no hay nada.
//
// Es lo mismo que cuando no atiende el objeto de un negocio (`lib/enElHub.ts::sinElObjeto`): el 503
// `external` de `lib/noDisponible.ts`.
//
//   · `CentralNoDisponible` (`cliente.ts`), un viaje que no ha vuelto con su respuesta: saturada,
//     `hub_overloaded` con `Retry-After`; un fallo pasajero de la plataforma, un plazo vencido o
//     cualquier otro rechazo del viaje, `hub_unavailable`.
//   · `ErrorDeLaCentral` con 503: sin aprovisionar, una operación que el objeto no conoce (un
//     despliegue a medias), una migración alterada o fallida, o algo a medias (una restauración desde
//     una copia, una vuelta a un instante). `hub_unavailable`, sin `Retry-After`.
//
// Cada vez queda un evento en Axiom (`central_no_disponible`) con el motivo exacto. Lo que no es carga
// ni un fallo pasajero de la plataforma (`esPasajeroDeLaCentral`: un plazo vencido, un rechazo del
// viaje sin marcas, que puede ser un fallo del programa dentro del objeto, la central sin aprovisionar
// o averiada) va además a Sentry, con su causa, y al log: ahí hay algo que mirar.
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
 * y no va a Sentry.
 */
function esPasajeroDeLaCentral(error: unknown): boolean {
	return error instanceof CentralNoDisponible && (error.motivo === "saturada" || error.motivo === "pasajera");
}

/** Por qué no ha podido atender la central, si es eso lo que dice `error`; `null` si es otra cosa. */
function motivoSinLaCentral(error: unknown): CentralNoDisponible["motivo"] | ErrorDeLaCentral["code"] | null {
	if (error instanceof CentralNoDisponible) return error.motivo;
	if (error instanceof ErrorDeLaCentral && error.status === 503) return error.code;
	return null;
}

/**
 * ¿Dice `error` que la central no ha podido atender? Es lo que `respuestaSinLaCentral` contesta con su
 * 503.
 */
export function laCentralNoAtiende(error: unknown): boolean {
	return motivoSinLaCentral(error) !== null;
}

/** La respuesta si `error` es que la central no ha podido atender; `null` si es cualquier otra cosa. */
export function respuestaSinLaCentral(c: Context, error: unknown): Response | null {
	const motivo = motivoSinLaCentral(error);
	if (!motivo) return null;

	// Lo que dijo la plataforma, si fue ella (o lo que lanzó el objeto); si no, lo que dijo el objeto.
	const causa = ((error as Error).cause ?? error) as { message?: unknown };
	if (!esPasajeroDeLaCentral(error)) {
		// A Sentry va con su causa: el SDK la enseña enlazada.
		capturarError(error, `${c.req.method} ${c.req.routePath}`);
		// FABLE-B: el detalle se queda aquí y en Sentry; la respuesta no lo lleva. En el log, la ruta va
		// por su patrón y no por su camino, que lo escribe quien llama (un correo en el lugar de la
		// versión del feed), y el mensaje, con el de su causa, filtrado y acotado como lo que va a
		// telemetría.
		const conCausa = causa === error ? "" : `: ${String(causa.message ?? causa)}`;
		console.error(acotar(`[central] ${c.req.method} ${c.req.routePath} → ${(error as Error).message}${conCausa}`, scrub));
	}

	const tenantId = (c as unknown as { get: (clave: "tenantId") => string | undefined }).get("tenantId");
	enSegundoPlano(
		c,
		reportarCentralNoDisponible(c.env, {
			motivo,
			metodo: c.req.method,
			// Como en `sinElObjeto` (AUD-32): el principio de la ruta, filtrado antes de recortarlo.
			ruta: acotar(new URL(c.req.url).pathname, scrub, { bytes: 256, filtrado: MAX_FILTRADO }),
			error: String(causa.message ?? error).slice(0, 300),
			...(tenantId ? { tenant_id: tenantId } : {}),
		}),
	);

	return respuestaNoDisponible(c, motivo === "saturada");
}
