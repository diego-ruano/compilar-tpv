// src/lib/sesion.ts
//
// El JWT de sesión con el que un dispositivo —la Main o una Handy— se identifica ante el worker.
// Hermano de `deviceAuth.ts` (la firma ed25519 del dispositivo) y de `internalAuth.ts` (el HMAC
// entre el worker y el Durable Object): tres primitivas de autenticación, una por módulo, cada
// una la única fuente de su formato.
//
// ── UNA SOLA IMPLEMENTACIÓN (ARQ-02) ─────────────────────────────────────────────────────
//
// Antes había dos. Firmar iba por `jose`, pero verificar se hacía de dos maneras según la ruta:
// `jose` en `/v1/license/status`, y un HS256 escrito a mano (`server/middleware/jwtHs256.ts`)
// en `tenantAuth` — o sea, en TODO lo demás: el REST de la Handy, la sync, el bootstrap, las
// imágenes y el correo. Que las dos mitades encajaran no lo garantizaba el código sino un test,
// y el día que se separasen el síntoma habría sido que una Handy recién vinculada no entra.
// Aquí se firma y se verifica con la misma pieza, así que no queda nada que pueda separarse.
//
// ── LOS IDENTIFICADORES DE ERROR SON CONTRATO ────────────────────────────────────────────
//
// `tenantAuth` devuelve el MENSAJE de la excepción como el `error` de la respuesta, y de ese
// identificador sale la frase que acaba leyendo la persona (`lib/errorCodes.ts`). Así que
// `verificarSesion` traduce lo que lanza `jose` a los identificadores de siempre, y lo hace por
// `e.code` y **nunca** por el texto: la redacción de un error de librería cambia entre versiones
// y esa comparación se pudre sin que nada falle de forma visible. Es la misma regla que el DO
// aplica a los errores de libsql.

import { SignJWT, jwtVerify, decodeJwt, type JWTPayload } from "jose";

import type { Env } from "../env";

/** Lo que un token de sesión afirma, y lo único que se lee de él. */
export type ClaimsSesion = { tenantId: string; deviceId: string; licHash: string };

/** Vida del token de sesión de la Main. Nunca se llega a ella: `/status` lo renueva cada 6 h. */
export const MAIN_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Vida del token de la Handy, que se emite al emparejar (`pairFetchToken`) y se reemite en
 * `/refresh`. Los dos sitios preguntan aquí: un TTL escrito dos veces se separa, y la mitad que
 * se quedara corta caducaría tokens que la otra da por buenos.
 *
 * El suelo de una hora es contra un valor mal puesto en la configuración del worker: un TTL de
 * segundos dejaría a las Handy renovando en bucle.
 */
export function handyTokenTtlSeconds(env: Env): number {
	const raw = Number((env as any)?.HANDY_TOKEN_TTL_SECONDS ?? 0);
	if (Number.isFinite(raw) && raw >= 3600) return Math.floor(raw);

	return MAIN_TOKEN_TTL_SECONDS;
}

/**
 * CFG-03, la misma regla que `internalAuth.ts`: sin secreto no se firma ni se verifica.
 *
 * El verificador de antes hacía `String(env.LICENSE_JWT_SECRET || "")`, así que con la variable
 * ausente o vacía aceptaba cualquier token firmado con la clave vacía — y `tenantAuth`, a
 * diferencia de las rutas de licencia, no pasa por `assertEnv`. Una comprobación de seguridad
 * tiene que fallar cerrando por sí misma, no confiar en que el runtime rechace una clave de
 * longitud cero.
 *
 * El identificador es el que ya produce `assertEnv` para esta misma variable, para que una
 * configuración incompleta se diagnostique igual venga por donde venga.
 */
function claveDeSesion(env: Env): Uint8Array {
	const secreto = (env as any)?.LICENSE_JWT_SECRET;
	if (typeof secreto !== "string" || secreto.trim().length === 0) {
		throw new Error("missing_env_LICENSE_JWT_SECRET");
	}
	return new TextEncoder().encode(secreto);
}

/**
 * El token del header `Authorization: Bearer …`, o `null` si no viene.
 *
 * Devuelve `null` en vez de lanzar porque sus llamantes reaccionan distinto: `tenantAuth`
 * convierte el fallo en excepción y las rutas de licencia responden ellas mismas. Lo que se
 * unifica es el formato, que estaba copiado en cuatro sitios.
 *
 * No vale para el token de administración (`requireAdmin.ts`), que no es una sesión.
 */
export function leerBearer(req: Request): string | null {
	const h = req.headers.get("authorization") || "";
	const m = h.match(/^Bearer\s+(.+)$/i);
	return m ? m[1] : null;
}

/**
 * Emite un token de sesión. Es el ÚNICO sitio donde se firma uno: antes el del emparejamiento se
 * construía a mano (su propio HS256, su propio base64url) y el de la licencia con `jose`, así que
 * eran dos formas de decir lo mismo que podían separarse sin que nada fallara.
 *
 * `rol` va en el payload por fidelidad con el token que ya emitía el emparejamiento, pero **nadie
 * lo lee** —`verificarSesion` ni siquiera lo devuelve—: el rol de un dispositivo sale siempre de
 * su fila en `devices` (ver `tenant.ts`), porque un claim del token no puede otorgar privilegios
 * que la BD central no reconozca.
 */
export async function firmarSesion(
	env: Env,
	claims: ClaimsSesion,
	opciones: { rol?: "tpv" | "handy"; ttlSegundos?: number } = {},
): Promise<string> {
	const ttl = opciones.ttlSegundos ?? MAIN_TOKEN_TTL_SECONDS;
	const payload = opciones.rol ? { ...claims, role: opciones.rol } : { ...claims };

	return await new SignJWT(payload)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
		.sign(claveDeSesion(env));
}

/**
 * Verifica firma y vigencia, y devuelve los claims. El único camino para autorizar por token.
 *
 * `algorithms` va pinado a propósito: sin esa lista, `jose` tomaría la cabecera del token como
 * indicación de con qué verificar. El verificador de antes se defendía de eso ignorando la
 * cabecera y calculando HS256 pasara lo que pasara; esto es lo mismo dicho explícitamente.
 */
export async function verificarSesion(env: Env, token: string): Promise<ClaimsSesion> {
	// Fuera del `try`: un secreto ausente es una configuración rota, no un token malo, y
	// traducirlo a `bad_jwt_payload` apuntaría al sitio equivocado.
	const clave = claveDeSesion(env);

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, clave, { algorithms: ["HS256"] }));
	} catch (e: any) {
		// `cause`: sin ella se pierde el error original de `jose`, que es lo que distingue una
		// firma mal formada de una que no cuadra.
		throw new Error(identificadorDe(e), { cause: e });
	}

	return parsearClaims(payload);
}

/**
 * Lee los claims de un token **sin verificar la caducidad**. Solo para `/refresh`: el token
 * caducado sigue diciendo quién dice ser, y a ese "quién" se le exige a continuación un
 * device-proof firmado con la clave privada del dispositivo. Es lo que evita que un reloj
 * desajustado o un token vencido borren la licencia del cliente (bug #4).
 *
 * NO usar para autorizar nada sin comprobar después el device-proof.
 */
export function leerClaimsSinVerificar(token: string): ClaimsSesion | null {
	try {
		return parsearClaims(decodeJwt(token));
	} catch {
		return null;
	}
}

/** Los tres claims, o nada. Un token bien firmado al que le falte uno no identifica a nadie. */
function parsearClaims(payload: JWTPayload): ClaimsSesion {
	const tenantId = String(payload.tenantId || "");
	const deviceId = String(payload.deviceId || "");
	const licHash = String(payload.licHash || "");

	if (!tenantId || !deviceId || !licHash) throw new Error("invalid_token_claims");
	return { tenantId, deviceId, licHash };
}

/**
 * Lo que lanza `jose` → el identificador del catálogo. Se busca por `code`, nunca por el mensaje.
 *
 * Va como tabla y no como `switch` a propósito: `test/mensajesDeError.test.ts` lee el fuente para
 * comprobar que todo identificador que el worker puede emitir tiene frase, y reconoce la forma
 * `error: "…"`. Un `switch` que los devolviera los escondería de esa comprobación, y el catálogo
 * podría quedarse sin la frase de uno de ellos sin que nada fallara. Se recorre en orden: la fila
 * con `claim` es más específica y va antes que la que sólo mira el `code`.
 */
const SEGUN_JOSE: ReadonlyArray<{ de: string; claim?: string; error: string }> = [
	{ de: "ERR_JWT_EXPIRED", error: "jwt_expired" },

	// Una firma que no cuadra y un `alg` que no aceptamos dicen lo mismo de cara afuera: "esta
	// firma no me vale". Y es lo que ya respondía el verificador anterior, que al ignorar la
	// cabecera trataba un `alg` ajeno como una firma incorrecta.
	{ de: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", error: "bad_jwt_signature" },
	{ de: "ERR_JOSE_ALG_NOT_ALLOWED", error: "bad_jwt_signature" },

	// No tiene forma de JWS compacto (no son tres tramos, o no se decodifican).
	{ de: "ERR_JWS_INVALID", error: "invalid_jwt" },

	{ de: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "nbf", error: "jwt_not_active" },
	{ de: "ERR_JWT_CLAIM_VALIDATION_FAILED", error: "bad_jwt_payload" },
];

/** `ERR_JWT_INVALID` (el payload no es un objeto de claims) y lo que traiga el futuro. */
const SIN_CLASIFICAR = "bad_jwt_payload";

function identificadorDe(e: any): string {
	const code = String(e?.code || "");
	const fila = SEGUN_JOSE.find((f) => f.de === code && (f.claim === undefined || f.claim === e?.claim));

	return fila?.error ?? SIN_CLASIFICAR;
}
