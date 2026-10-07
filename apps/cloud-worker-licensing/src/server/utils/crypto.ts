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

/**
 * sha256 (hex) de unos BYTES.
 *
 * La versión de bytes es la primaria y no un extra: el device-proof cubre el cuerpo de la
 * petición, y un cuerpo no siempre es texto — la subida de imágenes manda un JPEG. Hashear un
 * binario después de decodificarlo como UTF-8 da un valor que no se parece en nada al que firmó
 * el cliente (los bytes inválidos se convierten en U+FFFD), y el error que sale es
 * `bad_device_signature`: apunta a la clave cuando el problema estaba en el cuerpo.
 */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	// Copia normalizada: una vista con `byteOffset` no vale para `digest`, que hashearía el
	// buffer entero.
	const copia = new Uint8Array(bytes.byteLength);
	copia.set(bytes);

	const buf = await crypto.subtle.digest("SHA-256", copia.buffer);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexStr(s: string): Promise<string> {
	return sha256HexBytes(new TextEncoder().encode(s));
}
