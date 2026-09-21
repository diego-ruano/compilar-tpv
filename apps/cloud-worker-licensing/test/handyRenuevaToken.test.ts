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
//   · seguir siendo la Main de la licencia sigue siendo obligatorio para quien es una Main.

import { describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { decodeJwt } from "jose";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { firmarSesion, handyTokenTtlSeconds, verificarSesion } from "../src/lib/sesion";
import { ensureEd25519Sha512 } from "../src/server/utils/nobleEd25519";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
	TURSO_DATABASE_URL: "libsql://no-se-usa",
	TURSO_AUTH_TOKEN: "no-se-usa",
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
	nombre: string,
	opciones: { pubDeLaHandy: string; handyRevocadaMs?: number },
	prueba: (sql: any) => Promise<T>,
): Promise<T> {
	return enElHub(`handy-renueva-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["devices", "licenses", "tenants"]) sql.exec(`DELETE FROM ${tabla};`);
		dbDePruebas = clienteSobre(sql);

		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, term_months,
			                       origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email,
			                       created_at_ms, updated_at_ms)
			 VALUES ('lic-1', ?, ?, ?, 'active', 12, 'manual', 1, 1, ?, 'bar@ejemplo.test', 1, 1);`,
			LIC_HASH,
			TENANT,
			LA_MAIN,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg, revoked_at_ms)
			 VALUES (?, ?, 'handy', ?, 'ed25519', ?);`,
			LA_HANDY,
			TENANT,
			opciones.pubDeLaHandy,
			opciones.handyRevocadaMs ?? null,
		);
		return prueba(sql);
	});
}

/**
 * `POST /refresh` tal y como lo firma el cliente (`sign_device_proof` en Rust). El token que lleva
 * puede estar caducado —es justo el caso— porque `/refresh` lee sus claims sin verificar y lo que
 * autentica de verdad es la firma de la clave privada del equipo.
 */
async function renovar(deviceId: string, seed: Uint8Array): Promise<Response> {
	const token = await firmarSesion(ENV as any, { tenantId: TENANT, deviceId, licHash: LIC_HASH });
	const ts = Date.now();
	const mensaje = [ts, "POST", "/refresh", await sha256HexStr(token), await sha256HexBytes(new Uint8Array())].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));

	return licenseRoutes.request(
		"/refresh",
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "X-Device-Ts": String(ts), "X-Device-Sig": firma },
		},
		ENV,
	);
}

describe("una Handy renueva su token", () => {
	it("lo reemite con sus mismas claims: es el de siempre con otra fecha", async () => {
		const { seed, pub } = await clave(3);
		await escenario("viva", { pubDeLaHandy: pub }, async () => {
			const res = await renovar(LA_HANDY, seed);
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
		await escenario("revocada", { pubDeLaHandy: pub, handyRevocadaMs: Date.now() }, async () => {
			const res = await renovar(LA_HANDY, seed);
			expect(res.status).toBe(401);
			// `device_revoked` está en el catálogo compartido: el cliente ramifica por él y deja de
			// reintentar en vez de enseñar «Conectando…» para siempre.
			expect(((await res.json()) as any).error).toBe("device_revoked");
		});
	});

	it("sin la firma de su clave registrada no renueva nada", async () => {
		const registrada = await clave(3);
		const otra = await clave(4);
		await escenario("otra-clave", { pubDeLaHandy: registrada.pub }, async () => {
			const res = await renovar(LA_HANDY, otra.seed);
			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe("bad_device_signature");
		});
	});

	it("a una Main desplazada se le sigue diciendo que lo está", async () => {
		const { seed, pub } = await clave(5);
		await escenario("main-desplazada", { pubDeLaHandy: pub }, async (sql) => {
			// El mismo equipo, pero dado de alta como `tpv` y sin ser el de la licencia.
			sql.exec(`UPDATE devices SET role='tpv' WHERE device_id=?;`, LA_HANDY);

			const res = await renovar(LA_HANDY, seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("device_replaced");
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
