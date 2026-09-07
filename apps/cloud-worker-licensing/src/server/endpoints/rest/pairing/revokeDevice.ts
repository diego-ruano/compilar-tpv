import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { SQL_DEVICE_ACTIVO, tieneRol } from "../../../../lib/deviceAuth";
import { json, unauthorized, serverError } from "../../../utils/response";
import { cerrarSocketsDelDispositivo } from "../../../../lib/hub";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
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

		const okMain = await tieneRol(dbCentral, tenantId, requesterDeviceId, "tpv");
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
				  AND ${SQL_DEVICE_ACTIVO};
			`,
			args: [now, now, tenantId, targetDeviceId],
		});

		const changed = rowsAffected(updateRes);

		// Best-effort: si falla, el dispositivo quedará bloqueado en el próximo reconnect.
		await cerrarSocketsDelDispositivo(
			hubNs,
			String(env.LICENSE_JWT_SECRET || ""),
			tenantId,
			targetDeviceId,
		);

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