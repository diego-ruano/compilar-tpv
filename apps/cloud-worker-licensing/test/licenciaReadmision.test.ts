// test/licenciaReadmision.test.ts
//
// Un equipo que fue la Main de un negocio, se usó un tiempo como Handy de otro y vuelve a modo TPV.
//
// La identidad del equipo es una sola, así que al vincularse como Handy su fila de `devices` pasó
// al otro negocio. Al volver, `/v1/license/status` no lo encontraba en el suyo: contestaba
// `device_pubkey_not_registered`, el cliente lo tomaba por falta de red y tiraba de la gracia sin
// conexión hasta bloquearse, sin decir por qué. Lo que se fija aquí:
//
//   · si sigue siendo la Main de su licencia, la nube lo vuelve a dar de alta sola;
//   · si la licencia ya está en otro equipo, se le dice `device_replaced` en el acto;
//   · nada de eso ocurre sin la firma de la clave que ese equipo tiene registrada.

import { describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { signToken } from "../src/domains/licensing/licensing.helpers";
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
const EQUIPO = "equipo-1";
const BAR_A = "tenant-bar-a";
const BAR_B = "tenant-bar-b";
const LIC_HASH = "hash-licencia-bar-a";

async function clave(relleno: number) {
	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(relleno);
	return { seed, pub: bytesToB64(await ed.getPublicKeyAsync(seed)) };
}

/**
 * El bar A con su licencia, cuya Main es `mainDeLaLicencia`, y la fila de `EQUIPO` en el bar B como
 * Handy: lo que deja haberlo vinculado allí.
 */
async function escenario<T>(
	nombre: string,
	opciones: { mainDeLaLicencia: string; pubRegistrada: string },
	prueba: (sql: any) => Promise<T>,
): Promise<T> {
	return enElHub(`readmision-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["devices", "licenses", "tenants"]) sql.exec(`DELETE FROM ${tabla};`);
		dbDePruebas = clienteSobre(sql);

		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?), (?);`, BAR_A, BAR_B);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, term_months,
			                       origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email,
			                       created_at_ms, updated_at_ms)
			 VALUES ('lic-a', ?, ?, ?, 'active', 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			LIC_HASH,
			BAR_A,
			opciones.mainDeLaLicencia,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, 'handy', ?, 'ed25519');`,
			EQUIPO,
			BAR_B,
			opciones.pubRegistrada,
		);
		return prueba(sql);
	});
}

/** Una petición como la que firma el cliente Rust (`sign_device_proof`). */
async function pedir(metodo: "GET" | "POST", ruta: string, seed: Uint8Array): Promise<Response> {
	const token = await signToken(ENV as any, { tenantId: BAR_A, deviceId: EQUIPO, licHash: LIC_HASH });
	const ts = Date.now();
	const mensaje = [ts, metodo, ruta, await sha256HexStr(token), await sha256HexBytes(new Uint8Array())].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));

	return licenseRoutes.request(
		ruta,
		{
			method: metodo,
			headers: { authorization: `Bearer ${token}`, "X-Device-Ts": String(ts), "X-Device-Sig": firma },
		},
		ENV,
	);
}

function fila(sql: any) {
	return sql.exec(`SELECT tenant_id, role FROM devices WHERE device_id = ?;`, EQUIPO).toArray()[0];
}

describe("una Main que vuelve después de haber sido Handy de otro negocio", () => {
	it("si sigue siendo la Main de su licencia, la nube la vuelve a dar de alta sola", async () => {
		const { seed, pub } = await clave(1);
		await escenario("vuelve", { mainDeLaLicencia: EQUIPO, pubRegistrada: pub }, async (sql) => {
			const res = await pedir("GET", "/status", seed);
			expect(res.status).toBe(200);
			expect(fila(sql)).toEqual({ tenant_id: BAR_A, role: "tpv" });
		});
	});

	it("también al renovar el token", async () => {
		const { seed, pub } = await clave(1);
		await escenario("refresh", { mainDeLaLicencia: EQUIPO, pubRegistrada: pub }, async (sql) => {
			expect((await pedir("POST", "/refresh", seed)).status).toBe(200);
			expect(fila(sql)).toEqual({ tenant_id: BAR_A, role: "tpv" });
		});
	});

	it("si la licencia está en otro equipo, se le dice en el acto y no se toca nada", async () => {
		const { seed, pub } = await clave(1);
		await escenario("desplazada", { mainDeLaLicencia: "otro-equipo", pubRegistrada: pub }, async (sql) => {
			const res = await pedir("GET", "/status", seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("device_replaced");
			expect(fila(sql)).toEqual({ tenant_id: BAR_B, role: "handy" });
		});
	});

	it("sin la firma de la clave registrada no se readmite nada", async () => {
		const registrada = await clave(1);
		const otra = await clave(2);
		await escenario("otra-clave", { mainDeLaLicencia: EQUIPO, pubRegistrada: registrada.pub }, async (sql) => {
			const res = await pedir("GET", "/status", otra.seed);
			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe("bad_device_signature");
			expect(fila(sql)).toEqual({ tenant_id: BAR_B, role: "handy" });
		});
	});
});
