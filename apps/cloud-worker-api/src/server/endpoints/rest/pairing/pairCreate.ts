import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { json, unauthorized, serverError } from "../../../utils/response";
import { sha256HexStr } from "../../../utils/crypto";
import { bytesToB64 } from "../../../utils/base64";

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
			SELECT role
			FROM devices
			WHERE tenant_id=? AND device_id=?
			  AND (revoked_at_ms IS NULL OR revoked_at_ms=0)
			LIMIT 1;
		`,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	const role = String(row?.role || "").trim().toLowerCase();

	return role === "tpv";
}

function randomDigits6(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);

	const n =
		((bytes[0] << 24) >>> 0) +
		(bytes[1] << 16) +
		(bytes[2] << 8) +
		bytes[3];

	const v = n % 1_000_000;
	return String(v).padStart(6, "0");
}

export async function handlePairCreate(
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
		const ttlMs = 10 * 60 * 1000;
		const expiresAtMs = now + ttlMs;

		const secretBytes = new Uint8Array(32);
		crypto.getRandomValues(secretBytes);

		const pairSecret = bytesToB64(secretBytes);
		const pepper = String(env.PAIR_PEPPER || "");
		const secretHash = await sha256HexStr(`${pairSecret}.${pepper}`);

		for (let i = 0; i < 10; i++) {
			const pairCode = randomDigits6();

			try {
				await dbCentral.execute({
					sql: `
						INSERT INTO pair_requests (
							pair_code,
							secret_hash,
							tenant_id,
							created_by_device_id,
							status,
							created_at_ms,
							expires_at_ms
						)
						VALUES (?, ?, ?, ?, 'pending', ?, ?);
					`,
					args: [pairCode, secretHash, tenantId, deviceId, now, expiresAtMs],
				});

				return json({ ok: true, pairCode, pairSecret, expiresAtMs }, 200, req);
			} catch (e: any) {
				const msg = String(e?.message || e);
				if (
					msg.includes("UNIQUE") ||
					msg.includes("constraint") ||
					msg.includes("PRIMARY")
				) {
					continue;
				}

				throw e;
			}
		}

		return serverError(req, "pair_code_generation_failed");
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isAuthError(msg)) {
			return unauthorized(req, msg, {
				name: e?.name,
				stack: e?.stack,
				cause: e?.cause ? String(e.cause) : undefined,
			});
		}

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
			cause: e?.cause ? String(e.cause) : undefined,
		});
	}
}