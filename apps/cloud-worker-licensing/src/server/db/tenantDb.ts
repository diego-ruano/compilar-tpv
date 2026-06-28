// src/server/db/tenantDb.ts
//
// Resolución LOCAL de las credenciales de la base de datos por-tenant.
//
// Antes esto vivía únicamente dentro del worker de licensing y se consultaba
// desde el worker de API por un service binding (`TPV_LICENSING`) con una
// petición HTTP firmada por HMAC. Al fusionar ambos workers en `tpv-api`, esa
// llamada cruzada desaparece: el Durable Object (y, en el futuro, el middleware
// de tenant de la API) resuelven las credenciales invocando estas funciones
// directamente contra la DB central.
//
// La rotación del token de Turso se mantiene idéntica al comportamiento previo:
// el token se regenera de forma proactiva si supera `TENANT_DB_ROTATE_INTERVAL_MS`
// (o si se fuerza por un fallo de autenticación 401 contra la DB del tenant).

import type { Client } from "@libsql/client/web";

import { b64ToBytes, bytesToB64 } from "../utils/base64";
import { aesGcmDecryptFromB64 } from "../utils/crypto";
import { runTenantMigrations } from "../tenantMigrations";

/** Campos del Env que necesita la resolución/rotación de la DB del tenant. */
export type TenantDbEnv = {
	LICENSE_STORE_KEY: string;
	TURSO_PLATFORM_TOKEN: string;
	TURSO_ORG_SLUG: string;
};

export type ResolvedTenantDb = {
	dbName: string;
	tursoUrl: string;
	tursoAuthToken: string;
	rotated: boolean;
	rotatedAtMs: number;
};

const TENANT_DB_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------- Guard de migración por tenant (caché por isolate) ----------------
//
// Comprobar la tabla `_migrations` en Turso por HTTP en CADA petición arruinaría el rendimiento.
// Aquí cacheamos, durante el ciclo de vida del isolate del Worker, qué tenants ya han sido
// verificados/migrados. Tras la primera vez, el guard deja pasar la petición al instante.
//
// Guardamos la PROMESA (no un boolean) a propósito: así varias peticiones concurrentes del MISMO
// tenant comparten la misma migración en vuelo (single-flight) en lugar de lanzar dos a la vez.
// - Éxito  → la entrada (promesa resuelta) queda cacheada para siempre en este isolate.
// - Fallo  → se borra la entrada para reintentar en la próxima petición.
const migrationGuard = new Map<string, Promise<void>>();

/**
 * Garantiza —una sola vez por isolate y por tenant— que la BD del tenant tiene aplicadas todas las
 * migraciones. Idempotente y barato tras la primera vez (devuelve la promesa ya resuelta, sin tocar
 * Turso). Es el camino que hace que un cambio de esquema llegue a tenants YA activos sin necesidad
 * de re-provisionar manualmente.
 */
export function ensureTenantMigrated(client: Client, tenantId: string): Promise<void> {
	let inFlight = migrationGuard.get(tenantId);
	if (!inFlight) {
		inFlight = runTenantMigrations(client).catch((e) => {
			// Permite reintentar en la próxima petición (no dejamos el fallo cacheado).
			migrationGuard.delete(tenantId);
			throw e;
		});
		migrationGuard.set(tenantId, inFlight);
	}
	return inFlight;
}

// ---------------- AES-GCM encrypt (para persistir el token rotado) ----------------

async function aesGcmEncryptToB64(
	keyB64: string,
	plaintext: string,
): Promise<string> {
	const keyBytes = b64ToBytes(keyB64);
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes as unknown as BufferSource,
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	const out = new Uint8Array(iv.length + ct.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(ct), iv.length);
	return bytesToB64(out);
}

// ---------------- tenant_databases (DB central) ----------------

export async function getTenantDbRow(dbCentral: Client, tenantId: string) {
	const r = await dbCentral.execute({
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

export async function upsertTenantDbRow(
	dbCentral: Client,
	env: TenantDbEnv,
	tenantId: string,
	dbName: string,
	tursoUrl: string,
	tursoTokenPlain: string,
) {
	const enc = await aesGcmEncryptToB64(env.LICENSE_STORE_KEY, tursoTokenPlain);
	await dbCentral.execute({
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

export async function tursoCreateDbToken(
	env: TenantDbEnv,
	dbName: string,
): Promise<string> {
	const r = await fetch(
		`https://api.turso.tech/v1/organizations/${encodeURIComponent(
			env.TURSO_ORG_SLUG,
		)}/databases/${encodeURIComponent(dbName)}/auth/tokens?expiration=7d`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.TURSO_PLATFORM_TOKEN}`,
				Accept: "application/json",
			},
		},
	);

	const text = await r.text();
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch {}

	if (!r.ok) throw new Error(`turso_create_db_token_failed (${r.status}) ${text}`);

	const jwt = String(data?.jwt || "");
	if (!jwt) throw new Error(`turso_create_db_token_failed_missing_jwt ${text}`);
	return jwt;
}

function toNumOrNull(v: any): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function getTenantTokenAgeBaseMs(row: any): number {
	return toNumOrNull(row?.rotated_at_ms) ?? toNumOrNull(row?.created_at_ms) ?? 0;
}

/**
 * Resuelve (y rota si procede) las credenciales de la DB del tenant.
 *
 * @param dbCentral  Cliente libsql a la DB central (control).
 * @param env        Secretos para descifrar/rotar el token.
 * @param tenantId   Tenant a resolver.
 * @param forceRotate Fuerza la generación de un token nuevo (p. ej. tras un 401).
 */
export async function resolveTenantDbCredentials(
	dbCentral: Client,
	env: TenantDbEnv,
	tenantId: string,
	forceRotate = false,
): Promise<ResolvedTenantDb> {
	const row = await getTenantDbRow(dbCentral, tenantId);

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
		await upsertTenantDbRow(dbCentral, env, tenantId, dbName, tursoUrl, freshToken);

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
		String(row.turso_auth_token_enc),
	);

	return {
		dbName,
		tursoUrl,
		tursoAuthToken: token,
		rotated: false,
		rotatedAtMs: lastRotationBaseMs,
	};
}
