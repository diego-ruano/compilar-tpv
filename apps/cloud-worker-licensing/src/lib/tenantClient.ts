// src/lib/tenantClient.ts
//
// Resolución + caché (a nivel de isolate) del cliente Turso de cada tenant, para
// las LECTURAS de la API (van directas a Turso, sin pasar por el Durable Object).
//
// - Cachea el cliente por tenant con un TTL corto para evitar un SELECT a la DB
//   central en cada petición.
// - Si una query falla por 401 (token rotado), invalida la caché, re-resuelve con
//   `forceRotate` y reintenta una vez. Mismo criterio que el DO.

import { createClient, type Client } from "@libsql/client/web";

import type { Env } from "../env";
import { getDb } from "../server/db";
import { resolveTenantDbCredentials, ensureTenantMigrated } from "../server/db/tenantDb";

type Cached = { client: Client; expiresAtMs: number };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, Cached>();

async function build(env: Env, tenantId: string, forceRotate: boolean): Promise<Client> {
	const creds = await resolveTenantDbCredentials(
		getDb(env),
		env as any,
		tenantId,
		forceRotate,
	);

	const client = createClient({
		url: creds.tursoUrl,
		authToken: creds.tursoAuthToken,
		intMode: "number",
	});

	cache.set(tenantId, { client, expiresAtMs: Date.now() + CACHE_TTL_MS });
	return client;
}

async function getTenantClient(env: Env, tenantId: string): Promise<Client> {
	const hit = cache.get(tenantId);
	const client =
		hit && hit.expiresAtMs > Date.now() ? hit.client : await build(env, tenantId, false);

	// Guard de migración: garantiza el esquema al día una vez por isolate (no-op tras la primera
	// vez). Cubre el caso de un tenant ya activo cuando se publica un cambio de esquema.
	await ensureTenantMigrated(client, tenantId);

	return client;
}

function isAuthError(e: unknown): boolean {
	const m = String((e as any)?.message ?? e ?? "").toLowerCase();
	return m.includes("401") || m.includes("unauthorized");
}

/**
 * Ejecuta una lectura contra la DB del tenant. Reintenta una vez con credenciales
 * rotadas si el token había caducado (401).
 *
 * ⚠️ La resolución del cliente va DENTRO del `try` a propósito. `getTenantClient` habla con Turso
 * por dos vías (resolver credenciales y, sobre todo, el guard de migración `ensureTenantMigrated`),
 * así que también puede lanzar 401. Cuando esa llamada quedaba fuera del `try`, un token caducado
 * hacía que el guard lanzase el 401 antes de llegar al `catch`: la rotación no se ejecutaba NUNCA y
 * **todas** las lecturas REST de la Handy se quedaban en 500 permanente (`internal_error`), sin
 * recuperarse solas. El sync seguía funcionando porque el Durable Object tiene su propio reintento
 * con rotación (`withTenantDbRetry`), de ahí que fallasen las lecturas pero no la replicación.
 */
export async function tenantQuery<T>(
	env: Env,
	tenantId: string,
	fn: (db: Client) => Promise<T>,
): Promise<T> {
	try {
		const db = await getTenantClient(env, tenantId);
		return await fn(db);
	} catch (e) {
		if (!isAuthError(e)) throw e;
		cache.delete(tenantId);
		const fresh = await build(env, tenantId, true);
		// Si el 401 vino del guard de migración, su entrada ya se invalidó al fallar: hay que
		// reintentarlo con el token nuevo antes de la query (si ya estaba migrado, es un no-op).
		await ensureTenantMigrated(fresh, tenantId);
		return await fn(fresh);
	}
}
