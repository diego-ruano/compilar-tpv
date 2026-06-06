import type { Client } from "@libsql/client/web";

import { b64ToBytes, bytesToB64 } from "../../../utils/base64";
import { json, serverError } from "../../../utils/response";
import { ed25519Verify, nobleForceU8 } from "../../../utils/nobleEd25519";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function sanitizeB64(input: string): string {
	let s = String(input || "").trim();

	s = s.replace(/^"+|"+$/g, "");
	s = s.replace(/\s+/g, "");
	s = s.replace(/-/g, "+").replace(/_/g, "/");

	const mod = s.length % 4;
	if (mod === 2) s += "==";
	else if (mod === 3) s += "=";

	return s;
}

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

function getHandyTokenTtlSeconds(env: any): number {
	const raw = Number(env?.HANDY_TOKEN_TTL_SECONDS ?? 0);
	if (Number.isFinite(raw) && raw >= 3600) return Math.floor(raw);

	return 30 * 24 * 60 * 60;
}

async function getTenantLicHash(
	dbCentral: Client,
	tenantId: string,
): Promise<string | null> {
	const r = await dbCentral.execute({
		sql: `
			SELECT license_key_hash
			FROM licenses
			WHERE tenant_id = ?
			  AND status = 'active'
			ORDER BY updated_at_ms DESC
			LIMIT 1;
		`,
		args: [tenantId],
	});

	const row = r.rows?.[0] as any | undefined;
	const v = row ? String(row.license_key_hash || "").trim() : "";

	return v || null;
}

async function getActiveHandyDevicePubkey(
	dbCentral: Client,
	tenantId: string,
	deviceId: string,
): Promise<string | null> {
	const r = await dbCentral.execute({
		sql: `
			SELECT role, revoked_at_ms, device_pubkey_b64
			FROM devices
			WHERE tenant_id=?
			  AND device_id=?
			LIMIT 1;
		`,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	if (!row) return null;

	const role = String(row.role || "").trim().toLowerCase();
	if (role !== "handy") return null;

	const revoked = row.revoked_at_ms == null ? 0 : Number(row.revoked_at_ms);
	if (revoked !== 0) return null;

	const pub = String(row.device_pubkey_b64 || "").trim();
	return pub || null;
}

function toExactArrayBuffer(u8: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out.buffer;
}

function b64ToB64url(b64: string): string {
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlFromBytes(bytes: Uint8Array): string {
	return b64ToB64url(bytesToB64(bytes));
}

function b64urlFromUtf8(s: string): string {
	return b64urlFromBytes(new TextEncoder().encode(s));
}

async function hmacSha256Sign(
	secret: string,
	data: Uint8Array,
): Promise<Uint8Array> {
	const keyBytes = new TextEncoder().encode(secret);

	const key = await crypto.subtle.importKey(
		"raw",
		toExactArrayBuffer(keyBytes),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const sigBuf = await crypto.subtle.sign(
		"HMAC",
		key,
		toExactArrayBuffer(data),
	);

	return new Uint8Array(sigBuf);
}

async function signJwtHs256(
	payload: Record<string, any>,
	secret: string,
	expSeconds: number,
): Promise<string> {
	const nowSec = Math.floor(Date.now() / 1000);

	const header = { alg: "HS256", typ: "JWT" };
	const body = { ...payload, iat: nowSec, exp: nowSec + expSeconds };

	const encHeader = b64urlFromUtf8(JSON.stringify(header));
	const encPayload = b64urlFromUtf8(JSON.stringify(body));
	const signingInput = `${encHeader}.${encPayload}`;

	const sigBytes = await hmacSha256Sign(
		secret,
		new TextEncoder().encode(signingInput),
	);

	const encSig = b64urlFromBytes(sigBytes);

	return `${signingInput}.${encSig}`;
}

export async function handlePairFetchToken(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const body = await readJsonSafe(req, {
			pairCode: "",
			deviceId: "",
			nonceB64: "",
			sigB64: "",
			ts: 0,
		});

		const pairCode = String((body as any).pairCode || "").trim();
		const deviceId = String((body as any).deviceId || "").trim();
		const nonceB64 = String((body as any).nonceB64 || "").trim();
		const sigB64Raw = String((body as any).sigB64 || "").trim();
		const ts = Number((body as any).ts || 0);

		if (!pairCode) {
			return json({ ok: false, error: "missing_pairCode" }, 400, req);
		}

		if (!deviceId) {
			return json({ ok: false, error: "missing_deviceId" }, 400, req);
		}

		if (!nonceB64 || !sigB64Raw || !ts) {
			return json({ ok: false, error: "missing_proof" }, 400, req);
		}

		const now = Date.now();
		const MAX_SKEW_MS = 2 * 60 * 1000;

		if (Math.abs(now - ts) > MAX_SKEW_MS) {
			return json({ ok: false, error: "timestamp_out_of_range" }, 401, req);
		}

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});

		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) {
			return json({ ok: false, error: "pair_code_not_found" }, 404, req);
		}

		if (pr.used_at_ms) {
			return json({ ok: false, error: "already_used" }, 409, req);
		}

		if (Number(pr.expires_at_ms || 0) < now) {
			return json({ ok: false, error: "pair_code_expired" }, 410, req);
		}

		if (String(pr.status || "") !== "approved") {
			return json({ ok: false, error: "not_approved" }, 409, req);
		}

		if (String(pr.claimed_by_device_id || "") !== deviceId) {
			return json({ ok: false, error: "device_mismatch" }, 403, req);
		}

		const tenantId = String(pr.tenant_id || "").trim();
		const pubB64Raw = String(pr.claimed_device_pubkey_b64 || "").trim();

		if (!tenantId) {
			return serverError(req, "missing_tenant_id");
		}

		if (!pubB64Raw) {
			return serverError(req, "missing_pubkey");
		}

		const activeDevicePubkey = await getActiveHandyDevicePubkey(
			dbCentral,
			tenantId,
			deviceId,
		);

		if (!activeDevicePubkey) {
			return json(
				{ ok: false, error: "device_not_registered_or_revoked" },
				401,
				req,
			);
		}

		if (sanitizeB64(activeDevicePubkey) !== sanitizeB64(pubB64Raw)) {
			return json({ ok: false, error: "device_pubkey_mismatch" }, 401, req);
		}

		const chRes = await dbCentral.execute({
			sql: `
				SELECT *
				FROM device_challenges
				WHERE device_id=?
				  AND nonce_b64=?
				LIMIT 1;
			`,
			args: [deviceId, nonceB64],
		});

		const ch = chRes.rows?.[0] as any | undefined;
		if (!ch) {
			return json({ ok: false, error: "challenge_not_found" }, 404, req);
		}

		if (ch.used_at_ms) {
			return json({ ok: false, error: "challenge_used" }, 409, req);
		}

		if (Number(ch.expires_at_ms || 0) < now) {
			return json({ ok: false, error: "challenge_expired" }, 410, req);
		}

		const sigB64 = sanitizeB64(sigB64Raw);
		const pubB64 = sanitizeB64(pubB64Raw);

		let sigU8: Uint8Array;
		let pubU8: Uint8Array;

		try {
			sigU8 = nobleForceU8(b64ToBytes(sigB64));
			pubU8 = nobleForceU8(b64ToBytes(pubB64));
		} catch {
			return json({ ok: false, error: "bad_b64" }, 401, req);
		}

		if (sigU8.length !== 64) {
			return json({ ok: false, error: "bad_signature_len" }, 401, req);
		}

		if (pubU8.length !== 32) {
			return json({ ok: false, error: "bad_pubkey_len" }, 401, req);
		}

		const msgBytes = new TextEncoder().encode(
			`${ts}\nPAIR_FETCH\n${pairCode}\n${nonceB64}\n${deviceId}`,
		);

		const msgU8 = nobleForceU8(msgBytes);

		const ok = await ed25519Verify(sigU8, msgU8, pubU8);
		if (!ok) {
			return json({ ok: false, error: "bad_device_signature" }, 401, req);
		}

		const licHash = await getTenantLicHash(dbCentral, tenantId);
		if (!licHash) {
			return serverError(req, "no_active_license_for_tenant");
		}

		const jwtSecret = String(env.LICENSE_JWT_SECRET || "");
		if (!jwtSecret) {
			return serverError(req, "missing_LICENSE_JWT_SECRET");
		}

		const ttlSeconds = getHandyTokenTtlSeconds(env);

		const token = await signJwtHs256(
			{
				tenantId,
				deviceId,
				licHash,
				role: "handy",
			},
			jwtSecret,
			ttlSeconds,
		);

		const challengeUpdate = await dbCentral.execute({
			sql: `
				UPDATE device_challenges
				SET used_at_ms=?
				WHERE device_id=?
				  AND nonce_b64=?
				  AND used_at_ms IS NULL
				  AND expires_at_ms >= ?;
			`,
			args: [now, deviceId, nonceB64, now],
		});

		if (rowsAffected(challengeUpdate) <= 0) {
			return json(
				{ ok: false, error: "challenge_used_or_expired" },
				409,
				req,
			);
		}

		const pairUpdate = await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET status='used',
				    used_at_ms=?
				WHERE pair_code=?
				  AND claimed_by_device_id=?
				  AND status='approved'
				  AND used_at_ms IS NULL
				  AND expires_at_ms >= ?;
			`,
			args: [now, pairCode, deviceId, now],
		});

		if (rowsAffected(pairUpdate) <= 0) {
			return json(
				{ ok: false, error: "pair_code_used_or_invalid_state" },
				409,
				req,
			);
		}

		return json(
			{
				ok: true,
				tenantId,
				token,
				deviceId,
				expiresInSeconds: ttlSeconds,
			},
			200,
			req,
		);
	} catch (e: any) {
		const msg = String(e?.message || e);

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
		});
	}
}