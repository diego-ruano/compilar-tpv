// src/domains/pairing/pairing.avisos.ts
//
// El empujón a la Main para que recargue su lista de solicitudes.

import { signInternalWorkerRequest } from "../../lib/internalAuth";

/**
 * Empuja a la Main el aviso de que ha cambiado una solicitud de emparejamiento (una nueva, o una
 * que la Handy ha cancelado), para que recargue la lista.
 *
 * Best-effort **a propósito**: el cambio ya está guardado cuando llegamos aquí, así que un DO
 * que no responde —o un local sin ninguna Main conectada— no puede tumbar un emparejamiento
 * válido. El panel tiene su propia recarga de respaldo para ese caso.
 */
export async function avisarSolicitudALaMain(env: any, tenantId: string): Promise<void> {
	if (!tenantId) return;

	try {
		const stub = env.TenantHub.get(env.TenantHub.idFromName(tenantId));
		const rawBody = JSON.stringify({ tenantId });

		// FABLE-F: misma firma HMAC que `/internal/apply` y `/internal/revoke`. `pathname` y
		// `rawBody` tienen que coincidir exactamente con lo que verá el DO.
		const sigHeaders = await signInternalWorkerRequest(
			String(env.LICENSE_JWT_SECRET || ""),
			"POST",
			"/internal/pair-request",
			rawBody,
		);

		await stub.fetch("https://do/internal/pair-request", {
			method: "POST",
			headers: { "content-type": "application/json", ...sigHeaders },
			body: rawBody,
		});
	} catch {
		// Silencio deliberado: ver el comentario de arriba.
	}
}

/** La IP con la que cuenta el freno por fallos (`pairing.intentos.ts`). */
export function ipDeLaPeticion(req: Request): string {
	return String(req.headers.get("CF-Connecting-IP") || req.headers.get("x-forwarded-for") || "unknown")
		.split(",")[0]
		.trim();
}
