// src/server/middleware/auth.ts
import type { Client } from "@libsql/client/web";

import { cargarDevice, estaRevocado } from "../../lib/deviceAuth";
import { leerBearer, verificarSesion, type ClaimsSesion } from "../../lib/sesion";
import { b64ToBytes } from "../utils/base64";
import { sha256HexBytes, sha256HexStr } from "../utils/crypto";
import { ed25519Verify, nobleForceU8 } from "../utils/nobleEd25519";

export type AuthClaims = ClaimsSesion;

// Cache de pubkeys de dispositivos (scope de isolate de CF Worker).
// La pubkey no cambia tras el pairing, así que 60 s de TTL es suficiente para
// eliminar el round-trip a la central DB en cada petición sin riesgo real
// (la revocación puede tardar hasta 60 s en hacer efecto, aceptable en un TPV).
type DeviceCacheEntry = { pubB64: string; expiresAtMs: number };
const devicePubkeyCache = new Map<string, DeviceCacheEntry>();
const DEVICE_CACHE_TTL_MS = 60_000;

function deviceCacheKey(tenantId: string, deviceId: string): string {
	return `${tenantId}:${deviceId}`;
}

/**
 * El token y lo que afirma. Devuelve también el token porque el device-proof lo cubre con su
 * hash: quien autentica y quien comprueba la firma tienen que ver exactamente la misma cadena.
 */
export async function verifyJwt(env: any, req: Request): Promise<{ token: string; claims: AuthClaims }> {
	const token = leerBearer(req);
	if (!token) throw new Error("missing_token");

	return { token, claims: await verificarSesion(env, token) };
}

/**
 * Estado del dispositivo para firmar: o su pubkey, o el motivo exacto por el que no.
 *
 * Los tres motivos se distinguen a propósito. Antes los tres devolvían
 * `device_pubkey_not_registered`, así que un dispositivo **revocado** decía "no tienes
 * pubkey registrada" — un mensaje que apunta al sitio equivocado y convierte un
 * diagnóstico de diez segundos en una investigación. Además `device_revoked` sí está en el
 * catálogo compartido de códigos (`ErrorCode::DeviceRevoked`), así que el cliente puede
 * ramificar: la sync deja de reintentar en bucle y la UI enseña un texto que se entiende.
 */
type EstadoDevice =
	| { ok: true; pubB64: string }
	| { ok: false; error: "device_not_registered" | "device_revoked" | "device_pubkey_not_registered" };

async function resolverDevice(
	dbCentral: Client,
	tenantId: string,
	deviceId: string,
): Promise<EstadoDevice> {
	const key = deviceCacheKey(tenantId, deviceId);
	const hit = devicePubkeyCache.get(key);
	if (hit && hit.expiresAtMs > Date.now()) return { ok: true, pubB64: hit.pubB64 };

	const fila = await cargarDevice(dbCentral, tenantId, deviceId);

	// Nada de esto se cachea: si el dispositivo se registra, se readmite o le llega su
	// pubkey, la comprobación vuelve a la BD en la siguiente petición.
	if (!fila) {
		devicePubkeyCache.delete(key);
		return { ok: false, error: "device_not_registered" };
	}
	if (estaRevocado(fila)) {
		devicePubkeyCache.delete(key);
		return { ok: false, error: "device_revoked" };
	}

	const pubB64 = String(fila.device_pubkey_b64 || "").trim();
	if (!pubB64) {
		devicePubkeyCache.delete(key);
		return { ok: false, error: "device_pubkey_not_registered" };
	}

	devicePubkeyCache.set(key, { pubB64, expiresAtMs: Date.now() + DEVICE_CACHE_TTL_MS });
	return { ok: true, pubB64 };
}

/**
 * Verifica el “device proof”:
 * msg = "{ts}\n{METHOD}\n{PATH}\n{sha256(token)}\n{sha256(body)}"
 *
 * `rawBody` son los **bytes** del cuerpo tal cual llegaron (vacío si no hay). Cubrirlos con la
 * firma (FABLE-E) es lo que impide alterar el contenido de una petición ya firmada; antes la firma
 * solo ataba método y ruta.
 *
 * ⚠️ **Bytes, no texto.** Quien llame a esto tiene que leer el cuerpo como `arrayBuffer`. Leerlo
 * con `text()` lo decodifica como UTF-8, y un cuerpo binario —la subida de imágenes manda un
 * JPEG— pierde ahí todos los bytes que no forman un carácter válido: el hash deja de cuadrar y la
 * petición muere con `bad_device_signature` aunque la clave y la firma sean perfectas. En Hono,
 * `c.req.arrayBuffer()` queda cacheado y el handler puede seguir usando `c.req.json()` después.
 *
 * ⚠️ El formato debe ser idéntico al de `sign_device_proof` (`tpv-infra-licensing/src/device.rs`).
 */
export async function verifyDeviceProofOrThrow(
	req: Request,
	dbCentral: Client,
	claims: { tenantId: string; deviceId: string },
	bearerToken: string,
	rawBody: Uint8Array
): Promise<void> {
	const tsStr = (req.headers.get("X-Device-Ts") || "").trim();
	const sigB64Raw = (req.headers.get("X-Device-Sig") || "").trim();
	if (!tsStr || !sigB64Raw) throw new Error("missing_device_proof");

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) throw new Error("bad_device_ts");

	const now = Date.now();
	const MAX_SKEW_MS = 2 * 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) throw new Error("device_ts_out_of_range");

	const dev = await resolverDevice(dbCentral, claims.tenantId, claims.deviceId);
	if (!dev.ok) throw new Error(dev.error);
	const pubB64 = dev.pubB64;

	const url = new URL(req.url);
	const tokenHash = await sha256HexStr(bearerToken);
	const bodyHash = await sha256HexBytes(rawBody ?? new Uint8Array());
	const msg = `${ts}\n${req.method.toUpperCase()}\n${url.pathname}\n${tokenHash}\n${bodyHash}`;

	// por si llega con comillas
	const sigB64 = sigB64Raw.replace(/^"+|"+$/g, "");

	try {
		const pubU8 = nobleForceU8(b64ToBytes(pubB64));
		const sigU8 = nobleForceU8(b64ToBytes(sigB64));
		const payloadU8 = nobleForceU8(new TextEncoder().encode(msg));

		const ok = await ed25519Verify(sigU8, payloadU8, pubU8);
		if (!ok) throw new Error("bad_device_signature");
	} catch (e: any) {
		// `cause`: sin ella se pierde la traza del fallo original (una firma mal formada y un
		// error de la cripto llegan indistinguibles al log).
		throw new Error(`verify_failed: ${String(e?.message || e)}`, { cause: e });
	}
}