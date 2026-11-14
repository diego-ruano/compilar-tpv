// src/domains/licensing/licensing.helpers.ts
//
// Helpers del dominio de licencias: device-proof, estado derivado de la licencia, **firma
// ed25519 del estado** (el control central del gate, ver docs/arquitectura/licencias.md), OTP de cambio de
// dispositivo y provisión de la BD del tenant.
//
// El JWT de sesión ya no vive aquí: es una primitiva que usa el worker entero y no algo del
// dominio de licencias, así que se fue a `lib/sesion.ts` (ARQ-02).
//
// Reutiliza las utilidades compartidas del worker (base64, crypto, credenciales del tenant) en
// vez de mantener copias propias.

import { ed25519Sign, ed25519Verify, TOPE_FIRMA_B64 } from "../../server/utils/ed25519";
import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import type { LicenseGateState, SignedLicenseAssertion } from "../../shared";
import {
	ensureDevice,
	getDevicePubKeyB64,
	getDevicePubKeyB64EnCualquierNegocio,
	getLicenseByHash,
	type LicenseRow,
} from "../../server/licenseStore";
import { sha256Hex } from "../../server/crypto";
import { b64ToBytes, bytesToB64 } from "../../server/utils/base64";
import { sha256HexBytes, sha256HexStr } from "../../server/utils/crypto";
import { leerBearer } from "../../lib/sesion";
import { hubDe } from "../../lib/hub";
import { hubLocal } from "../../lib/hubLocal";
import { errorDeBasePerdida, negocioNacido } from "../../lib/basePerdida";
import { quitarComillas } from "../../lib/texto";

/** Caducidad: aviso los 7 días previos, y 3 días de gracia después */
export const WARN_DAYS = 7;
export const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** La aserción firmada solo vale 5 minutos: no sirve reproducir una vieja que dijera "active". */
const ASSERTION_TTL_MS = 5 * 60 * 1000;

/** El OTP de cambio de dispositivo: 10 minutos y 5 intentos. */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

/**
 * RI-68 · Los topes de verdad del código de cambio de equipo, POR LICENCIA y en 24 h.
 *
 * Los 5 intentos de arriba son por código, y un código es de una pareja (licencia, equipo nuevo):
 * con la clave de licencia, cada `deviceId` inventado abría su pareja, y pedir otro código volvía a
 * dar 5 intentos. Eran intentos sin fin —y un correo al titular por cada uno—. Un dueño que cambia
 * de PC de verdad pide uno o dos códigos y acierta, así que estos topes no le rozan.
 */
export const OTP_VENTANA_MS = 24 * 60 * 60 * 1000;
export const OTP_CODIGOS_AL_DIA = 5;
export const OTP_FALLOS_AL_DIA = 10;

// ---------------- Env / utilidades genéricas ----------------

export function assertEnv(env: Env, names: (keyof Env)[]): string | null {
	for (const n of names) {
		const v = (env as any)[n];
		if (!v || String(v).trim().length === 0) return `missing_env_${String(n)}`;
	}
	return null;
}

/** Turso suele devolver 0/1; el cliente espera boolean. */
export function toBool01(v: any, fallback = false): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "1") return true;
		if (s === "false" || s === "0") return false;
	}
	return fallback;
}

// ---------------- Estado derivado de la licencia ----------------

/**
 * La verdad sobre una licencia, derivada por el SERVIDOR (que es la autoridad) y firmada a
 * continuación. El cliente no recalcula esto: lo verifica y obedece.
 *
 * `deviceId` es el del dispositivo que pregunta: si la licencia ya se movió a otro Main
 * (cambio de equipo), a este se le responde `device_replaced` y se queda fuera.
 */
export function computeLicenseState(
	lic: LicenseRow,
	deviceId: string,
	nowMs: number,
): LicenseGateState {
	if (lic.status === "revoked" || toBool01(lic.disabled)) return "revoked";

	if (lic.main_device_id && lic.main_device_id !== deviceId) return "device_replaced";

	// Emitida pero sin activar: no debería llegar aquí (sin activar no hay token), pero si
	// pasa, no está caducada.
	if (!lic.expires_at_ms) return "active";

	const restante = lic.expires_at_ms - nowMs;
	if (restante > WARN_DAYS * DAY_MS) return "active";
	if (restante > 0) return "warn";
	if (restante > -GRACE_DAYS * DAY_MS) return "expiry_grace";
	return "expired";
}

/** Los estados con los que el TPV puede seguir trabajando. */
export function stateAllowsUse(state: LicenseGateState): boolean {
	return state === "active" || state === "warn" || state === "expiry_grace";
}

// ---------------- Firma ed25519 del estado (cierra LIC-01) ----------------

/**
 * Mensaje canónico de la aserción: orden FIJO, separador `|`. No se firma el JSON porque el
 * orden de sus claves no está garantizado y el cliente debe poder reconstruir byte a byte
 * exactamente lo mismo que firmó el servidor.
 *
 * ⚠️ Cualquier cambio aquí hay que replicarlo EXACTO en el cliente Rust
 * (`crates/tpv-infra-licensing`) y subir la versión `v`.
 */
export function licenseAssertionMessage(
	a: Omit<SignedLicenseAssertion, "sig">,
): string {
	return [
		`v${a.v}`,
		a.tenantId,
		a.deviceId,
		a.licenseId,
		a.state,
		a.plan,
		a.expiresAtMs ?? "",
		a.issuedAtMs,
		a.assertionExpiresAtMs,
		a.clientTs,
	].join("|");
}

/**
 * Firma el estado con la clave privada ed25519 del worker. La pública está **pineada** en el
 * binario del TPV, así que un servidor falso, un MITM con CA de confianza o un DNS envenenado
 * pueden devolver lo que quieran: sin esta privada, el cliente no se lo cree.
 */
export async function signLicenseAssertion(
	env: Env,
	fields: Omit<SignedLicenseAssertion, "sig">,
): Promise<SignedLicenseAssertion> {
	const seed = b64ToBytes(String(env.LICENSE_SIGNING_PRIVATE_KEY || "").trim());
	if (seed.length !== 32) throw new Error("LICENSE_SIGNING_PRIVATE_KEY must decode to 32 bytes");

	const msg = new TextEncoder().encode(licenseAssertionMessage(fields));
	const sig = await ed25519Sign(msg, seed);

	return { ...fields, sig: bytesToB64(sig) };
}

/** Construye la aserción firmada para una licencia concreta y la petición concreta que la pide. */
export async function buildSignedAssertion(
	env: Env,
	args: {
		lic: LicenseRow;
		tenantId: string;
		deviceId: string;
		clientTs: number;
		nowMs: number;
	},
): Promise<SignedLicenseAssertion> {
	return signLicenseAssertion(env, {
		v: 1,
		tenantId: args.tenantId,
		deviceId: args.deviceId,
		licenseId: args.lic.license_id,
		state: computeLicenseState(args.lic, args.deviceId, args.nowMs),
		plan: args.lic.plan,
		expiresAtMs: args.lic.expires_at_ms,
		issuedAtMs: args.nowMs,
		assertionExpiresAtMs: args.nowMs + ASSERTION_TTL_MS,
		clientTs: args.clientTs,
	});
}

// ---------------- OTP de cambio de dispositivo ----------------

/** 6 dígitos con CSPRNG. Rango uniforme: se descarta el sesgo del módulo. */
export function generateOtpCode(): string {
	const buf = new Uint32Array(1);
	// 4_294_967_296 no es múltiplo de 1e6: los valores por encima del último múltiplo exacto
	// se descartan para que los 10^6 códigos sean equiprobables.
	const limite = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= limite);

	return String(buf[0] % 1_000_000).padStart(6, "0");
}

export async function otpHash(code: string): Promise<string> {
	return sha256Hex(code.trim());
}

/** Pista del email para la UI: `a***@bar.com`. Nunca se devuelve el correo entero. */
export function emailHint(email: string): string {
	const [user, domain] = String(email || "").split("@");
	if (!user || !domain) return "***";
	const visible = user.slice(0, 1);
	return `${visible}${"*".repeat(Math.max(user.length - 1, 1))}@${domain}`;
}

// ---------------- Device proof (anti-copia, ed25519) ----------------

export async function verifyDeviceProof(
	request: Request,
	dbi: Client,
	claims: { tenantId: string; deviceId: string },
	target?: { method: string; path: string },
	rawBody?: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return comprobarFirma(
		request,
		() => getDevicePubKeyB64(dbi, claims.tenantId, claims.deviceId),
		target,
		rawBody,
	);
}

/**
 * Vuelve a dar de alta como TPV a la Main de una licencia cuya fila de `devices` ya no está en su
 * negocio. Lo llaman `/status` y `/refresh` cuando la firma falla por `device_pubkey_not_registered`.
 *
 * Pasa cuando un equipo que fue la Main se usa un tiempo como Handy de otro negocio: la identidad
 * del equipo es una sola, así que al recoger su token de Handy su fila pasó a ese otro negocio. Al
 * volver a modo TPV, sin esto, la nube no lo reconocía: el WebSocket se quedaba reintentando y la
 * licencia lo tomaba por falta de red y tiraba de la gracia sin conexión hasta bloquearse, sin
 * decir por qué — y el cliente tenía que volver a meter la clave.
 *
 * Sólo si la firma cuadra con la clave que ese equipo tiene registrada (en el negocio que sea) y
 * el equipo sigue siendo el `main_device_id` de la licencia. Si la licencia se trasladó a otro
 * equipo, se contesta `device_replaced`: se bloquea al momento en vez de agotar la gracia.
 */
export async function readmitirMain(
	request: Request,
	dbi: Client,
	claims: { tenantId: string; deviceId: string; licHash: string },
	rawBody?: Uint8Array,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
	const noRegistrado = { ok: false as const, status: 401 as const, error: "device_pubkey_not_registered" };

	const lic = await getLicenseByHash(dbi, claims.licHash);
	if (!lic || lic.tenant_id !== claims.tenantId) return noRegistrado;

	const clave = await getDevicePubKeyB64EnCualquierNegocio(dbi, claims.deviceId);
	const firma = await comprobarFirma(request, async () => clave, undefined, rawBody);
	if (!firma.ok) return { ok: false, status: 401, error: firma.error };

	if (lic.main_device_id !== claims.deviceId) {
		return { ok: false, status: 403, error: "device_replaced" };
	}

	// AUD-01: la fila se muda con la misma clave con la que se ha comprobado la firma, y sólo si
	// sigue registrada con ella (`ensureDevice`). Sin clave no se llega aquí: la firma ya habría
	// contestado `device_pubkey_not_registered`.
	if (!clave) return noRegistrado;
	try {
		await ensureDevice(dbi, claims.tenantId, claims.deviceId, "tpv", clave);
	} catch (e: any) {
		if (e?.code === "device_key_mismatch") return noRegistrado;
		throw e;
	}
	return { ok: true };
}

/**
 * AUD-01 · La ruta que firma quien activa. Va fija y no se lee de la petición: la firma de una
 * activación sólo vale para activar, esté montado el router donde esté.
 */
const RUTA_DE_ACTIVACION = "/v1/license/activate";

/**
 * AUD-01 · La prueba de posesión de `/v1/license/activate`: el device-proof de siempre, comprobado
 * con la clave pública que la propia petición presenta.
 *
 * La ruta es anónima y las guardas de REV-07 y REV-13 comparan esa clave pública con la registrada,
 * pero una clave pública no es un secreto: la ve la Main de cualquier negocio por el que pasó el
 * equipo (`/v1/device/list`, `/v1/pair/pending`). Con esta firma, presentar una clave exige tener su
 * privada, así que aquellas comparaciones pasan a exigirla también.
 *
 * Lo firmado es `DEVICE_PROOF \n ts \n POST \n /v1/license/activate \n sha256("") \n sha256(cuerpo)`:
 * todavía no hay token, así que su tramo es el hash de la cadena vacía (ninguna ruta autenticada
 * acepta un token vacío). El cuerpo entra entero, y con él el `deviceId`, la clave pública, la clave
 * de activación, el código de traslado, `soloSumar` y `tenantActual`. El gemelo del cliente es
 * `device.rs::mensaje_de_activacion`, y los dos leen el mismo vector
 * (`crates/tpv-infra-licensing/src/firma_activacion_casos.json`).
 */
export async function verificarFirmaDeActivacion(
	request: Request,
	pubB64: string,
	rawBody: Uint8Array,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return comprobarFirma(
		request,
		async () => pubB64,
		{ method: "POST", path: RUTA_DE_ACTIVACION },
		rawBody,
		false,
	);
}

/**
 * Las cabeceras del device-proof: que estén, que la hora se pueda leer y que caiga dentro del margen
 * de ±2 minutos. Es lo que se puede decidir sin haber leído el cuerpo ni la clave.
 */
export function cabecerasDeLaFirma(
	request: Request,
): { ok: true; ts: number; sigB64: string } | { ok: false; error: string } {
	const tsStr = (request.headers.get("X-Device-Ts") || "").trim();
	const sigCabecera = request.headers.get("X-Device-Sig") || "";
	// AUD-33: una firma son 88 caracteres. Más larga se rechaza antes de tocarla.
	if (sigCabecera.length > TOPE_FIRMA_B64) return { ok: false, error: "bad_device_signature" };
	const sigB64Raw = sigCabecera.trim();
	if (!tsStr || !sigB64Raw) return { ok: false, error: "missing_device_proof" };

	const sigB64 = quitarComillas(sigB64Raw);
	if (!tsStr || !sigB64) return { ok: false, error: "missing_device_proof" };

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) return { ok: false, error: "bad_device_ts" };

	const now = Date.now();
	const MAX_SKEW_MS = 2 * 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, error: "device_ts_out_of_range" };

	return { ok: true, ts, sigB64 };
}

async function comprobarFirma(
	request: Request,
	obtenerClave: () => Promise<string | null>,
	target?: { method: string; path: string },
	rawBody?: Uint8Array,
	/** `false` sólo al activar (AUD-01), que se firma antes de tener token: su tramo va vacío. */
	conToken = true,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const cabeceras = cabecerasDeLaFirma(request);
	if (!cabeceras.ok) return cabeceras;
	const { ts, sigB64 } = cabeceras;

	const pubB64 = await obtenerClave();
	if (!pubB64) return { ok: false, error: "device_pubkey_not_registered" };

	let token = "";
	if (conToken) {
		const bearer = leerBearer(request);
		if (!bearer) return { ok: false, error: "missing_token" };
		token = bearer;
	}

	const tokenHash = await sha256HexStr(token);

	const method = String(target?.method || request.method).toUpperCase();
	const url = new URL(request.url);
	const path = String(target?.path || url.pathname + url.search);

	// FABLE-E: el cuerpo entra en la firma, y entra como BYTES (leerlo como texto rompería
	// cualquier cuerpo binario; ver `verifyDeviceProofOrThrow`). Estos endpoints (status/refresh)
	// se llaman sin cuerpo, así que suele estar vacío — pero el tramo va SIEMPRE, para que el
	// mensaje tenga la misma forma que el que firma el cliente (`sign_device_proof` en Rust).
	const bodyHash = await sha256HexBytes(rawBody ?? new Uint8Array());
	const msg = ["DEVICE_PROOF", ts, method, path, tokenHash, bodyHash].join("\n");

	let pub: Uint8Array;
	let sig: Uint8Array;
	try {
		pub = b64ToBytes(pubB64);
		sig = b64ToBytes(sigB64);
	} catch {
		return { ok: false, error: "bad_b64" };
	}

	const ok = await ed25519Verify(sig, new TextEncoder().encode(msg), pub);
	if (!ok) return { ok: false, error: "bad_device_signature" };

	return { ok: true };
}

// ---------------- Provisión de la base del negocio ----------------

/**
 * Garantiza que el negocio tiene su base con el esquema aplicado y el admin inicial.
 *
 * La base es el SQLite de su TenantHub, y aprovisionarla es cosa suya (`MotorTenantHub.aprovisionar`):
 * crea el esquema y siembra el administrador. Desde una ruta que ya corre dentro de ese DO
 * (`/v1/sync/initialize-empty`) se le pide al de al lado, sin RPC: un objeto no se llama a sí mismo.
 *
 * DO-PERDIDA · **Sólo se crea la base de un negocio que no ha nacido** (`lib/basePerdida.ts`). Si
 * ya la tiene, no hay nada que hacer (`reused`). Si no la tiene y alguna licencia suya llegó a
 * activarse, su base existió y no está donde se la busca: lanza `tenant_db_perdida` sin crear nada.
 * Una base vacía en su lugar dejaría al negocio con una nube en blanco y los datos de verdad en otro
 * objeto. Por aquí pasan la activación (también la de un equipo nuevo en un traslado, que antes
 * creaba esa base vacía sin preguntar) y `/v1/sync/initialize-empty`.
 */
export async function provisionTenantDatabase(dbi: Client, env: Env, tenantId: string): Promise<{ reused: boolean }> {
	if (await negocioAprovisionado(env, tenantId)) return { reused: true };
	if (await negocioNacido(dbi, tenantId)) throw errorDeBasePerdida();
	const local = hubLocal(tenantId);
	return local ? local.aprovisionar() : hubDe(env, tenantId).aprovisionar(tenantId);
}

/** ¿Tiene ya su base este negocio? Como `provisionTenantDatabase`, por el DO de al lado si lo hay. */
export async function negocioAprovisionado(env: Env, tenantId: string): Promise<boolean> {
	const local = hubLocal(tenantId);
	return local ? local.estaAprovisionado() : hubDe(env, tenantId).estaAprovisionado();
}
