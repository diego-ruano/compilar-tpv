// src/server/endpoints/rest/pairing/pairCancel.ts
//
// La Handy deja de esperar la aprobación: suelta el código que había reclamado.
//
// Sin esto, cancelar en la Handy sólo paraba la espera en la pantalla y la solicitud seguía en la
// lista de la Main. Si alguien la aprobaba después, el dispositivo quedaba dado de alta sin que
// ninguna Handy fuera a recoger nunca el token. Soltar el claim la quita de la lista y deja el
// código como estaba antes: la misma Handy, u otra, puede volver a usarlo mientras no caduque.
//
// Sólo se suelta una solicitud PENDIENTE. Si la Main ya la aprobó, no se toca: deshacer eso sería
// revocar un dispositivo, y la Handy puede recoger su token volviendo a reclamar el mismo código.
//
// Es anónima, como `fetch-token`, y por lo mismo va firmada por el dispositivo que reclamó.

import type { Client } from "@libsql/client/web";

import { json, serverError } from "../../../utils/response";
import { avisarSolicitudALaMain } from "./pairClaim";
import { comprobarFirmaDelReclamante, relojFueraDeMargen } from "./pairing.firma";

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

export async function handlePairCancel(
	req: Request,
	env: any,
	dbCentral: Client,
	ahoraMs: number = Date.now(),
): Promise<Response> {
	try {
		const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

		const pairCode = String(body.pairCode || "").trim();
		const deviceId = String(body.deviceId || "").trim();
		const nonceB64 = String(body.nonceB64 || "").trim();
		const sigB64 = String(body.sigB64 || "").trim();
		const ts = Number(body.ts || 0);

		if (!pairCode) return json({ ok: false, error: "missing_pairCode" }, 400, req);
		if (!deviceId) return json({ ok: false, error: "missing_deviceId" }, 400, req);
		if (!nonceB64 || !sigB64 || !ts) return json({ ok: false, error: "missing_proof" }, 400, req);

		if (relojFueraDeMargen(ts, ahoraMs)) {
			return json({ ok: false, error: "timestamp_out_of_range" }, 401, req);
		}

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});
		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) return json({ ok: false, error: "pair_code_not_found" }, 404, req);

		if (String(pr.claimed_by_device_id || "") !== deviceId) {
			return json({ ok: false, error: "device_mismatch" }, 403, req);
		}

		const problema = await comprobarFirmaDelReclamante(dbCentral, {
			accion: "PAIR_CANCEL",
			pairCode,
			deviceId,
			nonceB64,
			ts,
			sigB64,
			pubB64: String(pr.claimed_device_pubkey_b64 || ""),
			ahoraMs,
		});
		if (problema) return json({ ok: false, error: problema.error }, problema.status, req);

		const soltado = await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET claimed_at_ms=NULL,
				    claimed_by_device_id=NULL,
				    claimed_device_pubkey_b64=NULL,
				    claimed_device_name=NULL
				WHERE pair_code=?
				  AND claimed_by_device_id=?
				  AND status='pending'
				  AND used_at_ms IS NULL;
			`,
			args: [pairCode, deviceId],
		});

		// El reto es de un solo uso también aquí: la firma de esta cancelación no puede repetirse.
		await dbCentral.execute({
			sql: `UPDATE device_challenges SET used_at_ms=? WHERE device_id=? AND nonce_b64=? AND used_at_ms IS NULL;`,
			args: [ahoraMs, deviceId, nonceB64],
		});

		const liberado = rowsAffected(soltado) > 0;
		if (liberado) await avisarSolicitudALaMain(env, String(pr.tenant_id || ""));

		return json({ ok: true, liberado }, 200, req);
	} catch (e: any) {
		return serverError(req, "internal_error", { message: String(e?.message || e) });
	}
}
