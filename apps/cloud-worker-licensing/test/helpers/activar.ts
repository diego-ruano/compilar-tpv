// test/helpers/activar.ts
//
// AUD-01 · `POST /v1/license/activate` sólo entra firmada con la clave privada de la clave pública
// que presenta. Todo test que active pasa por aquí: claves ed25519 de verdad y el mismo mensaje que
// firma el cliente Rust (`device.rs::mensaje_de_activacion`).
//
//   const PUB_A = await clavePublica(1);            // en vez de un base64 de relleno
//   const res = await licenseRoutes.request(
//     "/activate",
//     await activacionFirmada({ activationKey, deviceId: "equipo-a", devicePubKey: PUB_A }),
//     ENV,
//   );
//
// `activacionFirmada` firma con la privada de `devicePubKey`, que recuerda de cuando se creó la
// clave. Para el caso contrario (quien presenta una clave que no es suya) están `firmarCon`, `ts` y
// `sinFirma`.
//
// El mensaje y el firmante (`@noble/ed25519`) están escritos aquí aparte, sin importar nada del
// worker: si el formato cambia en el fuente y no aquí, los tests fallan.

import * as ed from "@noble/ed25519";

import { ensureEd25519Sha512 } from "./ed25519";

/** La ruta que se firma, sea cual sea la URL del test (`licenseRoutes.request("/activate", …)`). */
const RUTA = "/v1/license/activate";

/** La semilla (clave privada) de cada clave pública creada aquí. */
const semillas = new Map<string, Uint8Array>();

function aBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copia = new Uint8Array(bytes.byteLength);
	copia.set(bytes);
	const hash = await crypto.subtle.digest("SHA-256", copia.buffer);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** El par de claves ed25519 cuya semilla son 32 bytes con el valor `relleno`. Siempre el mismo. */
export async function parDeClaves(relleno: number): Promise<{ seed: Uint8Array; pub: string }> {
	return parDeSemilla(new Uint8Array(32).fill(relleno));
}

/** El par de claves de una semilla dada (32 bytes). */
export async function parDeSemilla(seed: Uint8Array): Promise<{ seed: Uint8Array; pub: string }> {
	ensureEd25519Sha512();
	const pub = aBase64(await ed.getPublicKeyAsync(seed));
	semillas.set(pub, seed);
	return { seed, pub };
}

/** La clave pública (base64) del par `relleno`, como la manda el cliente en `devicePubKey`. */
export async function clavePublica(relleno: number): Promise<string> {
	return (await parDeClaves(relleno)).pub;
}

/**
 * El mensaje EXACTO que firma quien activa: el device-proof sobre `POST /v1/license/activate`, con
 * el tramo del token vacío (aún no hay sesión) y los bytes del cuerpo tal como se mandan.
 */
export async function mensajeDeActivacion(ts: number, cuerpo: Uint8Array): Promise<string> {
	return ["DEVICE_PROOF", ts, "POST", RUTA, await sha256Hex(new Uint8Array()), await sha256Hex(cuerpo)].join("\n");
}

/** La firma (base64) de ese mensaje con la semilla dada: lo que va en `X-Device-Sig`. */
export async function firmarActivacion(ts: number, cuerpo: Uint8Array, seed: Uint8Array): Promise<string> {
	ensureEd25519Sha512();
	const mensaje = new TextEncoder().encode(await mensajeDeActivacion(ts, cuerpo));
	return aBase64(await ed.signAsync(mensaje, seed));
}

type OpcionesDeFirma = {
	/** Firma con esta semilla y no con la de `devicePubKey`: quien no tiene la privada del equipo. */
	firmarCon?: Uint8Array;
	/** La hora que se firma y se manda en `X-Device-Ts`. Por defecto, ahora. */
	ts?: number;
	/** Sin cabeceras de firma. */
	sinFirma?: boolean;
	/** El cuerpo tal cual, en vez de `JSON.stringify(datos)`. Se firma y se manda éste. */
	cuerpo?: string;
};

/**
 * La petición de una activación firmada, lista para `licenseRoutes.request("/activate", …)` o para
 * `app.request("/v1/license/activate", …)`. `datos` es el cuerpo: `activationKey`, `deviceId`,
 * `devicePubKey` y lo que haga falta (`deviceChangeCode`, `soloSumar`, `tenantInfo`).
 */
export async function activacionFirmada(
	datos: Record<string, unknown>,
	opciones: OpcionesDeFirma = {},
): Promise<{ method: "POST"; headers: Record<string, string>; body: string }> {
	const body = opciones.cuerpo ?? JSON.stringify(datos);
	const headers: Record<string, string> = { "content-type": "application/json" };

	if (!opciones.sinFirma) {
		const seed = opciones.firmarCon ?? semillas.get(String(datos.devicePubKey));
		if (!seed) {
			throw new Error(
				"activacionFirmada: no hay clave privada para ese `devicePubKey`. Créalo con `clavePublica(n)` o pasa `firmarCon`.",
			);
		}
		const ts = opciones.ts ?? Date.now();
		headers["X-Device-Ts"] = String(ts);
		headers["X-Device-Sig"] = await firmarActivacion(ts, new TextEncoder().encode(body), seed);
	}

	return { method: "POST", headers, body };
}
