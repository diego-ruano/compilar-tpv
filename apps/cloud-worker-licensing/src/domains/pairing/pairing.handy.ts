// src/domains/pairing/pairing.handy.ts
//
// Los tres pasos que da una Handy que se está emparejando, y que da SIN token: reclamar el código,
// recoger el token cuando la Main aprueba, y soltarlo si deja de esperar.
//
// Lo que los protege, al no haber sesión: el código de 6 cifras, la espera por fallos de
// `pairing.intentos.ts`, que el claim se adjudique al primero, la aprobación manual en la Main, y
// —en los dos últimos— la firma ed25519 sobre un reto de un solo uso (`pairing.firma.ts`).
//
// Aquí sólo se DECIDE: cada función devuelve un `Resultado` (status + cuerpo) y no una `Response`.
// La forma de la petición la garantiza `pairing.schemas.ts` antes de llegar, así que en este
// fichero no hay ni un `String(body.x ?? "")` ni un `if (!campo)`.

import type { Base } from "../../lib/sql";
import type { z } from "zod";

import { DEMASIADAS_PETICIONES } from "../../lib/limitador";
import { firmarSesion, handyTokenTtlSeconds } from "../../lib/sesion";
import { exigirClaveSiEsDeOtroNegocio } from "../../server/licenseStore";
import { sha256HexStr } from "../../server/utils/crypto";
import { bytesToB64 } from "../../server/utils/base64";
import { avisarSolicitudALaMain } from "./pairing.avisos";
import { comprobarFirmaDelReclamante, relojFueraDeMargen, sanitizeB64 } from "./pairing.firma";
import { anotarFallo, segundosDeEspera, textoDeEspera } from "./pairing.intentos";
import { fallo, ok, type Resultado } from "./pairing.resultado";
import type { cancelSchema, claimSchema, fetchTokenSchema } from "./pairing.schemas";

/**
 * La puerta del filtro exterior (`pairing.intentos.ts::pasaElFiltroExterior`).
 *
 * Tiene su propio texto porque aquí no ha fallado nadie: sobran peticiones. Y da un plazo fijo
 * porque el binding de Cloudflare no sabe decir cuánto queda — sólo sí o no.
 */
export function demasiadasPeticiones(): Resultado {
	return fallo(429, "too_many_attempts", {
		message: DEMASIADAS_PETICIONES,
	});
}

function demasiadosIntentos(segundos: number): Resultado {
	return fallo(429, "too_many_attempts", {
		message: `Demasiados intentos fallidos. Vuelve a intentarlo dentro de ${textoDeEspera(segundos)}.`,
		reintentarEnSegundos: segundos,
	});
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
	db: Base,
	deviceId: string,
	pr: any,
	now: number,
	state: "pending_approval" | "approved",
): Promise<Resultado> {
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

	return ok({
		state,
		nonceB64,
		nonceExpiresAtMs: expMs,
		caducaEnMs: Math.max(0, expMs - now),
	});
}

/** El tope de 8 intentos sobre UN código, que lo protege contra muchas IPs a la vez. */
async function anotarIntentoSobreElCodigo(db: Base, pairCode: string, now: number): Promise<void> {
	await db.execute({
		sql: `
			UPDATE pair_requests
			SET attempts = attempts + 1,
			    last_attempt_at_ms=?
			WHERE pair_code=?;
		`,
		args: [now, pairCode],
	});
}

/**
 * Reclama un código. El `pairSecret` es OPCIONAL:
 *  - QR/URI  → llega el secret → se verifica abajo (prueba criptográfica de posesión).
 *  - Sólo código → sin secret → se omite la verificación y la seguridad recae en tres cosas: la
 *    espera por fallos (enumeración), que el claim se adjudique al PRIMERO y no se pueda pisar
 *    (FABLE-D, más abajo), y la aprobación manual en la Main, donde el dueño compara la huella del
 *    reclamante con la que muestra el Handy.
 */
export async function reclamarCodigo(
	db: Base,
	env: any,
	datos: z.infer<typeof claimSchema>,
	clientIp: string,
	now: number,
): Promise<Resultado> {
	const { pairCode, pairSecret, deviceId, devicePubKey, deviceName } = datos;

	// La espera por fallos se mira ANTES de leer el código: si no, cada intento bloqueado
	// seguiría diciendo si el código existe, que es justo lo que se quiere frenar.
	const espera = await segundosDeEspera(db, clientIp, now);
	if (espera > 0) return demasiadosIntentos(espera);

	// Todo lo que sale por aquí es un intento fallido de esta IP (ver `pairing.intentos.ts`). Los
	// 400 del schema no cuentan: son un cliente mal hecho, no alguien probando códigos. El fallo
	// que cierra un tramo ya contesta con la espera, para que se vea en ese momento.
	const contarFallo = async (r: Resultado): Promise<Resultado> => {
		const impuesta = await anotarFallo(db, clientIp, now);
		return impuesta > 0 ? demasiadosIntentos(Math.ceil(impuesta / 1000)) : r;
	};

	const prRes = await db.execute({
		sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});

	const pr = prRes.rows?.[0] as any | undefined;
	if (!pr) return contarFallo(fallo(404, "pair_code_not_found"));

	const attempts = Number(pr.attempts || 0);
	const lastAttempt = Number(pr.last_attempt_at_ms || 0);

	if (attempts >= 8 && now - lastAttempt < 10 * 60 * 1000) {
		return contarFallo(fallo(429, "too_many_attempts"));
	}

	if (pr.used_at_ms) return contarFallo(fallo(409, "pair_code_used"));

	if (Number(pr.expires_at_ms || 0) < now) {
		await db.execute({
			sql: `
				UPDATE pair_requests
				SET status='expired'
				WHERE pair_code=?
				  AND used_at_ms IS NULL;
			`,
			args: [pairCode],
		});

		return contarFallo(fallo(410, "pair_code_expired"));
	}

	const status = String(pr.status || "").trim().toLowerCase();

	// Aprobado para ESTE dispositivo: es su propio reintento (se cerró la aplicación esperando,
	// o canceló y volvió a intentarlo). Se le da un reto nuevo y recoge el token con él. Antes se
	// le contestaba `pair_code_already_approved` y el código quedaba gastado sin que nadie
	// tuviera el token.
	const aprobadoParaEste =
		status === "approved" && String(pr.claimed_by_device_id || "") === deviceId;

	if (status === "approved" && !aprobadoParaEste) {
		return contarFallo(fallo(409, "pair_code_already_approved"));
	}

	if (status === "rejected") return contarFallo(fallo(409, "pair_rejected"));

	if (status !== "pending" && !aprobadoParaEste) {
		return contarFallo(fallo(409, "invalid_pair_status", { status }));
	}

	// Verificación del secret SOLO en la ruta fuerte (QR/URI). Si no llega secret, es la
	// ruta de "solo código" y se confía en la aprobación manual posterior.
	if (pairSecret) {
		const pepper = String(env.PAIR_PEPPER || "");
		const hash = await sha256HexStr(`${pairSecret}.${pepper}`);

		if (hash !== String(pr.secret_hash || "")) {
			await anotarIntentoSobreElCodigo(db, pairCode, now);
			return contarFallo(fallo(401, "invalid_pair_secret"));
		}
	}

	if (aprobadoParaEste) {
		// La Main aprobó ESTA clave; con otra, el token acabaría en manos de quien no se vio.
		if (sanitizeB64(String(pr.claimed_device_pubkey_b64 || "")) !== devicePubKey) {
			return contarFallo(fallo(401, "device_pubkey_mismatch"));
		}
		// AUD-11: acertar no borra los fallos de esta IP (ver `pairing.intentos.ts`).
		return nuevoReto(db, deviceId, pr, now, "approved");
	}

	// FABLE-D: el claim se fija al PRIMER reclamante. Sin la condición sobre
	// `claimed_by_device_id`, un segundo dispositivo podía pisar el claim del primero mientras
	// el código siguiera pendiente y acabar siendo el que el dueño aprueba. Se exceptúa al
	// propio reclamante para que un reintento suyo (app reiniciada, respuesta perdida) siga
	// siendo idempotente en vez de dejarle fuera de su propio emparejamiento.
	const claimRes = await db.execute({
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
		args: [now, deviceId, devicePubKey, deviceName || null, now, pairCode, now, deviceId],
	});

	if (claimRes.rowsAffected <= 0) {
		// FABLE-D: un claim rechazado (código ya reclamado por otro dispositivo, o estado
		// inválido) cuenta como intento. Antes solo se contaban los secretos inválidos, así
		// que por la ruta de "solo código" —donde no hay secreto que fallar— el tope de 8
		// intentos de arriba no llegaba a activarse nunca y un código admitía martilleo
		// indefinido hasta expirar.
		await anotarIntentoSobreElCodigo(db, pairCode, now);
		return contarFallo(fallo(409, "pair_claim_race_or_invalid_state"));
	}

	// AUD-11: tampoco aquí se borran los fallos de esta IP. Este reclamo se puede repetir sin gastar
	// nada (es el reintento del propio dispositivo), y borrarlos ponía la espera a cero a voluntad.
	await avisarSolicitudALaMain(env, String(pr.tenant_id || ""));

	return nuevoReto(db, deviceId, pr, now, "pending_approval");
}

async function licenciaActivaDelTenant(db: Base, tenantId: string): Promise<string | null> {
	const r = await db.execute({
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

/** La Handy recoge su token: el código está aprobado y ella prueba que es quien lo reclamó. */
export async function entregarToken(
	db: Base,
	env: any,
	datos: z.infer<typeof fetchTokenSchema>,
	now: number,
): Promise<Resultado> {
	const { pairCode, deviceId, nonceB64, sigB64, ts } = datos;

	if (relojFueraDeMargen(ts, now)) return fallo(401, "timestamp_out_of_range");

	const prRes = await db.execute({
		sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});

	const pr = prRes.rows?.[0] as any | undefined;

	// AUD-10: esta ruta es anónima y sin freno por fallos (la Handy pregunta cada 1,5 s; su filtro por
	// IP, `LIMITADOR_SESION`, sólo recorta volumen), así que no puede
	// decir nada de un código a quien no lo ha reclamado. Antes miraba el estado antes que la firma, y
	// con una prueba inventada contestaba 404 si el código no existía y `not_approved` si estaba vivo
	// y pendiente: el oráculo para adelantarse a la Handy en el `claim`. Ahora, a quien no es el
	// reclamante se le contesta como a un código que no existe, y la firma va antes que el estado.
	if (!pr || String(pr.claimed_by_device_id || "") !== deviceId) return fallo(404, "pair_code_not_found");

	const tenantId = String(pr.tenant_id || "").trim();
	const pubB64Raw = String(pr.claimed_device_pubkey_b64 || "").trim();

	if (!tenantId) return fallo(500, "missing_tenant_id");
	if (!pubB64Raw) return fallo(500, "missing_pubkey");

	const problema = await comprobarFirmaDelReclamante(db, {
		accion: "PAIR_FETCH",
		pairCode,
		deviceId,
		nonceB64,
		ts,
		sigB64,
		pubB64: pubB64Raw,
		ahoraMs: now,
	});
	if (problema) return fallo(problema.status, problema.error);

	if (pr.used_at_ms) return fallo(409, "already_used");
	if (Number(pr.expires_at_ms || 0) < now) return fallo(410, "pair_code_expired");

	const status = String(pr.status || "");

	// Rechazada en la Main: la Handy tiene que enterarse en la siguiente consulta, no seguir
	// esperando una aprobación que no va a llegar.
	if (status === "rejected") return fallo(409, "pair_rejected");
	if (status !== "approved") return fallo(409, "not_approved");

	// REV-07: y la firma de arriba prueba que tiene la clave que ACABA DE MANDAR, no la que este
	// `device_id` tuviera registrada. Sin este corte, el upsert de más abajo pisaba `tenant_id`
	// **y `device_pubkey_b64`**, así que bastaba con vincular una Handy a un negocio propio
	// usando el `device_id` de la Main de otro —que las Handy del local conocen, viaja en los
	// avisos del WebSocket (`main_online`)— para dejar aquella Main firmando con una clave que
	// ya no es la suya: `bad_device_signature` en todo, y sin poder reactivar, porque
	// `/v1/license/activate` la rechaza entonces con `device_key_mismatch`.
	//
	// Que un equipo pueda mudarse de negocio sigue siendo cierto y deliberado (§9): lo que se
	// exige es que lo haga firmando con SU clave, que es lo que prueba que es él. Dentro del
	// mismo negocio la clave sí puede cambiar: es como se recupera un Handy que perdió la suya,
	// y lo aprueba el dueño desde su Main.
	try {
		await exigirClaveSiEsDeOtroNegocio(db, deviceId, pubB64Raw, tenantId);
	} catch (e: any) {
		if (e?.code === "device_key_mismatch") return fallo(409, "device_key_mismatch");
		// AUD-01: la fila está en otro negocio y sin clave registrada. La firma de arriba sólo prueba
		// la clave que se acaba de presentar, así que no hay con qué comprobar que es ese equipo.
		if (e?.code === "device_key_missing") return fallo(409, "device_key_missing");
		throw e;
	}

	const licHash = await licenciaActivaDelTenant(db, tenantId);
	if (!licHash) return fallo(500, "no_active_license_for_tenant");

	// El mismo identificador que produce `assertEnv` y que lanza `lib/sesion.ts`: una condición,
	// un nombre. El guard se queda porque llega antes que el de `firmarSesion`, y sin él esto
	// saldría como `internal_error` con la causa enterrada en `details`.
	if (!String(env.LICENSE_JWT_SECRET || "")) return fallo(500, "missing_env_LICENSE_JWT_SECRET");

	const ttlSeconds = handyTokenTtlSeconds(env);

	// El mismo emisor que usa `/v1/license/refresh` para reemitirlo cuando caduque: si cada uno
	// firmara el suyo, un token renovado podría no ser el mismo token con otra fecha.
	const token = await firmarSesion(
		env,
		{ tenantId, deviceId, licHash },
		{ rol: "handy", ttlSegundos: ttlSeconds },
	);

	const challengeUpdate = await db.execute({
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

	if (challengeUpdate.rowsAffected <= 0) return fallo(409, "challenge_used_or_expired");

	const pairUpdate = await db.execute({
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

	if (pairUpdate.rowsAffected <= 0) return fallo(409, "pair_code_used_or_invalid_state");

	// Ahora, y no al aprobar, es cuando el dispositivo existe de verdad: el código está gastado,
	// la firma es la de la clave que la Main aprobó y el token sale en esta respuesta. Si ya
	// estaba (una Handy que se vuelve a vincular), se reactiva.
	//
	// `device_pubkey_b64` se sigue escribiendo, pero ya no puede CAMBIAR de dueño: arriba se ha
	// exigido que sea la que este `device_id` tuviera registrada (REV-07). Escribirla aquí es lo
	// que le pone clave a un dispositivo que aún no la tenía.
	//
	// AUD-01: y la regla de REV-07 va también DENTRO de la sentencia. La comprobación de arriba y
	// esta escritura no son un lote: dos recogidas aprobadas para el mismo `device_id`, en negocios
	// distintos y con claves distintas, veían las dos que no había fila; la primera la creaba y el
	// upsert de la segunda, sin condición, le cambiaba el negocio y la clave. Una fila que ya
	// existe sólo se toca si es de este negocio (la recuperación que aprueba el dueño) o si su clave
	// registrada es ésta (la mudanza del propio equipo). Si no escribe, no se entrega el token.
	const alta = await db.execute({
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
				pubkey_alg='ed25519'
			WHERE devices.tenant_id = excluded.tenant_id
			   OR devices.device_pubkey_b64 = excluded.device_pubkey_b64;
		`,
		args: [deviceId, tenantId, now, now, pubB64Raw],
	});

	if (alta.rowsAffected <= 0) return fallo(409, "device_key_mismatch");

	// La lista de vinculados de la Main cambia en este momento, no al aprobar.
	await avisarSolicitudALaMain(env, tenantId);

	return ok({ tenantId, token, deviceId, expiresInSeconds: ttlSeconds });
}

/**
 * La Handy deja de esperar la aprobación: suelta el código que había reclamado.
 *
 * Sin esto, cancelar en la Handy sólo paraba la espera en la pantalla y la solicitud seguía en la
 * lista de la Main. Si alguien la aprobaba después, el dispositivo quedaba dado de alta sin que
 * ninguna Handy fuera a recoger nunca el token. Soltar el claim la quita de la lista y deja el
 * código como estaba antes: la misma Handy, u otra, puede volver a usarlo mientras no caduque.
 *
 * Sólo se suelta una solicitud PENDIENTE. Si la Main ya la aprobó, no se toca: deshacer eso sería
 * revocar un dispositivo, y la Handy puede recoger su token volviendo a reclamar el mismo código.
 */
export async function soltarCodigo(
	db: Base,
	env: any,
	datos: z.infer<typeof cancelSchema>,
	ahoraMs: number,
): Promise<Resultado> {
	const { pairCode, deviceId, nonceB64, sigB64, ts } = datos;

	if (relojFueraDeMargen(ts, ahoraMs)) return fallo(401, "timestamp_out_of_range");

	const prRes = await db.execute({
		sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});
	const pr = prRes.rows?.[0] as any | undefined;
	// AUD-10: como en `entregarToken`, quien no es el reclamante no sabe si el código existe.
	if (!pr || String(pr.claimed_by_device_id || "") !== deviceId) return fallo(404, "pair_code_not_found");

	const problema = await comprobarFirmaDelReclamante(db, {
		accion: "PAIR_CANCEL",
		pairCode,
		deviceId,
		nonceB64,
		ts,
		sigB64,
		pubB64: String(pr.claimed_device_pubkey_b64 || ""),
		ahoraMs,
	});
	if (problema) return fallo(problema.status, problema.error);

	const soltado = await db.execute({
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
	await db.execute({
		sql: `UPDATE device_challenges SET used_at_ms=? WHERE device_id=? AND nonce_b64=? AND used_at_ms IS NULL;`,
		args: [ahoraMs, deviceId, nonceB64],
	});

	const liberado = soltado.rowsAffected > 0;
	if (liberado) await avisarSolicitudALaMain(env, String(pr.tenant_id || ""));

	return ok({ liberado });
}
