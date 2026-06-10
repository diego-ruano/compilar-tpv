import type { Client } from "@libsql/client/web";

import { json, serverError } from "../../../utils/response";
import { sha256HexStr } from "../../../utils/crypto";
import { b64ToBytes, bytesToB64 } from "../../../utils/base64";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
}

function sanitizeB64(input: string): string {
	let s = String(input || "").trim();

	s = s.replace(/^"+|"+$/g, "");
	s = s.replace(/\s+/g, "");
	s = s.replace(/-/g, "+").replace(/_/g, "/");

	const mod = s.length % 4;
	if (mod === 2) s += "==";
	else if (mod === 3) s += "=";

	return s;
}

function normalizeEd25519PubkeyB64(input: string): string | null {
	const clean = sanitizeB64(input);

	try {
		const bytes = b64ToBytes(clean);
		if (bytes.length !== 32) return null;
		return clean;
	} catch {
		return null;
	}
}

function rowsAffected(result: any): number {
	return Number(result?.rowsAffected ?? result?.rows_affected ?? 0);
}

// Throttle por IP del endpoint de claim (anónimo). El secret protege la ruta del QR, pero la
// ruta de "solo código" no lo lleva, así que sin esto el espacio de 10^6 códigos quedaría
// abierto a enumeración. Ventana fija de 60s; el límite es holgado para reintentos legítimos
// (un emparejamiento hace UN claim y luego sondea fetch-token, otro endpoint), pero corta en
// seco cualquier barrido masivo. Global (no por-colo), apoyado en la DB de control.
const CLAIM_RL_WINDOW_MS = 60 * 1000;
const CLAIM_RL_MAX = 30;

async function claimRateLimitOk(
	db: Client,
	ip: string,
	now: number,
): Promise<boolean> {
	await db.execute(`
		CREATE TABLE IF NOT EXISTS pair_claim_throttle (
			ip TEXT PRIMARY KEY,
			window_start_ms INTEGER NOT NULL,
			count INTEGER NOT NULL
		);
	`);

	const r = await db.execute({
		sql: `SELECT window_start_ms, count FROM pair_claim_throttle WHERE ip=? LIMIT 1;`,
		args: [ip],
	});

	const row = r.rows?.[0] as any | undefined;

	// Ventana nueva (o primera vez): reinicia el contador.
	if (!row || now - Number(row.window_start_ms || 0) >= CLAIM_RL_WINDOW_MS) {
		await db.execute({
			sql: `
				INSERT INTO pair_claim_throttle (ip, window_start_ms, count)
				VALUES (?, ?, 1)
				ON CONFLICT(ip) DO UPDATE SET window_start_ms=excluded.window_start_ms, count=1;
			`,
			args: [ip, now],
		});
		return true;
	}

	if (Number(row.count || 0) >= CLAIM_RL_MAX) return false;

	await db.execute({
		sql: `UPDATE pair_claim_throttle SET count=count+1 WHERE ip=?;`,
		args: [ip],
	});
	return true;
}

export async function handlePairClaim(
	req: Request,
	env: any,
	dbCentral: Client,
): Promise<Response> {
	try {
		const body = await readJsonSafe(req, {
			pairCode: "",
			pairSecret: "",
			deviceId: "",
			devicePubKey: "",
			deviceName: "",
		});

		const pairCode = String((body as any).pairCode || "").trim();
		const pairSecret = String((body as any).pairSecret || "").trim();
		const deviceId = String((body as any).deviceId || "").trim();
		const devicePubKeyRaw = String((body as any).devicePubKey || "").trim();
		const deviceName = String((body as any).deviceName || "").trim();

		if (!/^\d{6}$/.test(pairCode)) {
			return json({ ok: false, error: "invalid_pair_code" }, 400, req);
		}

		// Ruta dual: el `pairSecret` es OPCIONAL.
		//  - QR/URI  → llega el secret → se verifica abajo (prueba criptográfica de posesión).
		//  - Solo código → sin secret → se omite la verificación y la seguridad recae en la
		//    aprobación manual del Main (+ el throttle por IP de arriba contra enumeración).

		if (!deviceId) {
			return json({ ok: false, error: "missing_deviceId" }, 400, req);
		}

		if (!devicePubKeyRaw) {
			return json({ ok: false, error: "missing_devicePubKey" }, 400, req);
		}

		const devicePubKey = normalizeEd25519PubkeyB64(devicePubKeyRaw);
		if (!devicePubKey) {
			return json({ ok: false, error: "invalid_devicePubKey" }, 400, req);
		}

		const now = Date.now();

		const clientIp = String(
			req.headers.get("CF-Connecting-IP") ||
				req.headers.get("x-forwarded-for") ||
				"unknown",
		)
			.split(",")[0]
			.trim();

		if (!(await claimRateLimitOk(dbCentral, clientIp, now))) {
			return json({ ok: false, error: "too_many_requests" }, 429, req);
		}

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});

		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) {
			return json({ ok: false, error: "pair_code_not_found" }, 404, req);
		}

		const attempts = Number(pr.attempts || 0);
		const lastAttempt = Number(pr.last_attempt_at_ms || 0);

		if (attempts >= 8 && now - lastAttempt < 10 * 60 * 1000) {
			return json({ ok: false, error: "too_many_attempts" }, 429, req);
		}

		if (pr.used_at_ms) {
			return json({ ok: false, error: "pair_code_used" }, 409, req);
		}

		if (Number(pr.expires_at_ms || 0) < now) {
			await dbCentral.execute({
				sql: `
					UPDATE pair_requests
					SET status='expired'
					WHERE pair_code=?
					  AND used_at_ms IS NULL;
				`,
				args: [pairCode],
			});

			return json({ ok: false, error: "pair_code_expired" }, 410, req);
		}

		const status = String(pr.status || "").trim().toLowerCase();

		if (status === "approved") {
			return json({ ok: false, error: "pair_code_already_approved" }, 409, req);
		}

		if (status !== "pending") {
			return json(
				{ ok: false, error: "invalid_pair_status", status },
				409,
				req,
			);
		}

		// Verificación del secret SOLO en la ruta fuerte (QR/URI). Si no llega secret, es la
		// ruta de "solo código" y se confía en la aprobación manual posterior.
		if (pairSecret) {
			const pepper = String(env.PAIR_PEPPER || "");
			const hash = await sha256HexStr(`${pairSecret}.${pepper}`);

			if (hash !== String(pr.secret_hash || "")) {
				await dbCentral.execute({
					sql: `
						UPDATE pair_requests
						SET attempts = attempts + 1,
						    last_attempt_at_ms=?
						WHERE pair_code=?;
					`,
					args: [now, pairCode],
				});

				return json({ ok: false, error: "invalid_pair_secret" }, 401, req);
			}
		}

		const claimRes = await dbCentral.execute({
			sql: `
				UPDATE pair_requests
				SET
					status='pending',
					claimed_at_ms=?,
					claimed_by_device_id=?,
					claimed_device_pubkey_b64=?,
					claimed_device_name=?,
					last_attempt_at_ms=?
				WHERE pair_code=?
				  AND used_at_ms IS NULL
				  AND status='pending'
				  AND expires_at_ms >= ?;
			`,
			args: [
				now,
				deviceId,
				devicePubKey,
				deviceName || null,
				now,
				pairCode,
				now,
			],
		});

		if (rowsAffected(claimRes) <= 0) {
			return json(
				{ ok: false, error: "pair_claim_race_or_invalid_state" },
				409,
				req,
			);
		}

		const nonceBytes = new Uint8Array(32);
		crypto.getRandomValues(nonceBytes);

		const nonceB64 = bytesToB64(nonceBytes);
		const expMs = now + 2 * 60 * 1000;

		await dbCentral.execute({
			sql: `
				INSERT INTO device_challenges (
					device_id,
					nonce_b64,
					expires_at_ms,
					created_at_ms
				)
				VALUES (?, ?, ?, ?);
			`,
			args: [deviceId, nonceB64, expMs, now],
		});

		return json(
			{
				ok: true,
				state: "pending_approval",
				nonceB64,
				nonceExpiresAtMs: expMs,
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