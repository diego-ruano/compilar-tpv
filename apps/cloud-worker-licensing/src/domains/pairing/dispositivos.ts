// src/domains/pairing/dispositivos.ts
//
// Los dispositivos vinculados a un negocio: verlos y desvincularlos. Es la otra mitad de
// Configuración → Vincular Handy, y por eso vive junto al emparejamiento.
//
// Como el resto del dominio, aquí sólo se decide: quién pregunta lo resuelven `tenantAuth` y
// `soloLaMain` en la ruta.

import type { Env } from "../../env";
import type { Client } from "@libsql/client/web";

import { SQL_DEVICE_ACTIVO } from "../../lib/deviceAuth";
import { cerrarSocketsDelDispositivo } from "../../lib/hub";
import { rowsAffected } from "../../server/db";
import { fallo, ok, type Resultado } from "./pairing.resultado";

/** Los Handy vinculados (no revocados) del negocio. */
export async function listarDispositivos(db: Client, tenantId: string): Promise<Resultado> {
	const r = await db.execute({
		sql: `
			SELECT device_id, device_pubkey_b64, first_seen_at_ms, last_seen_at_ms
			FROM devices
			WHERE tenant_id=?
			  AND role='handy'
			  AND ${SQL_DEVICE_ACTIVO}
			ORDER BY last_seen_at_ms DESC
			LIMIT 100;
		`,
		args: [tenantId],
	});

	const items = (r.rows || []).map((row: any) => ({
		deviceId: String(row.device_id),
		devicePubKeyB64: row.device_pubkey_b64 ? String(row.device_pubkey_b64) : null,
		firstSeenAtMs: Number(row.first_seen_at_ms || 0),
		lastSeenAtMs: Number(row.last_seen_at_ms || 0),
	}));

	return ok({ items });
}

/** Desvincula un Handy y le cierra el socket para que se entere ya. */
export async function revocarDispositivo(
	db: Client,
	env: any,
	hubNs: Env["TenantHub"],
	tenantId: string,
	quienPide: string,
	objetivo: string,
	now: number,
): Promise<Resultado> {
	if (objetivo === quienPide) return fallo(400, "cannot_revoke_self");

	const updateRes = await db.execute({
		sql: `
			UPDATE devices
			SET revoked_at_ms=?,
			    last_seen_at_ms=?
			WHERE tenant_id=?
			  AND device_id=?
			  AND ${SQL_DEVICE_ACTIVO};
		`,
		args: [now, now, tenantId, objetivo],
	});

	const cambiadas = rowsAffected(updateRes);

	// Best-effort: si falla, el dispositivo quedará bloqueado en el próximo reconnect.
	await cerrarSocketsDelDispositivo(
		hubNs,
		tenantId,
		objetivo,
	);

	return ok({
		revoked: cambiadas > 0,
		alreadyRevokedOrMissing: cambiadas <= 0,
		deviceId: objetivo,
	});
}
