// src/durableObjects/tenantHub.identidad.ts
//
// ARQ-04 · Quién es el que llama y qué puede hacer.
//
// Las reglas del handshake del WebSocket, sacadas de la clase: emitir el reto, leer de la base
// central lo que se sabe del dispositivo, verificar la firma y decidir el rol. El CABLEADO vive
// con su transporte --el upgrade de `/ws` emite el reto, el handler de `helloSigned` lo consume--
// pero las reglas están aquí, en un sitio, y se pueden probar sin levantar un Durable Object.
//
// Lo que no se puede perder de vista al tocar esto:
//   · el rol lo dicta EXCLUSIVAMENTE la base central; la cabecera `x-role` del cliente no otorga
//     nada (activación → 'tpv', pairing → 'handy').
//   · el reto es de un solo uso, y quien lo consume es el llamante ANTES de llamar aquí.

import type { Client } from "@libsql/client/web";

import { b64ToBytes, bytesToB64 } from "../server/utils/base64";
import { ed25519Verify, nobleForceU8 } from "../server/utils/nobleEd25519";
import { estaRevocado } from "../lib/deviceAuth";
import { nowMs } from "./tenantHub.tiempo";

import type { HelloSignedMsg, Role } from "./tenantHub.types";

export function roleNormalize(r: any): Role {
	const s = String(r || "").toLowerCase();
	if (s === "tpv") return "tpv";
	if (s === "handy") return "handy";
	return "unknown";
}

export function isEventAllowed(role: Role, name: string): boolean {
	const n = String(name || "");
	if (!n) return false;

	if (role === "tpv") return true;

	if (role === "handy") {
		return (
			n.startsWith("handy.") ||
			n.startsWith("mesa.") ||
			n.startsWith("ticket.") ||
			n.startsWith("order.")
		);
	}

	return false;
}

export async function loadDeviceFromCentral(
	dbCentral: Client,
	tenantId: string,
	deviceId: string,
): Promise<{ role: Role; pubkeyB64: string | null; revoked: boolean }> {
	const r = await dbCentral.execute({
		sql: `
			SELECT role, device_pubkey_b64, revoked_at_ms
			FROM devices
			WHERE tenant_id=? AND device_id=?
			LIMIT 1
		`,
		args: [tenantId, deviceId],
	});

	const row = r.rows?.[0] as any | undefined;
	if (!row) return { role: "unknown", pubkeyB64: null, revoked: true };

	const role = roleNormalize(row.role);
	const pubkeyB64 = String(row.device_pubkey_b64 || "").trim() || null;
	const revoked = estaRevocado(row);

	return { role, pubkeyB64, revoked };
}

// SYNC-16: ya no se guarda en un Map del DO; el llamante lo adosa al socket (attachment) para
// que sobreviva a la hibernación.
export function issueChallenge(): { nonceB64: string; expiresAtMs: number } {
	const nonce = new Uint8Array(32);
	crypto.getRandomValues(nonce);
	const nonceB64 = bytesToB64(nonce);

	const expiresAtMs = nowMs() + 60_000;

	return { nonceB64, expiresAtMs };
}

// SYNC-16: el challenge y la pista de pubkey llegan desde el attachment del socket (el llamante
// ya ha consumido el challenge antes de invocarnos) y devolvemos la pubkey confirmada para que
// el llamante la persista de vuelta en el attachment.
export async function verifyHelloSigned(params: {
	tenantId: string;
	deviceId: string;
	msg: HelloSignedMsg;
	challenge: { nonceB64: string; expiresAtMs: number } | null;
	pubkeyB64Hint?: string | null;
	/**
	 * Quién dice la base central que es este dispositivo. Llega como argumento y no como
	 * import para que un test pueda comprobar las reglas del handshake sin una base delante:
	 * lo que se prueba aquí es el reto, la firma y el rol, no el SELECT.
	 */
	cargarDispositivo: (
		tenantId: string,
		deviceId: string,
	) => Promise<{ role: Role; pubkeyB64: string | null; revoked: boolean }>;
}): Promise<{ roleFinal: Role; pubkeyB64: string }> {
	const { tenantId, deviceId, msg, challenge: ch, pubkeyB64Hint } = params;

	if (!ch) throw new Error("missing_challenge");
	if (msg.nonceB64 !== ch.nonceB64) throw new Error("challenge_mismatch");
	if (nowMs() > ch.expiresAtMs) throw new Error("challenge_expired");

	const MAX_SKEW_MS = 2 * 60 * 1000;
	if (!Number.isFinite(msg.ts)) throw new Error("bad_ts");
	if (Math.abs(nowMs() - msg.ts) > MAX_SKEW_MS) {
		throw new Error("ts_out_of_range");
	}

	let pubkeyB64 = (pubkeyB64Hint || "").trim();

	const centralInfo = await params.cargarDispositivo(tenantId, deviceId);
	if (centralInfo.revoked) throw new Error("device_revoked");
	if (centralInfo.pubkeyB64) pubkeyB64 = centralInfo.pubkeyB64;

	// El rol lo dicta EXCLUSIVAMENTE la BD central (activación → 'tpv',
	// pairing → 'handy'). La cabecera x-role es del cliente y no puede
	// otorgar privilegios: si la fila no trae un rol válido, el dispositivo
	// queda "unknown" (sin permisos de apply ni de eventos).
	const roleFinal: Role = centralInfo.role;

	if (!pubkeyB64) throw new Error("device_pubkey_not_registered");

	const payload = new TextEncoder().encode(
		`WS_HELLO\n${msg.ts}\n${tenantId}\n${deviceId}\n${msg.nonceB64}`,
	);

	const pub = nobleForceU8(b64ToBytes(pubkeyB64));
	const sig = nobleForceU8(b64ToBytes(msg.sigB64));

	const ok = await ed25519Verify(sig, payload, pub);
	if (!ok) throw new Error("bad_ws_signature");

	return { roleFinal, pubkeyB64 };
}
