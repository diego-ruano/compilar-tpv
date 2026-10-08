/** RI-44: una única implementación Ed25519, la nativa del runtime de Workers. */
export function bytesExactos(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
	const source = ArrayBuffer.isView(value)
		? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
		: new Uint8Array(value);
	const result = new Uint8Array(source.byteLength);
	result.set(source);
	return result;
}

export async function ed25519Verify(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): Promise<boolean> {
	if (pub.byteLength !== 32 || sig.byteLength !== 64) return false;
	const key = await crypto.subtle.importKey("raw", bytesExactos(pub), "Ed25519", false, ["verify"]);
	return crypto.subtle.verify("Ed25519", key, bytesExactos(sig), bytesExactos(msg));
}

/** La configuración guarda una semilla de 32 bytes; PKCS#8 la envuelve sin cambiar la clave. */
export async function ed25519Sign(msg: Uint8Array, seed: Uint8Array): Promise<Uint8Array> {
	if (seed.byteLength !== 32) throw new Error("LICENSE_SIGNING_PRIVATE_KEY must decode to 32 bytes");
	const pkcs8 = new Uint8Array(48);
	pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
	pkcs8.set(seed, 16);
	const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytesExactos(msg)));
}
