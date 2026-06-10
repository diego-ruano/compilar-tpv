// shared/lib/deviceFingerprint.ts
//
// Huella corta y estable de la clave pública (ed25519, base64) de un dispositivo.
//
// Sirve para que el operador del Main pueda **comparar visualmente** el dispositivo que va a
// aprobar (lista de solicitudes) con el que muestra el propio Handy. Es la red de seguridad de
// la ruta de "solo código" (sin QR/secret): la aprobación deja de ser a ciegas.
//
// Se hashea SIEMPRE sobre los bytes decodificados (no sobre la cadena base64), para que la
// huella coincida en ambos lados aunque la codificación base64 difiera (estándar vs url-safe,
// padding, etc.).

function b64ToBytes(b64: string): Uint8Array {
	let s = String(b64 || "").trim();
	s = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
	const mod = s.length % 4;
	if (mod === 2) s += "==";
	else if (mod === 3) s += "=";

	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * Devuelve una huella legible tipo `1A2B-3C4D-5E6F` (48 bits de SHA-256 del pubkey).
 * Cadena vacía si el pubkey no es válido.
 */
export async function deviceFingerprint(pubkeyB64: string): Promise<string> {
	const raw = String(pubkeyB64 || "").trim();
	if (!raw) return "";

	try {
		const bytes = b64ToBytes(raw);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		const hex = Array.from(new Uint8Array(digest).slice(0, 6))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.toUpperCase();

		return hex.replace(/(.{4})(?=.)/g, "$1-"); // 1A2B-3C4D-5E6F
	} catch {
		return "";
	}
}
