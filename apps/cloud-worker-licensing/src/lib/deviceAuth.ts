// src/lib/deviceAuth.ts
//
// Helpers de autorización a nivel de dispositivo, compartidos entre dominios
// (sync, login, etc.) para evitar duplicación de lógica.

import type { Env } from "../env";
import { getDb } from "../server/db";

/**
 * Devuelve `true` si el dispositivo (tenant_id + device_id) está emparejado con
 * rol `tpv` y no ha sido revocado. Usado para restringir endpoints que solo la
 * Main debe consumir.
 */
export async function isTpvDevice(
	env: Env,
	tenantId: string,
	deviceId: string,
): Promise<boolean> {
	const r = await getDb(env).execute({
		sql: `
			SELECT role
			FROM devices
			WHERE tenant_id=? AND device_id=?
			  AND (revoked_at_ms IS NULL OR revoked_at_ms=0)
			LIMIT 1;
		`,
		args: [tenantId, deviceId],
	});
	const row = r.rows?.[0] as any | undefined;
	return String(row?.role || "").trim().toLowerCase() === "tpv";
}
