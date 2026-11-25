// src/server/central/operaciones/traslado.ts
//
// TRASLADO-REINTENTO · El traslado de una licencia a otro equipo con el código del correo
// (`/v1/license/activate`, `domains/licensing/licensing.routes.ts`): gastar el código, dar de alta el
// equipo nuevo y mover la licencia con su traza (`license_device_swaps`) van juntos o no van. Con
// viajes sueltos, el código se gastaba primero, y un fallo de la central en el alta del equipo o en
// el traslado obligaba a pedir otro.
//
// Lo que decide va antes de escribir nada, así que un resultado de negocio no deja nada hecho: la
// licencia que ya no está en el equipo del que se traslada, la clave del equipo que ha cambiado, el
// código que ya no vale. Lo que la ruta comprueba antes (la licencia, la firma, el código comparado
// con su huella) llega en los datos.
//
// El código gastado y la traza llevan la misma hora (`ahoraMs`): es lo que reconoce después el
// reintento del mismo traslado (`licenseStore.ts::trasladoQueSeRepite`).

import type { SqlSync } from "../../../lib/sql";
import { ALTA_DEL_EQUIPO, ALTA_DEL_NEGOCIO, argumentosDelAltaDelEquipo, argumentosDelAltaDelNegocio } from "./licencias";

type DatosDelTraslado = {
	licenciaId: string;
	/** El equipo en el que está la licencia, según lo leyó la ruta. */
	deDeviceId: string | null;
	/** El equipo nuevo, que trae el código. */
	aDeviceId: string;
	/** Su clave pública, con la que la ruta ha comprobado la firma. */
	devicePubKey: string;
	/** El negocio de la licencia. */
	tenantId: string;
	/** La huella del código que la ruta ha comparado con el tecleado. */
	codeHash: string;
	/** El id de la traza: lo pone la ruta, que lo busca si la respuesta se pierde. */
	swapId: string;
	ahoraMs: number;
};

export type ResultadoDelTraslado =
	| { resultado: "trasladada" }
	/** La licencia ya no está en el equipo del que se trasladaba: otra petición se ha adelantado. */
	| { resultado: "movida" }
	/** El equipo nuevo ya está registrado con otra clave (o sin ninguna). */
	| { resultado: "clave_distinta" }
	/** El código ya está gastado, ha caducado o se ha pedido otro. */
	| { resultado: "codigo_invalido" };

export function trasladarLicencia(sql: SqlSync, d: DatosDelTraslado): ResultadoDelTraslado {
	if (!sigueEnElEquipo(sql, d.licenciaId, d.deDeviceId)) return { resultado: "movida" };
	if (!claveDelEquipoValida(sql, d.aDeviceId, d.devicePubKey)) return { resultado: "clave_distinta" };
	if (!gastarCodigo(sql, d)) return { resultado: "codigo_invalido" };

	sql.execute({ sql: ALTA_DEL_NEGOCIO, args: argumentosDelAltaDelNegocio(d.tenantId, d.ahoraMs) });
	// El alta del equipo, la misma sentencia que `ensureDevice`: una fila que ya existe sólo se muda
	// si su clave es ésta, que se ha mirado arriba. Si aun así no entra, se deshace todo.
	const alta = sql.execute({
		sql: ALTA_DEL_EQUIPO,
		args: argumentosDelAltaDelEquipo({
			deviceId: d.aDeviceId,
			tenantId: d.tenantId,
			rol: "tpv",
			devicePubKeyB64: d.devicePubKey,
			ahoraMs: d.ahoraMs,
		}),
	});
	if (alta.rowsAffected <= 0) throw new Error("El alta del equipo nuevo no ha entrado con la clave que se ha comprobado.");

	sql.execute({
		sql: `UPDATE licenses SET main_device_id = ?, updated_at_ms = ? WHERE license_id = ?;`,
		args: [d.aDeviceId, d.ahoraMs, d.licenciaId],
	});
	sql.execute({
		sql: `INSERT INTO license_device_swaps (swap_id, license_id, from_device_id, to_device_id, at_ms)
          VALUES (?, ?, ?, ?, ?);`,
		args: [d.swapId, d.licenciaId, d.deDeviceId, d.aDeviceId, d.ahoraMs],
	});
	return { resultado: "trasladada" };
}

/** ¿Sigue la licencia en el equipo del que se traslada, viva? */
function sigueEnElEquipo(sql: SqlSync, licenciaId: string, deDeviceId: string | null): boolean {
	const r = sql.execute({
		sql: `SELECT 1 AS si FROM licenses
           WHERE license_id = ? AND main_device_id IS ? AND disabled = 0 AND status IN ('active', 'expired');`,
		args: [licenciaId, deDeviceId],
	});
	return r.rows.length > 0;
}

/**
 * ¿Puede el equipo nuevo darse de alta con esta clave? Sin fila, sí; con fila, sólo si la registrada
 * es ésta (AUD-01: una fila sin clave registrada no se la lleva quien firme con la suya).
 */
function claveDelEquipoValida(sql: SqlSync, deviceId: string, pub: string): boolean {
	const r = sql.execute({ sql: `SELECT device_pubkey_b64 FROM devices WHERE device_id = ?;`, args: [deviceId] });
	const fila = r.rows[0] as { device_pubkey_b64?: unknown } | undefined;
	if (!fila) return true;
	const registrada = String(fila.device_pubkey_b64 ?? "").trim();
	return registrada !== "" && registrada === pub.trim();
}

/**
 * Gasta el código que se ha comparado (AUD-04: sólo el de esa huella, y si no ha caducado): si dos
 * peticiones llegan a la vez con el código bueno, sólo una lo gasta.
 */
function gastarCodigo(sql: SqlSync, d: DatosDelTraslado): boolean {
	const r = sql.execute({
		sql: `UPDATE license_device_otp
             SET consumed_at_ms = ?
           WHERE license_id = ? AND new_device_id = ? AND consumed_at_ms IS NULL AND code_hash = ?
             AND expires_at_ms >= ?;`,
		args: [d.ahoraMs, d.licenciaId, d.aDeviceId, d.codeHash, d.ahoraMs],
	});
	return r.rowsAffected > 0;
}
