// src/domains/ws/canje.ts
//
// SYNC-15 · Canjear el ticket de un solo uso con el que se abre el WebSocket (`GET /ws`, `app.ts`).
//
// Abrir un socket costaba cuatro viajes a la base central: el Worker canjeaba el ticket y cargaba el
// dispositivo, y el TenantHub, al saludar, volvía a cargar el mismo dispositivo y apuntaba su
// `last_seen`. Ahora es uno: el canje, la fila del dispositivo y el `last_seen` van en un solo lote,
// en una transacción, y el TenantHub se fía de lo que el Worker le pasa (sólo el Worker puede hablar
// con él: `lib/enElHub.ts`).
//
// El ticket sigue siendo de un solo uso: lo que decide si esta petición lo ha canjeado es el `DELETE
// … RETURNING`, dentro de la misma transacción que lee la fila. Dos peticiones con el mismo ticket
// van una detrás de otra, y la segunda no encuentra nada que borrar.

import type { Client } from "@libsql/client/web";

import { SQL_DEVICE_ACTIVO, estaRevocado, normalizarRol } from "../../lib/deviceAuth";

/** Quién abre el socket, según la base central: lo que el Worker le pasa al TenantHub. */
export type SocketAutorizado = {
	ok: true;
	tenantId: string;
	deviceId: string;
	/** El rol de la fila del dispositivo (`tpv` | `handy`), normalizado. */
	rol: string;
	/** La clave pública registrada del dispositivo: con ella el TenantHub verifica el saludo. */
	clave: string;
};

export type SocketRechazado = {
	ok: false;
	error: "invalid_ticket" | "expired_ticket" | "device_not_registered" | "device_revoked" | "device_pubkey_not_registered";
};

/**
 * Canjea `ticket` y devuelve quién abre el socket, o por qué no puede.
 *
 * El lote, en una transacción y un viaje: la fila del ticket con la de su dispositivo; el
 * `last_seen` del dispositivo, sólo si el ticket vale y el dispositivo está vivo y tiene su clave
 * (lo que antes apuntaba el TenantHub al aceptar el socket); y el canje, que borra el ticket. Un
 * ticket caducado se gasta igual: no vale para nada.
 */
export async function canjearTicket(db: Pick<Client, "batch">, ticket: string, ahoraMs: number): Promise<SocketAutorizado | SocketRechazado> {
	const [leido, , canjeado] = await db.batch(
		[
			{
				sql: `SELECT t.tenant_id, t.device_id, t.expires_at_ms,
				             d.device_id AS registrado, d.role, d.device_pubkey_b64, d.revoked_at_ms
				      FROM Ws_Tickets t
				      LEFT JOIN devices d ON d.tenant_id = t.tenant_id AND d.device_id = t.device_id
				      WHERE t.ticket = ?1;`,
				args: [ticket],
			},
			{
				sql: `UPDATE devices SET last_seen_at_ms = ?2
				      WHERE (tenant_id, device_id) = (SELECT tenant_id, device_id FROM Ws_Tickets
				                                       WHERE ticket = ?1 AND expires_at_ms >= ?2)
				        AND ${SQL_DEVICE_ACTIVO} AND COALESCE(TRIM(device_pubkey_b64), '') <> '';`,
				args: [ticket, ahoraMs],
			},
			{
				sql: `DELETE FROM Ws_Tickets WHERE ticket = ?1 RETURNING tenant_id, device_id, expires_at_ms;`,
				args: [ticket],
			},
		],
		"write",
	);

	// Sólo cuenta el ticket que ha borrado esta petición.
	const borrado = canjeado.rows?.[0] as any | undefined;
	const fila = leido.rows?.[0] as any | undefined;
	if (!borrado || !fila) return { ok: false, error: "invalid_ticket" };
	if (Number(borrado.expires_at_ms) < ahoraMs) return { ok: false, error: "expired_ticket" };

	const tenantId = String(borrado.tenant_id || "");
	const deviceId = String(borrado.device_id || "");
	if (!tenantId || !deviceId) return { ok: false, error: "invalid_ticket" };
	if (fila.registrado == null) return { ok: false, error: "device_not_registered" };
	if (estaRevocado(fila)) return { ok: false, error: "device_revoked" };

	const clave = String(fila.device_pubkey_b64 || "").trim();
	if (!clave) return { ok: false, error: "device_pubkey_not_registered" };

	return { ok: true, tenantId, deviceId, rol: normalizarRol(fila.role), clave };
}

/**
 * Las cabeceras con las que el Worker le dice al TenantHub quién abre el socket. Las pone sólo el
 * Worker: si el cliente manda alguna, se quita antes (una que se colara pasaría por la del Worker).
 */
export const CABECERAS_DE_IDENTIDAD = ["x-tenant-id", "x-device-id", "x-role", "x-device-pubkey-b64"] as const;
