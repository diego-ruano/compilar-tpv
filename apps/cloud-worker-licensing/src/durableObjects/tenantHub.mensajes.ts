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
// Los `apply_lote` esperan en fila (`enTurnoDeEntrada`): el orden en que entran es el orden en que
// llegaron, también si al primero le toca esperar la comprobación. `recovery_ready` no la
// espera ni la pide: decide con la tabla tal como está, y a la Main no se le rechaza nunca.
//
// Un dispositivo no manda nada más por aquí. No hay mensajes de un dispositivo a los demás: lo que
// tienen que ver los otros es un cambio en la base, y eso lo difunde el motor al confirmarlo.

import { esFalloPasajero, esRechazoPermanente } from "./tenantHub.errores";
import { nowMs } from "./tenantHub.tiempo";
import { capturarError } from "../observability/errors";
import { scrub } from "../observability/scrub";
import { acotar } from "../observability/tope";
import { HubError } from "../lib/errorHttp";
import { bytesUtf8 } from "../lib/texto";
import { buildInternalPayloadForHash, safeJsonParse, stableStringify } from "./tenantHub.envelope";
import { formaDelPaso, type PasoDeSubida, type SubidaEnElSaludo } from "./tenantHub.subida";

import type {
	AnyMsg,
	ApplyLoteMsg,
	HelloSignedMsg,
	InternalApplyCommand,
	OpDeLote,
	RecoveryReadyMsg,
	Role,
	SubidaMsg,
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

	touchLastSeen(tenantId: string, deviceId: string): Promise<void>;
	verifyHelloSigned(params: {
		tenantId: string;
		deviceId: string;
		msg: HelloSignedMsg;
		challenge: { nonceB64: string; expiresAtMs: number } | null;
		/** El rol y la clave del dispositivo que el Worker puso al abrir el socket (`tenantHub.rutas.ts`). */
		rol: Role;
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
	/**
	 * Un fallo de lo que el hub le pide a la base central: lo que no es que no pueda atender, a
	 * Sentry; lo que sí, como en el Worker (`registrarSinLaCentral`).
	 */
	registrarFalloDeLaCentral(error: unknown, operacion: string, tenantId: string): void;
	/** Todo cierre que inicia el DO: la sesión queda fuera, se cierra y se contabiliza su salida. */
	cerrar(ws: WebSocket, a: WsAttachment | null, code: number, motivo: string): void;
	/** AUD-02: en fila con lo demás que la Main manda y entra en el acto (`apply_lote`). */
	enTurnoDeEntrada(trabajo: () => Promise<void> | void): Promise<void>;

	isMainConnected(except?: WebSocket): boolean;
	isMainRecovering(): boolean;
	/** SYN-INC-01: cierra (por `cerrar`) las sesiones de Main que ya no dan señales de vida. */
	cerrarMainsSinLatido(): void;

	/** El lote de la Main: sus operaciones en orden, en un turno, y el acuse dentro de él. */
	aplicarLote(params: {
		tenantId: string;
		deviceId: string;
		sesion: WebSocket;
		ops: OpDeLote[];
		alReservarTurno?: () => void;
		alTerminar: (resultados: VeredictoDeLote[]) => void;
	}): Promise<void>;

	/**
	 * DO-SUBIDA: lo que lleva el `hello_ok` de un `tpv` que acaba de entrar como Main vigente: la
	 * petición de subida completa, si es suya. Sin esperas.
	 */
	subidaParaElSaludo(deviceId: string): SubidaEnElSaludo | null;
	/** DO-SUBIDA: un paso de la subida, en el turno del log, y su acuse dentro de él. */
	aplicarSubida(params: {
		tenantId: string;
		deviceId: string;
		sesion: WebSocket;
		paso: PasoDeSubida;
		alTerminar: (respuesta: Record<string, unknown>) => void;
	}): Promise<void>;
}

/**
 * Lo más que ocupa un mensaje que se llega a leer, en bytes de UTF-8: por encima no se intenta ni
 * trocear el JSON (`payload_too_large`). Un lote de la Main son como mucho 256 KB de sentencias, pero
 * una operación va sola en su lote aunque pase de ahí, y tiene que poder llegar a la base con
 * cualquier valor que la base admita (MAX-MENSAJE):
 *
 * - **Lo más grande que la base acepta cabe.** El SQLite del DO admite filas de hasta 8 MiB y 34 bytes
 *   (`MAX_ROW_LENGTH` de workerd, cargaDeCopias.ts; «8 MB» en
 *   https://developers.cloudflare.com/durable-objects/platform/limits/), y una operación que entra
 *   deja además en `Sync_Changes` una fila con todas sus sentencias y sus valores en JSON
 *   (`loteDe`), con los mismos escapes que el mensaje. Así que el JSON de cualquier operación que la
 *   base acepta ocupa como mucho 8 MiB y 34 bytes, y su mensaje, eso y el sobre (`type`, `loteId`,
 *   `opId`…): 9 MiB deja un MiB de margen. Lo que pasa de ahí, la base tampoco lo aceptaría: un
 *   valor con muchos escapes, que en el JSON ocupa más que en su fila, no cabe en la del log.
 * - **Por debajo del límite de la plataforma**: un mensaje de WebSocket que recibe un Durable Object,
 *   32 MiB (la misma página). Los valores van como parámetros: no cuentan en los 100 KB de una
 *   sentencia.
 * - **Con margen de memoria** (128 MB por aislado, que puede tener otros objetos;
 *   https://developers.cloudflare.com/workers/platform/limits/): mientras se aplica, el mensaje está
 *   varias veces (el texto, el JSON leído, el cuerpo que se hashea, el del log y lo que recibe
 *   SQLite). Medido en workerd con una operación de N MiB, el proceso entero crece unas cinco veces
 *   N: unos 31 MB con 4 MiB, 42 con 8 y 59 con 12.
 *
 * Que una operación de más de 4 MiB se lee y la juzga la base, y que una de más del tope no se lee,
 * lo prueban `test/veredictoDelAcuse.test.ts` y `test/loteDeLaMain.test.ts`. El workerd local de las
 * pruebas admite un valor de algo más de 2 MiB (`test/sondaSqliteDo.test.ts`, `valor2MiBYUnByte`).
 */
const MAX_MENSAJE = 9 * 1024 * 1024;

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
	// En bytes de UTF-8; un carácter ocupa de uno a tres, así que sólo se cuentan si hace falta.
	if (data.length > MAX_MENSAJE || (data.length * 3 > MAX_MENSAJE && bytesUtf8(data) > MAX_MENSAJE)) {
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
	if (msg.type === "subida") return atenderSubida(ctx, ws, a, msg);

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
					rol: a.role,
					pubkeyB64Hint: a.pubkeyB64,
				});

				// AUD-02: el rol `tpv` dice que el equipo se activó como Main, no que lo siga
				// siendo. Quién lo es ahora está en la tabla del DO. El saludo de un `tpv` la pone
				// al día antes de mirarla, y si la base central no contesta no entra: como con la
				// lectura del dispositivo, sin ella no se sabe quién es. Ese fallo queda registrado
				// como el de cualquier otra lectura de la Main; el de la firma no, que es un saludo
				// que no vale. El de una Handy es actividad, y pregunta sólo si toca.
				if (roleFinal === "tpv") {
					try {
						await ctx.leerMain(tenantId);
					} catch (e) {
						ctx.registrarFalloDeLaCentral(e, "sync.main_vigente", tenantId);
						throw e;
					}
				} else await ctx.comprobarMain();

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
					// SYN-INC-01: su señal de vida hasta que mande el primer latido.
					autenticadaMs: Date.now(),
				});

				// DO-SUBIDA: a la Main de la petición se le dice que tiene que subir su base entera. A una
				// Handy, nunca. Una Main vieja no mira el campo.
				const subida = roleFinal === "tpv" ? ctx.subidaParaElSaludo(deviceId) : null;
				ctx.send(ws, {
					type: "hello_ok",
					role: roleFinal,
					authed: true,
					...(subida ? { subida } : {}),
				});

				// SYN-INC-01: lo que se le diga de la Main, con las que ya no dan señales de vida
				// cerradas (y anunciadas a las Handy).
				ctx.cerrarMainsSinLatido();

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
				ctx.send(ws, {
					type: "error",
					error: "hello_failed",
					details: motivoDelSaludoFallido(e),
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

/** Un código, como los que lanza el saludo (`bad_ws_signature`, `device_replaced`…). */
const CODIGO = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * El `details` de un `hello_failed`: el código de por qué no ha entrado (`device_replaced`,
 * `license_revoked`, `challenge_expired`, `hub_unavailable`…), nunca texto interno. Un `HubError` da
 * su código, sin su detalle (un error de SQL de la central, `central_error_sql`). Lo que no es un
 * código ni un `HubError` (un `TypeError`) sale como `internal_error`, y su texto se queda en el log,
 * filtrado (FABLE-B). Los clientes no leen `details` (`saludo_socket.rs` sólo mira el tipo): es para
 * quien mira el tráfico, como el generador de carga.
 */
function motivoDelSaludoFallido(e: unknown): string {
	if (e instanceof HubError) return e.code;
	const mensaje = String((e as Error | undefined)?.message || e);
	if (CODIGO.test(mensaje)) return mensaje;
	console.error(acotar(`[ws] hello_failed → ${(e as Error | undefined)?.name || "Error"}: ${mensaje}`, scrub));
	return "internal_error";
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
 * El lote de la Main: lo que sube de su outbox, hasta 200 operaciones de una vez, en orden. Es lo
 * único que la Main escribe por aquí.
 *
 * El acuse (`apply_lote_ack`, con el `loteId` del mensaje) lleva el veredicto de cada operación
 * (`VeredictoDeLote`). Lo que afecta al lote entero sale con `ok: false` y su error, sin haber
 * aplicado nada: el rol, la forma de cualquiera de sus operaciones, o que la sesión ya no sea la
 * de la Main.
 */
async function atenderApplyLote(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: ApplyLoteMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;
	const loteId = String(msg.loteId ?? "").trim();
	const acusar = (cuerpo: Record<string, unknown>) =>
		ctx.send(ws, { type: "apply_lote_ack", loteId, ...cuerpo });

	// Autorización por rol: sólo la Main (`tpv`) ejecuta SQL crudo por el socket. El rol viene del
	// saludo (la fila del dispositivo en la base central), nunca del cliente. Las escrituras de la
	// Handy van por REST, como comandos de dominio acotados (`lib/hub.ts` → RPC `aplicar`).
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
	const clientNowLote = String(msg.clientNow || "");
	const ops: OpDeLote[] = [];
	for (const item of msg.ops) {
		const inner = item?.command;
		const cmdType = String(inner?.type || "").trim();
		const opId = String(item?.opId ?? "").trim();
		const commandName = String(item?.commandName ?? "").trim();
		if (!cmdType || !opId || !commandName) {
			acusar({ ok: false, error: "missing_apply_fields" });
			return;
		}
		const cmd = { type: inner!.type, payload: inner!.payload } as InternalApplyCommand;
		ops.push({
			opId,
			commandName,
			cmd,
			// El cuerpo canónico que se hashea (`Request_Hash`): el reenvío de una operación casa con él.
			requestPayloadJson: stableStringify(buildInternalPayloadForHash(cmd)),
			// La Main manda sus sentencias con la hora ya resuelta; si viniera, por operación o una vez
			// para todo el lote.
			clientNow: String(item?.clientNow || "") || clientNowLote,
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

			// La fila no suelta al siguiente hasta que el lote tiene sitio en el turno del log
			// (`alReservarTurno`), que es lo que fija el orden en que se confirman. Antes de eso el motor
			// prepara cada operación (su hash) y abre la base del negocio (al despertar, el DO comprueba
			// sus migraciones): son esperas, y un lote cuyas esperas acabaran antes se adelantaría al
			// anterior. Lo que tarde después ya no retiene la fila.
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

/**
 * DO-SUBIDA · Un paso de la subida completa de la Main (`tenantHub.subida.ts`). Como un `apply_lote`:
 * sólo un `tpv`, la forma antes que nada, en fila con lo demás que manda la Main, y la sesión como
 * está después de la comprobación por actividad. El acuse (`subida_ack`, con el `pasoId` del
 * mensaje) lleva `ok`, o el error con su clase (`permanente`, `transitorio`), o `aplazada`.
 */
async function atenderSubida(
	ctx: ContextoDeMensajes,
	ws: WebSocket,
	a: WsAttachment,
	msg: SubidaMsg,
): Promise<void> {
	const { tenantId, deviceId } = a;
	const pasoId = typeof msg.pasoId === "string" ? msg.pasoId.slice(0, 100) : "";
	const acusar = (cuerpo: Record<string, unknown>) => ctx.send(ws, { type: "subida_ack", pasoId, ...cuerpo });
	const rechazo = (e: any) => ({
		ok: false,
		error: String(e?.code ?? e?.message ?? e).slice(0, 200),
		permanente: esRechazoPermanente(e),
		transitorio: esFalloPasajero(e),
	});

	if (a.role !== "tpv") {
		acusar({ ok: false, error: "forbidden_not_tpv", permanente: true, transitorio: false });
		return;
	}
	let paso: PasoDeSubida;
	try {
		if (!pasoId) throw new Error("subida_mal_formada");
		paso = formaDelPaso(msg);
	} catch (e) {
		acusar(rechazo(e));
		return;
	}

	ctx.waitUntil(
		ctx.enTurnoDeEntrada(async () => {
			await ctx.comprobarMain();
			if (!ctx.esLaMain(sesionAbierta(ctx, ws))) {
				acusar({ ok: false, error: "not_authenticated", permanente: false, transitorio: true });
				return;
			}
			try {
				await ctx.aplicarSubida({ tenantId, deviceId, sesion: ws, paso, alTerminar: acusar });
			} catch (e: any) {
				acusar(rechazo(e));
			}
		}),
	);
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
