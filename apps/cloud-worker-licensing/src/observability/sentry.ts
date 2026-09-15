// src/observability/sentry.ts
//
// Opciones de Sentry compartidas por el fetch handler (Hono) y el Durable Object (TenantHub).
//
// Sentry aquí cubre SÓLO errores (excepciones no controladas en rutas + ciclo de vida del DO). La
// telemetría estructurada de negocio/sync va a Axiom (ver observability/axiom.ts). Si `SENTRY_DSN`
// no está configurado, `dsn: undefined` deja Sentry deshabilitado (no-op): el wrapper es seguro de
// desplegar antes de que exista el proyecto en Sentry.

import type { Env } from "../env";
import { scrubEvent, type EventoSentry } from "./scrub";

export function sentryOptions(env: Env) {
	return {
		dsn: env.SENTRY_DSN,
		environment: env.ENVIRONMENT ?? "prod",
		release: env.SENTRY_RELEASE,
		// División de responsabilidades: Sentry = errores; el tracing de rendimiento se desactiva
		// (0) para no duplicar coste con Axiom. Se puede subir si hace falta perfilar.
		tracesSampleRate: 0,
		// Nunca enviar PII por defecto (datos de clientes/ventas). GDPR.
		sendDefaultPii: false,
		// OBS-01: `sendDefaultPii` no llega al mensaje de una excepción ni a los breadcrumbs. Esto
		// sí (ver `scrub.ts`).
		beforeSend: <E extends EventoSentry>(event: E): E | null => {
			try {
				return scrubEvent(event);
			} catch {
				// Si el filtro fallara, es más seguro NO enviar que enviar sin depurar.
				return null;
			}
		},
	};
}
