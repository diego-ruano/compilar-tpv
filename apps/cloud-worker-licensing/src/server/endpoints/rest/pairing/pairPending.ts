import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { json, unauthorized, serverError } from "../../../utils/response";

function roleIsTpv(r: any) {
	return String(r || "").trim().toLowerCase() === "tpv";
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

async function isTpvDevice(
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

	const revoked = Number(row.revoked_at_ms || 0);
	if (revoked !== 0) return false;

	return roleIsTpv(row.role);
}

export async function handlePairPending(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		const deviceId = String(ctx?.claims?.deviceId || "").trim();

		if (!tenantId || !deviceId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const okTpv = await isTpvDevice(dbCentral, tenantId, deviceId);
		if (!okTpv) return unauthorized(req, "forbidden_not_tpv");

		const now = Date.now();

		await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET status='expired'
				WHERE tenant_id=?
				  AND used_at_ms IS NULL
				  AND expires_at_ms < ?
				  AND status IN ('pending', 'approved');
			`,
			args: [tenantId, now],
		});

		const r = await dbCentral.execute({
			sql: `
				SELECT
					pair_code,
					status,
					created_at_ms,
					expires_at_ms,
					claimed_at_ms,
					claimed_by_device_id,
					claimed_device_name,
					claimed_device_pubkey_b64,
					attempts,
					last_attempt_at_ms
				FROM pair_requests
				WHERE tenant_id=?
				  AND used_at_ms IS NULL
				  AND expires_at_ms >= ?
				  AND status='pending'
				  AND claimed_by_device_id IS NOT NULL
				ORDER BY claimed_at_ms DESC
				LIMIT 50;
			`,
			args: [tenantId, now],
		});

		const items = (r.rows || []).map((row: any) => ({
			pairCode: String(row.pair_code),
			status: String(row.status || "pending"),
			createdAtMs: Number(row.created_at_ms || 0),
			expiresAtMs: Number(row.expires_at_ms || 0),

			claimedAtMs:
				row.claimed_at_ms != null ? Number(row.claimed_at_ms) : null,
			claimedDeviceId: row.claimed_by_device_id
				? String(row.claimed_by_device_id)
				: null,
			claimedDeviceName: row.claimed_device_name
				? String(row.claimed_device_name)
				: null,
			claimedDevicePubKeyB64: row.claimed_device_pubkey_b64
				? String(row.claimed_device_pubkey_b64)
				: null,

			attempts: Number(row.attempts || 0),
			lastAttemptAtMs:
				row.last_attempt_at_ms != null
					? Number(row.last_attempt_at_ms)
					: null,
		}));

		return json({ ok: true, items }, 200, req);
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isAuthError(msg)) {
			return unauthorized(req, msg);
		}

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
		});
	}
}