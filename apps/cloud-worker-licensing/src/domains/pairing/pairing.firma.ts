// src/domains/pairing/pairing.firma.ts
//
// La prueba de que quien habla es el dispositivo que reclamó el código.
//
// Las rutas que usa la Handy antes de tener token (`fetch-token`, `cancel`) son anónimas. Lo que
// las protege es que el cuerpo va firmado con la clave cuya parte pública quedó guardada en el
// claim, sobre un reto de un solo uso: `ts \n ACCION \n código \n reto \n dispositivo`. La acción va
// dentro para que la firma de una consulta no sirva para cancelar, ni al revés.

import type { Client } from "@libsql/client/web";

import { b64ToBytes } from "../../server/utils/base64";
import { ed25519Verify, nobleForceU8 } from "../../server/utils/nobleEd25519";

export type AccionFirmada = "PAIR_FETCH" | "PAIR_CANCEL";

export type ProblemaDeFirma = { status: 401 | 404 | 409 | 410; error: string };

const MARGEN_DE_RELOJ_MS = 2 * 60 * 1000;

export function sanitizeB64(input: string): string {
	let s = String(input || "").trim();

	s = s.replace(/^"+|"+$/g, "");
	s = s.replace(/\s+/g, "");
	s = s.replace(/-/g, "+").replace(/_/g, "/");

	const mod = s.length % 4;
	if (mod === 2) s += "==";
	else if (mod === 3) s += "=";

	return s;
}

export function mensajeFirmado(
	accion: AccionFirmada,
	ts: number,
	pairCode: string,
	nonceB64: string,
	deviceId: string,
): string {
	return `${accion}\n${ts}\n${pairCode}\n${nonceB64}\n${deviceId}`;
}

/** Se mira lo primero: con el reloj del dispositivo mal, nada de lo demás va a salir. */
export function relojFueraDeMargen(ts: number, ahoraMs: number): boolean {
	return Math.abs(ahoraMs - ts) > MARGEN_DE_RELOJ_MS;
}

/**
 * Comprueba el reto y la firma. `null` si todo cuadra; si no, el error con el que contestar. No
 * gasta el reto: eso lo hace quien llama, cuando la operación sale bien.
 */
export async function comprobarFirmaDelReclamante(
	db: Client,
	datos: {
		accion: AccionFirmada;
		pairCode: string;
		deviceId: string;
		nonceB64: string;
		ts: number;
		sigB64: string;
		pubB64: string;
		ahoraMs: number;
	},
): Promise<ProblemaDeFirma | null> {
	const chRes = await db.execute({
		sql: `
			SELECT *
			FROM device_challenges
			WHERE device_id=?
			  AND nonce_b64=?
			LIMIT 1;
		`,
		args: [datos.deviceId, datos.nonceB64],
	});

	const ch = chRes.rows?.[0] as any | undefined;
	if (!ch) return { status: 404, error: "challenge_not_found" };
	if (ch.used_at_ms) return { status: 409, error: "challenge_used" };
	if (Number(ch.expires_at_ms || 0) < datos.ahoraMs) return { status: 410, error: "challenge_expired" };

	let sigU8: Uint8Array;
	let pubU8: Uint8Array;

	try {
		sigU8 = nobleForceU8(b64ToBytes(sanitizeB64(datos.sigB64)));
		pubU8 = nobleForceU8(b64ToBytes(sanitizeB64(datos.pubB64)));
	} catch {
		return { status: 401, error: "bad_b64" };
	}

	if (sigU8.length !== 64) return { status: 401, error: "bad_signature_len" };
	if (pubU8.length !== 32) return { status: 401, error: "bad_pubkey_len" };

	const mensaje = new TextEncoder().encode(
		mensajeFirmado(datos.accion, datos.ts, datos.pairCode, datos.nonceB64, datos.deviceId),
	);

	const ok = await ed25519Verify(sigU8, nobleForceU8(mensaje), pubU8);
	return ok ? null : { status: 401, error: "bad_device_signature" };
}
