import type { Client } from "@libsql/client/web";

import { signInternalWorkerRequest } from "../../../../lib/internalAuth";
import { json, serverError } from "../../../utils/response";
import { sha256HexStr } from "../../../utils/crypto";
import { b64ToBytes, bytesToB64 } from "../../../utils/base64";
import { sanitizeB64 } from "./pairing.firma";
import {
	anotarFallo,
	olvidarFallos,
	pasaElFiltroExterior,
	segundosDeEspera,
	textoDeEspera,
} from "./pairing.intentos";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		return fallback;
	}
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

export function ipDeLaPeticion(req: Request): string {
	return String(req.headers.get("CF-Connecting-IP") || req.headers.get("x-forwarded-for") || "unknown")
		.split(",")[0]
		.trim();
}

/**
 * La puerta del filtro exterior (`pairing.intentos.ts::pasaElFiltroExterior`).
 *
 * Tiene su propio texto porque aquí no ha fallado nadie: sobran peticiones. Y da un plazo fijo
 * porque el binding de Cloudflare no sabe decir cuánto queda — sólo sí o no.
 */
function demasiadasPeticiones(req: Request): Response {
	return json(
		{
			ok: false,
			error: "too_many_attempts",
			message: "Demasiadas peticiones desde esta red. Vuelve a intentarlo dentro de 1 minuto.",
		},
		429,
		req,
	);
}

function demasiadosIntentos(req: Request, segundos: number): Response {
	return json(
		{
			ok: false,
			error: "too_many_attempts",
			message: `Demasiados intentos fallidos. Vuelve a intentarlo dentro de ${textoDeEspera(segundos)}.`,
			reintentarEnSegundos: segundos,
		},
		429,
		req,
	);
}

/**
 * Empuja a la Main el aviso de que ha cambiado una solicitud de emparejamiento (una nueva, o una
 * que la Handy ha cancelado), para que recargue la lista.
 *
 * Best-effort **a propósito**: el cambio ya está guardado cuando llegamos aquí, así que un DO
 * que no responde —o un local sin ninguna Main conectada— no puede tumbar un emparejamiento
 * válido. El panel tiene su propia recarga de respaldo para ese caso.
 */
export async function avisarSolicitudALaMain(env: any, tenantId: string): Promise<void> {
	if (!tenantId) return;

	try {
		const stub = env.TenantHub.get(env.TenantHub.idFromName(tenantId));
		const rawBody = JSON.stringify({ tenantId });

		// FABLE-F: misma firma HMAC que `/internal/apply` y `/internal/revoke`. `pathname` y
		// `rawBody` tienen que coincidir exactamente con lo que verá el DO.
		const sigHeaders = await signInternalWorkerRequest(
			String(env.LICENSE_JWT_SECRET || ""),
			"POST",
			"/internal/pair-request",
			rawBody,
		);

		await stub.fetch("https://do/internal/pair-request", {
			method: "POST",
			headers: { "content-type": "application/json", ...sigHeaders },
			body: rawBody,
		});
	} catch {
		// Silencio deliberado: ver el comentario de arriba.
	}
}

/**
 * El reto que la Handy firma en cada consulta de `fetch-token` (y al cancelar).
 *
 * Vive lo mismo que el código, no dos minutos. Antes caducaba a los 2 minutos mientras la Handy
 * esperaba 3: si la Main aprobaba entre medias, la Handy recibía `challenge_expired` y el código
 * quedaba aprobado y gastado sin que nadie tuviera el token. `caducaEnMs` es relativo a propósito:
 * la Handy lo suma a su propio reloj, que no tiene por qué coincidir con el del worker.
 */
async function nuevoReto(
	req: Request,
	db: Client,
	deviceId: string,
	pr: any,
	now: number,
	state: "pending_approval" | "approved",
): Promise<Response> {
	const nonceBytes = new Uint8Array(32);
	crypto.getRandomValues(nonceBytes);

	const nonceB64 = bytesToB64(nonceBytes);
	const expMs = Number(pr.expires_at_ms || 0);

	await db.execute({
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
			state,
			nonceB64,
			nonceExpiresAtMs: expMs,
			caducaEnMs: Math.max(0, expMs - now),
		},
		200,
		req,
	);
}

export async function handlePairClaim(
	req: Request,
	env: any,
	dbCentral: Client,
	ahoraMs: number = Date.now(),
): Promise<Response> {
	try {
		// El filtro exterior va ANTES de todo, incluido leer el cuerpo: lo que se quiere es soltar
		// el lastre cuanto antes, y para esto sólo hace falta la IP. Un cliente roto que mande
		// basura a 20 por minuto también sobra, aunque hoy sus 400 no cuenten como intento.
		if (!(await pasaElFiltroExterior(env, ipDeLaPeticion(req)))) {
			return demasiadasPeticiones(req);
		}

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
		//  - Solo código → sin secret → se omite la verificación y la seguridad recae en tres
		//    cosas: la espera por fallos de abajo (enumeración), que el claim se adjudique al
		//    PRIMERO y no se pueda pisar (FABLE-D, más abajo), y la aprobación manual en la Main,
		//    donde el dueño compara la huella del reclamante con la que muestra el Handy.

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

		const now = ahoraMs;
		const clientIp = ipDeLaPeticion(req);

		// La espera por fallos se mira ANTES de leer el código: si no, cada intento bloqueado
		// seguiría diciendo si el código existe, que es justo lo que se quiere frenar.
		const espera = await segundosDeEspera(dbCentral, clientIp, now);
		if (espera > 0) {
			return demasiadosIntentos(req, espera);
		}

		// Todo lo que sale por aquí es un intento fallido de esta IP (ver `pairing.intentos.ts`).
		// Los 400 de arriba no cuentan: son un cliente mal hecho, no alguien probando códigos. El
		// fallo que cierra un tramo ya contesta con la espera, para que se vea en ese momento.
		const fallo = async (cuerpo: Record<string, unknown>, status: number) => {
			const impuesta = await anotarFallo(dbCentral, clientIp, now);
			return impuesta > 0
				? demasiadosIntentos(req, Math.ceil(impuesta / 1000))
				: json({ ok: false, ...cuerpo }, status, req);
		};

		const prRes = await dbCentral.execute({
			sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
			args: [pairCode],
		});

		const pr = prRes.rows?.[0] as any | undefined;
		if (!pr) {
			return fallo({ error: "pair_code_not_found" }, 404);
		}

		const attempts = Number(pr.attempts || 0);
		const lastAttempt = Number(pr.last_attempt_at_ms || 0);

		if (attempts >= 8 && now - lastAttempt < 10 * 60 * 1000) {
			return fallo({ error: "too_many_attempts" }, 429);
		}

		if (pr.used_at_ms) {
			return fallo({ error: "pair_code_used" }, 409);
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

			return fallo({ error: "pair_code_expired" }, 410);
		}

		const status = String(pr.status || "").trim().toLowerCase();

		// Aprobado para ESTE dispositivo: es su propio reintento (se cerró la aplicación esperando,
		// o canceló y volvió a intentarlo). Se le da un reto nuevo y recoge el token con él. Antes se
		// le contestaba `pair_code_already_approved` y el código quedaba gastado sin que nadie
		// tuviera el token.
		const aprobadoParaEste =
			status === "approved" && String(pr.claimed_by_device_id || "") === deviceId;

		if (status === "approved" && !aprobadoParaEste) {
			return fallo({ error: "pair_code_already_approved" }, 409);
		}

		if (status === "rejected") {
			return fallo({ error: "pair_rejected" }, 409);
		}

		if (status !== "pending" && !aprobadoParaEste) {
			return fallo({ error: "invalid_pair_status", status }, 409);
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

				return fallo({ error: "invalid_pair_secret" }, 401);
			}
		}

		if (aprobadoParaEste) {
			// La Main aprobó ESTA clave; con otra, el token acabaría en manos de quien no se vio.
			if (sanitizeB64(String(pr.claimed_device_pubkey_b64 || "")) !== devicePubKey) {
				return fallo({ error: "device_pubkey_mismatch" }, 401);
			}
			await olvidarFallos(dbCentral, clientIp);
			return nuevoReto(req, dbCentral, deviceId, pr, now, "approved");
		}

		// FABLE-D: el claim se fija al PRIMER reclamante. Sin la condición sobre
		// `claimed_by_device_id`, un segundo dispositivo podía pisar el claim del primero mientras
		// el código siguiera pendiente y acabar siendo el que el dueño aprueba. Se exceptúa al
		// propio reclamante para que un reintento suyo (app reiniciada, respuesta perdida) siga
		// siendo idempotente en vez de dejarle fuera de su propio emparejamiento.
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
				  AND expires_at_ms >= ?
				  AND (claimed_by_device_id IS NULL OR claimed_by_device_id = ?);
			`,
			args: [
				now,
				deviceId,
				devicePubKey,
				deviceName || null,
				now,
				pairCode,
				now,
				deviceId,
			],
		});

		if (rowsAffected(claimRes) <= 0) {
			// FABLE-D: un claim rechazado (código ya reclamado por otro dispositivo, o estado
			// inválido) cuenta como intento. Antes solo se contaban los secretos inválidos, así
			// que por la ruta de "solo código" —donde no hay secreto que fallar— el tope de 8
			// intentos de arriba no llegaba a activarse nunca y un código admitía martilleo
			// indefinido hasta expirar.
			await dbCentral.execute({
				sql: `
					UPDATE pair_requests
					SET attempts = attempts + 1,
					    last_attempt_at_ms=?
					WHERE pair_code=?;
				`,
				args: [now, pairCode],
			});

			return fallo({ error: "pair_claim_race_or_invalid_state" }, 409);
		}

		await olvidarFallos(dbCentral, clientIp);
		await avisarSolicitudALaMain(env, String(pr.tenant_id || ""));

		return nuevoReto(req, dbCentral, deviceId, pr, now, "pending_approval");
	} catch (e: any) {
		const msg = String(e?.message || e);

		return serverError(req, "internal_error", {
			message: msg,
			name: e?.name,
			stack: e?.stack,
		});
	}
}
