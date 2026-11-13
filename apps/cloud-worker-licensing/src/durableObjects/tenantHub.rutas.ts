// Adaptadores de WebSocket y operaciones internas del motor (RI-45).

import { HubError } from "../lib/errorHttp";
import { errorHorario } from "./tenantHub.errores";
import type { ApplyParams, ResultadoAplicacion } from "./tenantHub.rpc";
import { issueChallenge, roleNormalize } from "./tenantHub.identidad";
import { buildInternalPayloadForHash, readRequestPayloadJson } from "./tenantHub.envelope";
import type { InternalApplyCommand, WsAttachment } from "./tenantHub.types";

/** Lo que las rutas necesitan del hub. */
export interface ContextoDeRutas {
	att(ws: WebSocket): WsAttachment | null;
	setAtt(ws: WebSocket, att: WsAttachment): void;
	send(ws: WebSocket, obj: any): void;
	broadcastRol(rol: "tpv" | "handy" | "unknown", obj: any): void;
	liveSocketsFor(deviceId: string, except?: WebSocket): WebSocket[];
	/** AUD-02: cierra una sesión (deja de estar autenticada, queda fuera y se contabiliza su salida). */
	cerrar(ws: WebSocket, a: WsAttachment | null, code: number, motivo: string): void;

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
		clientNow?: string | null;
		allowWhileRecovering?: boolean;
	}): Promise<{ result: any; seq: number }>;
}

export function esUpgradeDeWebSocket(req: Request): boolean {
	const h = req.headers.get("Upgrade") || "";
	return h.toLowerCase() === "websocket";
}

/**
 * El dispositivo se ha dado de baja (`devices.revoked_at_ms`): sus sesiones se cierran en el acto,
 * sin condición.
 *
 * AUD-02: por `cerrar`, así que dejan de estar autenticadas antes de cerrarse y lo que tuvieran
 * esperando no entra. Un cambio de licencia (traslado, anulación, reembolso) no pasa por aquí: no
 * nombra a quién echar, pide releer quién es la Main (`releerMain`), y así un aviso que llega
 * tarde no echa a la Main que ha vuelto a serlo.
 */
export function revocar(ctx: ContextoDeRutas, deviceId: string): void {
	if (!deviceId) return;
	for (const ws of ctx.liveSocketsFor(deviceId)) {
		ctx.cerrar(ws, ctx.att(ws), 4001, "revoked");
	}
}

/** Aviso sin datos: la Main sigue leyendo la solicitud por REST firmado. */
export function avisoDePairing(ctx: ContextoDeRutas): void {
	ctx.broadcastRol("tpv", { type: "pair_request" });
}

/**
 * Reservas desde la web (docs/estudios/reservas-web.md §4.4): la agenda del negocio tiene algo para
 * la Main. Sólo el empujón: la Main lo pide por REST (`/v1/reservas-web/pendientes`). No se guarda
 * nada, y sin Main conectada no pasa nada: lo recoge al conectar.
 */
export function avisoDeReservasWeb(ctx: ContextoDeRutas): void {
	ctx.broadcastRol("tpv", { type: "reservas_web" });
}

export async function aplicar(ctx: ContextoDeRutas, params: ApplyParams): Promise<ResultadoAplicacion> {
	const { tenantId, deviceId, opId, commandName, command, cloudPayload, clientNow } = params;
	if (!tenantId) return { ok: false, error: "missing_tenant_id", status: 400 };
	if (!opId) return { ok: false, error: "missing_op_id", status: 400 };
	if (!commandName) return { ok: false, error: "missing_command_name", status: 400 };
	// Conserva exactamente el hash anterior: los reintentos siguen siendo idempotentes.
	const body = { cloud_payload: cloudPayload ?? null };
	try {
		const { result } = await ctx.applyInternalCommandIdempotent({
			tenantId, cmd: command, opId, commandName, deviceId,
			requestPayloadJson: readRequestPayloadJson(body, buildInternalPayloadForHash(command)),
			clientNow: clientNow ?? "",
		});
		return { ok: true, data: result };
	} catch (error) {
		const horario = errorHorario(error);
		if (horario) return { ok: false, error: horario.error, status: horario.status, details: { message: horario.message } };
		if (error instanceof HubError) {
			return { ok: false, error: error.code, status: error.status, details: error.details as { message: string } | undefined };
		}
		// Los fallos inesperados viajan como excepciones RPC y los recoge Sentry.
		throw error;
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
	// AUD-15: y deja de estar autenticada antes de cerrarla. Mientras termina de cerrarse puede
	// seguir en `getWebSockets()`, y una Main reemplazada no puede seguir autorizando a las Handy
	// (ni congelándolas) por encima de lo que diga la sesión nueva.
	// AUD-02: por `cerrar`, como todo cierre: queda `fuera` (un saludo que tuviera a medias no la
	// vuelve a autenticar, ni entra lo que dejara esperando) y su salida se contabiliza aquí, sin
	// contar con que el runtime avise del cierre. Con la sesión nueva ya abierta, eso no anuncia
	// nada; lo anunciará el cierre de la nueva si su saludo falla.
	for (const prev of ctx.liveSocketsFor(deviceId, server)) {
		ctx.cerrar(prev, ctx.att(prev), 4000, "replaced");
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

	return new Response(null, { status: 101, webSocket: client });
}
