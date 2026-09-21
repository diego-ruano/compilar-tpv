import type { Client } from "@libsql/client/web";

import { firmarSesion, handyTokenTtlSeconds } from "../../../../lib/sesion";
import { exigirClaveSiEsDeOtroNegocio } from "../../../licenseStore";
import { json, serverError } from "../../../utils/response";
import { avisarSolicitudALaMain } from "./pairClaim";
import { comprobarFirmaDelReclamante, relojFueraDeMargen } from "./pairing.firma";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

async function getTenantLicHash(
	dbCentral: Client,
	tenantId: string,
): Promise<string | null> {
	const r = await dbCentral.execute({
		sql: `
			SELECT license_key_hash
			FROM licenses
			WHERE tenant_id = ?
			  AND status = 'active'
			ORDER BY updated_at_ms DESC
			LIMIT 1;
		`,
		args: [tenantId],
	});

	const row = r.rows?.[0] as any | undefined;
	const v = row ? String(row.license_key_hash || "").trim() : "";

	return v || null;
}

export async function handlePairFetchToken(
	req: Request,
	env: any,
	dbCentral: Client,
	ahoraMs: number = Date.now(),
): Promise<Response> {
	try {
		const body = await readJsonSafe(req, {
			pairCode: "",
			deviceId: "",
			nonceB64: "",
			sigB64: "",
			ts: 0,
		});

		const pairCode = String((body as any).pairCode || "").trim();
		const deviceId = String((body as any).deviceId || "").trim();
		const nonceB64 = String((body as any).nonceB64 || "").trim();
		const sigB64Raw = String((body as any).sigB64 || "").trim();
		const ts = Number((body as any).ts || 0);

		if (!pairCode) {
			return json({ ok: false, error: "missing_pairCode" }, 400, req);
		}

		if (!deviceId) {
			return json({ ok: false, error: "missing_deviceId" }, 400, req);
		}

		if (!nonceB64 || !sigB64Raw || !ts) {
			return json({ ok: false, error: "missing_proof" }, 400, req);
		}

		const now = ahoraMs;

		if (relojFueraDeMargen(ts, now)) {
			return json({ ok: false, error: "timestamp_out_of_range" }, 401, req);
		}

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});

		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) {
			return json({ ok: false, error: "pair_code_not_found" }, 404, req);
		}

		if (pr.used_at_ms) {
			return json({ ok: false, error: "already_used" }, 409, req);
		}

		if (Number(pr.expires_at_ms || 0) < now) {
			return json({ ok: false, error: "pair_code_expired" }, 410, req);
		}

		const status = String(pr.status || "");

		// Rechazada en la Main: la Handy tiene que enterarse en la siguiente consulta, no seguir
		// esperando una aprobación que no va a llegar.
		if (status === "rejected") {
			return json({ ok: false, error: "pair_rejected" }, 409, req);
		}

		if (status !== "approved") {
			return json({ ok: false, error: "not_approved" }, 409, req);
		}

		if (String(pr.claimed_by_device_id || "") !== deviceId) {
			return json({ ok: false, error: "device_mismatch" }, 403, req);
		}

		const tenantId = String(pr.tenant_id || "").trim();
		const pubB64Raw = String(pr.claimed_device_pubkey_b64 || "").trim();

		if (!tenantId) {
			return serverError(req, "missing_tenant_id");
		}

		if (!pubB64Raw) {
			return serverError(req, "missing_pubkey");
		}

		const problema = await comprobarFirmaDelReclamante(dbCentral, {
			accion: "PAIR_FETCH",
			pairCode,
			deviceId,
			nonceB64,
			ts,
			sigB64: sigB64Raw,
			pubB64: pubB64Raw,
			ahoraMs: now,
		});
		if (problema) {
			return json({ ok: false, error: problema.error }, problema.status, req);
		}

		// REV-07: y la firma de arriba prueba que tiene la clave que ACABA DE MANDAR, no la que este
		// `device_id` tuviera registrada. Sin este corte, el upsert de más abajo pisaba `tenant_id`
		// **y `device_pubkey_b64`**, así que bastaba con vincular una Handy a un negocio propio
		// usando el `device_id` de la Main de otro —que las Handy del local conocen, viaja en los
		// mensajes de presencia del WebSocket— para dejar aquella Main firmando con una clave que
		// ya no es la suya: `bad_device_signature` en todo, y sin poder reactivar, porque
		// `/v1/license/activate` la rechaza entonces con `device_key_mismatch`.
		//
		// Que un equipo pueda mudarse de negocio sigue siendo cierto y deliberado (§9): lo que se
		// exige es que lo haga firmando con SU clave, que es lo que prueba que es él. Dentro del
		// mismo negocio la clave sí puede cambiar: es como se recupera un Handy que perdió la suya,
		// y lo aprueba el dueño desde su Main.
		try {
			await exigirClaveSiEsDeOtroNegocio(dbCentral, deviceId, pubB64Raw, tenantId);
		} catch (e: any) {
			if (e?.code === "device_key_mismatch") {
				return json({ ok: false, error: "device_key_mismatch" }, 409, req);
			}
			throw e;
		}

		const licHash = await getTenantLicHash(dbCentral, tenantId);
		if (!licHash) {
			return serverError(req, "no_active_license_for_tenant");
		}

		const jwtSecret = String(env.LICENSE_JWT_SECRET || "");
		if (!jwtSecret) {
			return serverError(req, "missing_LICENSE_JWT_SECRET");
		}

		const ttlSeconds = handyTokenTtlSeconds(env);

		// El mismo emisor que usa `/v1/license/refresh` para reemitirlo cuando caduque: si cada uno
		// firmara el suyo, un token renovado podría no ser el mismo token con otra fecha.
		const token = await firmarSesion(
			env,
			{ tenantId, deviceId, licHash },
			{ rol: "handy", ttlSegundos: ttlSeconds },
		);

		const challengeUpdate = await dbCentral.execute({
			sql: `
				UPDATE device_challenges
				SET used_at_ms=?
				WHERE device_id=?
				  AND nonce_b64=?
				  AND used_at_ms IS NULL
				  AND expires_at_ms >= ?;
			`,
			args: [now, deviceId, nonceB64, now],
		});

		if (rowsAffected(challengeUpdate) <= 0) {
			return json(
				{ ok: false, error: "challenge_used_or_expired" },
				409,
				req,
			);
		}

		const pairUpdate = await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET status='used',
				    used_at_ms=?
				WHERE pair_code=?
				  AND claimed_by_device_id=?
				  AND status='approved'
				  AND used_at_ms IS NULL
				  AND expires_at_ms >= ?;
			`,
			args: [now, pairCode, deviceId, now],
		});

		if (rowsAffected(pairUpdate) <= 0) {
			return json(
				{ ok: false, error: "pair_code_used_or_invalid_state" },
				409,
				req,
			);
		}

		// Ahora, y no al aprobar, es cuando el dispositivo existe de verdad: el código está gastado,
		// la firma es la de la clave que la Main aprobó y el token sale en esta respuesta. Si ya
		// estaba (una Handy que se vuelve a vincular), se reactiva.
		//
		// `device_pubkey_b64` se sigue escribiendo, pero ya no puede CAMBIAR de dueño: arriba se ha
		// exigido que sea la que este `device_id` tuviera registrada (REV-07). Escribirla aquí es lo
		// que le pone clave a un dispositivo que aún no la tenía.
		await dbCentral.execute({
			sql: `
				INSERT INTO devices (
					device_id,
					tenant_id,
					role,
					first_seen_at_ms,
					last_seen_at_ms,
					revoked_at_ms,
					device_pubkey_b64,
					pubkey_alg
				)
				VALUES (?, ?, 'handy', ?, ?, NULL, ?, 'ed25519')
				ON CONFLICT(device_id) DO UPDATE SET
					tenant_id=excluded.tenant_id,
					role='handy',
					last_seen_at_ms=excluded.last_seen_at_ms,
					revoked_at_ms=NULL,
					device_pubkey_b64=excluded.device_pubkey_b64,
					pubkey_alg='ed25519';
			`,
			args: [deviceId, tenantId, now, now, pubB64Raw],
		});

		// La lista de vinculados de la Main cambia en este momento, no al aprobar.
		await avisarSolicitudALaMain(env, tenantId);

		return json(
			{
				ok: true,
				tenantId,
				token,
				deviceId,
				expiresInSeconds: ttlSeconds,
			},
			200,
			req,
		);
	} catch (e: any) {
		const msg = String(e?.message || e);

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
		});
	}
}
