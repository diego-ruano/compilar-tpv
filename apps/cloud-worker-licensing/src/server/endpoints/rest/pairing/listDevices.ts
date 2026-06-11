import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { json, unauthorized, serverError } from "../../../utils/response";

function roleNormalize(r: any) {
	const s = String(r || "").toLowerCase();
	if (s === "tpv") return "tpv";
	if (s === "handy") return "handy";
	return "unknown";
}

function isAuthError(msg: string): boolean {
	return (
		msg.includes("missing_token") ||
		msg.includes("invalid_token") ||
		msg.includes("invalid_token_claims") ||
		msg.includes("missing_device_proof") ||
		msg.includes("bad_device_signature") ||
		msg.includes("device_ts_out_of_range") ||
		msg.includes("device_pubkey_not_registered") ||
		msg.includes("bad_device_ts") ||
		msg.includes("bad_b64") ||
		msg.includes("device_not_registered") ||
		msg.includes("device_revoked") ||
		msg.includes("forbidden")
	);
}

async function isMainDevice(
	dbCentral: Client,
	tenantId: string,
	deviceId: string,
): Promise<boolean> {
	const r = await dbCentral.execute({
		sql: `
			SELECT role, revoked_at_ms
			FROM devices
			WHERE tenant_id=? AND device_id=?
			LIMIT 1;
		`,
		args: [tenantId, deviceId],
	});
	const row = r.rows?.[0] as any | undefined;
	if (!row) return false;
	if (row.revoked_at_ms) return false;
	return roleNormalize(row.role) === "tpv";
}

// Lista los dispositivos Handy vinculados (no revocados) del tenant. Solo la Main (rol tpv)
// puede consultarla; es lo que muestra la sección "Vincular Handy" para poder desvincular.
export async function handleListDevices(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		const requesterDeviceId = String(ctx?.claims?.deviceId || "").trim();

		if (!tenantId || !requesterDeviceId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const okMain = await isMainDevice(dbCentral, tenantId, requesterDeviceId);
		if (!okMain) return unauthorized(req, "forbidden_not_main");

		const r = await dbCentral.execute({
			sql: `
				SELECT device_id, device_pubkey_b64, first_seen_at_ms, last_seen_at_ms
				FROM devices
				WHERE tenant_id=?
				  AND role='handy'
				  AND (revoked_at_ms IS NULL OR revoked_at_ms=0)
				ORDER BY last_seen_at_ms DESC
				LIMIT 100;
			`,
			args: [tenantId],
		});

		const items = (r.rows || []).map((row: any) => ({
			deviceId: String(row.device_id),
			devicePubKeyB64: row.device_pubkey_b64
				? String(row.device_pubkey_b64)
				: null,
			firstSeenAtMs: Number(row.first_seen_at_ms || 0),
			lastSeenAtMs: Number(row.last_seen_at_ms || 0),
		}));

		return json({ ok: true, items }, 200, req);
	} catch (e: any) {
		const msg = String(e?.message || e);
		if (isAuthError(msg)) return unauthorized(req, msg);
		if (msg.includes("tenant_db_not_provisioned")) {
			return serverError(req, "tenant_db_not_provisioned");
		}
		return serverError(req, "internal_error", msg);
	}
}
