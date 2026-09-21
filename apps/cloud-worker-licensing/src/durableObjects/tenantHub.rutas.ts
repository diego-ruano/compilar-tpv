// src/durableObjects/tenantHub.rutas.ts
//
// ARQ-04 · Lo que llega al DO por HTTP.
//
// Tres rutas internas que sólo puede llamar el worker --revocar un dispositivo, avisar de un
// emparejamiento pendiente, aplicar una escritura de la Handy-- y el upgrade del WebSocket.
//
// Las tres internas empiezan igual y NO por casualidad: leen el cuerpo en crudo y comprueban el
// HMAC del worker ANTES de mirar nada (`verifyInternalWorkerRequest`). El DO no es direccionable
// desde Internet, pero eso es una suposición sobre el despliegue, no un control; quien alcanzase
// el DO con las cabeceras puestas escribiría en la base del negocio.

import { verifyInternalWorkerRequest } from "../lib/internalAuth";

import { issueChallenge, roleNormalize } from "./tenantHub.identidad";
import {
	buildInternalPayloadForHash,
	getFirstOwnValue,
	readCloudPayloadJson,
	readEnvelopeMetadata,
	readRequestPayloadJson,
	safeJsonParse,
} from "./tenantHub.envelope";

import type { InternalApplyCommand, WsAttachment } from "./tenantHub.types";

/** Lo que las rutas necesitan del hub. */
export interface ContextoDeRutas {
	/** `LICENSE_JWT_SECRET`, ya normalizado a cadena: con él se firma y se comprueba el HMAC. */
	readonly secretoInterno: string;

	att(ws: WebSocket): WsAttachment | null;
	setAtt(ws: WebSocket, att: WsAttachment): void;
	send(ws: WebSocket, obj: any): void;
	broadcast(obj: any, exceptDeviceId?: string): void;
	broadcastRol(rol: "tpv" | "handy" | "unknown", obj: any): void;
	liveSocketsFor(deviceId: string, except?: WebSocket): WebSocket[];
	sessionGone(ws: WebSocket, a: WsAttachment): void;

	/** SYNC-16: `acceptWebSocket`, no `server.accept()`. Es lo que permite hibernar sin cerrar. */
	aceptarWebSocket(ws: WebSocket, tags: string[]): void;
	waitUntil(p: Promise<unknown>): void;
	touchLastSeen(tenantId: string, deviceId: string, force?: boolean): Promise<void>;

	applyInternalCommandIdempotent(params: {
		tenantId: string;
		cmd: InternalApplyCommand;
		opId: string;
		commandName: string;
		deviceId?: string | null;
		requestPayloadJson: string;
		cloudPayloadJson: string;
		clientNow?: string | null;
		allowWhileRecovering?: boolean;
	}): Promise<{ result: any; seq: number }>;
}

export function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export function esUpgradeDeWebSocket(req: Request): boolean {
	const h = req.headers.get("Upgrade") || "";
	return h.toLowerCase() === "websocket";
}

export async function revocar(
	ctx: ContextoDeRutas,
	request: Request,
): Promise<Response> {
	const raw = await request.text();

	// FABLE-F: mismo HMAC que `/internal/apply`. El DO no es direccionable desde
	// Internet, pero cerrar sockets por `deviceId` sin autenticar era una asimetría
	// que sólo se sostenía por esa suposición.
	try {
		await verifyInternalWorkerRequest(
			request,
			ctx.secretoInterno,
			raw,
		);
	} catch (e: any) {
		return jsonResponse({ ok: false, error: String(e?.message || e) }, 401);
	}

	const body = safeJsonParse(raw) || {};
	const deviceId = String(body.deviceId || "").trim();

	// SYNC-16: no hay estado que limpiar a mano (el attachment muere con el socket). Pero el
	// cierre lo inicia el SERVIDOR, y Cloudflare no garantiza que eso dispare
	// `webSocketClose`, así que hacemos la contabilidad de presencia/freeze explícitamente:
	// revocar la Main debe congelar las Handy igual que si se hubiera caído.
	if (deviceId) {
		for (const ws of ctx.liveSocketsFor(deviceId)) {
			const a = ctx.att(ws);
			try {
				ws.close(4001, "revoked");
			} catch { }
			if (a) ctx.sessionGone(ws, a);
		}
	}

	return new Response("OK", { status: 200 });
}

// Un Handy acaba de reclamar un código de emparejamiento y espera que alguien le abra
// la puerta desde la Main. En vez de que el panel de la Main pregunte cada pocos
// segundos "¿hay alguien esperando?", se lo empujamos por su WebSocket.
//
// El aviso va VACÍO a propósito: es un "vuelve a mirar", no el dato. La solicitud —con
// su huella y su clave pública, que es justo lo que el operario compara antes de
// aprobar— la sigue leyendo la Main por REST firmado. Así este mensaje no puede
// convertirse en una vía para colar información en la pantalla de aprobación.
export async function avisoDePairing(
	ctx: ContextoDeRutas,
	request: Request,
): Promise<Response> {
	const raw = await request.text();

	try {
		await verifyInternalWorkerRequest(
			request,
			ctx.secretoInterno,
			raw,
		);
	} catch (e: any) {
		return jsonResponse({ ok: false, error: String(e?.message || e) }, 401);
	}

	ctx.broadcastRol("tpv", { type: "pair_request" });

	return new Response("OK", { status: 200 });
}

export async function aplicar(
	ctx: ContextoDeRutas,
	request: Request,
): Promise<Response> {
	const raw = await request.text();

	// Sólo el worker `tpv-api` legítimo (que conoce LICENSE_JWT_SECRET) puede
	// aplicar SQL en el tenant. Sin esto, cualquiera que alcanzase el DO con los
	// headers correctos podría escribir comandos arbitrarios.
	try {
		await verifyInternalWorkerRequest(
			request,
			ctx.secretoInterno,
			raw,
		);
	} catch (e: any) {
		return jsonResponse({ ok: false, error: String(e?.message || e) }, 401);
	}

	const tenantId = String(request.headers.get("x-tenant-id") || "").trim();
	if (!tenantId) {
		return jsonResponse({ ok: false, error: "missing_tenant_id" }, 400);
	}

	const body = safeJsonParse(raw) || {};
	const type = String(body?.type || "").trim();

	if (!type) {
		return jsonResponse({ ok: false, error: "missing_command_type" }, 400);
	}

	const { opId, commandName, deviceId } = readEnvelopeMetadata(
		body,
		request,
	);

	if (!opId) {
		return jsonResponse({ ok: false, error: "missing_op_id" }, 400);
	}

	if (!commandName) {
		return jsonResponse({ ok: false, error: "missing_command_name" }, 400);
	}

	const cmd = {
		type: body.type,
		payload: body.payload,
	} as InternalApplyCommand;

	const clientNow = String(
		request.headers.get("x-client-now") ||
		getFirstOwnValue(body, ["client_now", "clientNow"]) ||
		"",
	);

	const fallbackPayloadForHash = buildInternalPayloadForHash(cmd);
	const requestPayloadJson = readRequestPayloadJson(
		body,
		fallbackPayloadForHash,
	);
	const cloudPayloadJson = readCloudPayloadJson({
		body,
		opId,
		commandName,
		fallbackPayloadForHash,
	});

	try {
		const { result } = await ctx.applyInternalCommandIdempotent({
			tenantId,
			cmd,
			opId,
			commandName,
			deviceId,
			requestPayloadJson,
			cloudPayloadJson,
			clientNow,
		});

		return jsonResponse({ ok: true, data: result }, 200);
	} catch (e: any) {
		const msg = String(e?.message || e);

		const status =
			msg === "idempotency_payload_mismatch"
				? 409
				: msg === "idempotency_command_mismatch"
					? 409
					: msg === "idempotency_operation_processing"
						? 409
						: 400;

		return jsonResponse(
			{
				ok: false,
				error: msg,
			},
			status,
		);
	}
}

/**
 * El upgrade: acepta el socket, le adosa su sesión y le manda el reto. Las REGLAS del handshake
 * están en `tenantHub.identidad.ts`; esto es su cableado con el transporte.
 */
export function abrirWebSocket(
	ctx: ContextoDeRutas,
	request: Request,
): Response {
	const tenantId = request.headers.get("x-tenant-id") || "";
	const deviceId = request.headers.get("x-device-id") || "";
	const roleHeader = roleNormalize(request.headers.get("x-role") || "unknown");
	const pubkeyHint =
		(request.headers.get("x-device-pubkey-b64") || "").trim() || null;

	if (!tenantId || !deviceId) {
		return new Response("missing identity", { status: 400 });
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	// SYNC-16: `acceptWebSocket` (en vez de `server.accept()`) entrega el socket al runtime, que
	// puede entonces evacuar el DO de memoria mientras la conexión está ociosa SIN cerrarla. La
	// etiqueta `deviceId` sustituye al antiguo `Map<deviceId, WebSocket>` → `getWebSockets(id)`.
	ctx.aceptarWebSocket(server, [deviceId]);

	const ch = issueChallenge();

	// Todo el estado de la sesión va adosado al socket: sobrevive a la hibernación.
	ctx.setAtt(server, {
		tenantId,
		deviceId,
		role: roleHeader,
		authed: false,
		pubkeyB64: pubkeyHint,
		challenge: ch,
		recovering: false,
	});

	// Reconexión con el mismo deviceId: se echa la sesión anterior. Se cierra DESPUÉS de aceptar
	// la nueva para que su `webSocketClose` vea que ya hay un socket vivo y no dispare el freeze.
	for (const prev of ctx.liveSocketsFor(deviceId, server)) {
		try {
			prev.close(4000, "replaced");
		} catch { }
	}

	ctx.waitUntil(ctx.touchLastSeen(tenantId, deviceId, true));

	ctx.send(server, {
		type: "connected",
		tenantId,
		deviceId,
		role: roleHeader,
		auth: "required",
	});

	ctx.send(server, {
		type: "challenge",
		nonceB64: ch.nonceB64,
		expiresAtMs: ch.expiresAtMs,
	});

	ctx.broadcast(
		{
			type: "presence",
			action: "join",
			deviceId,
			role: roleHeader,
			authed: false,
		},
		deviceId,
	);

	return new Response(null, { status: 101, webSocket: client });
}