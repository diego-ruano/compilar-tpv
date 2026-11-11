// src/domains/pairing/pairing.avisos.ts
//
// El empujón a la Main para que recargue su lista de solicitudes.

import type { Env } from "../../env";
import { hubDe } from "../../lib/hub";

/**
 * Empuja a la Main el aviso de que ha cambiado una solicitud de emparejamiento (una nueva, o una
 * que la Handy ha cancelado), para que recargue la lista.
 *
 * Best-effort **a propósito**: el cambio ya está guardado cuando llegamos aquí, así que un DO
 * que no responde —o un local sin ninguna Main conectada— no puede tumbar un emparejamiento
 * válido. El panel tiene su propia recarga de respaldo para ese caso.
 */
export async function avisarSolicitudALaMain(env: Env, tenantId: string): Promise<void> {
	if (!tenantId) return;

	try {
		await hubDe(env, tenantId).avisarEmparejamiento();
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
