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

import { ed25519Sign, ed25519Verify } from "../../server/utils/ed25519";
import { createClient, type Client } from "@libsql/client/web";

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
import { runTenantMigrations } from "../../server/tenantMigrations";
import {
	getTenantDbRow,
	resolveTenantDbCredentials,
	tursoCreateDbToken,
	upsertTenantDbRow,
} from "../../server/db/tenantDb";

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
	const sigB64Raw = (request.headers.get("X-Device-Sig") || "").trim();
	if (!tsStr || !sigB64Raw) return { ok: false, error: "missing_device_proof" };

	const sigB64 = sigB64Raw.replace(/^"+|"+$/g, "");
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

// ---------------- Bootstrap del admin inicial del tenant ----------------

const PBKDF2_PREFIX = "$pbkdf2-sha256$";
// Máximo que admite el PBKDF2 de Cloudflare Workers (100k, límite del runtime). Debe coincidir con
// `DEFAULT_ITERS` (login.crypto.ts) y `PBKDF2_ITERS` (crates/tpv-domain/src/login.rs): el admin que
// se siembra aquí se verifica luego con esos verificadores.
const PBKDF2_ITERS = 100_000;
const PBKDF2_SALT_LEN = 16;
const PBKDF2_DK_LEN = 32;

function randomBytes(len: number): Uint8Array {
	const out = new Uint8Array(len);
	crypto.getRandomValues(out);
	return out;
}

async function hashPinPbkdf2(pin: string): Promise<string> {
	const p = String(pin || "").trim();
	if (p.length < 4) throw new Error("PIN demasiado corto");

	const salt = randomBytes(PBKDF2_SALT_LEN);

	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(p),
		"PBKDF2",
		false,
		["deriveBits"],
	);

	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
		keyMaterial,
		PBKDF2_DK_LEN * 8,
	);

	const dk = new Uint8Array(bits);
	return `${PBKDF2_PREFIX}i=${PBKDF2_ITERS}$${bytesToB64(salt)}$${bytesToB64(dk)}`;
}

function rowNumber(row: any, key: string, fallback = 0): number {
	const n = Number(row?.[key] ?? row?.[0] ?? fallback);
	return Number.isFinite(n) ? n : fallback;
}

async function tenantQuerySingleNumber(
	client: Client,
	sql: string,
	args: any[] = [],
): Promise<number> {
	const r = await client.execute({ sql, args });
	const row = r.rows?.[0] as any | undefined;
	if (!row) return 0;
	const firstKey = Object.keys(row)[0] || "";
	return rowNumber(row, firstKey, 0);
}

async function tenantQuerySingleString(
	client: Client,
	sql: string,
	args: any[] = [],
): Promise<string | null> {
	const r = await client.execute({ sql, args });
	const row = r.rows?.[0] as any | undefined;
	if (!row) return null;
	const firstKey = Object.keys(row)[0] || "";
	const v = row?.[firstKey] ?? row?.[0];
	return v == null ? null : String(v);
}

async function ensureTenantInitialAdmin(client: Client): Promise<void> {
	// Los roles ya los siembra el esquema con sus UUIDv7 fijos; aquí sólo creamos el usuario admin
	// inicial si la tabla Usuarios está vacía.
	const usersCount = await tenantQuerySingleNumber(
		client,
		`SELECT COUNT(*) AS count FROM Usuarios;`,
	);
	if (usersCount > 0) return;

	const adminRoleId = await tenantQuerySingleString(
		client,
		`
			SELECT ID_Rol AS id
			FROM Roles
			WHERE Nombre_Rol = 'Administrador'
			LIMIT 1;
		`,
	);
	if (!adminRoleId) throw new Error("initial_admin_role_missing");

	const hash = await hashPinPbkdf2("1234");

	await client.execute({
		sql: `
			INSERT INTO Usuarios (
				ID_Usuario,
				ID_Rol,
				Email,
				Password_Hash,
				Nombre,
				Apellido,
				Estado,
				Requiere_Setup
			)
			VALUES (?, ?, ?, ?, ?, ?, 'Activo', 1);
		`,
		args: [
			// UUID FIJO: debe coincidir con el admin que siembra la Main (ADMIN_USUARIO_ID en
			// crates/tpv-infra-sqlite/src/util.rs). Si difiere, la Handy referencia un admin que la
			// Main no tiene y los fichajes/comandas revientan con FOREIGN KEY al sincronizar.
			"00000000-0000-7000-8000-000000000501",
			adminRoleId,
			"admin@local",
			hash,
			"Admin",
			"TPV",
		],
	});
}

// ---------------- Provisión de la BD del tenant (Turso) ----------------

/**
 * El grupo de Turso donde van las bases de los tenants: el del proyecto, en Frankfurt. Tiene que
 * existir antes de desplegar: Turso no lo crea al crear una base, contesta «group not found».
 */
export const GRUPO_TURSO = "tpv";

/** Sanitiza el nombre de DB: minúsculas, números y guiones; máx 64. */
function makeDbNameFromTenant(tenantId: string): string {
	const base = `tpv-${tenantId}`.toLowerCase();
	const clean = base.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
	return clean.length <= 64 ? clean : clean.slice(0, 64);
}

async function tursoCreateDatabase(
	env: Env,
	dbName: string,
): Promise<{ name: string; hostname: string; url: string }> {
	const r = await fetch(
		`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORG_SLUG)}/databases`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ name: dbName, group: GRUPO_TURSO }),
		},
	);

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch {}

	if (!r.ok) throw new Error(`turso_create_db_failed (${r.status}) ${text}`);

	const hostname = String(data?.database?.Hostname || data?.database?.hostname || "");
	const name = String(data?.database?.Name || data?.database?.name || dbName);

	if (!hostname) throw new Error(`turso_create_db_failed_missing_hostname ${text}`);

	const url = `libsql://${hostname}`;
	return { name, hostname, url };
}

async function applyTenantSchemaOnce(tursoUrl: string, token: string): Promise<void> {
	const client = createClient({ url: tursoUrl, authToken: token });
	// Construye/actualiza el esquema aplicando las migraciones (fuente única compartida en
	// packages/database/migrations). Ver `tenantMigrations.ts`.
	await runTenantMigrations(client);
	await ensureTenantInitialAdmin(client);
}

/**
 * Garantiza que el tenant tiene su BD en Turso con el esquema aplicado y el admin inicial.
 * Si ya existe, reaplica migraciones (idempotente); si no, la crea, genera token y la registra.
 */
export async function provisionTenantDatabase(dbi: Client, env: Env, tenantId: string) {
	const existing = await getTenantDbRow(dbi, tenantId);

	if (existing?.turso_url && existing?.turso_auth_token_enc && existing?.turso_db_name) {
		const resolved = await resolveTenantDbCredentials(dbi, env, tenantId, false);
		await applyTenantSchemaOnce(resolved.tursoUrl, resolved.tursoAuthToken);
		return { reused: true, dbName: resolved.dbName, url: resolved.tursoUrl };
	}

	const dbName = makeDbNameFromTenant(tenantId);
	const created = await tursoCreateDatabase(env, dbName);
	const dbToken = await tursoCreateDbToken(env, created.name);

	await upsertTenantDbRow(dbi, env, tenantId, created.name, created.url, dbToken);
	await applyTenantSchemaOnce(created.url, dbToken);

	return { reused: false, dbName: created.name, url: created.url };
}
