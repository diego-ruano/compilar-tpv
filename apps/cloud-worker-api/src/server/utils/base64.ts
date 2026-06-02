// src/server/utils/base64.ts

function normalizeB64Input(b64: unknown): string {
	if (typeof b64 !== "string") {
		const t = typeof b64;
		const tag = Object.prototype.toString.call(b64);
		throw new Error(`bad_b64_input type=${t} tag=${tag}`);
	}

	// soporta base64url y base64 estándar
	const s = b64.trim().replace(/-/g, "+").replace(/_/g, "/");

	// padding
	const pad = s.length % 4;
	return pad ? s + "=".repeat(4 - pad) : s;
}

const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64ToBytes(b64: unknown): Uint8Array {
	const s = normalizeB64Input(b64);
	if (!s) return new Uint8Array(0);

	let bufferLength = (s.length * 3) / 4;
	if (s.endsWith("==")) bufferLength -= 2;
	else if (s.endsWith("=")) bufferLength -= 1;

	const bytes = new Uint8Array(bufferLength);

	let p = 0;
	for (let i = 0; i < s.length; i += 4) {
		const c1 = ALPH.indexOf(s[i]);
		const c2 = ALPH.indexOf(s[i + 1]);
		const c3 = s[i + 2] === "=" ? -1 : ALPH.indexOf(s[i + 2]);
		const c4 = s[i + 3] === "=" ? -1 : ALPH.indexOf(s[i + 3]);

		if (c1 < 0 || c2 < 0 || (c3 < 0 && s[i + 2] !== "=") || (c4 < 0 && s[i + 3] !== "=")) {
			throw new Error("bad_b64_chars");
		}

		const n = (c1 << 18) | (c2 << 12) | ((c3 & 63) << 6) | (c4 & 63);

		if (p < bytes.length) bytes[p++] = (n >> 16) & 255;
		if (c3 !== -1 && p < bytes.length) bytes[p++] = (n >> 8) & 255;
		if (c4 !== -1 && p < bytes.length) bytes[p++] = n & 255;
	}

	return bytes;
}

export function bytesToB64(bytes: Uint8Array): string {
	let out = "";
	const len = bytes.length;

	for (let i = 0; i < len; i += 3) {
		const a = bytes[i];
		const b = i + 1 < len ? bytes[i + 1] : 0;
		const c = i + 2 < len ? bytes[i + 2] : 0;

		const n = (a << 16) | (b << 8) | c;

		out += ALPH[(n >> 18) & 63];
		out += ALPH[(n >> 12) & 63];
		out += i + 1 < len ? ALPH[(n >> 6) & 63] : "=";
		out += i + 2 < len ? ALPH[n & 63] : "=";
	}

	return out;
}