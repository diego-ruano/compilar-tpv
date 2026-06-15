// src/server/index.ts
import { SignJWT, jwtVerify } from "jose";
import * as ed from "@noble/ed25519";
import type {
	ActivateRequest,
	ActivateResponse,
	ApiError,
	LemonWebhookPayload,
	LicenseStatus,
} from "../shared";

import { getDb, type TursoEnv } from "./db";
import {
	ensureExtraSchema,
	ensureTenantExistsMinimal,
	ensureDevice,
	upsertLicenseFromEventOrActivation,
	upsertLicenseInstance,
	getLicenseByHash,
	getDecryptedLicenseKey,
	upsertWebhookEvent,
	markWebhookProcessed,
	getDevicePubKeyB64,
	setDevicePubKeyB64IfEmptyOrThrow,
} from "./licenseStore";
import { sha256Hex } from "./crypto";

import { createClient, type Client } from "@libsql/client";
import TPV_SCHEMA_SQL from "../../../../packages/database/schema.sql";

// ---------------- Env ----------------

export interface Env extends TursoEnv {
	LEMON_WEBHOOK_SECRET: string;
	LICENSE_JWT_SECRET: string;
	LICENSE_STORE_KEY: string; // base64 32 bytes (AES-GCM)

	// ✅ Turso Platform API (para crear DBs + tokens)
	TURSO_PLATFORM_TOKEN: string; // Bearer token (platform)
	TURSO_ORG_SLUG: string; // "altarialights" (slug de org o user)
}

// ---------------- Helpers ----------------

function json(data: any, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function requireJson(req: Request) {
	const ct = req.headers.get("content-type") || "";
	if (!ct.toLowerCase().includes("application/json")) {
		return json({ ok: false, error: "Content-Type must be application/json" }, 415);
	}
	return null;
}

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function secretKey(str: string) {
	return new TextEncoder().encode(str);
}

function assertEnv(env: Env, names: (keyof Env)[]) {
	for (const n of names) {
		const v = (env as any)[n];
		if (!v || String(v).trim().length === 0) return `missing_env_${String(n)}`;
	}
	return null;
}

async function signToken(env: Env, claims: { tenantId: string; deviceId: string; licHash: string }) {
	return await new SignJWT(claims)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(secretKey(env.LICENSE_JWT_SECRET));
}

async function verifyToken(env: Env, token: string) {
	const { payload } = await jwtVerify(token, secretKey(env.LICENSE_JWT_SECRET), {
		algorithms: ["HS256"],
	});

	const tenantId = String(payload.tenantId || "");
	const deviceId = String(payload.deviceId || "");
	const licHash = String(payload.licHash || "");

	if (!tenantId || !deviceId || !licHash) throw new Error("Invalid token claims");
	return { tenantId, deviceId, licHash };
}

function timingSafeEqualHex(a: string, b: string) {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

async function verifyLemonSignature(req: Request, secret: string, rawBody: string) {
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
		["sign"]
	);

	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

	return timingSafeEqualHex(hex, sig);
}

/** ✅ FIX: Turso suele devolver 0/1; Rust espera boolean en status */
function toBool01(v: any, fallback = false): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (s === "true" || s === "1") return true;
		if (s === "false" || s === "0") return false;
	}
	return fallback;
}

// ---------------- Base64 helpers ----------------

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

// ---------------- AES-GCM (para turso_auth_token_enc) ----------------

async function aesGcmEncryptToB64(keyB64: string, plaintext: string): Promise<string> {
	const keyBytes = b64ToBytes(keyB64);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext)
	);
	const out = new Uint8Array(iv.length + ct.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(ct), iv.length);
	return bytesToB64(out);
}

async function aesGcmDecryptFromB64(keyB64: string, payloadB64: string): Promise<string> {
	const raw = b64ToBytes(payloadB64);
	const iv = raw.slice(0, 12);
	const data = raw.slice(12);
	const keyBytes = b64ToBytes(keyB64);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
	return new TextDecoder().decode(pt);
}

// ---------------- Device Proof (anti-copia) ----------------

async function sha256HexStr(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyDeviceProof(
	request: Request,
	dbi: ReturnType<typeof getDb>,
	claims: { tenantId: string; deviceId: string },
	target?: { method: string; path: string }
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

// ---------------- Lemon License API ----------------

async function lemonActivate(licenseKey: string, instanceName: string) {
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
	} catch { }
	return { ok: r.ok, status: r.status, data, text };
}

async function lemonValidate(licenseKey: string, instanceId?: string | null) {
	const body = new URLSearchParams();
	body.set("license_key", licenseKey);
	if (instanceId) body.set("instance_id", instanceId);

	const r = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
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
	} catch { }
	return { ok: r.ok, status: r.status, data, text };
}

// ---------------- Initial tenant admin bootstrap ----------------

const PBKDF2_PREFIX = "$pbkdf2-sha256$";
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

	if (p.length < 4) {
		throw new Error("PIN demasiado corto");
	}

	const salt = randomBytes(PBKDF2_SALT_LEN);

	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(p),
		"PBKDF2",
		false,
		["deriveBits"]
	);

	const bits = await crypto.subtle.deriveBits(
		{
			name: "PBKDF2",
			salt,
			iterations: PBKDF2_ITERS,
			hash: "SHA-256",
		},
		keyMaterial,
		PBKDF2_DK_LEN * 8
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
	args: any[] = []
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
	args: any[] = []
): Promise<string | null> {
	const r = await client.execute({ sql, args });
	const row = r.rows?.[0] as any | undefined;
	if (!row) return null;

	const firstKey = Object.keys(row)[0] || "";
	const v = row?.[firstKey] ?? row?.[0];
	return v == null ? null : String(v);
}

async function ensureTenantInitialAdmin(client: Client): Promise<void> {
	// Los roles ya los siembra schema.sql con sus UUIDv7 fijos; aquí sólo creamos
	// el usuario admin inicial si la tabla Usuarios está vacía.
	const usersCount = await tenantQuerySingleNumber(
		client,
		`SELECT COUNT(*) AS count FROM Usuarios;`
	);

	if (usersCount > 0) {
		return;
	}

	const adminRoleId = await tenantQuerySingleString(
		client,
		`
			SELECT ID_Rol AS id
			FROM Roles
			WHERE Nombre_Rol = 'Administrador'
			LIMIT 1;
		`
	);

	if (!adminRoleId) {
		throw new Error("initial_admin_role_missing");
	}

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
			VALUES (
				?,
				?,
				?,
				?,
				?,
				?,
				'Activo',
				1
			);
		`,
		args: [
			// UUID FIJO: debe coincidir con el admin que siembra la Main (ADMIN_USUARIO_ID en
			// crates/tpv-infra-sqlite/src/util.rs). Si difiere, la Handy referencia un admin que
			// la Main no tiene y los fichajes/comandas revientan con FOREIGN KEY al sincronizar.
			"00000000-0000-7000-8000-000000000501",
			adminRoleId,
			"admin@local",
			hash,
			"Admin",
			"TPV",
		],
	});
}

async function ensureTenantInitialAdminByCredentials(
	tursoUrl: string,
	token: string
): Promise<void> {
	const client: Client = createClient({
		url: tursoUrl,
		authToken: token,
	});

	try {
		await ensureTenantInitialAdmin(client);
	} catch (e: any) {
		const msg = String(e?.message || e).toLowerCase();

		if (
			msg.includes("no such table") ||
			msg.includes("sqlite_error") ||
			msg.includes("schema")
		) {
			await applyTenantSchemaOnce(tursoUrl, token);
			return;
		}

		throw e;
	}
}


// Sanitiza nombre db: minúsculas, números y guiones; max 64
function makeDbNameFromTenant(tenantId: string): string {
	const base = `tpv-${tenantId}`.toLowerCase();
	const clean = base.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
	return clean.length <= 64 ? clean : clean.slice(0, 64);
}

async function tursoCreateDatabase(env: Env, dbName: string): Promise<{ name: string; hostname: string; url: string }> {
	const r = await fetch(`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORG_SLUG)}/databases`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			name: dbName,
			group: "default",
		}),
	});

	const text = await r.text();
	let data: any = null;
	try { data = JSON.parse(text); } catch { }

	if (!r.ok) {
		throw new Error(`turso_create_db_failed (${r.status}) ${text}`);
	}

	const hostname = String(data?.database?.Hostname || data?.database?.hostname || "");
	const name = String(data?.database?.Name || data?.database?.name || dbName);

	if (!hostname) throw new Error(`turso_create_db_failed_missing_hostname ${text}`);

	const url = `libsql://${hostname}`;
	return { name, hostname, url };
}

async function tursoCreateDbToken(env: Env, dbName: string): Promise<string> {
	const r = await fetch(
		`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORG_SLUG)}/databases/${encodeURIComponent(
			dbName
		)}/auth/tokens?expiration=7d`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
				Accept: "application/json",
			},
		}
	);

	const text = await r.text();
	let data: any = null;
	try { data = JSON.parse(text); } catch { }

	if (!r.ok) throw new Error(`turso_create_db_token_failed (${r.status}) ${text}`);

	const jwt = String(data?.jwt || "");
	if (!jwt) throw new Error(`turso_create_db_token_failed_missing_jwt ${text}`);
	return jwt;
}

async function getTenantDbRow(dbi: ReturnType<typeof getDb>, tenantId: string) {
	const r = await dbi.execute({
		sql: `
			SELECT
				tenant_id,
				turso_db_name,
				turso_url,
				turso_auth_token_enc,
				created_at_ms,
				rotated_at_ms
			FROM tenant_databases
			WHERE tenant_id = ?
			LIMIT 1
		`,
		args: [tenantId],
	});
	return r.rows?.[0] as any | undefined;
}

async function upsertTenantDbRow(
	dbi: ReturnType<typeof getDb>,
	env: Env,
	tenantId: string,
	dbName: string,
	tursoUrl: string,
	tursoTokenPlain: string
) {
	const enc = await aesGcmEncryptToB64(env.LICENSE_STORE_KEY, tursoTokenPlain);
	await dbi.execute({
		sql: `INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc, created_at_ms, rotated_at_ms)
		      VALUES (?, ?, ?, ?, unixepoch()*1000, NULL)
		      ON CONFLICT(tenant_id) DO UPDATE SET
		        turso_db_name = excluded.turso_db_name,
		        turso_url = excluded.turso_url,
		        turso_auth_token_enc = excluded.turso_auth_token_enc,
		        rotated_at_ms = unixepoch()*1000`,
		args: [tenantId, dbName, tursoUrl, enc],
	});
}

const TENANT_DB_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function toNumOrNull(v: any): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function getTenantTokenAgeBaseMs(row: any): number {
	return (
		toNumOrNull(row?.rotated_at_ms) ??
		toNumOrNull(row?.created_at_ms) ??
		0
	);
}

async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(raw)
	);

	return [...new Uint8Array(mac)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifyInternalWorkerRequest(
	req: Request,
	env: Env,
	rawBody: string
): Promise<void> {
	const tsStr = (req.headers.get("x-internal-ts") || "").trim();
	const sigHex = (req.headers.get("x-internal-sig") || "").trim().toLowerCase();

	if (!tsStr || !sigHex) throw new Error("missing_internal_auth");

	const ts = Number(tsStr);
	if (!Number.isFinite(ts)) throw new Error("bad_internal_ts");

	const now = Date.now();
	const MAX_SKEW_MS = 60 * 1000;
	if (Math.abs(now - ts) > MAX_SKEW_MS) throw new Error("internal_ts_out_of_range");

	const payload = `${ts}\n${req.method.toUpperCase()}\n${new URL(req.url).pathname}\n${rawBody}`;
	const expected = await hmacSha256Hex(
		String(env.LICENSE_JWT_SECRET || ""),
		payload
	);

	if (!timingSafeEqualHex(expected, sigHex)) {
		throw new Error("bad_internal_signature");
	}
}

async function resolveTenantDbCredentials(
	dbi: ReturnType<typeof getDb>,
	env: Env,
	tenantId: string,
	forceRotate = false
): Promise<{
	dbName: string;
	tursoUrl: string;
	tursoAuthToken: string;
	rotated: boolean;
	rotatedAtMs: number;
}> {
	const row = await getTenantDbRow(dbi, tenantId);

	if (!row?.turso_db_name || !row?.turso_url || !row?.turso_auth_token_enc) {
		throw new Error("tenant_db_not_provisioned");
	}

	const dbName = String(row.turso_db_name);
	const tursoUrl = String(row.turso_url);
	const lastRotationBaseMs = getTenantTokenAgeBaseMs(row);
	const shouldRotate =
		forceRotate ||
		!lastRotationBaseMs ||
		Date.now() - lastRotationBaseMs >= TENANT_DB_ROTATE_INTERVAL_MS;

	if (shouldRotate) {
		const freshToken = await tursoCreateDbToken(env, dbName);

		await upsertTenantDbRow(
			dbi,
			env,
			tenantId,
			dbName,
			tursoUrl,
			freshToken
		);

		return {
			dbName,
			tursoUrl,
			tursoAuthToken: freshToken,
			rotated: true,
			rotatedAtMs: Date.now(),
		};
	}

	const token = await aesGcmDecryptFromB64(
		env.LICENSE_STORE_KEY,
		String(row.turso_auth_token_enc)
	);

	return {
		dbName,
		tursoUrl,
		tursoAuthToken: token,
		rotated: false,
		rotatedAtMs: lastRotationBaseMs,
	};
}

async function applyTenantSchemaOnce(tursoUrl: string, token: string): Promise<void> {
	const client: Client = createClient({
		url: tursoUrl,
		authToken: token,
	});

	// El parser de Turso (sqld) rechaza los comentarios de bloque `/* */` del schema
	// ("non-terminated block comment at (1,1)"), pase por `batch` o por `executeMultiple`.
	// Los quitamos y ejecutamos el SQL completo como un único script multi-statement.
	// El schema no usa `/*` dentro de literales, así que el strip es seguro.
	const sql = TPV_SCHEMA_SQL.replace(/\/\*[\s\S]*?\*\//g, "");
	await client.executeMultiple(sql);

	await ensureTenantInitialAdmin(client);
}

async function provisionTenantDatabase(dbi: ReturnType<typeof getDb>, env: Env, tenantId: string) {
	const existing = await getTenantDbRow(dbi, tenantId);

	if (existing?.turso_url && existing?.turso_auth_token_enc && existing?.turso_db_name) {
		const resolved = await resolveTenantDbCredentials(dbi, env, tenantId, false);
		await applyTenantSchemaOnce(resolved.tursoUrl, resolved.tursoAuthToken);

		return {
			reused: true,
			dbName: resolved.dbName,
			url: resolved.tursoUrl,
		};
	}

	const dbName = makeDbNameFromTenant(tenantId);

	const created = await tursoCreateDatabase(env, dbName);
	const dbToken = await tursoCreateDbToken(env, created.name);

	await upsertTenantDbRow(dbi, env, tenantId, created.name, created.url, dbToken);

	await applyTenantSchemaOnce(created.url, dbToken);

	return { reused: false, dbName: created.name, url: created.url };
}

// ---------------- Worker ----------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// DB init (lazy)
		let db: ReturnType<typeof getDb> | null = null;
		const get = () => {
			if (!db) db = getDb(env);
			return db!;
		};

		if (url.pathname === "/health") {
			return json({ ok: true, service: "tpv-licensing", ts: Date.now() });
		}

		if (url.pathname === "/internal/tenant-db/resolve" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			try {
				await verifyInternalWorkerRequest(request, env, raw);
			} catch (e: any) {
				return json({ ok: false, error: String(e?.message || e) }, 401);
			}

			let body: any = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const originalMethod = String(body?.originalMethod || "").toUpperCase();
			const originalPath = String(body?.originalPath || "");
			const forceRotate = !!body?.forceRotate;

			if (!originalMethod || !originalPath.startsWith("/")) {
				return json({ ok: false, error: "invalid_original_request" }, 400);
			}

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(
				request,
				dbi,
				{ tenantId: claims.tenantId, deviceId: claims.deviceId },
				{ method: originalMethod, path: originalPath }
			);

			if (!proof.ok) {
				return json({ ok: false, error: proof.error }, 401);
			}

			try {
				const resolved = await resolveTenantDbCredentials(
					dbi,
					env,
					claims.tenantId,
					forceRotate
				);

				await ensureTenantInitialAdminByCredentials(
					resolved.tursoUrl,
					resolved.tursoAuthToken
				);

				return json({
					ok: true,
					result: {
						token: m[1],
						claims,
						...resolved,
					},
				});
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_resolve_failed",
						details: String(e?.message || e),
					},
					500
				);
			}
		}

		if (url.pathname === "/internal/tenant-db/resolve-by-tenant" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			try {
				await verifyInternalWorkerRequest(request, env, raw);
			} catch (e: any) {
				return json({ ok: false, error: String(e?.message || e) }, 401);
			}

			let body: any = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const tenantId = String(body?.tenantId || "").trim();
			const forceRotate = !!body?.forceRotate;

			if (!tenantId) {
				return json({ ok: false, error: "missing_tenant_id" }, 400);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			try {
				const resolved = await resolveTenantDbCredentials(
					dbi,
					env,
					tenantId,
					forceRotate
				);

				await ensureTenantInitialAdminByCredentials(
					resolved.tursoUrl,
					resolved.tursoAuthToken
				);

				return json({
					ok: true,
					result: {
						tenantId,
						...resolved,
					},
				});
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_resolve_failed",
						details: String(e?.message || e),
					},
					500
				);
			}
		}

		// 1) WEBHOOK Lemon
		if (url.pathname === "/v1/webhooks/lemon" && request.method === "POST") {
			const miss = assertEnv(env, ["LEMON_WEBHOOK_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "LICENSE_STORE_KEY"]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const raw = await request.text();

			console.log("[LEMON] webhook hit", {
				ts: Date.now(),
				sigPresent: Boolean((request.headers.get("X-Signature") || "").trim()),
				bytes: raw.length,
			});

			const validSig = await verifyLemonSignature(request, env.LEMON_WEBHOOK_SECRET, raw);
			if (!validSig) return json({ ok: false, error: "invalid_signature" }, 401);

			const sig = (request.headers.get("X-Signature") || "").trim().toLowerCase();
			const bodySha = await sha256Hex(raw);
			const eventUid = await sha256Hex(sig + ":" + bodySha);

			const dbi = get();
			await ensureExtraSchema(dbi);

			let payload: LemonWebhookPayload | null = null;
			try {
				payload = JSON.parse(raw);
			} catch {
				return json({ ok: false, error: "invalid_json" }, 400);
			}

			const eventName = String(payload?.meta?.event_name || "");
			const testMode = Boolean(payload?.meta?.test_mode);

			const resourceType = (payload as any)?.data?.type ? String((payload as any).data.type) : null;
			const resourceId = (payload as any)?.data?.id ? String((payload as any).data.id) : null;

			const idemp = await upsertWebhookEvent(dbi, {
				event_uid: eventUid,
				event_name: eventName || "unknown",
				resource_type: resourceType,
				resource_id: resourceId,
				sig_hex: sig || null,
				body_sha256: bodySha,
				payload_json: raw,
			});

			if (idemp.already) {
				return json({ ok: true, received: true, eventName, idempotent: true });
			}

			try {
				const attrs = payload?.data?.attributes || {};
				const licenseKey = String((attrs as any).key || "").trim();
				const status = String((attrs as any).status || "unknown").trim() as LicenseStatus;
				const expiresAt = (attrs as any).expires_at ? String((attrs as any).expires_at) : null;

				console.log("[LEMON] event", { eventName, hasKey: Boolean(licenseKey), status, expiresAt, testMode });

				if (licenseKey) {
					await upsertLicenseFromEventOrActivation({
						db: dbi,
						storeKeyB64: env.LICENSE_STORE_KEY,
						licenseKeyPlain: licenseKey,
						tenantId: null,
						status: (status || "active") as LicenseStatus,
						expiresAt,
						testMode,

						lemon_license_key_id: resourceId,
						lemon_created_at: (attrs as any).created_at ? String((attrs as any).created_at) : null,
						lemon_updated_at: (attrs as any).updated_at ? String((attrs as any).updated_at) : null,

						meta: { eventName, payload },
					});
				}

				await markWebhookProcessed(dbi, eventUid, true);
				return json({ ok: true, received: true, eventName });
			} catch (e: any) {
				await markWebhookProcessed(dbi, eventUid, false, String(e?.message || e));
				return json({ ok: false, error: "webhook_processing_failed" }, 500);
			}
		}

		// 2) ACTIVAR (TPV MAIN)
		if (url.pathname === "/v1/license/activate" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
				"TURSO_PLATFORM_TOKEN",
				"TURSO_ORG_SLUG",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const err = requireJson(request);
			if (err) return err;

			const body = await readJsonSafe<ActivateRequest & { devicePubKey?: string }>(
				request,
				{
					activationKey: "",
					deviceId: "",
					instanceName: undefined,
				} as any
			);

			const activationKey = String((body as any).activationKey || "").trim();

			// ✅ deviceId: si viene, lo respetamos; si no, lo genera el Worker
			const reqDeviceId = String((body as any).deviceId || "").trim();
			const deviceId = reqDeviceId || crypto.randomUUID();

			// ✅ NUEVO: devicePubKey (obligatoria para anti-copia)
			const devicePubKey = String((body as any).devicePubKey || "").trim();
			if (!devicePubKey) {
				return json({ ok: false, error: "devicePubKey required" }, 400);
			}

			// ✅ instanceName: si no viene, lo generamos a partir del deviceId
			const reqInstanceName = String((body as any).instanceName || "").trim();
			const instanceName = reqInstanceName || `tpv-${deviceId.slice(0, 12)}`;

			if (!activationKey) {
				const out: ApiError = { ok: false, error: "activationKey required" };
				return json(out, 400);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			// ✅ Idempotencia antes de tocar Lemon:
			const licHash = await sha256Hex(activationKey);
			const existing = await getLicenseByHash(dbi, licHash);

			let act: { ok: boolean; status: number; data: any; text: string } | null = null;

			if (!existing || !existing.tenant_id || existing.tenant_id === "PENDING") {
				act = await lemonActivate(activationKey, instanceName);
				if (!act.ok) {
					const out: ApiError = {
						ok: false,
						error: act.data?.error || "lemon_activate_failed",
						details: act.data || act.text,
					};
					return json(out, 400);
				}
			} else {
				act = {
					ok: true,
					status: 200,
					data: { license_key: { status: existing.status, expires_at: existing.expires_at }, meta: { reused: true } },
					text: "",
				};
			}

			const licenseKeyObj = act.data?.license_key;
			const instanceObj = act.data?.instance;

			const status = (licenseKeyObj?.status || "active") as LicenseStatus;
			const expiresAt = licenseKeyObj?.expires_at ? String(licenseKeyObj.expires_at) : null;
			const instanceId = instanceObj?.id ? String(instanceObj.id) : null;

			let tenantId =
				existing?.tenant_id && existing.tenant_id !== "PENDING"
					? existing.tenant_id
					: crypto.randomUUID();

			// Garantiza tenant y device
			await ensureTenantExistsMinimal(dbi, tenantId);

			// ✅ ensureDevice ahora también guarda pubkey si procede (y controla mismatch)
			await ensureDevice(dbi, tenantId, deviceId, "tpv", devicePubKey);

			// ✅ extra seguridad: si ya existía key distinta, esto lanza 409
			await setDevicePubKeyB64IfEmptyOrThrow(dbi, tenantId, deviceId, devicePubKey);

			const { license } = await upsertLicenseFromEventOrActivation({
				db: dbi,
				storeKeyB64: env.LICENSE_STORE_KEY,
				licenseKeyPlain: activationKey,
				tenantId,
				status,
				expiresAt,
				testMode: Boolean(act.data?.meta?.test_mode),

				lemon_license_key_id: licenseKeyObj?.id ? String(licenseKeyObj.id) : existing?.lemon_license_key_id ?? null,
				lemon_customer_id: licenseKeyObj?.customer_id ? String(licenseKeyObj.customer_id) : null,
				lemon_order_id: licenseKeyObj?.order_id ? String(licenseKeyObj.order_id) : null,
				lemon_order_item_id: licenseKeyObj?.order_item_id ? String(licenseKeyObj.order_item_id) : null,
				lemon_store_id: licenseKeyObj?.store_id ? String(licenseKeyObj.store_id) : null,
				lemon_product_id: licenseKeyObj?.product_id ? String(licenseKeyObj.product_id) : null,

				instances_count: typeof licenseKeyObj?.instances_count === "number" ? licenseKeyObj.instances_count : null,
				activation_limit: typeof licenseKeyObj?.activation_limit === "number" ? licenseKeyObj.activation_limit : null,

				user_name: licenseKeyObj?.user_name ? String(licenseKeyObj.user_name) : null,
				user_email: licenseKeyObj?.user_email ? String(licenseKeyObj.user_email) : null,

				lemon_created_at: licenseKeyObj?.created_at ? String(licenseKeyObj.created_at) : null,
				lemon_updated_at: licenseKeyObj?.updated_at ? String(licenseKeyObj.updated_at) : null,

				meta: act.data?.meta || null,
			});

			if (instanceId) {
				await upsertLicenseInstance(dbi, {
					instanceId,
					licenseId: license.license_id,
					tenantId,
					deviceId,
					instanceName: instanceName || null,
				});
			}

			// ✅ Provision tenant DB + aplicar schema + admin inicial
			try {
				await provisionTenantDatabase(dbi, env, tenantId);
			} catch (e: any) {
				return json(
					{
						ok: false,
						error: "tenant_db_provision_failed",
						details: String(e?.message || e),
					},
					500
				);
			}

			const token = await signToken(env, { tenantId, deviceId, licHash });

			const out: ActivateResponse & { deviceId: string } = {
				ok: true,
				tenantId,
				deviceId,
				token,
				status,
				expiresAt,
			};

			return json(out);
		}

		// 3) STATUS
		if (url.pathname === "/v1/license/status" && request.method === "GET") {
			const miss = assertEnv(env, ["LICENSE_JWT_SECRET", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(request, dbi, { tenantId: claims.tenantId, deviceId: claims.deviceId });
			if (!proof.ok) return json({ ok: false, error: proof.error }, 401);

			const lic = await getLicenseByHash(dbi, claims.licHash);
			if (!lic) return json({ ok: false, error: "not_found" }, 404);

			return json({
				ok: true,
				state: {
					tenant_id: lic.tenant_id,
					status: lic.status,
					expires_at: lic.expires_at,
					disabled: toBool01((lic as any).disabled, false),
					test_mode: toBool01((lic as any).test_mode, false),
					key_short: lic.key_short,
					updated_at_ms: lic.updated_at_ms,
					created_at_ms: lic.created_at_ms,
				},
				serverTime: Date.now(),
			});
		}

		// 4) VALIDATE (re-check con Lemon)
		if (url.pathname === "/v1/license/validate" && request.method === "POST") {
			const miss = assertEnv(env, [
				"LICENSE_JWT_SECRET",
				"LICENSE_STORE_KEY",
				"TURSO_DATABASE_URL",
				"TURSO_AUTH_TOKEN",
			]);
			if (miss) return json({ ok: false, error: miss }, 500);

			const h = request.headers.get("authorization") || "";
			const m = h.match(/^Bearer\s+(.+)$/i);
			if (!m) return json({ ok: false, error: "missing_token" }, 401);

			let claims: { tenantId: string; deviceId: string; licHash: string };
			try {
				claims = await verifyToken(env, m[1]);
			} catch {
				return json({ ok: false, error: "invalid_token" }, 401);
			}

			const dbi = get();
			await ensureExtraSchema(dbi);

			const proof = await verifyDeviceProof(request, dbi, { tenantId: claims.tenantId, deviceId: claims.deviceId });
			if (!proof.ok) return json({ ok: false, error: proof.error }, 401);

			const dec = await getDecryptedLicenseKey(dbi, env.LICENSE_STORE_KEY, claims.licHash);
			if (!dec) return json({ ok: false, error: "not_found" }, 404);

			const licenseKey = dec.licenseKey;

			const val = await lemonValidate(licenseKey, null);
			if (!val.ok) {
				return json({ ok: false, error: "lemon_validate_failed", details: val.data || val.text }, 400);
			}

			const status = (val.data?.license_key?.status || "active") as LicenseStatus;
			const expiresAt = val.data?.license_key?.expires_at ? String(val.data.license_key.expires_at) : null;

			await upsertLicenseFromEventOrActivation({
				db: dbi,
				storeKeyB64: env.LICENSE_STORE_KEY,
				licenseKeyPlain: licenseKey,
				tenantId: dec.lic.tenant_id,
				status,
				expiresAt,
				testMode: Boolean(val.data?.meta?.test_mode),
				instances_count:
					typeof val.data?.license_key?.instances_count === "number"
						? val.data.license_key.instances_count
						: null,
				activation_limit:
					typeof val.data?.license_key?.activation_limit === "number"
						? val.data.license_key.activation_limit
						: null,
				lemon_updated_at: val.data?.license_key?.updated_at ? String(val.data.license_key.updated_at) : null,
				meta: val.data?.meta || null,
			});

			return json({ ok: true, status, expiresAt, valid: val.data?.valid, meta: val.data?.meta });
		}

		return new Response("Not found", { status: 404 });
	},
};