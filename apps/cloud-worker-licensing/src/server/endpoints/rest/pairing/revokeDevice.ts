import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { json, unauthorized, serverError } from "../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

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

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
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

export async function handleRevokeDevice(
	req: Request,
	env: any,
	dbCentral: Client,
	hubNs: DurableObjectNamespace,
): Promise<Response> {
	try {
		const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		const requesterDeviceId = String(ctx?.claims?.deviceId || "").trim();

		if (!tenantId || !requesterDeviceId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const okMain = await isMainDevice(
			dbCentral,
			tenantId,
			requesterDeviceId,
		);

		if (!okMain) return unauthorized(req, "forbidden_not_main");

		const body = await readJsonSafe(req, { deviceId: "" });
		const targetDeviceId = String((body as any).deviceId || "").trim();

		if (!targetDeviceId) {
			return json({ ok: false, error: "missing_deviceId" }, 400, req);
		}

		if (targetDeviceId === requesterDeviceId) {
			return json({ ok: false, error: "cannot_revoke_self" }, 400, req);
		}

		const now = Date.now();

		const updateRes = await dbCentral.execute({
			sql: `
				UPDATE devices
				SET revoked_at_ms=?,
				    last_seen_at_ms=?
				WHERE tenant_id=?
				  AND device_id=?
				  AND (revoked_at_ms IS NULL OR revoked_at_ms=0);
			`,
			args: [now, now, tenantId, targetDeviceId],
		});

		const changed = rowsAffected(updateRes);

		try {
			const id = hubNs.idFromName(tenantId);
			const stub = hubNs.get(id);

			await stub.fetch("https://do/internal/revoke", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deviceId: targetDeviceId }),
			});
		} catch {
			// Best-effort. Si falla, el dispositivo quedará bloqueado en el próximo reconnect.
		}

		return json(
			{
				ok: true,
				revoked: changed > 0,
				alreadyRevokedOrMissing: changed <= 0,
				deviceId: targetDeviceId,
			},
			200,
			req,
		);
	} catch (e: any) {
		const msg = String(e?.message || e);

		// Visible en `wrangler tail` / logs de CF: el front solo recibe el código, así que sin
		// esto el motivo real del 500 quedaba oculto.
		console.error("revoke_device failed:", e?.stack || msg);

		if (isAuthError(msg)) {
			return unauthorized(req, msg);
		}

		if (msg.includes("tenant_db_not_provisioned")) {
			return serverError(req, "tenant_db_not_provisioned");
		}

		return serverError(req, "internal_error", msg);
	}
}