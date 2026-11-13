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
//
// AUD-02 · Y dentro de cada rama hay otro orden que tampoco se puede cambiar. Lo que sólo puede
// hacer la Main se decide con `ctx.esLaMain`, que mira la tabla del DO sin esperar a nadie:
//
//   forma del mensaje → [comprobación por actividad, si toca: la única espera] → attachment de
//   AHORA y `esLaMain` → el trabajo, en el acto
//
// La forma va primero para que un mensaje mal hecho no cueste una lectura de la base central. Y
// entre `esLaMain` y el trabajo no puede haber ninguna espera, ni siquiera la de una función
// `async` intermedia: mientras se espera pueden echar a la sesión, o cerrarse su socket, y el
// attachment que se leyó antes ya no vale (`sesionAbierta`).
//
// `apply` y `apply_lote` esperan en fila (`enTurnoDeEntrada`): el orden en que entran es el orden
// en que llegaron, también si al primero le toca esperar la comprobación. `recovery_ready` no la
// espera ni la pide: decide con la tabla tal como está, y a la Main no se le rechaza nunca.
//
// Un dispositivo no manda nada más por aquí. No hay mensajes de un dispositivo a los demás: lo que
// tienen que ver los otros es un cambio en la base, y eso lo difunde el motor al confirmarlo.

import { esFalloPasajero, esRechazoPermanente } from "./tenantHub.errores";
import { nowMs } from "./tenantHub.tiempo";
import { capturarError } from "../observability/errors";
import {
	buildInternalPayloadForHash,
	getFirstOwnValue,
	readRequestPayloadJson,
	safeJsonParse,
} from "./tenantHub.envelope";

import type {
	AnyMsg,
	ApplyLoteMsg,
	ApplyMsg,
	HelloSignedMsg,
	InternalApplyCommand,
	OpDeLote,
	RecoveryReadyMsg,
	Role,
	VeredictoDeLote,
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

	/** AUD-02: ¿es esta sesión la de la Main, según la tabla del DO? No espera. */
	esLaMain(a: WsAttachment | null): boolean;
	/** AUD-02: el dispositivo que es la Main según la tabla, o `null` si ninguno. No espera. */
	mainVigente(): string | null;
	/** AUD-02: pregunta a la base central quién es la Main y lo apunta. Lanza si no contesta. */
	leerMain(tenantId: string): Promise<void>;
	/** AUD-02: la comprobación por actividad. `null` si no toca; si toca, no lanza. */
	comprobarMain(): Promise<void> | null;
	/** Todo cierre que inicia el DO: la sesión queda fuera, se cierra y se contabiliza su salida. */
	cerrar(ws: WebSocket, a: WsAttachment | null, code: number, motivo: string): void;
	/** AUD-02: en fila con lo demás que la Main manda y entra en el acto (`apply`, `apply_lote`). */
	enTurnoDeEntrada(trabajo: () => Promise<void> | void): Promise<void>;

	isMainConnected(except?: WebSocket): boolean;
	isMainRecovering(): boolean;

	applyInternalCommandIdempotent(params: {
		tenantId: string;
		cmd: InternalApplyCommand;
		opId: string;
		commandName: string;
		deviceId?: string | null;
		requestPayloadJson: string;
		clientNow?: string | null;
		allowWhileRecovering?: boolean;
		/** AUD-02: el socket de la sesión que manda la escritura. */
		sesion?: WebSocket;
		/** AUD-02: se llama en cuanto la escritura tiene sitio en el turno del log. */
		alReservarTurno?: () => void;
	}): Promise<{ result: any; seq: number }>;

	/** El lote de la Main: sus operaciones en orden, en un turno, y el acuse dentro de él. */
	aplicarLote(params: {
		tenantId: string;
		deviceId: string;
		sesion: WebSocket;
		ops: OpDeLote[];
		alReservarTurno?: () => void;
		alTerminar: (resultados: VeredictoDeLote[]) => void;
	}): Promise<void>;
}

/**
 * Lo más que ocupa un mensaje que se llega a leer: por encima no se intenta ni trocear el JSON. Un
 * lote de la Main son como mucho 256 KB de sentencias, pero una operación va sola en su lote aunque
 * pase de ahí, y tiene que poder llegar a la base con cualquier valor que la base admita: el SQLite
 * del DO acepta como argumento algo más de 2 MiB (`test/applyAckVeredicto.test.ts`). Con el tope en
 * 2 MiB, una operación que la base sí aceptaría se rechazaba por grande, y la Main la apartaba.
 */
const MAX_MENSAJE = 4 * 1024 * 1024;

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
	// El tamaño, antes de leerlo: trocear un JSON enorme es trabajo que se le regala a quien lo manda.
	if (data.length > MAX_MENSAJE) {
		ctx.send(ws, { type: "error", error: "payload_too_large" });
		return;
	}
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
	if (msg.type === "apply_lote") return atenderApplyLote(ctx, ws, a, msg);
	if (msg.type === "apply") return atenderApply(ctx, ws, a, msg);

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

				// AUD-02: el rol `tpv` dice que el equipo se activó como Main, no que lo siga
				// siendo. Quién lo es ahora está en la tabla del DO. El saludo de un `tpv` la pone
				// al día antes de mirarla, y si la base central no contesta no entra: como con la
				// lectura del dispositivo, sin ella no se sabe quién es. El de una Handy es
				// actividad, y pregunta sólo si toca.
				if (roleFinal === "tpv") await ctx.leerMain(tenantId);
				else await ctx.comprobarMain();

				// ⚠️ De aquí al final no hay ninguna espera: la sesión se lee como está AHORA, se
				// decide con la tabla y se autentica en el mismo paso.
				//
				// Mientras se verificaba pudieron echarla (una revocación), reemplazarla (una
				// reconexión del mismo dispositivo) o cerrarse su socket (el cliente, la red, un
				// error): su salida ya está contabilizada, y no vuelve a entrar ni a anunciarse.
				const actual = sesionAbierta(ctx, ws);
				if (!actual) return;

				// La respuesta de este saludo pudo no apuntarse, porque ya había apuntada la de
				// una lectura que empezó después (`fijarMain`). Por eso no decide lo que le
				// contestaron a él, sino lo que dice la tabla: una respuesta vieja que llega tarde
				// no deja entrar a quien ya no es la Main, ni echa a quien lo es.
				if (roleFinal === "tpv") {
					const main = ctx.mainVigente();
					if (main !== deviceId) throw new Error(main ? "device_replaced" : "license_revoked");
				}

				// Persistimos el resultado de la autenticación en el attachment: es lo que
				// leerán los futuros mensajes, broadcasts y el cierre (incluso tras hibernar).
				ctx.setAtt(ws, {
					...actual,
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

				// Freeze por presencia de Main: informamos a este
				// dispositivo de si hay Main conectada (una Handy recién
				// autenticada necesita saberlo para bloquear/desbloquear su
				// UI). Y si quien se autentica ES la Main, avisamos a las
				// Handy de que ya pueden operar.
				ctx.send(ws, {
					type: "main_status",
					online: ctx.isMainConnected(),
					// AUD-15: una Handy que entra mientras la Main se pone al día tiene que bloquear
					// igual que si no hubiera Main; con `online` a secas no se enteraría.
					volcando: ctx.isMainRecovering(),
				});

				if (roleFinal === "tpv") {
					ctx.broadcast({ type: "main_online", deviceId }, deviceId);
					if (msg.recovering) {
						ctx.broadcastAuthed({ type: "main_volcando", volcando: true }, deviceId);
					}
					ctx.emitSyncEvent("main_online", { device_id: deviceId });
				}
			} catch (e: any) {
				// Echada o cerrada mientras se verificaba: su salida ya está contabilizada.
				const ahora = sesionAbierta(ctx, ws);
				if (!ahora) return;
				const err = String(e?.message || e);
				ctx.send(ws, {
					type: "error",
					error: "hello_failed",
					details: err,
				});
				// Por `cerrar`, como todo cierre que inicia el DO: contabiliza la salida sin contar
				// con que el runtime avise. Si era la Main reconectando, su sesión anterior ya se
				// echó al abrir ésta sin anunciar nada (había otra viva): es este cierre el que
				// les dice a las Handy que se han quedado sin Main.
				ctx.cerrar(ws, ahora, 4003, "auth_failed");
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
	// AUD-02: soltar a las Handy sólo puede hacerlo la Main. Aquí no hay lecturas ni esperas: `a`
	// se acaba de leer (`despachar`) y decide la tabla. A la Main no se le rechaza nunca, tampoco
	// con la base central caída: el cliente da el desbloqueo por hecho en cuanto lo manda.
	if (!ctx.esLaMain(a)) {
		ctx.send(ws, { type: "error", error: "not_authenticated" });
		return;
	}
	ctx.setAtt(ws, { ...a, recovering: false });
	ctx.broadcastAuthed({ type: "main_volcando", volcando: ctx.isMainRecovering() });
	ctx.send(ws, { type: "recovery_ready_ack" });
	return;
}

/**
 * El lote de la Main: lo que sube de su outbox, hasta 200 operaciones de una vez, en orden. Es un
 * mensaje nuevo y no una variante de `apply`: quien no lo conozca contesta `unknown_type`.
 *
 * El acuse (`apply_lote_ack`, con el `loteId` del mensaje) lleva el veredicto de cada operación
 * (`VeredictoDeLote`). Lo que afecta al lote entero sale con `ok: false` y su error, sin haber
 * aplicado nada: el rol, la forma de cualquiera de sus operaciones, o que la sesión ya no sea la
 * de la Main.
 */
export async function atenderApplyLote(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: ApplyLoteMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;
	const loteId = String(msg.loteId ?? "").trim();
	const acusar = (cuerpo: Record<string, unknown>) =>
		ctx.send(ws, { type: "apply_lote_ack", loteId, ...cuerpo });

	// Sólo la Main ejecuta SQL crudo por el socket, como en `apply`.
	if (a.role !== "tpv") {
		acusar({ ok: false, error: "forbidden_not_tpv" });
		return;
	}

	// AUD-02: la forma, antes que nada, y la de TODAS antes de aplicar ninguna: un lote mal hecho no
	// cuesta una lectura de la base central ni deja la mitad aplicada.
	if (!loteId || !Array.isArray(msg.ops)) {
		acusar({ ok: false, error: "missing_apply_fields" });
		return;
	}
	const clientNowLote = String(getFirstOwnValue(msg, ["client_now", "clientNow"]) || "");
	const ops: OpDeLote[] = [];
	for (const item of msg.ops) {
		const inner = item?.command;
		const cmdType = String(inner?.type || "").trim();
		const opId = String(item?.opId ?? item?.op_id ?? "").trim();
		const commandName = String(item?.commandName ?? item?.command_name ?? "").trim();
		if (!cmdType || !opId || !commandName) {
			acusar({ ok: false, error: "missing_apply_fields" });
			return;
		}
		const cmd = { type: inner!.type, payload: inner!.payload } as InternalApplyCommand;
		ops.push({
			opId,
			commandName,
			cmd,
			// El mismo cuerpo que hashea un `apply` suelto: la operación es la misma por los dos caminos.
			requestPayloadJson: readRequestPayloadJson(item, buildInternalPayloadForHash(cmd)),
			// La Main manda sus sentencias con la hora ya resuelta; si viniera, por operación o una vez
			// para todo el lote.
			clientNow: String(getFirstOwnValue(item, ["client_now", "clientNow"]) || "") || clientNowLote,
		});
	}
	if (!ops.length) {
		acusar({ ok: true, resultados: [] });
		return;
	}

	// AUD-02: en fila con lo demás que manda la Main (`enTurnoDeEntrada`), en el orden en que llegó.
	// Tras la comprobación por actividad, que es la última espera, la sesión como está ahora.
	ctx.waitUntil(
		ctx.enTurnoDeEntrada(async () => {
			await ctx.comprobarMain();
			if (!ctx.esLaMain(sesionAbierta(ctx, ws))) {
				acusar({ ok: false, error: "not_authenticated", transitorio: true });
				return;
			}

			// Como en `apply`: la fila no suelta al siguiente hasta que el lote tiene sitio en el turno
			// del log, que es lo que fija el orden en que se confirma. Lo que tarde después no la retiene.
			let conSitio!: () => void;
			const tieneSitio = new Promise<void>((r) => (conSitio = r));
			ctx.waitUntil(
				(async () => {
					try {
						await ctx.aplicarLote({
							tenantId,
							deviceId,
							sesion: ws,
							ops,
							alReservarTurno: conSitio,
							alTerminar: (resultados) => acusar({ ok: true, resultados }),
						});
					} catch (e: any) {
						capturarError(e, "sync.apply_lote");
						// Nada del lote se ha aplicado. El veredicto es del lote: de cómo está la nube
						// (`transitorio`) o de algo que no se arregla repitiéndolo.
						acusar({
							ok: false,
							error: String(e?.message || e).slice(0, 500),
							permanente: esRechazoPermanente(e),
							transitorio: esFalloPasajero(e),
						});
					} finally {
						// El que falla antes de llegar al turno también suelta la fila.
						conSitio();
					}
				})(),
			);
			await tieneSitio;
		}),
	);
}

// Una escritura suelta de la Main por WS: se aplica al MISMO motor idempotente que las escrituras
// REST de la Handy (commit en la base + broadcast del cambio al resto) y se contesta con su
// `apply_ack`. La Main sube por lotes (`apply_lote`); esto es lo que entiende de ella una versión
// que todavía no los manda.
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

	const requestPayloadJson = readRequestPayloadJson(m, buildInternalPayloadForHash(cmd));
	// La Main ya manda sus sentencias con el tiempo resuelto a literal; aun así
	// honramos un X-Client-Now si viniera (no hace daño: el rewrite es no-op).
	const clientNow = String(
		getFirstOwnValue(m, ["client_now", "clientNow"]) || "",
	);

	// AUD-02: el rol `tpv` no basta: tiene que ser la sesión de la Main. Y lo que manda entra en
	// fila (`enTurnoDeEntrada`), con sus lotes, en el orden en que llegó: si al primero le toca
	// esperar la comprobación por actividad, los de detrás esperan con él. Tras esa espera, que es la
	// última, la sesión como está ahora.
	ctx.waitUntil(
		ctx.enTurnoDeEntrada(async () => {
			await ctx.comprobarMain();
			if (!ctx.esLaMain(sesionAbierta(ctx, ws))) {
				ctx.send(ws, { type: "apply_ack", opId, ok: false, error: "not_authenticated" });
				return;
			}

			// La fila no suelta al siguiente hasta que éste tiene sitio en el turno del log
			// (`alReservarTurno`), que es lo que fija el orden en que se confirman. Antes de eso el motor
			// calcula el hash y abre la base del negocio (que al despertar el DO comprueba sus
			// migraciones): son esperas, y el segundo, si las suyas acababan antes, se le adelantaba. Lo
			// que tarde la escritura después ya no retiene la fila. La escritura lleva su socket
			// (`sesion`) para que el motor vuelva a mirar la sesión dentro del turno, justo antes de
			// aplicarla.
			let conSitio!: () => void;
			const tieneSitio = new Promise<void>((r) => (conSitio = r));
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
							clientNow,
							allowWhileRecovering: true,
							sesion: ws,
							alReservarTurno: conSitio,
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
						// comparando mensajes, que cambian de redacción entre versiones. Sin esto,
						// la subida trataba todo como transitorio y una sentencia que el esquema del
						// tenant no admite paraba el outbox entero para siempre.
						//
						// REV-11: y `transitorio` es la otra mitad. Sin él, una caída de la base —que
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
					} finally {
						// La que falla antes de llegar al turno (sin Main, por ejemplo) también suelta la fila.
						conSitio();
					}
				})(),
			);
			await tieneSitio;
		}),
	);
	return;
}

/**
 * AUD-02 · La sesión como está AHORA, después de una espera: `null` si se ha cerrado su socket o se
 * ha echado. Todo cierre la deja `fuera` (`cerrar`, `webSocketClose`), y se mira además el socket
 * por si el attachment de un socket ya cerrado no se dejara escribir.
 */
function sesionAbierta(ctx: ContextoDeMensajes, ws: WebSocket): WsAttachment | null {
	if (ws.readyState !== 1) return null;
	const a = ctx.att(ws);
	return a && !a.fuera ? a : null;
}
