// test/internalAuth.test.ts
//
// CFG-03: la firma interna tiene que fallar CERRANDO si falta el secreto, y por sí misma.
//
// Firmante y verificador hacían `String(secret || "")`. Con el secreto AUSENTE la puerta no llegaba
// a abrirse, pero por accidente: `crypto.subtle.importKey` de workerd rechaza una clave HMAC de
// longitud cero (`DataError`). Con un secreto EN BLANCO —unos espacios que se cuelan al pegarlo en
// `wrangler secret put`— no había accidente que la salvara: es una clave importable y adivinable.

import { describe, it, expect } from "vitest";

import {
	hmacSha256Hex,
	signInternalWorkerRequest,
	verifyInternalWorkerRequest,
} from "../src/lib/internalAuth";

const PATH = "/internal/apply";
const BODY = JSON.stringify({ tenantId: "t-1" });

function peticion(headers: Record<string, string>) {
	return new Request(`https://do${PATH}`, { method: "POST", headers, body: BODY });
}

describe("firma interna (CFG-03)", () => {
	it("no firma con un secreto vacío", async () => {
		await expect(signInternalWorkerRequest("", "POST", PATH, BODY)).rejects.toThrow(
			"internal_secret_missing",
		);
	});

	it("no firma con un secreto de sólo espacios", async () => {
		await expect(signInternalWorkerRequest("   ", "POST", PATH, BODY)).rejects.toThrow(
			"internal_secret_missing",
		);
	});

	it("un verificador sin secreto lo dice, en vez de reventar dentro de importKey", async () => {
		const headers = await signInternalWorkerRequest("secreto-de-prueba", "POST", PATH, BODY);

		await expect(verifyInternalWorkerRequest(peticion(headers), "", BODY)).rejects.toThrow(
			"internal_secret_missing",
		);
	});

	it("un verificador con el secreto en blanco no acepta la firma hecha con esos espacios", async () => {
		// Es la petición que antes PASABA: firmada y verificada con la misma clave de tres espacios.
		const ts = Date.now();
		const sig = await hmacSha256Hex("   ", `${ts}\nPOST\n${PATH}\n${BODY}`);

		await expect(
			verifyInternalWorkerRequest(
				peticion({ "x-internal-ts": String(ts), "x-internal-sig": sig }),
				"   ",
				BODY,
			),
		).rejects.toThrow("internal_secret_missing");
	});

	it("con un secreto de verdad, firmar y verificar sigue funcionando", async () => {
		const headers = await signInternalWorkerRequest("secreto-de-prueba", "POST", PATH, BODY);

		await expect(
			verifyInternalWorkerRequest(peticion(headers), "secreto-de-prueba", BODY),
		).resolves.toBeUndefined();
	});
});
