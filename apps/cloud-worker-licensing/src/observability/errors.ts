import * as Sentry from "@sentry/cloudflare";
import { HTTPException } from "hono/http-exception";
import { HubError } from "../lib/errorHttp";

// RI-24 (worker): los catch que conservan la operación también deben notificar el fallo técnico.

/**
 * Los 503 que no se mandan a Sentry desde donde se contestan: no hay Main, o es una avería de la que
 * ya avisó quien la vio, una vez (`MotorTenantHub.avisarUnaVez`, `avisarBasePerdida`), y que a partir
 * de ahí repite cada petición del negocio.
 */
const NO_DISPONIBLE_YA_AVISADO: ReadonlySet<string> = new Set([
	"main_offline",
	"tenant_db_migration_failed",
	// DO-PERDIDA: de la base que falta avisa `avisarBasePerdida`, una vez cada diez minutos.
	"tenant_db_perdida",
]);

export function esRechazoEsperado(error: unknown): boolean {
	if (error instanceof HTTPException) return error.status >= 400 && error.status < 500;
	if (error instanceof HubError) return (error.status >= 400 && error.status < 500) || (error.status === 503 && NO_DISPONIBLE_YA_AVISADO.has(error.code));
	return false;
}

/** No cambia el resultado ni propaga fallos de observabilidad a la operación principal. */
export function capturarError(error: unknown, operacion: string): void {
	if (esRechazoEsperado(error)) return;
	try {
		Sentry.captureException(error, { tags: { operation: operacion } });
	} catch { /* La operación principal conserva su comportamiento aunque falle la telemetría. */ }
}
