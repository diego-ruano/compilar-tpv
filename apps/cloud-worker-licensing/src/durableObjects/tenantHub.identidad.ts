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
//   · el rol `tpv` no basta para ser la Main (AUD-02): lo es el `main_device_id` de la licencia
//     viva del negocio (`mainDeLaLicencia`), y eso puede cambiar con la sesión abierta. Quién lo
//     es ahora lo guarda el hub en su propio SQL (`tenantHub.main.ts`).

import type { Client } from "@libsql/client/web";

import { b64ToBytes, bytesToB64 } from "../server/utils/base64";
import { ed25519Verify, bytesExactos } from "../server/utils/ed25519";
import { estaRevocado } from "../lib/deviceAuth";
import { nowMs } from "./tenantHub.tiempo";

import type { HelloSignedMsg, Role } from "./tenantHub.types";

export function roleNormalize(r: any): Role {
	const s = String(r || "").toLowerCase();
	if (s === "tpv") return "tpv";
	if (s === "handy") return "handy";
	return "unknown";
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

/**
 * AUD-02 · La Main de la licencia viva del negocio, o `null` si no la hay.
 *
 * El rol `tpv` de `devices` dice que el equipo se activó como Main, no que lo siga siendo: un
 * traslado sólo cambia `licenses.main_device_id`, y la fila del equipo anterior se queda como
 * estaba. Una licencia anulada no tiene Main; una caducada, sí: caducar no cierra el socket
 * (docs/arquitectura/licencias.md). Un negocio tiene una licencia; si alguna vez hubiera más de
 * una viva, manda la última que se tocó.
 *
 * Si la base central no contesta, lanza: qué hacer entonces lo decide quien llama.
 */
export async function mainDeLaLicencia(dbCentral: Client, tenantId: string): Promise<string | null> {
	const r = await dbCentral.execute({
		sql: `
			SELECT main_device_id
			FROM licenses
			WHERE tenant_id=? AND main_device_id IS NOT NULL
			  AND status <> 'revoked' AND disabled = 0
			ORDER BY updated_at_ms DESC
			LIMIT 1
		`,
		args: [tenantId],
	});

	const main = String((r.rows?.[0] as any)?.main_device_id ?? "").trim();
	return main || null;
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

	// RI-57: una firma permitida a la webview Handy nunca abre un socket con privilegios Main.
	const dominio = roleFinal === "handy" ? "WS_HANDY_HELLO" : "WS_HELLO";
	const payload = new TextEncoder().encode(
		`${dominio}\n${msg.ts}\n${tenantId}\n${deviceId}\n${msg.nonceB64}`,
	);

	const pub = bytesExactos(b64ToBytes(pubkeyB64));
	const sig = bytesExactos(b64ToBytes(msg.sigB64));

	const ok = await ed25519Verify(sig, payload, pub);
	if (!ok) throw new Error("bad_ws_signature");

	return { roleFinal, pubkeyB64 };
}
