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

import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { licenseRoutes } from "../src/domains/licensing/licensing.routes";
import { firmarSesion } from "../src/lib/sesion";
import { ensureEd25519Sha512 } from "./helpers/ed25519";
import { bytesToB64 } from "../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../src/server/utils/crypto";
import { licenseAssertionMessage } from "../src/domains/licensing/licensing.helpers";

const ENV = {
	LICENSE_JWT_SECRET: "secreto-de-pruebas",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
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
 * Handy: lo que deja haberlo vinculado allí. En una base central propia.
 */
async function escenario<T>(
	opciones: { mainDeLaLicencia: string; pubRegistrada: string; estado?: string; rol?: string; tenantDelEquipo?: string },
	prueba: (central: CentralDePrueba) => Promise<T>,
): Promise<T> {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id) VALUES (?), (?);`, BAR_A, BAR_B);
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, term_months,
		                       origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email,
		                       created_at_ms, updated_at_ms)
		 VALUES ('lic-a', ?, ?, ?, ?, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
		LIC_HASH,
		BAR_A,
		opciones.mainDeLaLicencia,
		opciones.estado ?? "active",
		Date.now() + 30 * 24 * 60 * 60 * 1000,
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
		 VALUES (?, ?, ?, ?, 'ed25519');`,
		EQUIPO,
		opciones.tenantDelEquipo ?? BAR_B,
		opciones.rol ?? "handy",
		opciones.pubRegistrada,
	);
	return prueba(central);
}

/** Una petición como la que firma el cliente Rust (`sign_device_proof`), con la central `central`. */
async function pedir(
	central: CentralDePrueba,
	metodo: "GET" | "POST",
	ruta: string,
	seed: Uint8Array,
): Promise<Response> {
	const token = await firmarSesion(ENV as any, { tenantId: BAR_A, deviceId: EQUIPO, licHash: LIC_HASH });
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, metodo, ruta, await sha256HexStr(token), await sha256HexBytes(new Uint8Array())].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), seed));

	return licenseRoutes.request(
		ruta,
		{
			method: metodo,
			headers: { authorization: `Bearer ${token}`, "X-Device-Ts": String(ts), "X-Device-Sig": firma },
		},
		{ ...ENV, ...central.entorno },
	);
}

async function fila(central: CentralDePrueba) {
	const [f] = await filasDe(central, `SELECT tenant_id, role FROM devices WHERE device_id = ?;`, EQUIPO);
	return f;
}

describe("una Main que vuelve después de haber sido Handy de otro negocio", () => {
	it("si sigue siendo la Main de su licencia, la nube la vuelve a dar de alta sola", async () => {
		const { seed, pub } = await clave(1);
		await escenario({ mainDeLaLicencia: EQUIPO, pubRegistrada: pub }, async (central) => {
			const res = await pedir(central, "GET", "/status", seed);
			expect(res.status).toBe(200);
			expect(await fila(central)).toEqual({ tenant_id: BAR_A, role: "tpv" });
		});
	});

	it("también al renovar el token", async () => {
		const { seed, pub } = await clave(1);
		await escenario({ mainDeLaLicencia: EQUIPO, pubRegistrada: pub }, async (central) => {
			expect((await pedir(central, "POST", "/refresh", seed)).status).toBe(200);
			expect(await fila(central)).toEqual({ tenant_id: BAR_A, role: "tpv" });
		});
	});

	it("si la licencia está en otro equipo, se le dice en el acto y no se toca nada", async () => {
		const { seed, pub } = await clave(1);
		await escenario({ mainDeLaLicencia: "otro-equipo", pubRegistrada: pub }, async (central) => {
			const res = await pedir(central, "GET", "/status", seed);
			expect(res.status).toBe(403);
			expect(((await res.json()) as any).error).toBe("device_replaced");
			expect(await fila(central)).toEqual({ tenant_id: BAR_B, role: "handy" });
		});
	});

	it("sin la firma de la clave registrada no se readmite nada", async () => {
		const registrada = await clave(1);
		const otra = await clave(2);
		await escenario({ mainDeLaLicencia: EQUIPO, pubRegistrada: registrada.pub }, async (central) => {
			const res = await pedir(central, "GET", "/status", otra.seed);
			expect(res.status).toBe(401);
			expect(((await res.json()) as any).error).toBe("bad_device_signature");
			expect(await fila(central)).toEqual({ tenant_id: BAR_B, role: "handy" });
		});
	});
});

/**
 * RI-09: el cliente ya no se cree un rechazo sin firmar (lo trata como no haber podido preguntar).
 * Los que vienen de una licencia que existe —traslado o anulación— llevan la aserción firmada, como
 * `/status`, para que un equipo que pasa por aquí (token caducado, o readmisión) quede bloqueado en
 * el acto y con el motivo bueno.
 */
describe("RI-09 · los rechazos de una licencia que existe van firmados", () => {
	/** La aserción del cuerpo, comprobada contra la pública de `LICENSE_SIGNING_PRIVATE_KEY`. */
	async function asercionVerificada(res: Response, tsEnviado: number) {
		const cuerpo = (await res.json()) as any;
		const a = cuerpo.assertion;
		expect(a).toBeTruthy();
		const pub = await ed.getPublicKeyAsync(new Uint8Array(32).fill(9));
		const { sig, ...campos } = a;
		const mensaje = new TextEncoder().encode(licenseAssertionMessage(campos));
		const firma = Uint8Array.from(atob(sig), (ch) => ch.charCodeAt(0));
		expect(await ed.verifyAsync(firma, mensaje, pub)).toBe(true);
		expect(a.clientTs).toBe(tsEnviado);
		return { cuerpo, a };
	}

	it("el traslado detectado al readmitir lleva la aserción device_replaced", async () => {
		const { seed, pub } = await clave(1);
		await escenario({ mainDeLaLicencia: "otro-equipo", pubRegistrada: pub }, async (central) => {
			const { res, ts } = await pedirConHora(central, "GET", "/status", seed);
			expect(res.status).toBe(403);
			const { cuerpo, a } = await asercionVerificada(res, ts);
			expect(cuerpo.error).toBe("device_replaced");
			expect(a.state).toBe("device_replaced");
		});
	});

	it("una licencia anulada contesta en /refresh con la aserción revoked", async () => {
		const { seed, pub } = await clave(1);
		await escenario(
			{ mainDeLaLicencia: EQUIPO, pubRegistrada: pub, estado: "revoked", rol: "tpv", tenantDelEquipo: BAR_A },
			async (central) => {
				const { res, ts } = await pedirConHora(central, "POST", "/refresh", seed);
				expect(res.status).toBe(403);
				const { cuerpo, a } = await asercionVerificada(res, ts);
				expect(cuerpo.error).toBe("license_revoked");
				expect(a.state).toBe("revoked");
			},
		);
	});

	it("la licencia trasladada a otro equipo contesta en /refresh con la aserción device_replaced", async () => {
		const { seed, pub } = await clave(1);
		await escenario(
			{ mainDeLaLicencia: "otro-equipo", pubRegistrada: pub, rol: "tpv", tenantDelEquipo: BAR_A },
			async (central) => {
				const { res, ts } = await pedirConHora(central, "POST", "/refresh", seed);
				expect(res.status).toBe(403);
				const { a } = await asercionVerificada(res, ts);
				expect(a.state).toBe("device_replaced");
			},
		);
	});
});

/** `pedir`, devolviendo también la hora firmada (la aserción va ligada a ella). */
async function pedirConHora(central: CentralDePrueba, metodo: "GET" | "POST", ruta: string, seed: Uint8Array) {
	const antes = Date.now();
	const res = await pedir(central, metodo, ruta, seed);
	// `pedir` firma con `Date.now()`: con el reloj real hay que leerla de la aserción, pero tiene que
	// caer entre antes y ahora.
	const clon = res.clone();
	const ts = ((await clon.json()) as any)?.assertion?.clientTs ?? -1;
	expect(ts).toBeGreaterThanOrEqual(antes);
	expect(ts).toBeLessThanOrEqual(Date.now());
	return { res, ts };
}
