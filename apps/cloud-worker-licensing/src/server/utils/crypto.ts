import { b64ToBytes } from "./base64";

export function secretKey(str: string) {
	return new TextEncoder().encode(str);
}

/**
 * Comparación de dos hex en tiempo constante. Un `===` normal sale del bucle en cuanto
 * encuentra el primer byte distinto, y ese tiempo revela cuántos acertaste: repitiendo, se
 * reconstruye la firma byte a byte. La usan las verificaciones de firma de webhook.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
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
		{ name: "AES-GCM" },
		false,
		["decrypt"],
	);

	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		data as unknown as BufferSource
	);

	return new TextDecoder().decode(pt);
}