// src/server/middleware/withTenant.ts
import type { Client } from "@libsql/client/web";

export type AuthClaims = {
	tenantId: string;
	deviceId: string;
	licHash: string;
};

export type TenantContext = {
	token: string;
	claims: AuthClaims;

	dbTenant: Client;
	db: Client;
};

type ResolveTenantDbResult = {
	token: string;
	claims: AuthClaims;
	dbName: string;
	tursoUrl: string;
	tursoAuthToken: string;
	rotated: boolean;
	rotatedAtMs: number;
};

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function hmacSha256Hex(secret: string, raw: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(raw),
	);

	return toHex(new Uint8Array(mac));
}

async function buildInternalSignature(
	env: any,
	method: string,
	path: string,
	bodyText: string,
): Promise<{ ts: string; sig: string }> {
	const secret = String(env?.LICENSE_JWT_SECRET || "").trim();
	if (!secret) throw new Error("missing_env_LICENSE_JWT_SECRET");

	const ts = String(Date.now());
	const payload = `${ts}\n${method.toUpperCase()}\n${path}\n${bodyText}`;
	const sig = await hmacSha256Hex(secret, payload);

	return { ts, sig };
}

function isTursoAuthError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err ?? "").toLowerCase();

	return (
		msg.includes("server returned http status 401") ||
		msg.includes("http status 401") ||
		msg.includes("unauthorized")
	);
}

async function probeTenantDb(db: Client): Promise<void> {
	await db.execute({
		sql: "SELECT 1 AS ok;",
		args: [],
	});
}

async function callLicensingResolveTenantDb(
	req: Request,
	env: any,
	forceRotate: boolean,
): Promise<ResolveTenantDbResult> {
	const binding = env?.TPV_LICENSING;
	if (!binding || typeof binding.fetch !== "function") {
		throw new Error("missing_service_binding_tpv_licensing");
	}

	const path = "/internal/tenant-db/resolve";
	const bodyObj = {
		forceRotate,
		originalMethod: req.method.toUpperCase(),
		originalPath: new URL(req.url).pathname,
	};
	const bodyText = JSON.stringify(bodyObj);

	const { ts, sig } = await buildInternalSignature(
		env,
		"POST",
		path,
		bodyText,
	);

	const headers = new Headers();
	headers.set("content-type", "application/json");
	headers.set("x-internal-ts", ts);
	headers.set("x-internal-sig", sig);

	const auth = req.headers.get("authorization");
	if (auth) headers.set("authorization", auth);

	const deviceTs = req.headers.get("X-Device-Ts");
	if (deviceTs) headers.set("X-Device-Ts", deviceTs);

	const deviceSig = req.headers.get("X-Device-Sig");
	if (deviceSig) headers.set("X-Device-Sig", deviceSig);

	const res = await binding.fetch(
		new Request(`https://tpv-licensing${path}`, {
			method: "POST",
			headers,
			body: bodyText,
		}),
	);

	const raw = await res.text().catch(() => "");
	let parsed: any = null;

	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}

	if (!res.ok || !parsed?.ok) {
		const err =
			parsed?.error ||
			parsed?.details ||
			raw ||
			`internal_tenant_resolve_failed_${res.status}`;
		throw new Error(String(err));
	}

	return parsed.result as ResolveTenantDbResult;
}

export async function buildTenantContext(
	req: Request,
	_env: any,
	_dbCentral: Client,
	makeTenantClient: (cfg: { url: string; authToken: string }) => Client,
): Promise<TenantContext> {
	const env = _env;

	const first = await callLicensingResolveTenantDb(req, env, false);

	let dbTenant = makeTenantClient({
		url: first.tursoUrl,
		authToken: first.tursoAuthToken,
	});

	try {
		await probeTenantDb(dbTenant);

		return {
			token: first.token,
			claims: first.claims,
			dbTenant,
			db: dbTenant,
		};
	} catch (e) {
		if (!isTursoAuthError(e)) {
			throw e;
		}
	}

	const second = await callLicensingResolveTenantDb(req, env, true);

	dbTenant = makeTenantClient({
		url: second.tursoUrl,
		authToken: second.tursoAuthToken,
	});

	await probeTenantDb(dbTenant);

	return {
		token: second.token,
		claims: second.claims,
		dbTenant,
		db: dbTenant,
	};
}