// test/deviceProofCuerpo.test.ts
//
// FABLE-E: la firma del dispositivo cubre el CUERPO de la petición. El cliente (Rust,
// `device.rs::device_proof_message`) firma el sha256 de los **bytes exactos** que envía, así que
// el worker tiene que hashear esos mismos bytes.
//
// El fallo que motiva estos tests: el worker leía el cuerpo con `text()`, que lo decodifica como
// UTF-8. Con JSON da igual (es UTF-8 válido y el viaje es de ida y vuelta), pero la subida de
// imágenes manda un JPEG: sus bytes no son UTF-8, el decodificador los sustituye por U+FFFD y el
// hash resultante no se parece en nada al que firmó el cliente. Resultado: TODA subida de imagen
// moría con `verify_failed: bad_device_signature` — un error que apunta a la clave cuando el
// problema estaba en el cuerpo.

import { describe, it, expect } from "vitest";

import { verifyDeviceProofOrThrow } from "../src/server/middleware/auth";
import { bytesToB64 } from "../src/server/utils/base64";

const TOKEN = "token-de-prueba";
const CLAIMS_BASE = { tenantId: "t-proof" };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copia = new Uint8Array(bytes.byteLength);
	copia.set(bytes);
	const buf = await crypto.subtle.digest("SHA-256", copia.buffer);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Par de claves ed25519 del "dispositivo". */
async function dispositivo() {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;

	const raw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
	);

	return {
		pubB64: bytesToB64(raw),
		async firmar(msg: string): Promise<string> {
			const sig = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "Ed25519" } as any,
					kp.privateKey,
					new TextEncoder().encode(msg),
				),
			);
			return bytesToB64(sig);
		},
	};
}

/** El mensaje EXACTO que firma el cliente (`device_proof_message` en Rust). */
async function mensajeProof(
	ts: number,
	method: string,
	path: string,
	body: Uint8Array,
): Promise<string> {
	return [
		ts,
		method.toUpperCase(),
		path,
		await sha256Hex(new TextEncoder().encode(TOKEN)),
		await sha256Hex(body),
	].join("\n");
}

/** BD central de mentira: el dispositivo existe, vivo, con esa pubkey. */
function bdCon(pubB64: string) {
	return {
		execute: async () => ({
			rows: [{ role: "tpv", revoked_at_ms: null, device_pubkey_b64: pubB64 }],
		}),
	} as any;
}

/** Monta la petición firmada tal y como la manda el cliente y la pasa por el verificador. */
async function verificar(
	deviceId: string,
	method: string,
	url: string,
	body: Uint8Array,
	contentType: string,
) {
	const disp = await dispositivo();
	const ts = Date.now();
	const path = new URL(url).pathname;

	const sigB64 = await disp.firmar(await mensajeProof(ts, method, path, body));

	const copia = new Uint8Array(body.byteLength);
	copia.set(body);

	const req = new Request(url, {
		method,
		headers: {
			"content-type": contentType,
			"X-Device-Ts": String(ts),
			"X-Device-Sig": sigB64,
		},
		body: copia,
	});

	// El worker lee el cuerpo por su cuenta (como hacen `tenantAuth` y `buildTenantContext`) y se
	// lo pasa al verificador. Aquí se reproduce ese paso.
	const bytes = new Uint8Array(await req.clone().arrayBuffer());

	await verifyDeviceProofOrThrow(
		req,
		bdCon(disp.pubB64),
		{ ...CLAIMS_BASE, deviceId },
		TOKEN,
		bytes,
	);
}

describe("el cuerpo firmado son los bytes que se envían", () => {
	it("un JSON firma y verifica", async () => {
		const body = new TextEncoder().encode(JSON.stringify({ hola: "qué tal", n: 3 }));

		await expect(
			verificar("d-json", "POST", "https://api.test/v1/pair/create", body, "application/json"),
		).resolves.toBeUndefined();
	});

	it("un JPEG también, aunque sus bytes no sean texto", async () => {
		// Cabecera JFIF real + bytes altos: 0xFF 0xD8 0xFF 0xE0 no es UTF-8 válido, así que
		// leerlo como texto lo convierte en U+FFFD y el hash deja de cuadrar. Esto es lo que
		// rompía la subida del logo y de cualquier foto de producto.
		const body = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
			0x80, 0x81, 0xfe, 0xff, 0x00, 0xc0, 0xaf, 0x7f, 0xd9,
		]);

		await expect(
			verificar(
				"d-jpeg",
				"PUT",
				"https://api.test/v1/images/images/logo/abc.jpg",
				body,
				"image/jpeg",
			),
		).resolves.toBeUndefined();
	});

	it("cambiar un byte del cuerpo invalida la firma", async () => {
		// La otra mitad del contrato: si el hash del cuerpo no entrara en la firma, esto pasaría.
		const disp = await dispositivo();
		const ts = Date.now();
		const path = "/v1/images/images/logo/abc.jpg";
		const firmado = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
		const enviado = new Uint8Array([0xff, 0xd8, 0xff, 0xe1]);

		const sigB64 = await disp.firmar(await mensajeProof(ts, "PUT", path, firmado));

		const req = new Request(`https://api.test${path}`, {
			method: "PUT",
			headers: { "X-Device-Ts": String(ts), "X-Device-Sig": sigB64 },
			body: enviado,
		});

		await expect(
			verifyDeviceProofOrThrow(
				req,
				bdCon(disp.pubB64),
				{ ...CLAIMS_BASE, deviceId: "d-manipulado" },
				TOKEN,
				enviado,
			),
		).rejects.toThrow("bad_device_signature");
	});
});
