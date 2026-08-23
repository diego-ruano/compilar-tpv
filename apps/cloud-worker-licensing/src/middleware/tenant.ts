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
import { SQL_DEVICE_ACTIVO } from "../lib/deviceAuth";
import { verifyJwt, verifyDeviceProofOrThrow } from "../server/middleware/auth";
import { unauthorized } from "../server/utils/response";

export type TenantVars = {
	tenantId: string;
	deviceId: string;
	token: string;
	/** Hash de la clave de licencia (claim del JWT). Identifica la fila de `licenses`. */
	licHash: string;
};

/**
 * Rol del dispositivo según la BD central (`tpv` | `handy`). El JWT no lo lleva: la cabecera
 * `x-role` es del cliente y no puede otorgar privilegios, así que la única fuente es la fila.
 */
export async function rolDelDispositivo(
	env: Env,
	tenantId: string,
	deviceId: string,
): Promise<string> {
	const r = await getDb(env).execute({
		sql: `SELECT role FROM devices WHERE tenant_id=? AND device_id=? AND ${SQL_DEVICE_ACTIVO} LIMIT 1;`,
		args: [tenantId, deviceId],
	});
	return String((r.rows?.[0] as any)?.role || "").toLowerCase();
}

/**
 * Cobrar es cosa de la Main y solo de la Main.
 *
 * Una Handy no tiene impresora ni cajón, así que cerrar una mesa desde ella dejaría al cliente sin
 * ticket y el dinero sin registrar en el cajón. Es una decisión de producto, y quien la hace
 * cumplir es el servidor: dejarla solo en la interfaz significa que cualquiera con el token de un
 * Handy podría cobrar igualmente.
 *
 * Devuelve la respuesta de rechazo, o `null` si puede seguir.
 */
export async function soloLaMainCobra(c: any): Promise<Response | null> {
	const rol = await rolDelDispositivo(c.env, c.get("tenantId"), c.get("deviceId"));
	if (rol === "tpv") return null;
	return c.json(
		{ ok: false, code: "external", error: "cobro_solo_en_main" },
		403,
	);
}

export const tenantAuth: MiddlewareHandler<{
	Bindings: Env;
	Variables: TenantVars;
}> = async (c, next) => {
	try {
		const dbCentral = getDb(c.env);
		const { token, claims } = await verifyJwt(c.env, c.req.raw);

		// El cuerpo entra en la firma (FABLE-E). Se lee aquí una vez; Hono cachea el texto, así
		// que el handler puede seguir haciendo `c.req.json()` sin quedarse sin body.
		const rawBody = c.req.raw.body ? await c.req.text() : "";
		await verifyDeviceProofOrThrow(c.req.raw, dbCentral, claims, token, rawBody);

		c.set("tenantId", claims.tenantId);
		c.set("deviceId", claims.deviceId);
		c.set("token", token);
		c.set("licHash", claims.licHash);
	} catch (e: any) {
		// Por `unauthorized` y no por `c.json` a pelo: así la respuesta lleva el `code` del
		// catálogo compartido (ARCH-05) además del `error` de siempre. Es lo que permite al
		// cliente ramificar ante un `device_revoked` en vez de reintentar contra una pared.
		return unauthorized(c.req.raw, String(e?.message || e));
	}

	await next();
};
