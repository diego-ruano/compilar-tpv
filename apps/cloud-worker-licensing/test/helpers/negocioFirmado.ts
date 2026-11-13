// test/helpers/negocioFirmado.ts
//
// Un negocio entero para probar por el camino de verdad: su base en su TenantHub, y en la base
// central (el SQLite de otro Durable Object de pruebas) su licencia, su Main y una Handy, cada una
// con su clave. Las peticiones salen firmadas como las del cliente Rust (`sign_device_proof`).
//
// El test pone el doble de la base central (`vi.mock("../src/server/db")` es de cada fichero) y
// pasa aquí cómo cambiarlo, además de la firma de sesión, que tiene que cargarse después del doble.

import { env as entorno } from "cloudflare:test";
import * as ed from "@noble/ed25519";

import { clienteSobre } from "./clienteSql";
import { ensureEd25519Sha512 } from "./ed25519";
import { enElHub } from "./hub";
import { prepararPlanoDeControl } from "./planoDeControl";
import { bytesToB64 } from "../../src/server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../../src/server/utils/crypto";

const env = entorno as any;

export const MAIN = "main-firmada";
export const HANDY = "handy-firmada";
const LIC_HASH = "hash-negocio-firmado";

const SEMILLAS: Record<string, Uint8Array> = {
	[MAIN]: new Uint8Array(32).fill(21),
	[HANDY]: new Uint8Array(32).fill(22),
};

export type Negocio = {
	tenantId: string;
	/** Lo que se le ha pedido a la base central, en orden. */
	central: string[];
	/** Ejecuta SQL en la base central, sin que cuente como consulta del worker. */
	enCentral: (sql: string, ...args: unknown[]) => void;
};

export type Dependencias = {
	/** Cambia la base central que devuelve el doble de `getDb` del test. */
	ponerCentral: (db: unknown) => void;
	firmarSesion: (env: any, claims: { tenantId: string; deviceId: string; licHash: string }) => Promise<string>;
	olvidarLicenciasCacheadas: () => void;
};

/**
 * Monta el negocio `nombre` (con licencia en vigor y, salvo `sinBase`, aprovisionado) y corre
 * `prueba` con él.
 */
export async function conNegocioFirmado<R>(
	deps: Dependencias,
	nombre: string,
	prueba: (n: Negocio) => Promise<R>,
	opciones: { sinBase?: boolean } = {},
): Promise<R> {
	deps.olvidarLicenciasCacheadas();
	const tenantId = `negocio-firmado-${nombre}`;
	if (!opciones.sinBase) await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);

	ensureEd25519Sha512();
	return enElHub(`negocio-firmado-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, tenantId);
		sql.exec(
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status,
			                       disabled, term_months, origin, issued_at_ms, activated_at_ms,
			                       expires_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, ?, 'active', 0, 12, 'manual', 1, 1, ?, 'bar@a.test', 1, 1);`,
			`lic-${nombre}`,
			LIC_HASH,
			tenantId,
			MAIN,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);
		for (const [deviceId, rol] of [[MAIN, "tpv"], [HANDY, "handy"]] as const) {
			sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg)
				 VALUES (?, ?, ?, ?, 'ed25519');`,
				deviceId,
				tenantId,
				rol,
				bytesToB64(await ed.getPublicKeyAsync(SEMILLAS[deviceId])),
			);
		}

		const central: string[] = [];
		const real = clienteSobre(sql);
		deps.ponerCentral({
			...real,
			execute: async (entrada: any) => {
				central.push(String(typeof entrada === "string" ? entrada : entrada.sql).replace(/\s+/g, " ").trim());
				return real.execute(entrada);
			},
		});
		try {
			return await prueba({ tenantId, central, enCentral: (texto, ...args) => void sql.exec(texto, ...args) });
		} finally {
			deps.ponerCentral(null);
		}
	});
}

/** La «ahora» del cliente, como la manda la app: hora local sin zona (en los tests, UTC). */
function ahora(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Una petición firmada por `deviceId` (`MAIN` o `HANDY`), lista para `app.request` o para el
 * `fetch` del worker. `cuerpo` se manda como JSON; sin él, la petición va sin cuerpo.
 */
export async function peticionFirmada(
	deps: Pick<Dependencias, "firmarSesion">,
	n: Negocio,
	deviceId: string,
	metodo: string,
	ruta: string,
	opciones: { cuerpo?: unknown; cabeceras?: Record<string, string> } = {},
): Promise<Request> {
	const token = await deps.firmarSesion(env, { tenantId: n.tenantId, deviceId, licHash: LIC_HASH });
	const cuerpo = opciones.cuerpo === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opciones.cuerpo));
	const ts = Date.now();
	const mensaje = ["DEVICE_PROOF", ts, metodo, ruta, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
	const firma = bytesToB64(await ed.signAsync(new TextEncoder().encode(mensaje), SEMILLAS[deviceId]));
	return new Request(`https://tpv-api.test${ruta}`, {
		method: metodo,
		headers: {
			authorization: `Bearer ${token}`,
			"X-Device-Ts": String(ts),
			"X-Device-Sig": firma,
			"X-Client-Now": ahora(),
			...(metodo === "GET" ? {} : { "X-Idempotency-Key": crypto.randomUUID() }),
			...(opciones.cuerpo === undefined ? {} : { "content-type": "application/json" }),
			...opciones.cabeceras,
		},
		...(opciones.cuerpo === undefined ? {} : { body: cuerpo }),
	});
}

/** Cuántos viajes de un tramo cuenta el `Server-Timing` (`hub-ruta;dur=12;desc="1"`). */
export function viajes(respuesta: Response, tramo: string): number {
	const tiempos = respuesta.headers.get("Server-Timing") ?? "";
	const m = new RegExp(`(?:^|, )${tramo};dur=[\\d.]+;desc="(\\d+)"`).exec(tiempos);
	return m ? Number(m[1]) : 0;
}
