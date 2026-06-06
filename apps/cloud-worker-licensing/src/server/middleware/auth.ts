// src/server/middleware/auth.ts
import type { Client } from "@libsql/client/web";

import { verifyJwtHs256 } from "./jwtHs256";
import { b64ToBytes } from "../utils/base64";
import { sha256HexStr } from "../utils/crypto";
import { ed25519Verify, nobleForceU8 } from "../utils/nobleEd25519";

export type AuthClaims = {
	tenantId: string;
	deviceId: string;
	licHash: string;
};

function readBearer(req: Request): string {
	const h = req.headers.get("authorization") || "";
	const m = h.match(/^Bearer\s+(.+)$/i);
	if (!m) throw new Error("missing_token");
	return m[1];
}

export async function verifyJwt(env: any, req: Request): Promise<{ token: string; claims: AuthClaims }> {
	const token = readBearer(req);

	const payload = await verifyJwtHs256(token, String(env.LICENSE_JWT_SECRET || ""));

	const tenantId = String((payload as any).tenantId || "");
	const deviceId = String((payload as any).deviceId || "");
	const licHash = String((payload as any).licHash || "");

	if (!tenantId || !deviceId || !licHash) throw new Error("invalid_token_claims");

	return { token, claims: { tenantId, deviceId, licHash } };
}

async function getDevicePubKeyB64(dbCentral: Client, tenantId: string, deviceId: string): Promise<string | null> {
	const r = await dbCentral.execute({
		sql: `
      SELECT device_pubkey_b64
      FROM devices
      WHERE tenant_id = ? AND device_id = ?
        AND revoked_at_ms IS NULL
      LIMIT 1
    `,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	const v = row ? String(row.device_pubkey_b64 || "").trim() : "";
	return v ? v : null;
}

/**
 * Verifica el “device proof”:
 * msg = "{ts}\n{METHOD}\n{PATH}\n{sha256(token)}"
 */
export async function verifyDeviceProofOrThrow(
	req: Request,
	dbCentral: Client,
	claims: { tenantId: string; deviceId: string },
	bearerToken: string
): Promise<void> {
	const tsStr = (req.headers.get("X-Device-Ts") || "").trim();
	const sigB64Raw = (req.headers.get("X-Device-Sig") || "").trim();
	if (!tsStr || !sigB64Raw) throw new Error("missing_device_proof");

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) throw new Error("bad_device_ts");

	const now = Date.now();
	const MAX_SKEW_MS = 2 * 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) throw new Error("device_ts_out_of_range");

	const pubB64 = await getDevicePubKeyB64(dbCentral, claims.tenantId, claims.deviceId);
	if (!pubB64) throw new Error("device_pubkey_not_registered");

	const url = new URL(req.url);
	const tokenHash = await sha256HexStr(bearerToken);
	const msg = `${ts}\n${req.method.toUpperCase()}\n${url.pathname}\n${tokenHash}`;

	// por si llega con comillas
	const sigB64 = sigB64Raw.replace(/^"+|"+$/g, "");

	try {
		const pubU8 = nobleForceU8(b64ToBytes(pubB64));
		const sigU8 = nobleForceU8(b64ToBytes(sigB64));
		const payloadU8 = nobleForceU8(new TextEncoder().encode(msg));

		const ok = await ed25519Verify(sigU8, payloadU8, pubU8);
		if (!ok) throw new Error("bad_device_signature");
	} catch (e: any) {
		throw new Error(`verify_failed: ${String(e?.message || e)}`);
	}
}