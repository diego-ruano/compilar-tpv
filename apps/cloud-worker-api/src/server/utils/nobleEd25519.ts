// src/server/utils/nobleEd25519.ts
import * as ed from "@noble/ed25519";

let configured = false;

/**
 * Devuelve Uint8Array "limpio": byteOffset=0 + ArrayBuffer normal
 * (sin SharedArrayBuffer / views raras)
 */
function forceU8(v: any): Uint8Array {
	let u8: Uint8Array;

	if (v instanceof Uint8Array) {
		u8 = v;
	} else if (v instanceof ArrayBuffer) {
		u8 = new Uint8Array(v);
	} else {
		// SharedArrayBuffer (si existe)
		// eslint-disable-next-line no-undef
		if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) {
			u8 = new Uint8Array(v);
		} else if (v && typeof v === "object" && v.buffer && typeof v.byteLength === "number") {
			u8 = new Uint8Array(v.buffer, v.byteOffset ?? 0, v.byteLength);
		} else {
			throw new Error(`bytes_expected type=${typeof v} tag=${Object.prototype.toString.call(v)}`);
		}
	}

	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

export function nobleForceU8(v: any): Uint8Array {
	return forceU8(v);
}

function toExactArrayBuffer(u8: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out.buffer;
}

/**
 * Configura noble para usar SHA-512 vía WebCrypto (solo necesario si acabamos usando noble).
 */
export function ensureEd25519Sha512() {
	if (configured) return;
	configured = true;

	(ed as any).hashes.sha512 = async (msg: any): Promise<Uint8Array> => {
		const u8 = forceU8(msg);
		const digest = await crypto.subtle.digest("SHA-512", toExactArrayBuffer(u8));
		return new Uint8Array(digest);
	};
}

/**
 * ✅ Verificación Ed25519 robusta en Cloudflare Workers:
 * - 1º intenta WebCrypto nativo (mejor en Workers)
 * - si no está soportado, cae a noble (con sha512 configurado)
 */
export async function ed25519Verify(sigAny: any, msgAny: any, pubAny: any): Promise<boolean> {
	const sig = forceU8(sigAny);
	const msg = forceU8(msgAny);
	const pub = forceU8(pubAny);

	// 1) WebCrypto nativo (ideal en Workers)
	try {
		// Algunos runtimes requieren objeto algoritmo como { name: "Ed25519" }
		const algo: any = { name: "Ed25519" };

		const key = await crypto.subtle.importKey(
			"raw",
			toExactArrayBuffer(pub),
			algo,
			false,
			["verify"]
		);

		const ok = await crypto.subtle.verify(
			algo,
			key,
			toExactArrayBuffer(sig),
			toExactArrayBuffer(msg)
		);

		return Boolean(ok);
	} catch (e: any) {
		// Si Ed25519 no está soportado o falla importKey/verify, probamos noble.
		// (No re-lanzamos todavía)
	}

	// 2) Fallback: noble
	ensureEd25519Sha512();
	return ed.verify(sig, msg, pub);
}