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
			LIMIT 1
		`,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	if (!row) return false;

	const revoked = row.revoked_at_ms == null ? 0 : Number(row.revoked_at_ms);
	if (revoked !== 0) return false;

	return String(row.role || "").trim().toLowerCase() === "tpv";
}

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

export async function handlePairApprove(
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

		const body = await readJsonSafe(req, { pairCode: "" });
		const pairCode = String((body as any).pairCode || "").trim();

		if (!pairCode) {
			return json({ ok: false, error: "missing_pairCode" }, 400, req);
		}

		const now = Date.now();

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});

		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) {
			return json({ ok: false, error: "pair_code_not_found" }, 404, req);
		}

		if (String(pr.tenant_id || "") !== tenantId) {
			return unauthorized(req, "wrong_tenant");
		}

		if (pr.used_at_ms) {
			return json({ ok: false, error: "already_used" }, 409, req);
		}

		if (Number(pr.expires_at_ms || 0) < now) {
			await dbCentral.execute({
				sql: `
					UPDATE pair_requests
					SET status='expired'
					WHERE pair_code=?
					  AND tenant_id=?
					  AND used_at_ms IS NULL;
				`,
				args: [pairCode, tenantId],
			});

			return json({ ok: false, error: "expired" }, 410, req);
		}

		const status = String(pr.status || "").trim().toLowerCase();

		if (status === "approved") {
			return json({ ok: true, state: "approved" }, 200, req);
		}

		if (status !== "pending") {
			return json(
				{ ok: false, error: "invalid_pair_status", status },
				409,
				req,
			);
		}

		const handyDeviceId = String(pr.claimed_by_device_id || "").trim();
		const handyPub = String(pr.claimed_device_pubkey_b64 || "").trim();

		if (!handyDeviceId || !handyPub) {
			return json({ ok: false, error: "no_claim_to_approve" }, 409, req);
		}

		await dbCentral.execute({
			sql: `
				INSERT INTO devices (
					device_id,
					tenant_id,
					role,
					first_seen_at_ms,
					last_seen_at_ms,
					revoked_at_ms,
					device_pubkey_b64,
					pubkey_alg
				)
				VALUES (?, ?, 'handy', ?, ?, NULL, ?, 'ed25519')
				ON CONFLICT(device_id) DO UPDATE SET
					tenant_id=excluded.tenant_id,
					role='handy',
					last_seen_at_ms=excluded.last_seen_at_ms,
					revoked_at_ms=NULL,
					device_pubkey_b64=excluded.device_pubkey_b64,
					pubkey_alg='ed25519';
			`,
			args: [handyDeviceId, tenantId, now, now, handyPub],
		});

		const updateRes = await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET status='approved',
				    approved_at_ms=?
				WHERE pair_code=?
				  AND tenant_id=?
				  AND used_at_ms IS NULL
				  AND status='pending'
				  AND claimed_by_device_id IS NOT NULL
				  AND expires_at_ms >= ?;
			`,
			args: [now, pairCode, tenantId, now],
		});

		if (rowsAffected(updateRes) <= 0) {
			return json(
				{ ok: false, error: "pair_approve_race_or_invalid_state" },
				409,
				req,
			);
		}

		return json({ ok: true, state: "approved" }, 200, req);
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isAuthError(msg)) {
			return unauthorized(req, msg);
		}

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
			cause: e?.cause ? String(e.cause) : undefined,
		});
	}
}