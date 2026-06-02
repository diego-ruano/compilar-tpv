// src/server/middleware/jwtHs256.ts
import { b64ToBytes } from "../utils/base64";

function b64urlToBytes(b64url: string): Uint8Array {
	const b64 =
		b64url.replace(/-/g, "+").replace(/_/g, "/") +
		"===".slice((b64url.length + 3) % 4);
	return b64ToBytes(b64);
}

function bytesToStr(u8: Uint8Array): string {
	return new TextDecoder().decode(u8);
}

/**
 * Convierte una vista (TypedArray) a un ArrayBuffer EXACTO (sin SharedArrayBuffer issues)
 * y sin depender de .slice sobre el buffer original.
 */
function toExactArrayBuffer(u8: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out.buffer; // ✅ ArrayBuffer
}

async function hmacSha256Verify(keyStr: string, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
	const keyBytes = new TextEncoder().encode(keyStr);

	const key = await crypto.subtle.importKey(
		"raw",
		toExactArrayBuffer(keyBytes), // ✅ ArrayBuffer
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"]
	);

	// ✅ verify con ArrayBuffer puros
	const sigBuf = toExactArrayBuffer(sig);
	const dataBuf = toExactArrayBuffer(data);

	return crypto.subtle.verify("HMAC", key, sigBuf, dataBuf);
}

export type JwtPayload = Record<string, any>;

export async function verifyJwtHs256(token: string, secret: string): Promise<JwtPayload> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("invalid_jwt");

	const [hB64u, pB64u, sB64u] = parts;

	const data = new TextEncoder().encode(`${hB64u}.${pB64u}`);
	const sig = b64urlToBytes(sB64u);

	const ok = await hmacSha256Verify(secret, data, sig);
	if (!ok) throw new Error("bad_jwt_signature");

	const payloadJson = bytesToStr(b64urlToBytes(pB64u));

	let payload: JwtPayload;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("bad_jwt_payload");
	}

	const exp = Number(payload.exp ?? 0);
	if (Number.isFinite(exp) && exp > 0) {
		const nowSec = Math.floor(Date.now() / 1000);
		if (nowSec >= exp) throw new Error("jwt_expired");
	}

	const nbf = Number(payload.nbf ?? 0);
	if (Number.isFinite(nbf) && nbf > 0) {
		const nowSec = Math.floor(Date.now() / 1000);
		if (nowSec < nbf) throw new Error("jwt_not_active");
	}

	return payload;
}