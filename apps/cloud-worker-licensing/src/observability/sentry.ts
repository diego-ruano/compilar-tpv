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
				return scrubEvent(limitarPeticion(event));
			} catch {
				// Si el filtro fallara, es más seguro NO enviar que enviar sin depurar.
				return null;
			}
		},
	};
}
