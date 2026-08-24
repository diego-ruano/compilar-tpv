// src/server/middleware/withTenant.ts
//
// Contexto de autenticación de dispositivo para los endpoints autenticados.
//
// IMPORTANTE: tras fusionar los workers, este middleware ya NO hace la llamada
// HTTP cruzada al worker de licensing (que resolvía además la DB del tenant).
// Las comprobaciones de seguridad son EXACTAMENTE las mismas que antes —
// verificación del JWT HS256 + "device proof" ed25519 contra la DB central—,
// pero ahora se ejecutan en proceso.
//
// Los endpoints de pairing sólo operan contra la DB central (`pair_requests`,
// `devices`, `device_challenges`), por lo que no necesitan resolver la DB del
// tenant. Por compatibilidad con las firmas previas se exponen `dbTenant`/`db`
// apuntando a la DB central recibida.

import type { Client } from "@libsql/client/web";

import { verifyJwt, verifyDeviceProofOrThrow, type AuthClaims } from "./auth";

export type { AuthClaims };

export type TenantContext = {
	token: string;
	claims: AuthClaims;
	dbTenant: Client;
	db: Client;
};

export async function buildTenantContext(
	req: Request,
	env: any,
	dbCentral: Client,
	_makeTenantClient?: (cfg: { url: string; authToken: string }) => Client,
): Promise<TenantContext> {
	const { token, claims } = await verifyJwt(env, req);

	// El cuerpo entra en la firma (FABLE-E), y entra como BYTES (ver `verifyDeviceProofOrThrow`).
	// Se lee sobre un `clone()` a propósito: estos handlers reciben la `Request` cruda (no el
	// contexto de Hono) y hacen su propio `req.json()` después; el cuerpo de una Request solo se
	// puede consumir una vez, así que sin el clon se quedarían sin él.
	const rawBody = req.body
		? new Uint8Array(await req.clone().arrayBuffer())
		: new Uint8Array();

	await verifyDeviceProofOrThrow(req, dbCentral, claims, token, rawBody);

	return {
		token,
		claims,
		dbTenant: dbCentral,
		db: dbCentral,
	};
}
