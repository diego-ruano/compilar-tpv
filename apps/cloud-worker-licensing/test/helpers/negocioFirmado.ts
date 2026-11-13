// test/helpers/negocioFirmado.ts
//
// Un negocio de verdad para pedirle a la `app` entera, como lo hace la Main: su base en su
// TenantHub, su licencia y su dispositivo en la base central, y peticiones firmadas con la clave del
// dispositivo. Es lo que hace falta para probar una ruta por el camino desplegado: el Worker
// autentica, `alHub` le pasa la petición al TenantHub por RPC y la respuesta vuelve por el mismo
// sitio (`lib/enElHub.ts`).
//
// Quien lo usa sustituye `getDb` de `src/server/db` por la base central de pruebas
// (`vi.mock("../src/server/db", …)`) y le da aquí cómo fijarla.

import { env as entorno } from "cloudflare:test";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./clienteSql";
import { ensureEd25519Sha512 } from "./ed25519";
import { enElHub } from "./hub";
import { prepararPlanoDeControl } from "./planoDeControl";
import { bytesToB64 } from "../../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../../src/server/utils/crypto";
import { firmarSesion } from "../../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../../src/lib/licenciaEnUso";

const env = entorno as any;

/** El dispositivo que firma: la Main del negocio. */
export const MAIN = "main-firmada";
const LIC_HASH = "hash-negocio-firmado";

export type Negocio = { tenantId: string; seed: Uint8Array };

/**
 * Da de alta un negocio (su base en el DO `tenantId`, su licencia y su Main en una base central de
 * pruebas) y ejecuta `prueba` con él. `fijarCentral` recibe la base central: es lo que tiene que
 * devolver el `getDb` sustituido.
 */
export async function conNegocioFirmado<R>(
	tenantId: string,
	fijarCentral: (db: unknown) => void,
	prueba: (n: Negocio) => Promise<R>,
): Promise<R> {
	olvidarLicenciasCacheadas();
	await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);

	ensureEd25519Sha512();
	const seed = new Uint8Array(32).fill(7);
	const pub = bytesToB64(await ed.getPublicKeyAsync(seed));
	return enElHub(`central-de-${tenantId}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec("INSERT INTO tenants (tenant_id) VALUES (?);", tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, 'active', 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			`lic-${tenantId}`,
			LIC_HASH,
			tenantId,
			MAIN,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
			 VALUES (?, ?, 'tpv', ?, 'ed25519');`,
			MAIN,
			tenantId,
			pub,
		);
		fijarCentral(clienteSobre(sql));
		return prueba({ tenantId, seed });
	});
}

/** Ejecuta `sembrar` sobre la base del negocio, dentro de su TenantHub. */
export function enLaBaseDe(n: Negocio, sembrar: (sql: any) => void): Promise<void> {
	return enElHub(n.tenantId, (hub: any) => sembrar(hub.state.storage.sql));
}

/** La «ahora» del cliente, como la manda la app: hora local sin zona (en los tests, UTC). */
function ahora(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Una petición POST firmada como la del cliente Rust (`sign_device_proof`), contra la `app` entera.
 * `entorno` pisa variables del de la suite (p. ej. `EJECUTAR_EN_EL_HUB: "0"`).
 */
export async function pedirFirmado(
	app: { request: (ruta: string, init: RequestInit, env: any) => Response | Promise<Response> },
	n: Negocio,
	ruta: string,
	opciones: { cuerpo?: unknown; cabeceras?: Record<string, string>; entorno?: Record<string, unknown> } = {},
): Promise<Response> {
	const token = await firmarSesion(env, { tenantId: n.tenantId, deviceId: MAIN, licHash: LIC_HASH });
	const cuerpo = new TextEncoder().encode(JSON.stringify(opciones.cuerpo ?? {}));
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, "POST", ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), n.seed));
	return app.request(
		ruta,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(ts),
				"X-Device-Sig": firma,
				"X-Client-Now": ahora(),
				"content-type": "application/json",
				...opciones.cabeceras,
			},
			body: cuerpo,
		},
		{ ...env, ...opciones.entorno },
	);
}

/** Cuántos viajes de un tramo cuenta el `Server-Timing` (`hub-ruta;dur=12;desc="1"`). */
export function viajes(res: Response, tramo: string): number {
	const tiempos = res.headers.get("Server-Timing") ?? "";
	const m = new RegExp(`(?:^|, )${tramo};dur=[\\d.]+;desc="(\\d+)"`).exec(tiempos);
	return m ? Number(m[1]) : 0;
}
