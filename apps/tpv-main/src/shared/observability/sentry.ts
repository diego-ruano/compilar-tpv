// shared/observability/sentry.ts
//
// Fachada de Sentry para la Webview. Los call-sites (error boundary, listeners globales) usan
// `captureException` de aquí en vez de importar el SDK directamente.
//
// El transporte de `defaultOptions` (tauri-plugin-sentry-api) REENVÍA los eventos al SDK de Rust
// vía `invoke`, de modo que Webview (JS) y Core (Rust) comparten un único cliente y DSN. Por eso
// aquí NO se configura DSN: si el plugin de Rust está deshabilitado (sin DSN embebido), los eventos
// simplemente se descartan. La observabilidad nunca debe impedir que la app arranque, así que todo
// va envuelto en try/catch.

import * as Sentry from "@sentry/browser";
import { defaultOptions } from "tauri-plugin-sentry-api";
import { yaRegistrado } from "@tpv/client";
import type { FalloDeComando } from "@tpv/contracts";

import { scrubEvent } from "./scrub";

let started = false;

/** Inicializa Sentry en la Webview. Idempotente. */
export function initSentry(): void {
	if (started) return;
	started = true;
	try {
		Sentry.init({
			...defaultOptions,
			// No grabamos la UI (Session Replay): un TPV maneja datos de clientes/ventas (PII).
			// Al no añadir la integración de replay, queda desactivado por defecto.
			//
			// Filtro de datos personales (OBS-01) antes de que el evento salga por el puente a Rust.
			beforeSend: (event) => {
				try {
					return scrubEvent(event);
				} catch {
					// Si el filtro fallara, es más seguro NO enviar que enviar sin depurar.
					return null;
				}
			},
		});
	} catch {
		/* la observabilidad jamás bloquea el arranque */
	}
}

/**
 * Reporta una excepción a Sentry. `context` se adjunta como datos extra (sin PII).
 *
 * El fallo de un comando ya lo registró `invocar` (`fallosDeComandos.ts`): si después lo recoge
 * otro —`conAviso`, el listener global, el `catch` de una pantalla—, no se cuenta otra vez.
 */
export function captureException(
	error: unknown,
	context?: Record<string, unknown>,
): void {
	if (yaRegistrado(error)) return;
	try {
		Sentry.captureException(error, context ? { extra: context } : undefined);
	} catch {
		/* no-op */
	}
}

/**
 * Un fallo del programa en un comando (`fallosDeComandos.ts`). Se agrupa por comando y código: el
 * mismo fallo en el mismo comando es el mismo issue, diga lo que diga el texto.
 */
export function capturarFalloDeComando(fallo: FalloDeComando): void {
	try {
		const error = new Error(fallo.mensaje ?? fallo.code);
		error.name = fallo.comando;
		Sentry.captureException(error, {
			fingerprint: ["comando", fallo.comando, fallo.code],
			tags: { comando: fallo.comando, code: fallo.code },
			extra: { pantalla: fallo.pantalla, duracion_ms: fallo.duracion_ms },
		});
	} catch {
		/* no-op */
	}
}
