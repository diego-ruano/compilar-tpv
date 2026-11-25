// test/handyRenuevaToken.test.ts
//
// El token de una Handy caduca (30 días desde que se emparejó) y hasta ahora NADA lo renovaba:
// `/v1/license/refresh` —el único sitio que reemite un token de sesión— derivaba el estado de la
// licencia con el `deviceId` de quien preguntaba, y una Handy nunca es el `main_device_id`, así que
// siempre le contestaba `device_replaced`. A los 30 días la Handy dejaba de funcionar y había que
// volver a vincularla a mano.
//
// Lo que se fija aquí:
//
//   · una Handy viva renueva su token, y el que recibe es el mismo token con otra fecha;
//   · una Handy revocada NO lo renueva, y se le dice por qué (para que deje de reintentar);
//   · seguir siendo la Main de la licencia sigue siendo obligatorio para quien es una Main;
//   · la licencia del token tiene que ser la de su negocio (AUD-03).
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`), a la que la ruta llega por
// `getDb(env)`.

import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { decodeJwt } from "jose";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { firmarSesion, handyTokenTtlSeconds, verificarSesion } from "../src/lib/sesion";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
};
const TENANT = "tenant-bar";
const LA_MAIN = "equipo-main";
const LA_HANDY = "tablet-1";
const LIC_HASH = "hash-licencia";

async function clave(relleno: number) {
	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(relleno);
	return { seed, pub: bytesToB64(await ed.getPublicKeyAsync(seed)) };
}

/** Un bar con su licencia activada en la Main y una Handy vinculada. */
async function escenario<T>(
	opciones: { pubDeLaHandy: string; handyRevocadaMs?: number },
	prueba: (central: CentralDePrueba) => Promise<T>,
): Promise<T> {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, term_months,
		                       origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email,
		                       created_at_ms, updated_at_ms)
		 VALUES ('lic-1', ?, ?, ?, 'active', 12, 'manual', 1, 1, ?, 'bar@ejemplo.test', 1, 1);`,
		LIC_HASH,
		TENANT,
		LA_MAIN,
		Date.now() + 30 * 24 * 60 * 60 * 1000,
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg, revoked_at_ms)
		 VALUES (?, ?, 'handy', ?, 'ed25519', ?);`,
		LA_HANDY,
		TENANT,
		opciones.pubDeLaHandy,
		opciones.handyRevocadaMs ?? null,
	);
	return prueba(central);
}

/**
 * `POST /refresh` tal y como lo firma el cliente (`sign_device_proof` en Rust). El token que lleva
 * puede estar caducado —es justo el caso— porque `/refresh` lee sus claims sin verificar y lo que
 * autentica de verdad es la firma de la clave privada del equipo.
 */
async function renovar(
	central: CentralDePrueba,
	deviceId: string,
	seed: Uint8Array,
	licHash = LIC_HASH,
): Promise<Response> {
	const token = await firmarSesion(ENV as any, { tenantId: TENANT, deviceId, licHash });
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, "POST", "/refresh", await sha256HexStr(token), await sha256HexBytes(new Uint8Array())].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));

	return licenseRoutes.request(
		"/refresh",
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "X-Device-Ts": String(ts), "X-Device-Sig": firma },
		},
		{ ...ENV, ...central.entorno },
	);
}

describe("una Handy renueva su token", () => {
	it("lo reemite con sus mismas claims: es el de siempre con otra fecha", async () => {
		const { seed, pub } = await clave(3);
		await escenario({ pubDeLaHandy: pub }, async (central) => {
			const res = await renovar(central, LA_HANDY, seed);
			expect(res.status).toBe(200);

			const token = String(((await res.json()) as any).token || "");
			const claims = decodeJwt(token);
			expect(claims.tenantId).toBe(TENANT);
			expect(claims.deviceId).toBe(LA_HANDY);
			expect(claims.licHash).toBe(LIC_HASH);
			// El rol viaja por fidelidad con el token del emparejamiento; quien manda es la fila.
			expect(claims.role).toBe("handy");
			expect(Number(claims.exp)).toBeGreaterThan(Math.floor(Date.now() / 1000));
		});
	});

	it("revocada no renueva, y se le dice cuál es el problema", async () => {
		const { seed, pub } = await clave(3);
		await escenario({ pubDeLaHandy: pub, handyRevocadaMs: Date.now() }, async (central) => {
			const res = await renovar(central, LA_HANDY, seed);
			expect(res.status).toBe(401);
			// `device_revoked` está en el catálogo compartido: el cliente ramifica por él y deja de
			// reintentar en vez de enseñar «Conectando…» para siempre.
			expect(((await res.json()) as any).error).toBe("device_revoked");
		});
	});

	it("sin la firma de su clave registrada no renueva nada", async () => {
		const registrada = await clave(3);
		const otra = await clave(4);
		await escenario({ pubDeLaHandy: registrada.pub }, async (central) => {
			const res = await renovar(central, LA_HANDY, otra.seed);
			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe("bad_device_signature");
		});
	});

	it("a una Main desplazada se le sigue diciendo que lo está", async () => {
		const { seed, pub } = await clave(5);
		await escenario({ pubDeLaHandy: pub }, async (central) => {
			// El mismo equipo, pero dado de alta como `tpv` y sin ser el de la licencia.
			await filasDe(central, `UPDATE devices SET role='tpv' WHERE device_id=?;`, LA_HANDY);

			const res = await renovar(central, LA_HANDY, seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("device_replaced");
		});
	});
});

describe("AUD-03 · la licencia del token tiene que ser la de su negocio", () => {
	// `/refresh` lee los claims sin verificar y el device-proof sólo ata tenant y dispositivo, así que
	// el `licHash` lo elige quien llama. Una Handy de un negocio con la licencia anulada apuntaba a
	// otra fila y salía con un token firmado que se saltaba REV-12 en todas las rutas.

	/** Anula la licencia del bar y da de alta otra fila a la que apuntar. */
	async function otraFila(
		central: CentralDePrueba,
		fila: { id: string; hash: string; tenant: string | null; status: string },
	) {
		await filasDe(central, `UPDATE licenses SET status='revoked', disabled=1 WHERE license_id='lic-1';`);
		await filasDe(
			central,
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, term_months,
			                       origin, issued_at_ms, expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, NULL, ?, 12, 'stripe', 1, ?, 'otro@ejemplo.test', 1, 1);`,
			fila.id,
			fila.hash,
			fila.tenant,
			fila.status,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
	}

	it("no renueva hacia una clave sin estrenar", async () => {
		const { seed, pub } = await clave(3);
		await escenario({ pubDeLaHandy: pub }, async (central) => {
			await otraFila(central, { id: "lic-nueva", hash: "hash-nueva", tenant: null, status: "issued" });

			const res = await renovar(central, LA_HANDY, seed, "hash-nueva");
			expect(res.status).toBe(404);
			const cuerpo = (await res.json()) as any;
			expect(cuerpo.error).toBe("license_not_found");
			expect(cuerpo.token).toBeUndefined();
		});
	});

	it("ni hacia una clave ya canjeada", async () => {
		const { seed, pub } = await clave(3);
		await escenario({ pubDeLaHandy: pub }, async (central) => {
			await otraFila(central, { id: "lic-canjeada", hash: "hash-canjeada", tenant: null, status: "redeemed" });

			const res = await renovar(central, LA_HANDY, seed, "hash-canjeada");
			expect(res.status).toBe(404);
			expect(((await res.json()) as any).error).toBe("license_not_found");
		});
	});

	it("ni hacia la licencia de otro negocio, y sin aserción que hable de ella", async () => {
		const { seed, pub } = await clave(3);
		await escenario({ pubDeLaHandy: pub }, async (central) => {
			await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES ('tenant-otro');`);
			await otraFila(central, { id: "lic-ajena", hash: "hash-ajena", tenant: "tenant-otro", status: "active" });

			const res = await renovar(central, LA_HANDY, seed, "hash-ajena");
			expect(res.status).toBe(404);
			const cuerpo = (await res.json()) as any;
			expect(cuerpo.error).toBe("license_not_found");
			expect(cuerpo.token).toBeUndefined();
			expect(cuerpo.assertion).toBeUndefined();
		});
	});
});

describe("el token de sesión: quien lo firma y quien lo verifica", () => {
	// Son la MISMA pieza (`lib/sesion.ts`, ARQ-02). Lo fueron dos: se firmaba con `jose` y se
	// verificaba con un HS256 escrito a mano, el que `tenantAuth` usaba para dejar entrar a la
	// Handy. Unificado el emisor —para que renovar el token devuelva el MISMO token con otra
	// fecha—, esa pareja sostenía el acceso de todas las Handy y sólo la ataba este test.
	it("lo que firma el worker lo acepta el worker, con rol y sin él", async () => {
		const claims = { tenantId: TENANT, deviceId: LA_HANDY, licHash: LIC_HASH };

		expect(await verificarSesion(ENV as any, await firmarSesion(ENV as any, claims))).toEqual(claims);

		const conRol = await firmarSesion(ENV as any, claims, { rol: "handy", ttlSegundos: 3600 });
		expect(await verificarSesion(ENV as any, conRol)).toEqual(claims);

		// El `rol` viaja en el payload por fidelidad con el token que emitía el emparejamiento,
		// pero el verificador NO lo devuelve: autorizar por un claim del token daría privilegios
		// que la BD central no ha concedido. Se mira el payload crudo, no lo que sale del gate.
		const payload = decodeJwt(conRol);
		expect(payload.role).toBe("handy");
		expect(Number(payload.exp) - Number(payload.iat)).toBe(3600);
		expect(decodeJwt(await firmarSesion(ENV as any, claims)).role).toBeUndefined();
	});

	it("un token caducado lo rechaza como tal: es el muro que la renovación evita", async () => {
		const token = await firmarSesion(
			ENV as any,
			{ tenantId: TENANT, deviceId: LA_HANDY, licHash: LIC_HASH },
			{ rol: "handy", ttlSegundos: -10 },
		);
		await expect(verificarSesion(ENV as any, token)).rejects.toThrow("jwt_expired");
	});

	it("el TTL de la Handy sale de la configuración, con un suelo contra un valor absurdo", () => {
		const TREINTA_DIAS = 30 * 24 * 60 * 60;
		expect(handyTokenTtlSeconds({} as any)).toBe(TREINTA_DIAS);
		expect(handyTokenTtlSeconds({ HANDY_TOKEN_TTL_SECONDS: "7200" } as any)).toBe(7200);
		// Segundos sueltos dejarían a las Handy renovando en bucle: se ignora y manda el defecto.
		expect(handyTokenTtlSeconds({ HANDY_TOKEN_TTL_SECONDS: 60 } as any)).toBe(TREINTA_DIAS);
		expect(handyTokenTtlSeconds({ HANDY_TOKEN_TTL_SECONDS: "lo-que-sea" } as any)).toBe(TREINTA_DIAS);
	});
});
