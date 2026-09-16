// src/server/endpoints/rest/pairing/pairing.intentos.ts
//
// Cuánto hay que esperar para volver a intentar una vinculación después de fallar.
//
// El código manual son 6 cifras sin secreto, así que quien pruebe códigos al azar no puede tener
// barra libre. Pero quien se equivoca al teclear tampoco puede quedarse fuera diez minutos. La
// espera crece por tramos de tres fallos seguidos desde la misma IP:
//
//   3 fallos → 30 segundos · 6 → 5 minutos · 9 o más → 30 minutos cada tres
//
// Con eso, un error de dedo no se nota y un barrido de 10^6 códigos es imposible (unos 144 al
// día). Emparejar bien borra la cuenta, y un día sin fallar también.
//
// Va por IP y no por dispositivo porque el `deviceId` lo elige quien hace la petición. El precio es
// que todas las Handy de un bar salen por la misma IP: si un camarero falla tres veces, los demás
// esperan 30 segundos. Vincular es algo que se hace pocas veces, así que se asume.
//
// Es aparte del tope por código (8 intentos sobre el mismo código, `pairClaim.ts`), que protege un
// código concreto contra muchas IPs a la vez.

import type { Client } from "@libsql/client/web";

import { exec } from "../../../db";

export const FALLOS_POR_TRAMO = 3;
/** Pasado este tiempo sin fallar, la cuenta vuelve a empezar. */
export const OLVIDO_MS = 24 * 60 * 60 * 1000;

const TRAMOS_MS = [30_000, 5 * 60_000, 30 * 60_000];

/** La espera que impone el fallo número `fallos`. Sólo el que cierra un tramo impone una. */
export function esperaTrasFallos(fallos: number): number {
	if (fallos < FALLOS_POR_TRAMO || fallos % FALLOS_POR_TRAMO !== 0) return 0;
	const tramo = fallos / FALLOS_POR_TRAMO;
	return TRAMOS_MS[Math.min(tramo, TRAMOS_MS.length) - 1];
}

/** «30 segundos», «5 minutos», «1 minuto». */
export function textoDeEspera(segundos: number): string {
	if (segundos < 60) return `${segundos} ${segundos === 1 ? "segundo" : "segundos"}`;
	const minutos = Math.ceil(segundos / 60);
	return `${minutos} ${minutos === 1 ? "minuto" : "minutos"}`;
}

/** Segundos que le quedan a esta IP para poder volver a intentarlo (0 si puede ya). */
export async function segundosDeEspera(db: Client, ip: string, ahoraMs: number): Promise<number> {
	const r = await exec(db, `SELECT bloqueado_hasta_ms FROM pair_claim_fallos WHERE ip = ? LIMIT 1;`, [ip]);
	const hasta = Number((r.rows?.[0] as any)?.bloqueado_hasta_ms ?? 0);
	return hasta > ahoraMs ? Math.ceil((hasta - ahoraMs) / 1000) : 0;
}

/**
 * Anota un fallo y devuelve la espera que impone (0 si ninguna). El contador se lee y se sube en
 * la misma sentencia: dos fallos simultáneos desde la misma IP cuentan dos.
 */
export async function anotarFallo(db: Client, ip: string, ahoraMs: number): Promise<number> {
	const r = await exec(
		db,
		`INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
		 VALUES (?1, 1, ?2, 0)
		 ON CONFLICT(ip) DO UPDATE SET
		   fallos = CASE WHEN ?2 - pair_claim_fallos.ultimo_fallo_ms > ?3 THEN 1 ELSE pair_claim_fallos.fallos + 1 END,
		   ultimo_fallo_ms = ?2
		 RETURNING fallos;`,
		[ip, ahoraMs, OLVIDO_MS],
	);
	const fallos = Number((r.rows?.[0] as any)?.fallos ?? 1);
	const espera = esperaTrasFallos(fallos);

	if (espera > 0) {
		await exec(db, `UPDATE pair_claim_fallos SET bloqueado_hasta_ms = ? WHERE ip = ?;`, [ahoraMs + espera, ip]);
	}
	return espera;
}

export async function olvidarFallos(db: Client, ip: string): Promise<void> {
	await exec(db, `DELETE FROM pair_claim_fallos WHERE ip = ?;`, [ip]);
}
