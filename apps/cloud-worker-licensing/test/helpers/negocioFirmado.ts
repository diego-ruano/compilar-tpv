// test/helpers/negocioFirmado.ts
//
// Un negocio entero para probar por el camino de verdad: su base en su TenantHub, y en una base
// central propia (`helpers/central.ts`) su licencia, su Main y una Handy, cada una con su clave. Las
// peticiones salen firmadas como las del cliente Rust (`sign_device_proof`).
//
// La central es un objeto `BaseCentral` de verdad, nuevo para cada negocio, y le llega lo mismo que en
// producción por los dos caminos:
//   · el del Worker (`tenantAuth`, las rutas que se quedan en él), por `n.entorno`. `pedirFirmado` y
//     `pedirComo` lo ponen solos; quien le pida a la `app` directamente, `{ ...env, ...n.entorno }`;
//   · el del TenantHub del negocio (`getCentralDb`, y `getDb` en las rutas que se ejecutan dentro),
//     porque `prueba` corre dentro de él con la central puesta (`enElHub(…, { central })`).
// Lo que le llega por cualquiera de los dos queda apuntado en `n.central`, y `n.interceptarLaCentral`
// provoca en su stub lo que haga falta (que no conteste, que tarde).
//
// El test pasa la firma de sesión y cómo olvidar la caché de licencias, cargadas después de sus
// `vi.mock`.

import { env as entorno } from "cloudflare:test";
import * as ed from "@noble/ed25519";

import { centralDePrueba, centralQueApunta, desvio, filasDe, negocioEnLaCentral, type Atender } from "./central";
import { ensureEd25519Sha512 } from "./ed25519";
import { enElHub } from "./hub";
import type { Env } from "../../src/env";
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
	/** Lo que se le ha pedido a la base central del negocio, desde el Worker y desde su TenantHub, en orden (`centralQueApunta`). */
	central: string[];
	/** Lo que lleva el `env` de una ruta para que su `getDb` llegue a la central del negocio. */
	entorno: Pick<Env, "BaseCentral">;
	/** Ejecuta SQL en la base central y devuelve sus filas, por debajo de sus guardas y sin que cuente en `central`. */
	enCentral: (sql: string, ...args: unknown[]) => Promise<Record<string, any>[]>;
	/** Desde ahora, lo que se pida a la central pasa por `atender` (después de apuntarlo); con `null`, va directo. */
	interceptarLaCentral: (atender: Atender | null) => void;
};

export type Dependencias = {
	firmarSesion: (env: any, claims: { tenantId: string; deviceId: string; licHash: string }) => Promise<string>;
	olvidarLicenciasCacheadas: () => void;
};

/**
 * Monta el negocio `nombre` (con licencia en vigor y, salvo `sinBase`, aprovisionado) y corre
 * `prueba` con él, dentro de su TenantHub (cuyo motor recibe).
 */
export async function conNegocioFirmado<R>(
	deps: Dependencias,
	nombre: string,
	prueba: (n: Negocio, hub: any) => Promise<R>,
	opciones: { sinBase?: boolean } = {},
): Promise<R> {
	deps.olvidarLicenciasCacheadas();
	const tenantId = `negocio-firmado-${nombre}`;
	if (!opciones.sinBase) await env.TenantHub.get(env.TenantHub.idFromName(tenantId)).aprovisionar(tenantId);

	ensureEd25519Sha512();
	const base = await centralDePrueba();
	await negocioEnLaCentral(base, {
		tenantId,
		main: MAIN,
		licenseId: `lic-${nombre}`,
		licenseKeyHash: LIC_HASH,
		dispositivos: await Promise.all(
			([[MAIN, "tpv"], [HANDY, "handy"]] as const).map(async ([deviceId, rol]) => ({
				deviceId,
				rol,
				pubkeyB64: bytesToB64(await ed.getPublicKeyAsync(SEMILLAS[deviceId])),
			})),
		),
	});

	const { atender, desviar } = desvio();
	const central = centralQueApunta(base, atender);
	const n: Negocio = {
		tenantId,
		central: central.pedido,
		entorno: central.entorno,
		enCentral: (texto, ...args) => filasDe(base, texto, ...args),
		interceptarLaCentral: desviar,
	};
	return enElHub(tenantId, (hub: any) => prueba(n, hub), { central });
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

/**
 * Un POST firmado por la Main y pedido a la `app` entera, con la central del negocio. `entorno` pisa
 * variables del de la suite.
 */
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
	return app.request(peticion, undefined, { ...env, ...n.entorno, ...opciones.entorno });
}

/**
 * Una petición firmada por `deviceId` (`MAIN` o `HANDY`) a la `app` entera, con la central del
 * negocio: su estado, su cuerpo y cuántos viajes ha hecho al TenantHub (`hub-ruta`). Es el camino
 * desplegado: `tenantAuth` en el Worker, `alHub`, `ejecutarRuta` y la ruta dentro del DO con el rol
 * de la identidad.
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
	const res = await app.request(await peticionFirmada(deps, n, deviceId, metodo, ruta, { cuerpo }), undefined, {
		...env,
		...n.entorno,
	});
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
