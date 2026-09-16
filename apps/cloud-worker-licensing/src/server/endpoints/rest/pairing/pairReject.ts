// src/server/endpoints/rest/pairing/pairReject.ts
//
// La Main rechaza una solicitud de emparejamiento.
//
// Antes sólo se podía aprobar. Una solicitud que no se reconocía (una huella que no cuadra, un
// dispositivo que no es del bar) se quedaba en la lista hasta caducar, y la Handy que la hizo
// esperando. Rechazarla la quita de la lista y la Handy se entera en su siguiente consulta
// (`pair_rejected` en `fetch-token`), en vez de agotar la espera.
//
// Rechazar quema el código: para volver a intentarlo hace falta uno nuevo, que es lo que tiene
// sentido si quien lo usó no era de fiar.

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../middleware/withTenant";
import { createDbClient } from "../../../db/clients";
import { tieneRol } from "../../../../lib/deviceAuth";
import { json, unauthorized, serverError } from "../../../utils/response";
import { isAuthError } from "./pairApprove";

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

export type ResultadoRechazo = { status: 200 | 404 | 409 | 410; cuerpo: Record<string, unknown> };

/** Lo que decide el rechazo, sin la autenticación de la Main: es lo que prueban los tests. */
export async function rechazarSolicitud(
	db: Client,
	tenantId: string,
	pairCode: string,
	ahoraMs: number,
): Promise<ResultadoRechazo> {
	const r = await db.execute({
		sql: `
			UPDATE pair_requests
			SET status='rejected'
			WHERE pair_code=?
			  AND tenant_id=?
			  AND status='pending'
			  AND used_at_ms IS NULL
			  AND expires_at_ms >= ?;
		`,
		args: [pairCode, tenantId, ahoraMs],
	});
	if (rowsAffected(r) > 0) return { status: 200, cuerpo: { ok: true, state: "rejected" } };

	const prRes = await db.execute({
		sql: `SELECT status, tenant_id, expires_at_ms, used_at_ms FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});
	const pr = prRes.rows?.[0] as any | undefined;

	// Un código de otro negocio se contesta igual que uno que no existe: decir otra cosa diría
	// que ese código está en uso en algún sitio.
	if (!pr || String(pr.tenant_id || "") !== tenantId) {
		return { status: 404, cuerpo: { ok: false, error: "pair_code_not_found" } };
	}
	if (String(pr.status || "") === "rejected") {
		return { status: 200, cuerpo: { ok: true, state: "rejected" } };
	}
	if (!pr.used_at_ms && Number(pr.expires_at_ms || 0) < ahoraMs) {
		return { status: 410, cuerpo: { ok: false, error: "pair_code_expired" } };
	}
	return { status: 409, cuerpo: { ok: false, error: "invalid_pair_status", status: pr.status } };
}

export async function handlePairReject(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		const deviceId = String(ctx?.claims?.deviceId || "").trim();

		if (!tenantId || !deviceId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const okTpv = await tieneRol(dbCentral, tenantId, deviceId, "tpv");
		if (!okTpv) return unauthorized(req, "forbidden_not_tpv");

		const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const pairCode = String(body.pairCode || "").trim();
		if (!pairCode) {
			return json({ ok: false, error: "missing_pairCode" }, 400, req);
		}

		const { status, cuerpo } = await rechazarSolicitud(dbCentral, tenantId, pairCode, Date.now());
		return json(cuerpo, status, req);
	} catch (e: any) {
		const msg = String(e?.message || e);

		if (isAuthError(msg)) {
			return unauthorized(req, msg);
		}

		return serverError(req, "internal_error", { message: msg });
	}
}
