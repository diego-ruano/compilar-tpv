import { b64ToBytes } from "./base64";

export function secretKey(str: string) {
	return new TextEncoder().encode(str);
}

export async function sha256HexStr(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * AES-GCM decrypt (payload = iv[12] + ciphertext)
 * keyB64 debe ser 32 bytes en base64
 */
export async function aesGcmDecryptFromB64(keyB64: string, payloadB64: string): Promise<string> {
	const raw = b64ToBytes(payloadB64);
	const iv = raw.slice(0, 12);
	const data = raw.slice(12);

	const keyBytes = b64ToBytes(keyB64);

	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes as unknown as BufferSource,
		{ name: "AES-GCM" } as unknown as AlgorithmIdentifier,
		false,
		["decrypt"] as KeyUsage[],
	);

	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv } as unknown as AlgorithmIdentifier,
		key,
		data as unknown as BufferSource
	);

	return new TextDecoder().decode(pt);
}