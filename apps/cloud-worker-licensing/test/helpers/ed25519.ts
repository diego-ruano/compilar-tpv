// El firmante de las pruebas es independiente de la implementación nativa de producción.
import * as ed from "@noble/ed25519";
export function ensureEd25519Sha512(): void {
	ed.hashes.sha512Async = async (msg: Uint8Array) => {
		const bytes = new Uint8Array(msg.byteLength);
		bytes.set(msg);
		return new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
	};
}
