// src/domains/pairing/pairing.main.ts
//
// Lo que hace la Main con las solicitudes de emparejamiento: crear un código, ver las que hay
// pendientes, aprobar una y rechazarla.
//
// Quién es la Main —y que lo sea— lo resuelven los middlewares de la ruta (`tenantAuth` +
// `soloLaMainVigente`), no estas funciones: aquí el `tenantId` ya llega comprobado. Antes cada handler
// repetía `buildTenantContext` + claims vacíos + `tieneRol` + un `try/catch` que clasificaba el
// error de autenticación comparando cadenas (`isAuthError`, cinco copias idénticas).

import type { Client } from "@libsql/client/web";

import { rowsAffected } from "../../server/db";
import { sha256HexStr } from "../../server/utils/crypto";
import { bytesToB64 } from "../../server/utils/base64";
import { fallo, ok, type Resultado } from "./pairing.resultado";

/** Los 10 minutos que vive un código de vinculación. */
const VIDA_DEL_CODIGO_MS = 10 * 60 * 1000;

/** Cuántas veces se reintenta si el código de 6 cifras ya existe. */
const INTENTOS_DE_CODIGO = 10;

/**
 * AUD-12: cuántos códigos vivos puede tener a la vez un negocio.
 *
 * Los números son un millón y los compartimos todos los negocios: `pair_code` es la clave primaria
 * de la base central. Sin tope, la Main de un negocio podía ir gastándolos hasta que a todos los
 * demás les fallaran casi todas las creaciones. Nadie vincula veinte Handy en diez minutos: la
 * pantalla pide uno al abrirse, otro cuando caduca o lo reclama una Handy, y otro al pulsar
 * «Regenerar».
 */
export const CODIGOS_VIVOS_POR_NEGOCIO = 20;

function demasiadosCodigos(): Resultado {
	return fallo(429, "too_many_attempts", {
		message: "Hay demasiados códigos de vinculación sin usar. Usa el que se ve en la pantalla o espera unos minutos.",
	});
}

function seisCifrasAlAzar(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);

	const n =
		((bytes[0] << 24) >>> 0) +
		(bytes[1] << 16) +
		(bytes[2] << 8) +
		bytes[3];

	return String(n % 1_000_000).padStart(6, "0");
}

/**
 * Crea un código nuevo para este negocio.
 *
 * El bucle reintenta sólo si el código sorteado **ya existe**, y eso se comprueba mirando la
 * tabla, no el texto de la excepción: antes era `msg.includes("UNIQUE") || …("constraint")`, que
 * es la misma clasificación por cadenas que se ha quitado del resto del fichero — y que al
 * primer cambio de redacción en libsql habría convertido una colisión (normal: hay un millón de
 * códigos y los vivos duran diez minutos) en un 500.
 *
 * AUD-12: el tope de códigos vivos del negocio va DENTRO de la misma sentencia, no en una lectura
 * previa: en la base central cada escritura va con el cerrojo del escritor, así que el recuento y el
 * alta no se cruzan con otra creación simultánea. Los números se liberan con la purga diaria
 * (`server/purga.ts`), un día después de caducar.
 */
export async function crearCodigo(
	db: Client,
	env: any,
	tenantId: string,
	deviceId: string,
	now: number,
): Promise<Resultado> {
	const expiresAtMs = now + VIDA_DEL_CODIGO_MS;

	const secretBytes = new Uint8Array(32);
	crypto.getRandomValues(secretBytes);

	const pairSecret = bytesToB64(secretBytes);
	const pepper = String(env.PAIR_PEPPER || "");
	const secretHash = await sha256HexStr(`${pairSecret}.${pepper}`);

	for (let i = 0; i < INTENTOS_DE_CODIGO; i++) {
		const pairCode = seisCifrasAlAzar();

		// `ON CONFLICT DO NOTHING` sobre la clave primaria: si el código está cogido no inserta y
		// **no lanza**, así que la colisión se reconoce por `rowsAffected`. Es además atómico, que
		// un `WHERE NOT EXISTS` no sería. El `WHERE` del `SELECT` es el tope (y es también lo que
		// deja a SQLite leer el `ON CONFLICT` como tal y no como la condición de un JOIN).
		const r = await db.execute({
			sql: `
				INSERT INTO pair_requests (
					pair_code,
					secret_hash,
					tenant_id,
					created_by_device_id,
					status,
					created_at_ms,
					expires_at_ms
				)
				SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6
				WHERE (
					SELECT COUNT(*) FROM pair_requests WHERE tenant_id = ?3 AND expires_at_ms >= ?5
				) < ?7
				ON CONFLICT(pair_code) DO NOTHING;
			`,
			args: [pairCode, secretHash, tenantId, deviceId, now, expiresAtMs, CODIGOS_VIVOS_POR_NEGOCIO],
		});

		if (rowsAffected(r) > 0) return ok({ pairCode, pairSecret, expiresAtMs });

		// No ha entrado: o el número estaba cogido (se sortea otro) o el negocio está en su tope (no
		// tiene sentido sortear más). Sólo se pregunta cuál cuando ha fallado, que es lo raro.
		const vivos = await db.execute({
			sql: `SELECT COUNT(*) AS n FROM pair_requests WHERE tenant_id = ? AND expires_at_ms >= ?;`,
			args: [tenantId, now],
		});
		if (Number((vivos.rows?.[0] as any)?.n ?? 0) >= CODIGOS_VIVOS_POR_NEGOCIO) return demasiadosCodigos();
	}

	return fallo(500, "pair_code_generation_failed");
}

/** Las solicitudes que esperan aprobación en este negocio. */
export async function solicitudesPendientes(
	db: Client,
	tenantId: string,
	now: number,
): Promise<Resultado> {
	await db.execute({
		sql: `
			UPDATE pair_requests
			SET status='expired'
			WHERE tenant_id=?
			  AND used_at_ms IS NULL
			  AND expires_at_ms < ?
			  AND status IN ('pending', 'approved');
		`,
		args: [tenantId, now],
	});

	// Una solicitud que ya no espera nadie (la Handy se cerró esperando) no se suelta aquí: la suelta
	// la propia Handy al volver a abrirse, con la espera que guardó (`soltarEsperaAnterior`). Desde
	// aquí no se puede saber si alguien la espera: una Handy vinculada que vuelve a pedir el mismo
	// negocio sigue conectada con su vínculo de antes mientras espera, y su `last_seen_at_ms` no dice
	// nada de la espera.

	const r = await db.execute({
		sql: `
			SELECT
				pair_code,
				status,
				created_at_ms,
				expires_at_ms,
				claimed_at_ms,
				claimed_by_device_id,
				claimed_device_name,
				claimed_device_pubkey_b64,
				attempts,
				last_attempt_at_ms
			FROM pair_requests
			WHERE tenant_id=?
			  AND used_at_ms IS NULL
			  AND expires_at_ms >= ?
			  AND status='pending'
			  AND claimed_by_device_id IS NOT NULL
			ORDER BY claimed_at_ms DESC
			LIMIT 50;
		`,
		args: [tenantId, now],
	});

	const items = (r.rows || []).map((row: any) => ({
		pairCode: String(row.pair_code),
		status: String(row.status || "pending"),
		createdAtMs: Number(row.created_at_ms || 0),
		expiresAtMs: Number(row.expires_at_ms || 0),

		claimedAtMs: row.claimed_at_ms != null ? Number(row.claimed_at_ms) : null,
		claimedDeviceId: row.claimed_by_device_id ? String(row.claimed_by_device_id) : null,
		claimedDeviceName: row.claimed_device_name ? String(row.claimed_device_name) : null,
		claimedDevicePubKeyB64: row.claimed_device_pubkey_b64
			? String(row.claimed_device_pubkey_b64)
			: null,

		attempts: Number(row.attempts || 0),
		lastAttemptAtMs: row.last_attempt_at_ms != null ? Number(row.last_attempt_at_ms) : null,
	}));

	return ok({ items });
}

/** La Main aprueba una solicitud: marca el código, y nada más. */
export async function aprobarSolicitud(
	db: Client,
	tenantId: string,
	pairCode: string,
	now: number,
): Promise<Resultado> {
	const prRes = await db.execute({
		sql: `SELECT * FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});

	const pr = prRes.rows?.[0] as any | undefined;

	// AUD-10: un código de otro negocio se contesta igual que uno que no existe, como en
	// `rechazarSolicitud`. Antes era `wrong_tenant`, y la Main de cualquier negocio sabía así qué
	// códigos se habían emitido alguna vez.
	if (!pr || String(pr.tenant_id || "") !== tenantId) return fallo(404, "pair_code_not_found");
	if (pr.used_at_ms) return fallo(409, "already_used");

	if (Number(pr.expires_at_ms || 0) < now) {
		await db.execute({
			sql: `
				UPDATE pair_requests
				SET status='expired'
				WHERE pair_code=?
				  AND tenant_id=?
				  AND used_at_ms IS NULL;
			`,
			args: [pairCode, tenantId],
		});

		// `pair_code_expired` y no `expired`: ése es el alias de licencia caducada del catálogo, y
		// la Main habría leído «La licencia ha caducado» al aprobar un código viejo.
		return fallo(410, "pair_code_expired");
	}

	const status = String(pr.status || "").trim().toLowerCase();

	if (status === "approved") return ok({ state: "approved" });
	if (status !== "pending") return fallo(409, "invalid_pair_status", { status });

	const handyDeviceId = String(pr.claimed_by_device_id || "").trim();
	const handyPub = String(pr.claimed_device_pubkey_b64 || "").trim();

	if (!handyDeviceId || !handyPub) return fallo(409, "no_claim_to_approve");

	// Aprobar sólo marca el código. El dispositivo se da de alta cuando la Handy recoge su token
	// (`pairing.handy.ts::entregarToken`): dado de alta aquí, una aprobación que nadie recogía
	// dejaba en `devices` un Handy que no existía.
	const updateRes = await db.execute({
		sql: `
			UPDATE pair_requests
			SET status='approved',
			    approved_at_ms=?
			WHERE pair_code=?
			  AND tenant_id=?
			  AND used_at_ms IS NULL
			  AND status='pending'
			  AND claimed_by_device_id IS NOT NULL
			  AND expires_at_ms >= ?;
		`,
		args: [now, pairCode, tenantId, now],
	});

	if (rowsAffected(updateRes) <= 0) return fallo(409, "pair_approve_race_or_invalid_state");

	return ok({ state: "approved" });
}

/**
 * La Main rechaza una solicitud de emparejamiento.
 *
 * Antes sólo se podía aprobar. Una solicitud que no se reconocía (una huella que no cuadra, un
 * dispositivo que no es del bar) se quedaba en la lista hasta caducar, y la Handy que la hizo
 * esperando. Rechazarla la quita de la lista y la Handy se entera en su siguiente consulta
 * (`pair_rejected` en `fetch-token`), en vez de agotar la espera.
 *
 * Rechazar quema el código: para volver a intentarlo hace falta uno nuevo, que es lo que tiene
 * sentido si quien lo usó no era de fiar.
 */
export async function rechazarSolicitud(
	db: Client,
	tenantId: string,
	pairCode: string,
	ahoraMs: number,
): Promise<Resultado> {
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
	if (rowsAffected(r) > 0) return ok({ state: "rejected" });

	const prRes = await db.execute({
		sql: `SELECT status, tenant_id, expires_at_ms, used_at_ms FROM pair_requests WHERE pair_code=? LIMIT 1;`,
		args: [pairCode],
	});
	const pr = prRes.rows?.[0] as any | undefined;

	// Un código de otro negocio se contesta igual que uno que no existe: decir otra cosa diría
	// que ese código está en uso en algún sitio.
	if (!pr || String(pr.tenant_id || "") !== tenantId) return fallo(404, "pair_code_not_found");
	if (String(pr.status || "") === "rejected") return ok({ state: "rejected" });
	if (!pr.used_at_ms && Number(pr.expires_at_ms || 0) < ahoraMs) return fallo(410, "pair_code_expired");

	return fallo(409, "invalid_pair_status", { status: pr.status });
}
