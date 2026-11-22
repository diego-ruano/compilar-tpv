// test/helpers/negocioFirmado.ts
//
// Un negocio entero para probar por el camino de verdad: su base en su TenantHub, y en la base
// central (el SQLite de otro Durable Object de pruebas) su licencia, su Main y una Handy, cada una
// con su clave. Las peticiones salen firmadas como las del cliente Rust (`sign_device_proof`).
//
// El test pone el doble de la base central (`vi.mock("../src/server/db")` es de cada fichero) y
// pasa aquí cómo cambiarlo, además de la firma de sesión, que tiene que cargarse después del doble.
//
// La base central de pruebas es el SQLite de un Durable Object, y sólo se puede tocar desde él. Por
// defecto es uno aparte: vale para lo que lee la base central en el Worker (`tenantAuth`), y una
// ruta que se ejecuta dentro del TenantHub del negocio no la alcanza (el rol, que es lo único que
// necesitaba de ella, le llega con la identidad). Con `centralEnElNegocio`, las tablas de la central
// van en el SQLite del propio TenantHub del negocio: así también la lee una ruta que corre dentro de
// él y la necesita de verdad (el cupo y la traza de un correo, la clave del widget).

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
 *
 * `prueba` corre dentro del Durable Object que guarda la base central de pruebas y recibe su motor:
 * uno aparte o, con `centralEnElNegocio`, el TenantHub del propio negocio.
 */
export async function conNegocioFirmado<R>(
	deps: Dependencias,
	nombre: string,
	prueba: (n: Negocio, hub: any) => Promise<R>,
	opciones: { sinBase?: boolean; centralEnElNegocio?: boolean } = {},
): Promise<R> {
	deps.olvidarLicenciasCacheadas();
	const tenantId = `negocio-firmado-${nombre}`;
	if (!opciones.sinBase) await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);

	ensureEd25519Sha512();
	const dondeLaCentral = opciones.centralEnElNegocio ? tenantId : `negocio-firmado-central-${nombre}`;
	return enElHub(dondeLaCentral, async (hub: any) => {
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
		const real = clienteSobre(sql, hub.state.storage);
		deps.ponerCentral({
			...real,
			execute: async (entrada: any) => {
				central.push(String(typeof entrada === "string" ? entrada : entrada.sql).replace(/\s+/g, " ").trim());
				return real.execute(entrada);
			},
		});
		try {
			return await prueba({ tenantId, central, enCentral: (texto, ...args) => void sql.exec(texto, ...args) }, hub);
		} finally {
			deps.ponerCentral(null);
		}
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
 * Una petición firmada por `deviceId` (`MAIN` o `HANDY`), lista para `app.request` o para el
 * `fetch` del worker. `cuerpo` se manda como JSON; `bytes`, tal cual (un PDF, una imagen); sin
 * ninguno de los dos, la petición va sin cuerpo. La firma cubre el camino como lo verá el worker,
 * ya normalizado por la URL (`..`, `%2e%2e`), igual que lo firma el cliente Rust.
 */
export async function peticionFirmada(
	deps: Pick<Dependencias, "firmarSesion">,
	n: Negocio,
	deviceId: string,
	metodo: string,
	ruta: string,
	opciones: { cuerpo?: unknown; bytes?: Uint8Array; cabeceras?: Record<string, string> } = {},
): Promise<Request> {
	const token = await deps.firmarSesion(env, { tenantId: n.tenantId, deviceId, licHash: LIC_HASH });
	const cuerpo =
		opciones.bytes ??
		(opciones.cuerpo === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opciones.cuerpo)));
	const ts = Date.now();
	const url = new URL(`https://tpv-api.test${ruta}`);
	const firmada = url.pathname + url.search;
	const mensaje = ["DEVICE_PROOF", ts, metodo, firmada, await sha256HexStr(token), await sha256HexBytes(cuerpo)].join("\n");
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
		...(opciones.cuerpo === undefined && opciones.bytes === undefined ? {} : { body: cuerpo }),
	});
}

/** Un POST firmado por la Main y pedido a la `app` entera. `entorno` pisa variables del de la suite. */
export async function pedirFirmado(
	deps: Pick<Dependencias, "firmarSesion">,
	app: { request: (peticion: Request, init: undefined, env: any) => Response | Promise<Response> },
	n: Negocio,
	ruta: string,
	opciones: { cuerpo?: unknown; cabeceras?: Record<string, string>; entorno?: Record<string, unknown> } = {},
): Promise<Response> {
	const peticion = await peticionFirmada(deps, n, MAIN, "POST", ruta, {
		// Las rutas que se piden así validan un cuerpo JSON; sin nada que mandar, uno vacío.
		cuerpo: opciones.cuerpo ?? {},
		cabeceras: opciones.cabeceras,
	});
	return app.request(peticion, undefined, { ...env, ...opciones.entorno });
}

/**
 * Una petición firmada por `deviceId` (`MAIN` o `HANDY`) a la `app` entera: su estado, su cuerpo y
 * cuántos viajes ha hecho al TenantHub (`hub-ruta`). Es el camino desplegado: `tenantAuth` en el
 * Worker, `alHub`, `ejecutarRuta` y la ruta dentro del DO con el rol de la identidad.
 */
export async function pedirComo(
	deps: Pick<Dependencias, "firmarSesion">,
	app: { request: (peticion: Request, init: undefined, env: any) => Response | Promise<Response> },
	n: Negocio,
	deviceId: string,
	metodo: string,
	ruta: string,
	cuerpo?: unknown,
): Promise<{ status: number; json: any; viajes: number }> {
	const res = await app.request(await peticionFirmada(deps, n, deviceId, metodo, ruta, { cuerpo }), undefined, env);
	const texto = await res.text();
	let json: any = null;
	try {
		json = texto ? JSON.parse(texto) : null;
	} catch {
		json = texto;
	}
	return { status: res.status, json, viajes: viajes(res, "hub-ruta") };
}

/** Cuántos viajes de un tramo cuenta el `Server-Timing` (`hub-ruta;dur=12;desc="1"`). */
export function viajes(respuesta: Response, tramo: string): number {
	const tiempos = respuesta.headers.get("Server-Timing") ?? "";
	const m = new RegExp(`(?:^|, )${tramo};dur=[\\d.]+;desc="(\\d+)"`).exec(tiempos);
	return m ? Number(m[1]) : 0;
}
