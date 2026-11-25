// src/server/central/operaciones/emparejamiento.ts
//
// EMPAREJAR-TOKEN · La recogida del token de una Handy (`/v1/pair/fetch-token`,
// `domains/pairing/pairing.handy.ts::entregarToken`): gastar el reto, gastar el código y dar de alta
// el dispositivo van juntos o no van. Con sentencias sueltas, un fallo del alta dejaba el reto y el
// código gastados sin dispositivo, y había que emparejar otra vez.
//
// Lo que la ruta necesita y no escribe (la firma, la licencia del negocio, la clave del equipo si
// está en otro) lo comprueba antes, fuera. El token lo firma la ruta cuando esto ha entrado.

import type { SqlSync } from "../../../lib/sql";

type DatosDeLaRecogida = {
	pairCode: string;
	deviceId: string;
	/** El reto que la Handy ha firmado en esta recogida. */
	nonceB64: string;
	/** El negocio del código. */
	tenantId: string;
	/** La clave con la que reclamó el código, la que la Main aprobó. */
	pubB64: string;
	ahoraMs: number;
};

/**
 * Lo que pasa con la recogida. Sólo `dado_de_alta` escribe: los demás no dejan nada.
 */
type ResultadoDeLaRecogida =
	| { resultado: "dado_de_alta" }
	/** El reto ya se gastó (otra recogida, o una cancelación) o ha caducado. */
	| { resultado: "reto_gastado" }
	/** El código ya no está aprobado para este dispositivo: otra recogida lo ha gastado, o ha caducado. */
	| { resultado: "codigo_gastado" }
	/** El `device_id` es de otro negocio y con otra clave (REV-07, AUD-01). */
	| { resultado: "clave_de_otro" };

/**
 * Gasta el reto y el código y da de alta (o reactiva) la Handy, todo o nada.
 *
 * Primero se mira, sin escribir, que el reto y el código sigan como los vio la ruta: dentro de la
 * transacción de la operación nadie los puede gastar entre que se miran y se escriben, y así un «no»
 * sale sin haber escrito nada. Después el alta, que es la única que puede decir que no escribiendo
 * (su regla va dentro de la sentencia), y por último las dos que gastan, con su condición también
 * dentro: si una no entrara pese a lo mirado, la operación lanza y no queda nada.
 */
export function recogerTokenDeLaHandy(sql: SqlSync, d: DatosDeLaRecogida): ResultadoDeLaRecogida {
	if (!retoVivo(sql, d)) return { resultado: "reto_gastado" };
	if (!codigoAprobadoParaEste(sql, d)) return { resultado: "codigo_gastado" };
	if (!darDeAlta(sql, d)) return { resultado: "clave_de_otro" };
	gastar(sql, "el reto", {
		sql: `
			UPDATE device_challenges
			SET used_at_ms=?
			WHERE device_id=?
			  AND nonce_b64=?
			  AND used_at_ms IS NULL
			  AND expires_at_ms >= ?;
		`,
		args: [d.ahoraMs, d.deviceId, d.nonceB64, d.ahoraMs],
	});
	// El código y el reto quedan gastados con la misma hora: es lo que reconoce el reintento de una
	// recogida que entró y cuya respuesta se perdió (`entregarToken`).
	gastar(sql, "el código", {
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
		args: [d.ahoraMs, d.pairCode, d.deviceId, d.ahoraMs],
	});
	return { resultado: "dado_de_alta" };
}

function retoVivo(sql: SqlSync, d: DatosDeLaRecogida): boolean {
	const r = sql.execute({
		sql: `
			SELECT 1 AS vivo
			FROM device_challenges
			WHERE device_id=?
			  AND nonce_b64=?
			  AND used_at_ms IS NULL
			  AND expires_at_ms >= ?
			LIMIT 1;
		`,
		args: [d.deviceId, d.nonceB64, d.ahoraMs],
	});
	return r.rows.length > 0;
}

function codigoAprobadoParaEste(sql: SqlSync, d: DatosDeLaRecogida): boolean {
	const r = sql.execute({
		sql: `
			SELECT 1 AS aprobado
			FROM pair_requests
			WHERE pair_code=?
			  AND claimed_by_device_id=?
			  AND status='approved'
			  AND used_at_ms IS NULL
			  AND expires_at_ms >= ?
			LIMIT 1;
		`,
		args: [d.pairCode, d.deviceId, d.ahoraMs],
	});
	return r.rows.length > 0;
}

/**
 * El alta: ahora, y no al aprobar, es cuando el dispositivo existe de verdad. Si ya estaba (una Handy
 * que se vuelve a vincular), se reactiva.
 *
 * `device_pubkey_b64` se escribe, pero no puede CAMBIAR de dueño (REV-07): una fila que ya existe sólo
 * se toca si es de este negocio (la recuperación que aprueba el dueño) o si su clave registrada es
 * ésta (la mudanza del propio equipo). La ruta lo ha comprobado antes (`exigirClaveSiEsDeOtroNegocio`),
 * pero esa lectura no está en la transacción, así que la regla va también dentro de la sentencia
 * (AUD-01): de dos recogidas simultáneas del mismo `device_id`, en negocios y con claves distintos,
 * entra una sola.
 */
function darDeAlta(sql: SqlSync, d: DatosDeLaRecogida): boolean {
	const r = sql.execute({
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
		args: [d.deviceId, d.tenantId, d.ahoraMs, d.ahoraMs, d.pubB64],
	});
	return r.rowsAffected > 0;
}

/** Una escritura que lo mirado garantiza: si no entra, se lanza y no queda nada de la recogida. */
function gastar(sql: SqlSync, que: string, sentencia: { sql: string; args: (string | number)[] }): void {
	if (sql.execute(sentencia).rowsAffected <= 0) {
		throw new Error(`La recogida del token no ha podido gastar ${que}, que seguía vivo al mirarlo.`);
	}
}
