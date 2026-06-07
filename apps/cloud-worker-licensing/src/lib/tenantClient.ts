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
import { resolveTenantDbCredentials } from "../server/db/tenantDb";

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
	if (hit && hit.expiresAtMs > Date.now()) return hit.client;
	return build(env, tenantId, false);
}

function isAuthError(e: unknown): boolean {
	const m = String((e as any)?.message ?? e ?? "").toLowerCase();
	return m.includes("401") || m.includes("unauthorized");
}

/**
 * Ejecuta una lectura contra la DB del tenant. Reintenta una vez con credenciales
 * rotadas si el token había caducado (401).
 */
export async function tenantQuery<T>(
	env: Env,
	tenantId: string,
	fn: (db: Client) => Promise<T>,
): Promise<T> {
	const db = await getTenantClient(env, tenantId);
	try {
		return await fn(db);
	} catch (e) {
		if (!isAuthError(e)) throw e;
		cache.delete(tenantId);
		const fresh = await build(env, tenantId, true);
		return await fn(fresh);
	}
}
