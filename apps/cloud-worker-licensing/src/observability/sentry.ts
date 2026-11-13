// src/observability/sentry.ts
//
// Opciones de Sentry compartidas por el fetch handler (Hono) y el Durable Object (TenantHub).
//
// Sentry cubre errores inesperados, incluidos los catch de Hono, cron, correos y sync. La
// telemetría estructurada de negocio/sync va a Axiom (ver observability/axiom.ts). Si `SENTRY_DSN`
// no está configurado, `dsn: undefined` deja Sentry deshabilitado (no-op): el wrapper es seguro de
// desplegar antes de que exista el proyecto en Sentry.

import type { Env } from "../env";
import * as Sentry from "@sentry/cloudflare";
import { scrubEvent, type EventoSentry } from "./scrub";
import { limitarPeticion } from "./requestContext";
import { acotar } from "./tope";
import { esRechazoEsperado } from "./errors";

export function sentryOptions(env: Env) {
	return {
		dsn: env.SENTRY_DSN,
		environment: env.ENVIRONMENT ?? "prod",
		release: env.SENTRY_RELEASE,
		initialScope: { tags: { build_commit: env.BUILD_COMMIT ?? "local" } },
		// División de responsabilidades: Sentry = errores; el tracing de rendimiento se desactiva
		// (0) para no duplicar coste con Axiom. Se puede subir si hace falta perfilar.
		tracesSampleRate: 0,
		enableRpcTracePropagation: true,
		// Nunca enviar PII por defecto (datos de clientes/ventas). GDPR.
		sendDefaultPii: false,
		integrations: [
			// Evita leer cuerpos automáticamente, incluso antes de la autenticación de Hono.
			Sentry.httpServerIntegration({ maxRequestBodySize: "none" }),
			Sentry.requestDataIntegration({ include: { data: false, headers: false, cookies: false, query_string: false, ip: false } }),
		],
		// OBS-01: `sendDefaultPii` no llega al mensaje de una excepción ni a los breadcrumbs. Esto
		// sí (ver `scrub.ts`).
		beforeSend: <E extends EventoSentry>(event: E, hint?: { originalException?: unknown }): E | null => {
			try {
				if (esRechazoEsperado(hint?.originalException)) return null;
				// AUD-32: cada cadena se filtra con sus topes (`tope.ts`).
				return scrubEvent(limitarPeticion(event), acotar);
			} catch {
				// Si el filtro fallara, es más seguro NO enviar que enviar sin depurar.
				return null;
			}
		},
	};
}

/**
 * Una ruta de negocio que se ejecuta dentro del TenantHub (`ejecutarRuta`, `lib/enElHub.ts`), tratada
 * por Sentry como lo que es: una petición.
 *
 * El SDK envuelve los métodos RPC de un Durable Object de otra forma que su `fetch`
 * (`wrapMethodWithSentry`): si en el isolate ya se creó algún cliente, sólo bifurca el ámbito
 * corriente, y el de aislamiento es el global, el mismo para todas las peticiones y para los DO de
 * todos los negocios que compartan isolate. Ahí es donde `registrarPeticion` y
 * `registrarCuerpoValidado` dejan la operación, la versión del cliente y los importes del cuerpo: se
 * quedaban puestos para el fallo siguiente, fuera de quien fuera. Y si la llamada llega sin los datos
 * de traza del Worker, el método corre sin envolver y sin cliente, y lo que se capture se pierde.
 *
 * `wrapRequestHandler` es lo que el SDK pone delante del `fetch` del Worker y del DO: un ámbito de
 * aislamiento nuevo, un cliente propio de esta petición, y el envío antes de soltarlo (por
 * `waitUntil`). Las etiquetas de una petición acaban con ella, y un fallo dentro de la ruta sale con
 * su `operation`. El cuerpo no se lee (`httpServerIntegration` con `maxRequestBodySize: "none"`).
 */
export function comoPeticionDeSentry(
	env: Env,
	contexto: DurableObjectState,
	peticion: Request,
	manejar: () => Promise<Response>,
): Promise<Response> {
	return Sentry.wrapRequestHandler(
		// El SDK le da a su propio `fetch` del DO este mismo contexto: sólo usa `waitUntil`.
		{ options: sentryOptions(env), request: peticion as any, context: contexto as unknown as ExecutionContext },
		manejar,
	);
}
