// src/lib/deviceAuth.ts
//
// Helpers de autorización a nivel de dispositivo, compartidos por los dominios, el pairing,
// el upgrade del WebSocket y el Durable Object.
//
// ── CRITERIO ÚNICO DE REVOCACIÓN ─────────────────────────────────────────────────────────
//
// `devices.revoked_at_ms` es `INTEGER` **nullable y sin DEFAULT**, así que su semántica la
// fija el esquema: **NULL = nunca revocado; cualquier otro valor = el instante en que se
// revocó**. Un `0` no lo puede producir nadie (`Date.now()` no devuelve 0 y ningún INSERT
// escribe la columna a mano salvo para ponerla a NULL).
//
// Antes esa columna se leía de tres formas distintas repartidas por diez ficheros:
// `IS NULL`, `IS NULL OR = 0`, y la truthiness de JS (`if (row.revoked_at_ms)`). Las dos
// últimas dan por ACTIVO un `0` — es decir, fallan **abriendo** la puerta en una
// comprobación de seguridad, y encima defendiéndose de un valor que el esquema no genera.
// Peor aún: al leerse distinto en cada sitio, un mismo dispositivo podía estar vivo para
// unos endpoints y muerto para otros, que es exactamente el fallo que costó una tarde de
// investigación (la Main pasaba `/v1/license/status` y fallaba en todo lo demás).
//
// El criterio vive aquí y solo aquí. Nadie más debe escribir `revoked_at_ms` en un WHERE.

import type { Base } from "./sql";

import type { Env } from "../env";
import { getDb } from "../server/db";

/**
 * Fragmento SQL del WHERE: "este dispositivo no está revocado".
 *
 * Se usa cuando la consulta debe **filtrar** (listados, UPDATEs condicionales). Cuando hay
 * que distinguir "no existe" de "revocado" para devolver un error distinto, NO se filtra:
 * se carga la fila con [`cargarDevice`] y se pregunta con [`estaRevocado`].
 */
export const SQL_DEVICE_ACTIVO = "revoked_at_ms IS NULL";

/** Fila de `devices` tal y como sale de la BD central (nombres de columna, sin mapear). */
export type FilaDevice = {
	role: string | null;
	revoked_at_ms: number | null;
	device_pubkey_b64: string | null;
};

/**
 * ¿Está revocado el dispositivo de esta fila?
 *
 * Espejo exacto de [`SQL_DEVICE_ACTIVO`] para cuando la fila ya está cargada. Quien llama
 * debe haber resuelto antes el caso "no hay fila": no es lo mismo un dispositivo que nunca
 * existió que uno al que le retiraron el acceso, y el error que se devuelve es distinto.
 */
export function estaRevocado(fila: { revoked_at_ms?: unknown }): boolean {
	return fila.revoked_at_ms != null;
}

/** Normaliza el rol: la fila la escribe el aprovisionamiento y una mayúscula no puede decidir nada. */
export function normalizarRol(role: unknown): string {
	return String(role ?? "").trim().toLowerCase();
}

/**
 * Carga la fila del dispositivo **sin filtrar por revocación**: quien llama decide qué hacer
 * con ella (401 `device_not_registered` vs 401 `device_revoked`, congelar el socket, etc.).
 */
export async function cargarDevice(
	db: Base,
	tenantId: string,
	deviceId: string,
): Promise<FilaDevice | null> {
	const r = await db.execute({
		sql: `
			SELECT role, revoked_at_ms, device_pubkey_b64
			FROM devices
			WHERE tenant_id=? AND device_id=?
			LIMIT 1;
		`,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	if (!row) return null;

	return {
		role: row.role == null ? null : String(row.role),
		revoked_at_ms: row.revoked_at_ms == null ? null : Number(row.revoked_at_ms),
		device_pubkey_b64:
			row.device_pubkey_b64 == null ? null : String(row.device_pubkey_b64),
	};
}

/**
 * ¿Existe el dispositivo, sigue vivo y tiene exactamente este rol?
 *
 * Es la pregunta que hacían por su cuenta —cada una con su propio SQL— las seis copias de
 * `isTpvDevice`/`isMainDevice` repartidas por pairing y dominios.
 */
export async function tieneRol(
	db: Base,
	tenantId: string,
	deviceId: string,
	rol: "tpv" | "handy",
): Promise<boolean> {
	const fila = await cargarDevice(db, tenantId, deviceId);
	if (!fila) return false;
	if (estaRevocado(fila)) return false;

	return normalizarRol(fila.role) === rol;
}

/**
 * Devuelve `true` si el dispositivo (tenant_id + device_id) está emparejado con
 * rol `tpv` y no ha sido revocado. Usado para restringir endpoints que solo la
 * Main debe consumir.
 */
export async function isTpvDevice(
	env: Env,
	tenantId: string,
	deviceId: string,
): Promise<boolean> {
	return tieneRol(getDb(env), tenantId, deviceId, "tpv");
}
