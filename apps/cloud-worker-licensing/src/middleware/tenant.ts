// src/middleware/tenant.ts
//
// Middleware de autenticación de tenant para los endpoints de negocio (Handy).
//
// Verifica el JWT HS256 + el "device proof" ed25519 (mismas comprobaciones que el
// resto del worker) y deja en el contexto de Hono el tenant/dispositivo, para que
// los handlers solo tengan que pedir el cliente Turso (lecturas) o aplicar comandos
// vía el DO (escrituras).

import type { MiddlewareHandler } from "hono";

import type { Env } from "../env";
import { getDb } from "../server/db";
import { verifyJwt, verifyDeviceProofOrThrow } from "../server/middleware/auth";

export type TenantVars = {
	tenantId: string;
	deviceId: string;
	token: string;
};

export const tenantAuth: MiddlewareHandler<{
	Bindings: Env;
	Variables: TenantVars;
}> = async (c, next) => {
	try {
		const dbCentral = getDb(c.env);
		const { token, claims } = await verifyJwt(c.env, c.req.raw);
		await verifyDeviceProofOrThrow(c.req.raw, dbCentral, claims, token);

		c.set("tenantId", claims.tenantId);
		c.set("deviceId", claims.deviceId);
		c.set("token", token);
	} catch (e: any) {
		return c.json({ error: String(e?.message || e) }, 401);
	}

	await next();
};
