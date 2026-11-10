// src/durableObjects/tenantHub.mensajes.ts
//
// ARQ-04 · Lo que llega por el WebSocket, una rama por mensaje.
//
// Era una cadena de siete `if (msg.type === …)` dentro de un método de 400 líneas, que es donde
// convergen todas las piezas del hub y por tanto el sitio donde más cuesta ver qué toca cada cosa.
// Aquí cada mensaje es una función con nombre, y `despachar` conserva el ORDEN, que es lo único
// del conjunto que importa de verdad:
//
//   att → json → ping → helloSigned → [autenticado] → last_seen → el resto
//
// Ese corchete es el gate: `ping` y `helloSigned` van ANTES porque son justamente los que atiende
// un socket que todavía no se ha autenticado. Mover una rama de un lado al otro del gate es abrir
// o cerrar una puerta, no reordenar código.

import { esFalloPasajero, esRechazoPermanente } from "./tenantHub.errores";
import { isEventAllowed } from "./tenantHub.identidad";
import { nowMs } from "./tenantHub.tiempo";
import { capturarError } from "../observability/errors";
import {
	buildInternalPayloadForHash,
	getFirstOwnValue,
	readCloudPayloadJson,
	readRequestPayloadJson,
	safeJsonParse,
} from "./tenantHub.envelope";

import type { Client } from "@libsql/client/web";
import type {
	AnyMsg,
	ApplyMsg,
	BulkApplyMsg,
	ColaApartadaAckMsg,
	EventMsg,
	HelloSignedMsg,
	InternalApplyCommand,
	OpParaAplicar,
	RecoveryReadyMsg,
	Role,
	WsAttachment,
} from "./tenantHub.types";

/**
 * Lo que las ramas necesitan del hub. Es la lista más larga del refactor y eso no es un defecto
 * del reparto: `webSocketMessage` es por donde entra todo lo que hace un TPV, así que toca todo.
 * Escrita, al menos se ve crecer.
 *
 * ⚠️ El hub la construye con envoltorios que leen `this.X` AL LLAMAR, no con `.bind()`: varios
 * tests sustituyen un método de la instancia y con la referencia atada eso dejaría de verse.
 */
export interface ContextoDeMensajes {
	att(ws: WebSocket): WsAttachment | null;
	setAtt(ws: WebSocket, att: WsAttachment): void;
	send(ws: WebSocket, obj: any): void;
	broadcast(obj: any, exceptDeviceId?: string): void;
	broadcastAuthed(obj: any, exceptDeviceId?: string): void;
	emitSyncEvent(name: string, fields: Record<string, unknown>): void;
	waitUntil(p: Promise<unknown>): void;

	touchLastSeen(tenantId: string, deviceId: string, force?: boolean): Promise<void>;
	verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		msg: HelloSignedMsg;
		challenge: { nonceB64: string; expiresAtMs: number } | null;
		pubkeyB64Hint?: string | null;
	}): Promise<{ roleFinal: Role; pubkeyB64: string }>;

	isMainConnected(except?: WebSocket): boolean;
	isMainRecovering(): boolean;

	cuantasEnCola(): number;
	encolar(tenantId: string, ops: OpParaAplicar[]): string[];
	apartadasPendientes(): { opId: string; commandName: string; error: string }[];
	olvidarApartadas(opIds: string[]): number;

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
	withTenantDbRetry<T>(tenantId: string, run: (db: Client) => Promise<T>): Promise<T>;
}

/**
 * El orden es el contrato. Lo demás son las ramas de abajo.
 */
export async function despachar(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	message: ArrayBuffer | string,
): Promise<void> {
	const a = ctx.att(ws);
	if (!a) {
		// Socket sin attachment: no sabemos ni quién es. No debería ocurrir.
		ctx.send(ws, { type: "error", error: "no_session" });
		return;
	}
	const { tenantId, deviceId } = a;

	const data = typeof message === "string" ? message : "";
	const msg = safeJsonParse(data) as AnyMsg | null;

	if (!msg || typeof msg.type !== "string") {
		ctx.send(ws, { type: "error", error: "bad_json" });
		return;
	}

	// El latido normal lo contesta el auto-response SIN despertar al DO (constructor), así que
	// aquí sólo caen pings con otra serialización. Se responde igual por compatibilidad.
	if (msg.type === "ping") {
		ctx.send(ws, { type: "pong", ts: nowMs() });
		return;
	}

	if (msg.type === "helloSigned") return atenderHelloSigned(ctx, ws, a, msg);

	if (!a.authed) {
		ctx.send(ws, { type: "error", error: "not_authenticated" });
		return;
	}

	// Actividad real del dispositivo (ya no hay pings que la reflejen): refrescamos `last_seen`
	// de forma throttleada y fire-and-forget.
	ctx.waitUntil(ctx.touchLastSeen(tenantId, deviceId));

	if (msg.type === "recovery_ready") return atenderRecoveryReady(ctx, ws, a, msg);
	if (msg.type === "cola_apartada_ack") return atenderColaApartadaAck(ctx, ws, a, msg);
	if (msg.type === "bulk_apply") return atenderBulkApply(ctx, ws, a, msg);
	if (msg.type === "apply") return atenderApply(ctx, ws, a, msg);
	if (msg.type === "event") return atenderEvent(ctx, ws, a, msg);

	ctx.send(ws, { type: "error", error: "unknown_type" });
}

export async function atenderHelloSigned(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: HelloSignedMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;

	// SYNC-07: challenge de un SOLO uso. Se consume AQUÍ, de forma síncrona y antes de
	// cualquier `await`, para que dos helloSigned seguidos no puedan reutilizar el nonce.
	const challenge = a.challenge;
	ctx.setAtt(ws, { ...a, challenge: null });

	ctx.waitUntil(
		(async () => {
			try {
				const { roleFinal, pubkeyB64 } = await ctx.verifyHelloSigned({
					tenantId,
					deviceId,
					msg,
					challenge,
					pubkeyB64Hint: a.pubkeyB64,
				});

				// Persistimos el resultado de la autenticación en el attachment: es lo que
				// leerán los futuros mensajes, broadcasts y el cierre (incluso tras hibernar).
				ctx.setAtt(ws, {
					...a,
					role: roleFinal,
					authed: true,
					pubkeyB64,
					challenge: null,
					recovering: roleFinal === "tpv" && Boolean(msg.recovering),
				});

				ctx.send(ws, {
					type: "hello_ok",
					role: roleFinal,
					authed: true,
				});

				ctx.broadcast(
					{
						type: "presence",
						action: "auth",
						deviceId,
						role: roleFinal,
						authed: true,
					},
					deviceId,
				);

				if (roleFinal === "tpv") {
					// REV-04: lo que la nube apartó mientras esta Main no estaba (o estaba y no
					// escuchaba: esto es también el reintento del aviso que no se acusó). Va
					// antes del catch-up a propósito —la Main pone su copia en cuarentena y
					// encola la reparación por estado— y se repite en cada conexión hasta que
					// alguien lo acuse. AUD-15: y antes de `main_status`, que cierra el saludo:
					// la Main no suelta a las Handy sin haberlo recibido.
					const apartadas = ctx.apartadasPendientes();
					if (apartadas.length) {
						ctx.send(ws, { type: "cola_apartada", ops: apartadas });
					}
				}

				// Freeze por presencia de Main: informamos a este
				// dispositivo de si hay Main conectada (una Handy recién
				// autenticada necesita saberlo para bloquear/desbloquear su
				// UI). Y si quien se autentica ES la Main, avisamos a las
				// Handy de que ya pueden operar.
				ctx.send(ws, {
					type: "main_status",
					online: ctx.isMainConnected(),
					// SYNC-18: una Handy que entra a mitad de un volcado tiene que bloquear
					// igual que si no hubiera Main; con `online` a secas no se enteraría.
					volcando: ctx.cuantasEnCola() > 0 || ctx.isMainRecovering(),
					// AUD-15: lo que queda en la cola. La Main no suelta a las Handy hasta verla
					// vacía: lo que se aparte al drenarla tiene que repararse antes.
					cola: ctx.cuantasEnCola(),
				});

				if (roleFinal === "tpv") {
					ctx.broadcast({ type: "main_online", deviceId }, deviceId);
					if (msg.recovering) {
						ctx.broadcastAuthed(
							{ type: "main_volcando", volcando: true, cola: ctx.cuantasEnCola() },
							deviceId,
						);
					}
					ctx.emitSyncEvent("main_online", { device_id: deviceId });
				}
			} catch (e: any) {
				const err = String(e?.message || e);
				ctx.send(ws, {
					type: "error",
					error: "hello_failed",
					details: err,
				});
				try {
					ws.close(4003, "auth_failed");
				} catch { }
			}
		})(),
	);
	return;
}

export function atenderRecoveryReady(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: RecoveryReadyMsg,
): void {
	if (a.role !== "tpv") {
		ctx.send(ws, { type: "error", error: "forbidden_not_tpv" });
		return;
	}
	ctx.setAtt(ws, { ...a, recovering: false });
	ctx.broadcastAuthed({
		type: "main_volcando",
		volcando: ctx.cuantasEnCola() > 0 || ctx.isMainRecovering(),
		cola: ctx.cuantasEnCola(),
	});
	ctx.send(ws, { type: "recovery_ready_ack" });
	return;
}

// REV-04: la Main confirma que ya ha anotado las apartadas. Es lo que convierte `_Cola_Muerta`
// en una bandeja de salida en vez de un archivo que no lee nadie: entregada la carta, se tira.
// Sólo la Main puede acusar, porque sólo ella puede reparar (tiene la fila; la Handy no).
export function atenderColaApartadaAck(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: ColaApartadaAckMsg,
): void {
	if (a.role !== "tpv") {
		ctx.send(ws, { type: "error", error: "forbidden_not_tpv" });
		return;
	}
	const opIds = Array.isArray(msg.opIds)
		? (msg.opIds as unknown[]).map((v) => String(v)).filter(Boolean)
		: [];
	const olvidadas = ctx.olvidarApartadas(opIds);
	if (olvidadas) {
		ctx.emitSyncEvent("cola_apartada_acusada", {
			device_id: a.deviceId,
			n: olvidadas,
		});
	}
	ctx.send(ws, { type: "cola_apartada_ack_ok", n: olvidadas });
	return;
}

// Escritura de la Main por WS: se aplica al MISMO motor idempotente que
// las escrituras REST de la Handy (commit en Turso + broadcast del cambio
// al resto). La Main no se bloquea esperando; recibe un `apply_ack`
// asíncrono solo para reconciliar/revertir si algo falla.
// SYNC-18: volcado del atraso. La Main manda por trozos lo que lleva acumulado, el DO lo
// guarda en su cola y confirma sin tocar Turso — de ahí que sea inmediato y que la Main
// pueda desconectarse justo después. El trabajo lo hace luego el `alarm`.
export async function atenderBulkApply(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: BulkApplyMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;

	const m = msg as BulkApplyMsg;

	if (a.role !== "tpv") {
		ctx.send(ws, { type: "bulk_ack", ok: false, error: "forbidden_not_tpv" });
		return;
	}

	const entrada = Array.isArray(m.ops) ? m.ops : [];
	const clientNowLote = String(getFirstOwnValue(m, ["client_now", "clientNow"]) || "");
	const ops: OpParaAplicar[] = [];

	for (const item of entrada) {
		const inner = item?.command;
		const cmdType = String(inner?.type || "").trim();
		const opId = String(item?.opId ?? item?.op_id ?? "").trim();
		const commandName = String(
			item?.commandName ?? item?.command_name ?? "",
		).trim();
		if (!cmdType || !opId || !commandName) {
			ctx.send(ws, { type: "bulk_ack", ok: false, error: "missing_apply_fields" });
			return;
		}

		const cmd = { type: inner!.type, payload: inner!.payload } as InternalApplyCommand;
		const fallback = buildInternalPayloadForHash(cmd);
		ops.push({
			opId,
			commandName,
			cmd,
			deviceId,
			requestPayloadJson: readRequestPayloadJson(item, fallback),
			cloudPayloadJson: readCloudPayloadJson({
				body: item,
				opId,
				commandName,
				fallbackPayloadForHash: fallback,
			}),
			// El reloj puede venir por operación o una vez para todo el trozo.
			clientNow:
				String(getFirstOwnValue(item, ["client_now", "clientNow"]) || "") ||
				clientNowLote,
		});
	}

	try {
		const aceptadas = ctx.encolar(tenantId, ops);
		ctx.send(ws, { type: "bulk_ack", ok: true, opIds: aceptadas });
	} catch (e: any) {
		capturarError(e, "sync.bulk_enqueue");
		ctx.send(ws, {
			type: "bulk_ack",
			ok: false,
			error: String(e?.message || e).slice(0, 300),
		});
	}
	return;
}

export async function atenderApply(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: ApplyMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;

	const m = msg as ApplyMsg;

	// Autorización por rol: solo la Main (`tpv`) puede ejecutar SQL crudo
	// por WS. El rol viene del helloSigned (BD central), nunca de la
	// cabecera x-role del cliente. Las escrituras de la Handy van por
	// REST → comandos de dominio acotados (hub.ts → /internal/apply).
	if (a.role !== "tpv") {
		ctx.send(ws, {
			type: "apply_ack",
			opId: String(m.opId ?? m.op_id ?? "").trim(),
			ok: false,
			error: "forbidden_not_tpv",
		});
		return;
	}

	const inner = m.command;
	const cmdType = String(inner?.type || "").trim();
	const opId = String(m.opId ?? m.op_id ?? "").trim();
	const commandName = String(m.commandName ?? m.command_name ?? "").trim();

	if (!cmdType || !opId || !commandName) {
		ctx.send(ws, {
			type: "apply_ack",
			opId,
			ok: false,
			error: "missing_apply_fields",
		});
		return;
	}

	const cmd = {
		type: inner!.type,
		payload: inner!.payload,
	} as InternalApplyCommand;

	const fallback = buildInternalPayloadForHash(cmd);
	const requestPayloadJson = readRequestPayloadJson(m, fallback);
	const cloudPayloadJson = readCloudPayloadJson({
		body: m,
		opId,
		commandName,
		fallbackPayloadForHash: fallback,
	});
	// La Main ya manda sus sentencias con el tiempo resuelto a literal; aun así
	// honramos un X-Client-Now si viniera (no hace daño: el rewrite es no-op).
	const clientNow = String(
		getFirstOwnValue(m, ["client_now", "clientNow"]) || "",
	);

	// SYNC-18: si hay cola, esta operación va DETRÁS de ella. El outbox de la Main está
	// ordenado y sus operaciones se apoyan unas en otras (una línea necesita su comanda),
	// así que colarse por delante del atraso sería aplicar el futuro antes que el pasado.
	// Se responde igual de rápido, pero diciendo que quedó encolada.
	if (ctx.cuantasEnCola() > 0) {
		try {
			ctx.encolar(tenantId, [
				{
					opId,
					commandName,
					cmd,
					deviceId,
					requestPayloadJson,
					cloudPayloadJson,
					clientNow,
				},
			]);
			ctx.send(ws, { type: "apply_ack", opId, ok: true, encolada: true });
		} catch (e: any) {
			capturarError(e, "sync.enqueue");
			ctx.send(ws, {
				type: "apply_ack",
				opId,
				ok: false,
				error: String(e?.message || e).slice(0, 300),
			});
		}
		return;
	}

	ctx.waitUntil(
		(async () => {
			try {
				const { result, seq } = await ctx.applyInternalCommandIdempotent({
					tenantId,
					cmd,
					opId,
					commandName,
					deviceId,
					requestPayloadJson,
					cloudPayloadJson,
					clientNow,
					allowWhileRecovering: true,
				});
				ctx.send(ws, {
					type: "apply_ack",
					opId,
					ok: true,
					result,
					// `seq` que la nube asignó a la op: la Main asciende su anti-eco con él.
					seq,
				});
			} catch (e: any) {
				capturarError(e, "sync.apply");
				// SYNC-20: el ack dice de qué clase es el fallo. Quien tiene la excepción
				// delante es este DO; el cliente no puede deducirlo del texto sin acabar
				// comparando mensajes de libsql, que cambian de redacción entre versiones.
				// Sin esto, el drenado trataba todo como transitorio y una sentencia que el
				// esquema del tenant no admite paraba la cola entera para siempre.
				//
				// REV-11: y `transitorio` es la otra mitad. Sin él, una caída de Turso —que
				// no dice nada de la operación— le gastaba uno de sus veinte intentos, y
				// cuatro baches bastaban para apartar una venta perfectamente buena. Son
				// tres estados y no dos: definitivo (apartar ya), pasajero (no cuenta) y
				// desconocido (cuenta, y acabará apartándose si no deja de fallar).
				ctx.send(ws, {
					type: "apply_ack",
					opId,
					ok: false,
					error: String(e?.message || e),
					permanente: esRechazoPermanente(e),
					transitorio: esFalloPasajero(e),
				});
			}
		})(),
	);
	return;
}

export async function atenderEvent(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: EventMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;

	// El rol para autorizar viene del helloSigned (BD central); la
	// cabecera x-role del cliente jamás decide permisos.
	const role = a.role ?? "unknown";
	const name = String(msg.name || "");

	if (!isEventAllowed(role, name)) {
		ctx.send(ws, {
			type: "error",
			error: "forbidden_event",
			name,
		});
		return;
	}

	if (name === "tenantDb.ping") {
		ctx.waitUntil(
			(async () => {
				try {
					await ctx.withTenantDbRetry(tenantId, async (db) => {
						await db.execute({ sql: "SELECT 1", args: [] });
					});
					ctx.send(ws, { type: "event_ack", name, ok: true });
				} catch (e: any) {
					capturarError(e, "sync.database_probe");
					ctx.send(ws, {
						type: "event_ack",
						name,
						ok: false,
						error: String(e?.message || e),
					});
				}
			})(),
		);
		return;
	}

	ctx.broadcast(
		{
			type: "event",
			from: deviceId,
			role,
			name,
			payload: msg.payload ?? null,
			ts: nowMs(),
		},
		deviceId,
	);
	return;
}
