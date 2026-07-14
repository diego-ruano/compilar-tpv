// src/domains/licensing/licensing.helpers.ts
//
// Helpers del dominio de licencias (activación, status, webhook de Lemon). Portados desde el
// antiguo handler legacy `server/index.ts` al migrar las rutas a Hono. Reutiliza las utilidades
// compartidas del worker (base64, crypto, resolución de credenciales del tenant) en vez de
// mantener copias propias, eliminando la duplicación que arrastraba el código legacy.

import { SignJWT, jwtVerify } from "jose";
import * as ed from "@noble/ed25519";
import { createClient, type Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { getDevicePubKeyB64 } from "../../server/licenseStore";
import { b64ToBytes, bytesToB64 } from "../../server/utils/base64";
import { sha256HexStr, secretKey } from "../../server/utils/crypto";
import { runTenantMigrations } from "../../server/tenantMigrations";
import {
	getTenantDbRow,
	resolveTenantDbCredentials,
	tursoCreateDbToken,
	upsertTenantDbRow,
} from "../../server/db/tenantDb";

// ---------------- Env / utilidades genéricas ----------------

export function assertEnv(env: Env, names: (keyof Env)[]): string | null {
	for (const n of names) {
		const v = (env as any)[n];
		if (!v || String(v).trim().length === 0) return `missing_env_${String(n)}`;
	}
	return null;
}

/** Turso suele devolver 0/1; Rust espera boolean en `status`. */
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

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

// ---------------- JWT de licencia (HS256) ----------------

export async function signToken(
	env: Env,
	claims: { tenantId: string; deviceId: string; licHash: string },
): Promise<string> {
	return await new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(secretKey(env.LICENSE_JWT_SECRET));
}

export async function verifyToken(
	env: Env,
	token: string,
): Promise<{ tenantId: string; deviceId: string; licHash: string }> {
	const { payload } = await jwtVerify(token, secretKey(env.LICENSE_JWT_SECRET), {
		algorithms: ["HS256"],
	});

	const tenantId = String(payload.tenantId || "");
	const deviceId = String(payload.deviceId || "");
	const licHash = String(payload.licHash || "");

	if (!tenantId || !deviceId || !licHash) throw new Error("Invalid token claims");
	return { tenantId, deviceId, licHash };
}

// ---------------- Webhook de Lemon ----------------

export async function verifyLemonSignature(
	req: Request,
	secret: string,
	rawBody: string,
): Promise<boolean> {
	const sig = (req.headers.get("X-Signature") || "").trim().toLowerCase();

	if (!secret || secret.trim().length === 0) {
		console.log("[LEMON] Missing LEMON_WEBHOOK_SECRET in env");
		return false;
	}
	if (!sig) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

	return timingSafeEqualHex(hex, sig);
}

export async function lemonActivate(licenseKey: string, instanceName: string) {
	const body = new URLSearchParams();
	body.set("license_key", licenseKey);
	body.set("instance_name", instanceName);

	const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/activate", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch {}
	return { ok: r.ok, status: r.status, data, text };
}

// ---------------- Device proof (anti-copia, ed25519) ----------------

export async function verifyDeviceProof(
	request: Request,
	dbi: Client,
	claims: { tenantId: string; deviceId: string },
	target?: { method: string; path: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
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

	const pubB64 = await getDevicePubKeyB64(dbi, claims.tenantId, claims.deviceId);
	if (!pubB64) return { ok: false, error: "device_pubkey_not_registered" };

	const auth = request.headers.get("authorization") || "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	if (!m) return { ok: false, error: "missing_token" };
	const token = m[1];

	const tokenHash = await sha256HexStr(token);

	const method = String(target?.method || request.method).toUpperCase();
	const path = String(target?.path || new URL(request.url).pathname);

	const msg = `${ts}\n${method}\n${path}\n${tokenHash}`;

	let pub: Uint8Array;
	let sig: Uint8Array;
	try {
		pub = b64ToBytes(pubB64);
		sig = b64ToBytes(sigB64);
	} catch {
		return { ok: false, error: "bad_b64" };
	}

	const ok = await ed.verifyAsync(sig, new TextEncoder().encode(msg), pub);
	if (!ok) return { ok: false, error: "bad_device_signature" };

	return { ok: true };
}

// ---------------- Bootstrap del admin inicial del tenant ----------------

const PBKDF2_PREFIX = "$pbkdf2-sha256$";
const PBKDF2_ITERS = 600_000;
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
			body: JSON.stringify({ name: dbName, group: "default" }),
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
