// test/sesion.test.ts
//
// La traducción de lo que lanza `jose` a los identificadores del catálogo (`lib/errorCodes.ts`).
//
// No es cosmética: `tenantAuth` devuelve el MENSAJE de la excepción como el `error` de la
// respuesta, así que ese identificador ES el contrato de la API y de él sale la frase que lee la
// persona. Sin estas aserciones, una subida de versión de `jose` —que puede cambiar la redacción
// de sus errores, y por eso `verificarSesion` mira `e.code` y no el texto— dejaría saliendo por
// el cable una frase en inglés sin que nada fallara de forma visible.
//
// Hasta ARQ-02 esto lo cubría, de refilón, un HS256 escrito a mano que era su propia definición
// de estos cinco casos.

import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";

import { firmarSesion, leerBearer, leerClaimsSinVerificar, verificarSesion } from "../src/lib/sesion";

const ENV = { LICENSE_JWT_SECRET: "secreto-de-pruebas-no-usar-en-produccion" } as any;
const CLAIMS = { tenantId: "tnt_1", deviceId: "dev_1", licHash: "hash_1" };

/** Un token firmado a mano, para poder fabricar los casos que `firmarSesion` no produce. */
async function firmadoCon(
	secreto: string,
	payload: Record<string, unknown>,
	cabecera: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
	return await new SignJWT(payload as any)
		.setProtectedHeader(cabecera as any)
		.sign(new TextEncoder().encode(secreto));
}

describe("verificarSesion traduce los errores de jose al catálogo", () => {
	it("un token que no tiene forma de JWT", async () => {
		await expect(verificarSesion(ENV, "esto-no-es-un-token")).rejects.toThrow("invalid_jwt");
	});

	it("firmado con otra clave", async () => {
		const token = await firmadoCon("otro-secreto-cualquiera", CLAIMS);
		await expect(verificarSesion(ENV, token)).rejects.toThrow("bad_jwt_signature");
	});

	it("un `alg` que no aceptamos es una firma que no vale", async () => {
		// El verificador anterior ignoraba la cabecera y calculaba HS256 pasara lo que pasara, así
		// que un `alg` ajeno le salía como firma incorrecta. Con `algorithms` pinado, `jose` lo
		// rechaza antes — y se traduce al mismo identificador para no cambiar lo que ve el cliente.
		const token = await firmadoCon(ENV.LICENSE_JWT_SECRET, CLAIMS, { alg: "HS512", typ: "JWT" });
		await expect(verificarSesion(ENV, token)).rejects.toThrow("bad_jwt_signature");
	});

	it("caducado", async () => {
		const token = await firmarSesion(ENV, CLAIMS, { ttlSegundos: -10 });
		await expect(verificarSesion(ENV, token)).rejects.toThrow("jwt_expired");
	});

	it("todavía no es válido (`nbf` en el futuro)", async () => {
		const dentroDeUnaHora = Math.floor(Date.now() / 1000) + 3600;
		const token = await firmadoCon(ENV.LICENSE_JWT_SECRET, { ...CLAIMS, nbf: dentroDeUnaHora });
		await expect(verificarSesion(ENV, token)).rejects.toThrow("jwt_not_active");
	});

	it("bien firmado pero sin los claims: no identifica a nadie", async () => {
		const token = await firmadoCon(ENV.LICENSE_JWT_SECRET, { tenantId: "tnt_1" });
		await expect(verificarSesion(ENV, token)).rejects.toThrow("invalid_token_claims");
	});

	// CFG-03, la regla que `internalAuth.ts` ya aplica al HMAC: el verificador de antes hacía
	// `String(env.LICENSE_JWT_SECRET || "")`, o sea que con la variable ausente aceptaba cualquier
	// token firmado con la clave vacía. Y `tenantAuth` —a diferencia de las rutas de licencia— no
	// pasa por `assertEnv`, así que nada más lo habría parado.
	it("sin secreto no se verifica, y tampoco se firma", async () => {
		const token = await firmarSesion(ENV, CLAIMS);

		for (const roto of [{}, { LICENSE_JWT_SECRET: "" }, { LICENSE_JWT_SECRET: "   " }]) {
			await expect(verificarSesion(roto as any, token)).rejects.toThrow(
				"missing_env_LICENSE_JWT_SECRET",
			);
			await expect(firmarSesion(roto as any, CLAIMS)).rejects.toThrow(
				"missing_env_LICENSE_JWT_SECRET",
			);
		}
	});
});

describe("leerClaimsSinVerificar", () => {
	it("lee un token caducado, que es justo para lo que existe", async () => {
		const token = await firmarSesion(ENV, CLAIMS, { ttlSegundos: -10 });
		expect(leerClaimsSinVerificar(token)).toEqual(CLAIMS);
	});

	it("pero no se inventa claims que no están", async () => {
		expect(leerClaimsSinVerificar("no-es-un-token")).toBeNull();
		expect(leerClaimsSinVerificar(await firmadoCon("da-igual", { tenantId: "tnt_1" }))).toBeNull();
	});
});

describe("leerBearer", () => {
	const con = (h: string | null) =>
		leerBearer(new Request("https://x/y", h === null ? {} : { headers: { authorization: h } }));

	it("acepta el header tal y como lo manda el cliente", () => {
		expect(con("Bearer abc.def.ghi")).toBe("abc.def.ghi");
		expect(con("bearer abc")).toBe("abc");
	});

	it("y devuelve null cuando no hay token, que cada llamante trata a su manera", () => {
		expect(con(null)).toBeNull();
		expect(con("")).toBeNull();
		expect(con("Basic dXNlcjpwYXNz")).toBeNull();
	});
});
