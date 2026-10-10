import * as Sentry from "@sentry/cloudflare";
import { HTTPException } from "hono/http-exception";
import { HubError } from "../lib/errorHttp";

// RI-24 (worker): los catch que conservan la operación también deben notificar el fallo técnico.

export function esRechazoEsperado(error: unknown): boolean {
	if (error instanceof HTTPException) return error.status >= 400 && error.status < 500;
	if (error instanceof HubError) return (error.status >= 400 && error.status < 500) || (error.status === 503 && error.code === "main_offline");
	return false;
}

/** No cambia el resultado ni propaga fallos de observabilidad a la operación principal. */
export function capturarError(error: unknown, operacion: string): void {
	if (esRechazoEsperado(error)) return;
	try {
		Sentry.captureException(error, { tags: { operation: operacion } });
	} catch { /* La operación principal conserva su comportamiento aunque falle la telemetría. */ }
}
