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

// Cache de pubkeys de dispositivos (scope de isolate de CF Worker).
// La pubkey no cambia tras el pairing, así que 60 s de TTL es suficiente para
// eliminar el round-trip a la central DB en cada petición sin riesgo real
// (la revocación puede tardar hasta 60 s en hacer efecto, aceptable en un TPV).
type DeviceCacheEntry = { pubB64: string; expiresAtMs: number };
const devicePubkeyCache = new Map<string, DeviceCacheEntry>();
const DEVICE_CACHE_TTL_MS = 60_000;

function deviceCacheKey(tenantId: string, deviceId: string): string {
	return `${tenantId}:${deviceId}`;
}

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
	const key = deviceCacheKey(tenantId, deviceId);
	const hit = devicePubkeyCache.get(key);
	if (hit && hit.expiresAtMs > Date.now()) return hit.pubB64;

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
	const pubB64 = v ? v : null;

	if (pubB64) {
		devicePubkeyCache.set(key, { pubB64, expiresAtMs: Date.now() + DEVICE_CACHE_TTL_MS });
	} else {
		// No cachear null: si el dispositivo fue revocado o aún no existe,
		// la comprobación vuelve a la BD en la siguiente petición.
		devicePubkeyCache.delete(key);
	}

	return pubB64;
}

/**
 * Verifica el “device proof”:
 * msg = "{ts}\n{METHOD}\n{PATH}\n{sha256(token)}\n{sha256(body)}"
 *
 * `rawBody` es el cuerpo **tal cual llegó** (cadena vacía si no hay). Cubrirlo con la firma
 * (FABLE-E) es lo que impide alterar el contenido de una petición ya firmada; antes la firma solo
 * ataba método y ruta. Quien llame a esto tiene que leer el cuerpo con `c.req.text()` y pasarlo:
 * Hono cachea esa lectura, así que el handler puede seguir usando `c.req.json()` después.
 *
 * ⚠️ El formato debe ser idéntico al de `sign_device_proof` (`tpv-infra-licensing/src/device.rs`).
 */
export async function verifyDeviceProofOrThrow(
	req: Request,
	dbCentral: Client,
	claims: { tenantId: string; deviceId: string },
	bearerToken: string,
	rawBody: string
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
	const bodyHash = await sha256HexStr(rawBody ?? "");
	const msg = `${ts}\n${req.method.toUpperCase()}\n${url.pathname}\n${tokenHash}\n${bodyHash}`;

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