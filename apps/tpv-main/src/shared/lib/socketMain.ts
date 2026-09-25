// src/shared/lib/socketMain.ts
//
// Mantiene el WebSocket de la Main con el worker y APLICA en la BD local los cambios que llegan
// de la nube (Opción 3: sentencias ya resueltas). Conectar + responder al challenge firmado
// registra el dispositivo como `tpv` en el TenantHub (habilita las escrituras de la Handy).
//
// Vive fuera de React a propósito. Es el núcleo de la replicación y, dentro de un `useEffect`, sólo
// se podía probar montando el componente; aquí se prueba con un socket y un reloj falsos
// (`test/socketMain.test.ts`). El hook `useMainSocket` lo arranca y le avisa de lo que sólo sabe el
// navegador: que ha vuelto la red, que la ventana ha recuperado el foco o que llegó el `pulso`.
//
// SYNC-17: se intenta SIEMPRE mientras este dispositivo sea la Main. No hay ajuste que activar:
// la conectividad es un estado derivado que se publica en `useEstadoSync` (lo pinta Configuración
// → Conectividad). Lo único que puede impedir el intento es la palanca de emergencia
// (`preferencia === "off"`, sin UI) o que aún no haya licencia/identidad a la que conectarse.
// La Main es Local-First pase lo que pase: sin conexión sigue vendiendo y el outbox acumula.
//
// Flujo de aplicación:
//   - Al autenticarse (hello_ok) se hace un CATCH-UP: se pide a /v1/sync/changes todo lo que
//     falte desde el último checkpoint local y se aplica en orden. Los `change` que lleguen en
//     vivo durante el catch-up se BUFFERIZAN y se aplican al terminar (evita desorden).
//   - Después, cada `change` en vivo se aplica directo (el WS preserva el orden).
//   - Todo se aplica de forma serializada (una cadena de promesas) e idempotente por op_id en
//     Rust, así que solapes entre catch-up y vivo no duplican ni corrompen.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AplicacionSync, LicenseLocalState, OutboxFallo } from "@tpv/contracts";
import { toAppError } from "@tpv/client";

import { useEstadoSync, type PreferenciaSync } from "../stores/useEstadoSync";
import type { ModeStateValue } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { cloudPost, CLOUD_WS_URL as WS_URL } from "./cloudApi";
import { queryClient } from "./queryClient";
import {
	affectedComandas,
	affectedFeatureKeys,
	tocaAjustes,
	type RawStatement,
} from "./syncStatements";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { captureException } from "../observability/sentry";
import { reconcileRestoredDatabase, type RecoveryPhase } from "./recoverySync";
import {
	crearEsperas,
	firmarHello,
	leerIdDispositivo,
	pedirTicketWs,
	RETRY_RECHAZADO_MS,
	vigilarLatido,
} from "./socketComun";

// SYNC-17: esperas largas para los dos casos en los que reintentar rápido no arregla nada.
// `sin_identidad` no llega ni a tocar la red (son dos `invoke` locales), pero repetirlo cada 3 s
// en un TPV recién instalado solo llena la consola; el camino rápido de verdad es el `pulso` que
// dispara AppBoot en cuanto la licencia deja pasar.
const RETRY_SIN_IDENTIDAD_MS = 60_000;
const OUTBOX_BATCH = 50;
const ACK_TIMEOUT_MS = 10000;
// REV-11: los tres fallos que ponemos NOSOTROS cuando la nube no llega a contestar. Son cadenas
// nuestras, no mensajes de la nube, así que compararlas aquí es leer una constante propia y no
// adivinar la redacción de libsql — que es lo que la regla de SYNC-20 prohíbe.
const ERROR_SOCKET_CERRADO = "socket_not_open";
const ERROR_SIN_ACK = "ack_timeout";
const ERROR_SOCKET_SOLTADO = "socket_soltado";
const ERRORES_DE_TRANSPORTE = new Set([
	ERROR_SOCKET_CERRADO,
	ERROR_SIN_ACK,
	ERROR_SOCKET_SOLTADO,
]);
// SYNC-18: a partir de aquí no se sube de una en una, se VUELCA. El corte separa dos situaciones
// distintas: con la nube casi al día, subir en vivo va sobrado y el Handy ve el cambio al instante;
// con un atraso de verdad, esperar un ack por operación son minutos con el cliente atado a la
// conexión. Solo se mira al conectar: una ráfaga a mitad de servicio (importar un catálogo) sigue
// por el camino en vivo y no congela a nadie.
const UMBRAL_VOLCADO = 100;
// Tamaño de trozo. El límite de un mensaje WS son 32 MiB, así que esto no es por el límite: es para
// que un corte a mitad del volcado no obligue a repetirlo entero.
const VOLCADO_OPS_POR_TROZO = 200;
const VOLCADO_BYTES_POR_TROZO = 256 * 1024;
const VOLCADO_ACK_TIMEOUT_MS = 30000;
// Cuánto se espera la confirmación de una encolada antes de volver a ofrecerla. Reenviar es inocuo
// (la nube es idempotente por `Op_Id`); esto es lo que impide que una operación se quede en el
// limbo si su ack se perdió o la nube acabó descartándola.
const TTL_ENCOLADA_MS = 60 * 60 * 1000;
// SYNC-13: tope de páginas por ciclo de catch-up (× 500 ops/página = 1M ops). Si se alcanza, el
// catch-up quedó a medias: continúa en el siguiente ciclo, pero lo señalamos por telemetría.
const CATCHUP_MAX_PAGES = 2000;
// Red de seguridad: el drenado inmediato lo dispara el evento Tauri `outbox:pending` (emitido por
// Rust al confirmar cada escritura local). Este poll solo cubre reintentos de ops que fallaron al
// subir y el arranque; por eso puede ser holgado (no es el camino de latencia normal).
const DRAIN_INTERVAL_MS = 3000;

type ChangeArg = { op_id: string; seq: number; statements: unknown[] };
type OutboxEntry = {
	seq: number;
	op_id: string;
	command_name: string;
	statements: { sql: string; args: unknown[] }[];
};

function toChange(m: any): ChangeArg | null {
	const opId = String(m?.opId ?? m?.op_id ?? "");
	const seq = Number(m?.seq ?? 0);
	const statements = Array.isArray(m?.statements) ? m.statements : [];
	if (!opId || !statements.length) return null;
	return { op_id: opId, seq, statements };
}

// Solo necesitamos el tenantId para firmar el hello del WS. El token de sesión NO se expone al
// frontend (vive en el keyring): el intercambio del ticket y las llamadas firmadas las hace Rust.
async function loadLicense(): Promise<{ tenantId: string } | null> {
	try {
		const st = await invoke<LicenseLocalState | null>("license_get_state");
		const tenantId = String(st?.tenant_id ?? "");
		if (!tenantId) return null;
		return { tenantId };
	} catch {
		return null;
	}
}

/** Lo que decide si se conecta y cómo: los valores de los stores de los que depende el hook. */
export type EntradaSocketMain = {
	modo: ModeStateValue;
	hidratada: boolean;
	preferencia: PreferenciaSync;
	datosPerdidos: boolean;
	reconciliacionPendiente: boolean;
};

export type SocketMain = {
	/**
	 * SYNC-17: reconecta ya si la conexión no está sana, sin esperar a que venza el backoff. Lo
	 * llama quien se entera de que conviene: vuelve la red, la ventana recupera el foco (`forzar`
	 * falso) o llega el `pulso` de una licencia renovada o de un reintento pedido por el usuario
	 * (`forzar` verdadero, que salta las esperas largas y una recuperación bloqueada).
	 */
	reconectarSiHaceFalta: (forzar?: boolean) => void;
	/** Cierra el socket y lo para todo: temporizadores, reintentos y la escucha del outbox. */
	detener: () => void;
};

/**
 * Arranca el socket de la Main. Devuelve `null` si no hay que conectar: no es una Main, todavía no
 * se ha leído la palanca, o se ha publicado `pausada` (palanca en `off` o datos perdidos).
 */
export function iniciarSocketMain(entrada: EntradaSocketMain): SocketMain | null {
	const { preferencia, datosPerdidos, reconciliacionPendiente } = entrada;

	if (entrada.modo !== "tpv") return null;
	// Esperamos a leer la palanca de AppData: si está en `off`, arrancar y cerrar acto seguido
	// dejaría un parpadeo de "conectando" y una conexión inútil.
	if (!entrada.hidratada) return null;

	const marcar = useEstadoSync.getState().marcar;

	if (preferencia === "off") {
		marcar("pausada", "Sincronización desactivada en este dispositivo");
		return null;
	}

	// La BD local está vacía a la espera del bootstrap: conectar ahora dispararía un catch-up
	// desde `Last_Seq = 0` contra tablas sin filas. Ver `datosPerdidos` en el store.
	if (datosPerdidos) {
		marcar("pausada", "Faltan los datos de este equipo: recupéralos antes de sincronizar");
		return null;
	}

	let cancelled = false;
	let ws: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let latido: ReturnType<typeof vigilarLatido> | null = null;
	let unlistenOutbox: (() => void) | null = null;
	// Evita dos `open()` concurrentes: ahora la reconexión también la disparan eventos
	// (`online`/`focus`/`visibilitychange`), que pueden llegar a la vez.
	let opening = false;

	// Estado de aplicación (compartido entre reconexiones mientras siga arrancado).
	let caughtUp = false;
	const buffer: ChangeArg[] = [];
	let chain: Promise<void> = Promise.resolve();

	// Estado del drenado del outbox (Main → nube).
	let authed = false;
	let draining = false;
	let recoveryRunning = false;
	// La reconciliación agotó sus intentos: se deja de reconectar sola hasta que el usuario lo
	// pida. Sin esto, una causa que no es la red (la nube rechaza siempre la misma operación,
	// el tenant está roto) gira para siempre diciendo que espera conexión.
	let recuperacionBloqueada = false;
	let drainTimer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Lo que contesta la nube a un `apply`, o lo que ponemos nosotros cuando no llega a contestar.
	 *
	 * `permanente` y `transitorio` son las dos mitades de la clasificación que hace el DO
	 * (`tenantHub.errores.ts`): definitivo, pasajero, o ninguno de los dos —desconocido—. El cliente
	 * NO los deduce del texto; los mensajes de libsql cambian de redacción entre versiones.
	 */
	type Ack = {
		ok: boolean;
		error?: string;
		seq?: number;
		encolada?: boolean;
		// SYNC-20: la nube dice si su rechazo es definitivo. Ver `tenantHub.errores.ts`.
		permanente?: boolean;
		// REV-11: y si es de los que se arreglan solos, para no gastar un intento por ello.
		transitorio?: boolean;
	};
	const acks = new Map<string, (ack: Ack) => void>();
	// SYNC-18: sólo hay un volcado en curso a la vez (el bucle es secuencial), así que basta un
	// hueco en vez de un mapa.
	let ackVolcado: ((ok: boolean, error?: string) => void) | null = null;

	// Aplica de forma serializada (FIFO) para no solapar transacciones en la misma conexión.
	function enqueue(changes: ChangeArg[]): Promise<void> {
		if (!changes.length) return Promise.resolve();
		const task = chain.then(async () => {
			if (cancelled) return;
			const r = await invoke<AplicacionSync>("sync_apply_changes", {
				args: { changes },
			});

			// Avisar al front de que los datos locales cambiaron:
			//  - React Query: invalida (solo refetchea las queries MONTADAS, es barato).
			//  - POS (mesas / venta_rápida): tick + qué comandas tocó el lote, para que
			//    recarguen el ticket solo si es la comanda abierta (no la de otro device).
			//
			// Se reacciona SÓLO a lo que Rust aplicó de verdad. Lo que el gate de
			// idempotencia salta —nuestras propias operaciones volviendo por el catch-up,
			// un re-broadcast, una op en cuarentena— no cambió nada en esta BD. Reaccionar
			// a todo lo recibido recargaba media aplicación en cada página del catch-up, y
			// con los ajustes llegaba a realimentarse: releerlos generaba escrituras nuevas
			// que volvían a llegar como cambios.
			const aplicadas = new Set(r?.aplicadas ?? []);
			if (aplicadas.size === 0) return;

			if (!cancelled) {
				const statements = changes
					.filter((c) => aplicadas.has(c.op_id))
					.flatMap((c) => (Array.isArray(c.statements) ? c.statements : [])) as RawStatement[];
				// SYNC-06: invalidación selectiva por feature (fallback global si el lote toca
				// una tabla no mapeada).
				const featureKeys = affectedFeatureKeys(statements);
				if (featureKeys === null) {
					void queryClient.invalidateQueries();
				} else {
					for (const k of featureKeys) void queryClient.invalidateQueries({ queryKey: [k] });
				}
				useSyncSignal.getState().bump(affectedComandas(statements));
				// Los ajustes del negocio/ticket no están en React Query: viven en stores que se
				// leen al arrancar. Si los cambia otro dispositivo hay que recargarlos, o esta
				// Main seguiría IMPRIMIENDO con el ancho y el pie de página viejos.
				if (tocaAjustes(statements)) {
					void useBusinessSettings.getState().init();
					void useTicketSettings.getState().init();
				}
			}
		});
		// La cadena compartida siempre se recupera para que un fallo no mate el flujo vivo. El
		// `task` devuelto conserva el rechazo y permite que la recuperación falle cerrada.
		chain = task.catch((e) => {
			// No es ruido de red: los cambios YA estaban descargados y no se han podido
			// escribir en la BD local. Este dispositivo deja de converger hasta que se
			// arregle, así que tiene que verse fuera de la consola de quien lo esté mirando.
			console.warn("sync_apply_changes falló:", e);
			captureException(e, { fase: "sync_apply_changes" });
		});
		return task;
	}

	// Envía una operación del outbox por el WS (mensaje `apply`) y espera su `apply_ack`.
	function sendApply(socket: WebSocket, entry: OutboxEntry): Promise<Ack> {
		return new Promise<Ack>((resolve) => {
			if (socket.readyState !== WebSocket.OPEN) {
				resolve({ ok: false, error: ERROR_SOCKET_CERRADO });
				return;
			}
			const timer = setTimeout(() => {
				acks.delete(entry.op_id);
				resolve({ ok: false, error: ERROR_SIN_ACK });
			}, ACK_TIMEOUT_MS);

			acks.set(entry.op_id, (ack) => {
				clearTimeout(timer);
				acks.delete(entry.op_id);
				resolve(ack);
			});

			socket.send(
				JSON.stringify({
					type: "apply",
					opId: entry.op_id,
					commandName: entry.command_name,
					command: {
						type: "tenantDb.transaction",
						payload: {
							steps: entry.statements.map((s) => ({
								kind: "execute",
								sql: s.sql,
								args: s.args,
							})),
						},
					},
				}),
			);
		});
	}

	/**
	 * SYNC-18: manda un trozo del atraso y espera a que la nube confirme que lo ha guardado en
	 * su cola. Confirmar no es aplicar: el DO lo aplicará por su cuenta, y por eso este camino
	 * termina en cuanto se sube lo último, sin esperar a que se escriba en Turso.
	 */
	function enviarTrozo(
		socket: WebSocket,
		trozo: OutboxEntry[],
	): Promise<{ ok: boolean; error?: string }> {
		return new Promise((resolve) => {
			if (socket.readyState !== WebSocket.OPEN) {
				resolve({ ok: false, error: "socket_not_open" });
				return;
			}
			const timer = setTimeout(() => {
				ackVolcado = null;
				resolve({ ok: false, error: "bulk_ack_timeout" });
			}, VOLCADO_ACK_TIMEOUT_MS);

			ackVolcado = (ok, error) => {
				clearTimeout(timer);
				ackVolcado = null;
				resolve({ ok, error });
			};

			socket.send(
				JSON.stringify({
					type: "bulk_apply",
					ops: trozo.map((entry) => ({
						opId: entry.op_id,
						commandName: entry.command_name,
						command: {
							type: "tenantDb.transaction",
							payload: {
								steps: entry.statements.map((s) => ({
									kind: "execute",
									sql: s.sql,
									args: s.args,
								})),
							},
						},
					})),
				}),
			);
		});
	}

	/**
	 * Vuelca TODO el atraso a la cola de la nube, por trozos, y marca lo aceptado como encolado.
	 *
	 * Es el camino de "vengo de estar sin conexión": en cuanto termina, este TPV puede quedarse
	 * sin internet otra vez sin perder nada — sus operaciones ya están guardadas en el servidor,
	 * que las aplicará solo. Lo que NO hace es esperar a que se apliquen.
	 */
	async function volcarOutbox(socket: WebSocket): Promise<void> {
		for (let vuelta = 0; vuelta < 10000 && !cancelled && authed; vuelta++) {
			if (socket.readyState !== WebSocket.OPEN) return;

			const pendientes = (await invoke<OutboxEntry[]>("sync_outbox_pending", {
				limit: VOLCADO_OPS_POR_TROZO,
			})) as OutboxEntry[];
			if (!pendientes.length) return;

			// Recorte por tamaño: el trozo se cierra en cuanto se pasa del presupuesto de bytes.
			const trozo: OutboxEntry[] = [];
			let bytes = 0;
			for (const entry of pendientes) {
				trozo.push(entry);
				bytes += JSON.stringify(entry.statements).length;
				if (bytes >= VOLCADO_BYTES_POR_TROZO) break;
			}

			const { ok, error } = await enviarTrozo(socket, trozo);
			if (!ok) {
				console.warn("[volcado] la nube no aceptó el trozo:", error ?? "(sin error)");
				return; // se reintenta al reconectar; nada se ha perdido
			}

			await invoke("sync_outbox_mark_encolada", {
				opIds: trozo.map((e) => e.op_id),
			});
			console.log(`[volcado] ${trozo.length} op(s) en la cola de la nube`);
		}
	}

	/**
	 * SYNC-20: anota en el outbox que la nube rechazó esta operación, y decide si se aparta.
	 *
	 * Aquí vive además el único aviso que sirve de algo. Un rechazo de subida NO lo puede
	 * arreglar quien está delante del TPV: es un bug nuestro o un desajuste entre el esquema
	 * del tenant y la sentencia. Decirle al camarero «no se pudo subir la operación
	 * 8f3a-…» sería ruido que aprende a ignorar. Lo que hace falta es que se entere **quien
	 * puede arreglarlo**, sin que nadie tenga que mirar nada: por eso una operación apartada
	 * va a Sentry con lo justo para diagnosticarla.
	 *
	 * ⚠️ Va el NOMBRE del comando, nunca sus sentencias ni sus argumentos: por ahí pasan datos
	 * del negocio y la PII del personal (cifrada, pero no es sitio para mandarla). Para saber
	 * qué arreglar basta con qué comando y qué dijo la nube.
	 */
	async function anotarFalloDeSubida(
		opId: string,
		error?: string,
		permanente?: boolean,
		fase: "drain_outbox" | "cola_de_la_nube" = "drain_outbox",
	): Promise<OutboxFallo | null> {
		try {
			const fallo = await invoke<OutboxFallo>("sync_outbox_mark_failed", {
				opId,
				error: error ?? "sin detalle",
				permanente: Boolean(permanente),
			});
			if (fallo.apartada) {
				console.error(
					`[outbox] op APARTADA tras ${fallo.intentos} rechazo(s): ${opId}`,
					error,
				);
				captureException(new Error("outbox_op_apartada"), {
					fase,
					op_id: opId,
					command_name: fallo.command_name,
					intentos: fallo.intentos,
					permanente: Boolean(permanente),
					error_nube: error ?? "sin detalle",
				});
			}
			return fallo;
		} catch (e) {
			// Que no se pueda anotar el fallo no puede convertirse en un fallo distinto: se cae
			// al comportamiento de siempre (parar y reintentar luego), que es seguro.
			console.warn("sync_outbox_mark_failed falló:", e);
			return null;
		}
	}

	// Drena el outbox local en orden: por cada op pendiente, la envía y, si la nube confirma
	// (apply_ack ok), la marca como enviada. Si una falla/expira, para y reintenta más tarde.
	async function drainOutbox(socket: WebSocket, strict = false) {
		while (strict && draining && !cancelled) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (draining || !authed || socket.readyState !== WebSocket.OPEN) {
			if (strict) throw new Error("La conexión con la nube no está disponible");
			return;
		}
		draining = true;
		try {
			for (let i = 0; i < 1000 && !cancelled && authed; i++) {
				const pending = (await invoke<OutboxEntry[]>("sync_outbox_pending", {
					limit: OUTBOX_BATCH,
				})) as OutboxEntry[];
				if (!pending.length) break;
				console.log(`[outbox] ${pending.length} op(s) pendientes`);

				let progressed = false;
				for (const entry of pending) {
					if (cancelled || socket.readyState !== WebSocket.OPEN) break;
					const { ok, error, seq, encolada, permanente, transitorio } = await sendApply(
						socket,
						entry,
					);
					if (!ok) {
						console.warn(`[outbox] apply_ack FALLÓ op=${entry.op_id}:`, error ?? "(sin error)");

						// REV-11: lo que no es un rechazo de LA OPERACIÓN no le gasta un intento.
						//
						// Entran aquí los tres fallos de transporte —el socket se cerró, el ack no
						// llegó, o lo soltamos al reconectar— y los que la propia nube reconoce como
						// pasajeros (Turso ocupado o caído). Ninguno dice nada sobre esta operación:
						// dicen que ahora mismo no se puede subir NADA.
						//
						// Y ahí está la razón de fondo, que es distinta de la de SYNC-20: apartar
						// existe para que una operación imposible no detenga el día de ventas que
						// tiene detrás. Pero cuando lo que falla es el transporte, lo de detrás está
						// igual de parado —es el mismo cable—, así que apartar la cabeza de la cola
						// no desatasca nada: sólo tira una venta buena, avisa a Sentry de un
						// problema que no existe y deja la nube divergente. Se contaban ~5 intentos
						// por cada socket medio muerto (10 s de espera + 3 s hasta el reintento,
						// durante los 65 s que tarda el latido en cerrarlo), así que cuatro baches
						// de red bastaban para apartar una venta perfectamente sana.
						//
						// Lo desconocido sí cuenta, y acabará apartándose: es la política escrita de
						// «fallar hacia transitorio», no una excepción a ella.
						if (transitorio || ERRORES_DE_TRANSPORTE.has(String(error ?? ""))) {
							if (strict) {
								throw new Error(
									`No se pudo subir una operación local (${entry.op_id}): ${error ?? "sin conexión"}`,
								);
							}
							break;
						}

						if (strict) {
							// Con el op_id delante: reintentar en bucle una operación que la nube
							// rechaza siempre no lo arregla, y sin el identificador no hay por dónde
							// empezar a mirar.
							throw new Error(
								`La nube rechazó una operación local (${entry.op_id}): ${error ?? "sin detalle"}`,
							);
						}
						// SYNC-20: antes aquí sólo había un `break`, o sea "paro y lo reintento
						// luego", para siempre y sin contárselo a nadie. Como el outbox es una cola
						// ordenada, una operación que la nube no puede aplicar dejaba detenido todo
						// lo de detrás — que es un día de ventas. Ahora se anota el rechazo y, si la
						// operación se aparta, el drenado SIGUE con la siguiente.
						const fallo = await anotarFalloDeSubida(entry.op_id, error, permanente);
						if (fallo?.apartada) {
							progressed = true;
							continue;
						}
						break;
					}
					// SYNC-18: encolada ≠ aplicada. Su fila se queda en el outbox hasta que el
					// catch-up la devuelva; marcarla como enviada aquí sería darla por buena antes
					// de tiempo. Ya se anotó como encolada al recibir el ack.
					if (encolada) {
						progressed = true;
						continue;
					}
					try {
						// Tauri v2 camelCasea los nombres de argumento en la frontera JS↔Rust:
						// el comando `sync_outbox_mark_sent(op_id, seq)` se invoca con `opId`/`seq`.
						// El `seq` (cursor que la nube asignó) asciende el anti-eco a su valor real
						// para que la purga por cursor pueda retirarlo cuando el checkpoint lo supere.
						await invoke("sync_outbox_mark_sent", {
							opId: entry.op_id,
							seq: Number(seq ?? 0),
						});
						progressed = true;
					} catch (e) {
						console.warn("sync_outbox_mark_sent falló:", e);
						break;
					}
				}
				if (!progressed) break;
			}

			// La purga de `_Sync_Applied_Ops` ya NO se hace aquí: es mantenimiento periódico, no
			// parte del drenado, y colgarla de "esta pasada subió algo" la dejaba sin correr en
			// un equipo online y ocioso. Ahora es el job `purga_sync` (jobs/registro.rs).
		} catch (e) {
			console.warn("drenado del outbox falló:", e);
			if (strict) throw e;
		} finally {
			draining = false;
		}
	}

	/**
	 * SYNC-18: decide por dónde sube lo pendiente, y lo decide UNA VEZ, al conectar.
	 *
	 * Con poco atraso, de una en una: la nube está casi al día, cada operación se aplica al
	 * instante y el Handy la ve enseguida. Con atraso de verdad, volcado: se sube todo a la cola
	 * del servidor y este TPV queda libre, aunque le quiten el internet a continuación.
	 *
	 * Antes de nada se sueltan las encoladas que la nube nunca confirmó: reenviarlas es inocuo y
	 * es lo que impide que una operación se quede en el limbo.
	 */
	async function subirLoPendiente(socket: WebSocket) {
		try {
			const liberadas = await invoke<number>("sync_liberar_encoladas", {
				antiguedadMs: TTL_ENCOLADA_MS,
			});
			if (liberadas > 0) {
				console.log(`[outbox] ${liberadas} op(s) encoladas sin confirmar: se reenvían`);
			}
		} catch (e) {
			console.warn("sync_liberar_encoladas falló:", e);
		}

		let atraso = 0;
		try {
			const muestra = (await invoke<OutboxEntry[]>("sync_outbox_pending", {
				limit: UMBRAL_VOLCADO + 1,
			})) as OutboxEntry[];
			atraso = muestra.length;
		} catch (e) {
			console.warn("sync_outbox_pending falló:", e);
		}

		if (atraso > UMBRAL_VOLCADO) {
			console.log("[outbox] atraso grande: se vuelca a la cola de la nube");
			// HIG-04: `volcarOutbox` no captura sus `invoke`, y a esta función se llega con `void`.
			// El drenado de una en una se protege a sí mismo; el volcado se quedaba a medias sin
			// decirlo. No se pierde nada —lo que no llegó a marcarse sigue en el outbox y se
			// reintenta al reconectar—, así que basta con que se vea, igual que en `drainOutbox`.
			try {
				await volcarOutbox(socket);
			} catch (e) {
				console.warn("volcado del outbox falló:", e);
			}
			return;
		}
		await drainOutbox(socket);
	}

	async function catchUpThenLive(strict = false): Promise<number> {
		caughtUp = false;
		let highWater = 0;
		let failure: unknown = null;
		try {
			let since = 0;
			try {
				since = Number(await invoke<number>("sync_get_checkpoint")) || 0;
			} catch {
				since = 0;
			}

			let page = 0;
			for (; page < CATCHUP_MAX_PAGES && !cancelled; page++) {
				const resp = (await cloudPost<any>("tpv", "/v1/sync/changes", {
					since,
				})) as any;
				const items: any[] = Array.isArray(resp?.items) ? resp.items : [];
				const hw = resp?.highWater ?? resp?.high_water;
				if (hw == null) {
					// Un worker anterior a este contrato no manda el final del log. En modo estricto
					// eso NO es "cero": dar por bueno un high-water inventado degrada la verificación
					// a "el outbox está vacío" y desbloquearía el login sin haber comprobado nada.
					if (strict) {
						failure ??= new Error(
							"El servidor no informa del punto de sincronización; actualiza la nube antes de recuperar",
						);
						break;
					}
				} else {
					highWater = Number(hw);
				}
				if (!items.length) break;
				await enqueue(items.map(toChange).filter(Boolean) as ChangeArg[]);
				const next = Number(resp?.nextSince ?? since);
				if (next <= since) break;
				since = next;
			}
			// SYNC-13: si agotamos el tope de páginas, el catch-up no terminó en este ciclo
			// (Main mucho tiempo offline o Sync_Changes enorme). Reanuda al reconectar, pero lo
			// hacemos VISIBLE para no cortar la convergencia en silencio.
			if (page >= CATCHUP_MAX_PAGES && !cancelled) {
				const capError = new Error("sync_catchup_cap_reached");
				captureException(capError, {
					pages: page,
					lastSince: since,
				});
				if (strict) failure = capError;
			}
		} catch (e) {
			console.warn("catch-up de sync falló:", e);
			failure = e;
		} finally {
			// Aplica (en orden) lo recibido en vivo durante el catch-up y abre el flujo vivo.
			const pending = buffer.splice(0).sort((a, b) => a.seq - b.seq);
			caughtUp = true;
			try {
				await enqueue(pending);
			} catch (e) {
				failure ??= e;
			}
		}
		if (strict && failure) throw failure;
		return highWater;
	}

	// SYNC-09: esperas entre reintentos (vuelven a la corta en `hello_ok`).
	const esperas = crearEsperas();
	/**
	 * Programa el siguiente intento. `esperaFija` salta el backoff para los motivos que no se
	 * arreglan reintentando deprisa (sin identidad, rechazo del worker).
	 */
	const scheduleReconnect = (esperaFija?: number) => {
		if (cancelled || retryTimer || recuperacionBloqueada) return;
		const delay = esperaFija != null ? esperaFija + Math.random() * 1000 : esperas.siguiente();
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void open();
		}, delay);
	};

	/**
	 * Suelta el socket actual: sus temporizadores, sus confirmaciones pendientes y lo que se sabía de
	 * su conexión.
	 *
	 * Lo hace quien lo abandona y en el momento, no su `onclose`. Ese evento llega cuando termina el
	 * cierre, que en un TCP medio-abierto puede ser mucho después, y para entonces puede haber ya otro
	 * socket en su sitio. Mientras lo hacía el `onclose`, el de un socket abandonado le quitaba al
	 * nuevo la autenticación, el latido y la subida periódica, dejaba de aplicar lo que llegaba
	 * (`caughtUp` a falso sin un catch-up detrás) y programaba otra conexión; y como el TenantHub echa
	 * al socket anterior de un dispositivo en cuanto conecta uno nuevo, eso era un bucle.
	 */
	function soltarSocket() {
		latido?.parar();
		latido = null;
		if (drainTimer) {
			clearInterval(drainTimer);
			drainTimer = null;
		}
		// Resolver como fallo los acks pendientes para no dejar promesas colgadas. Con su motivo:
		// es un fallo de transporte, no un rechazo, y sin decirlo le costaba un intento a la
		// operación que estuviera en vuelo (REV-11).
		for (const cb of acks.values()) cb({ ok: false, error: ERROR_SOCKET_SOLTADO });
		acks.clear();
		ws = null;
		authed = false;
		// Forzamos catch-up al reconectar: lo perdido se recupera por el endpoint.
		caughtUp = false;
	}

	// SYNC-17: reconexión inmediata cuando vuelve la red / la app recupera el foco, SOLO si no
	// estamos ya sanos. Sin esto, un equipo que despierta de suspensión se queda esperando a que
	// venza un backoff que puede ir por 30 s, con el socket ya muerto. La Handy ya lo hacía.
	const reconnectNowIfNeeded = (forzar = false) => {
		if (cancelled || opening) return;
		// Una recuperación bloqueada sólo se reanuda a petición del usuario (`pulso`), no porque
		// vuelva la red o la ventana recupere el foco: lo que falla no es la conexión.
		if (recuperacionBloqueada) {
			if (!forzar) return;
			recuperacionBloqueada = false;
		}
		if (ws && ws.readyState === WebSocket.CONNECTING) return;
		// Sano = socket abierto Y autenticado (un WS abierto sin `hello_ok` no sirve de nada).
		if (ws?.readyState === WebSocket.OPEN && authed) return;
		// Un rechazo del worker no lo arregla volver a la ventana: sin esto, cada alt-tab
		// dispararía otra petición de ticket con la misma licencia bloqueada. Solo el `pulso`
		// (licencia renovada) tiene derecho a saltarse la espera larga.
		if (!forzar && useEstadoSync.getState().estado === "rechazado") return;

		esperas.reiniciar();
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (ws) {
			// Un WS "abierto" pero sin autenticar puede estar medio-muerto: cerrar para reabrir limpio.
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
			}
			// Se suelta ya, sin esperar a su `onclose`: ver `soltarSocket`.
			soltarSocket();
		}
		void open();
	};

	async function open() {
		if (cancelled || opening) return;
		opening = true;
		try {
			await openInner();
		} finally {
			opening = false;
		}
	}

	async function openInner() {
		if (cancelled) return;

		// "Conectando…" es para el primer intento, no para cada reintento: si ya estamos en un
		// estado de fallo conocido, se conserva. Si no, "sin conexión desde hace 40 min" se
		// reiniciaría cada pocos segundos y el usuario nunca sabría cuánto lleva caído.
		const estadoActual = useEstadoSync.getState().estado;
		if (
			estadoActual !== "reintentando" &&
			estadoActual !== "rechazado" &&
			estadoActual !== "sin_identidad"
		) {
			marcar("conectando");
		}

		const lic = await loadLicense();
		const deviceId = await leerIdDispositivo();
		if (cancelled) return;
		if (!lic || !deviceId) {
			// TPV recién instalado (o licencia aún sin activar): no hay tenant al que conectarse.
			// No es un error; en cuanto el gate deje pasar, AppBoot dispara el `pulso`.
			marcar("sin_identidad");
			scheduleReconnect(RETRY_SIN_IDENTIDAD_MS);
			return;
		}

		// SYNC-15: el WS se abre SOLO con un ticket efímero de un solo uso (nunca el token en la
		// URL). Si no lo obtenemos, el motivo decide cuánto esperamos.
		const res = await pedirTicketWs("tpv");
		if (cancelled) return;
		if (!res.ok) {
			if (res.rechazado) {
				marcar("rechazado", res.detalle);
				// La nube acaba de decir que esta licencia ya no vale en este equipo. Sin esto,
				// eso sólo se convertía en un badge de conectividad: el gate seguía en verde y
				// el TPV seguía vendiendo hasta la siguiente vuelta del job, seis horas después.
				// `license_check_now` emite `license:changed`, así que la pantalla se entera
				// sola. Es best-effort: si falla, el job lo resolverá igual, más tarde.
				void invoke("license_check_now").catch(() => {
					/* sin red no hay veredicto nuevo; decide la gracia offline */
				});
				scheduleReconnect(RETRY_RECHAZADO_MS);
			} else {
				marcar("reintentando", res.detalle);
				scheduleReconnect();
			}
			return;
		}
		const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(res.ticket)}`);
		ws = socket;

		socket.onopen = () => {
			// SYNC-17: latido con vigía, que cierra un socket medio muerto (ver `vigilarLatido`).
			latido?.parar();
			latido = vigilarLatido(socket);
		};

		socket.onmessage = async (ev) => {
			let msg: any;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
			} catch {
				return;
			}
			if (!msg || typeof msg.type !== "string") return;

			// SYNC-17: respuesta al latido. La contesta el auto-response del edge sin despertar al
			// DO (tenantHub.ts), así que llega aunque el hub esté hibernando: es justo lo que la
			// convierte en una señal fiable de "la ruta hasta la nube sigue viva".
			if (msg.type === "pong") {
				latido?.pong();
				return;
			}

			// Un Handy acaba de pedir el emparejamiento. El aviso viene vacío a propósito
			// (ver `/internal/pair-request` en el DO): sólo dice "vuelve a mirar", y quien
			// trae la solicitud —con la huella que hay que verificar— es el REST firmado que
			// hay detrás de esta query. Sustituye al sondeo cada 5 s del panel.
			if (msg.type === "pair_request") {
				void queryClient.invalidateQueries({ queryKey: ["pairing"] });
				return;
			}

			if (msg.type === "challenge") {
				try {
					const { ts, sigB64 } = await firmarHello(lic.tenantId, deviceId, String(msg.nonceB64 ?? ""));
					if (!cancelled && socket.readyState === WebSocket.OPEN) {
						socket.send(
							JSON.stringify({
								type: "helloSigned",
								ts,
								nonceB64: msg.nonceB64,
								sigB64,
								recovering: reconciliacionPendiente,
							}),
						);
					}
				} catch (e) {
					console.warn("WS hello: firma falló:", e);
				}
				return;
			}

			if (msg.type === "hello_ok") {
				// Autenticados: ponerse al día (nube→Main), drenar el outbox (Main→nube) y
				// subir a R2 las imágenes pendientes (canal aparte del outbox SQL).
				authed = true;
				marcar("conectado");
				esperas.reiniciar(); // SYNC-09: conexión sana → vuelve a la espera corta
				if (reconciliacionPendiente) {
					if (recoveryRunning) return;
					// Bloqueada: la reconciliación agotó sus intentos y ahora hace falta una decisión
					// (reintentar, otra copia, la nube). Hasta que llegue, no se toca nada.
					if (useEstadoSync.getState().faseRecuperacion === "bloqueada") {
						recuperacionBloqueada = true;
						// Se cierra en vez de quedarse conectada sin hacer nada: así el `pulso` de
						// "reintentar" encuentra el socket caído y abre uno limpio, y las Handy ven
						// `main_offline` (que es la verdad) en vez de una Main presente y muda.
						try {
							socket.close();
						} catch {
							/* noop */
						}
						return;
					}
					recoveryRunning = true;
					let recoveryQueueReleased = false;
					const phaseToStore: Record<RecoveryPhase, "descargando" | "subiendo" | "verificando"> = {
						downloading: "descargando",
						uploading: "subiendo",
						verifying: "verificando",
					};
					void reconcileRestoredDatabase({
						catchUp: () => catchUpThenLive(true),
						drainOutbox: async () => {
							if (!recoveryQueueReleased) {
								// Tras restaurar una copia no sabemos si una marca "encolada" sigue
								// correspondiendo a trabajo vivo del DO. Se ofrece otra vez una sola vez;
								// `Op_Id` hace que el reenvío sea idempotente.
								await invoke("sync_liberar_encoladas", { antiguedadMs: 0 });
								recoveryQueueReleased = true;
							}
							await drainOutbox(socket, true);
						},
						health: () => invoke("sync_health"),
						complete: async (highWater) => {
							await invoke("recovery_complete", { cloudHighWater: highWater });
							if (socket.readyState === WebSocket.OPEN) {
								socket.send(JSON.stringify({ type: "recovery_ready" }));
							}
						},
						wait: () => new Promise((resolve) => setTimeout(resolve, 1000)),
						onPhase: (phase) =>
							useEstadoSync.getState().marcarFaseRecuperacion(phaseToStore[phase]),
					})
						.then(() => useEstadoSync.getState().finalizarRecuperacion())
						.catch((e) => {
							const message = toAppError(e).message;
							useEstadoSync.getState().marcarFalloRecuperacion(message);
							captureException(e, { fase: "recovery_reconciliation" });
							// Tras varios ciclos seguidos fallidos la causa ya no es la red: se deja de
							// reintentar y la pantalla vuelve a ofrecer las alternativas.
							if (useEstadoSync.getState().faseRecuperacion === "bloqueada") {
								recuperacionBloqueada = true;
							}
							// Una conexión nueva rehace el ciclo completo. La marca persistente sigue puesta.
							try {
								socket.close();
							} catch {
								/* noop */
							}
						})
						.finally(() => {
							recoveryRunning = false;
						});
					return;
				}
				void catchUpThenLive();
				void subirLoPendiente(socket);
				// El drenado a R2 estuvo dos meses fallando en silencio (device-proof) y sólo se
				// vio porque alguien miró la consola: las fotos no llegaban a las Handy y nada
				// lo decía. Un fallo aquí se reporta.
				void invoke<string>("images_drain_pending")
					.then((r) => {
						if (!r || r === "vacio" || r === "sin_modo") return;
						console.log("[images_drain/hello_ok]", r);
						if (r.includes("error=")) {
							captureException(new Error("images_drain_con_errores"), { resultado: r });
						}
					})
					.catch((e) => {
						console.error("[images_drain/hello_ok] error:", e);
						captureException(e, { fase: "images_drain_pending" });
					});
				// Solo el outbox: es lo que pertenece a esta conexión. La subida de imágenes a R2
				// va por HTTP y no necesita el socket, así que su red de seguridad periódica es
				// el job `imagenes` (jobs/registro.rs); aquí se queda el intento del `hello_ok`,
				// que es un evento útil ("acabamos de recuperar conectividad"), no un poll.
				if (drainTimer) clearInterval(drainTimer);
				drainTimer = setInterval(() => {
					void drainOutbox(socket);
				}, DRAIN_INTERVAL_MS);
				return;
			}

			if (msg.type === "bulk_ack") {
				if (ackVolcado) {
					ackVolcado(Boolean(msg.ok), msg.ok ? undefined : String(msg.error ?? "unknown"));
				}
				return;
			}

			if (msg.type === "apply_ack") {
				const opId = String(msg.opId ?? msg.op_id ?? "");
				// SYNC-18: la nube puede contestar "la he encolado" en vez de "la he aplicado":
				// pasa cuando ya había atraso por delante y esta operación se pone a la cola para
				// no adelantarlo. No es un envío confirmado todavía.
				if (msg.ok && msg.encolada) {
					void invoke("sync_outbox_mark_encolada", { opIds: [opId] }).catch((e) =>
						console.warn("sync_outbox_mark_encolada falló:", e),
					);
					const cbEnc = acks.get(opId);
					if (cbEnc) cbEnc({ ok: true, seq: 0, encolada: true });
					return;
				}
				const cb = acks.get(opId);
				if (cb)
					cb({
						ok: Boolean(msg.ok),
						error: msg.ok ? undefined : String(msg.error ?? "unknown"),
						seq: Number(msg.seq ?? 0),
						encolada: false,
						permanente: Boolean(msg.permanente),
						// Un worker anterior a REV-11 no manda este campo: se cuenta como antes,
						// que es el lado seguro (de más, nunca de menos).
						transitorio: Boolean(msg.transitorio),
					});
				return;
			}

			// REV-04: la nube ha apartado operaciones de su cola. No es un reintento pendiente: es una
			// divergencia. Se marcan como apartadas aquí —lo que pone su fila en cuarentena y encola
			// la reparación por ESTADO de SYNC-22, que es lo único que repara el dato— y se acusa,
			// para que la nube deje de guardarlas. Va con `permanente: true` porque el DO ya agotó
			// sus intentos: reintentar la sentencia daría el mismo rechazo.
			if (msg.type === "cola_apartada") {
				const ops = Array.isArray(msg.ops) ? msg.ops : [];
				if (!ops.length) return;
				void (async () => {
					const acusadas: string[] = [];
					for (const o of ops) {
						const opId = String(o?.opId ?? o?.op_id ?? "");
						if (!opId) continue;
						// Sólo se acusa lo que se ha llegado a anotar: si esto falla, la nube lo
						// volverá a ofrecer en la conexión siguiente, que es justo lo que queremos.
						const fallo = await anotarFalloDeSubida(
							opId,
							String(o?.error ?? "la nube apartó la operación de su cola"),
							true,
							"cola_de_la_nube",
						);
						if (fallo) acusadas.push(opId);
					}
					if (acusadas.length && socket.readyState === WebSocket.OPEN) {
						socket.send(
							JSON.stringify({ type: "cola_apartada_ack", opIds: acusadas }),
						);
					}
				})();
				return;
			}

			if (msg.type === "cola_apartada_ack_ok") return;

			if (msg.type === "change") {
				const ch = toChange(msg);
				if (!ch) return;
				if (caughtUp) void enqueue([ch]);
				else buffer.push(ch);
				return;
			}
		};

		socket.onclose = () => {
			// Si ya se soltó —se reconectó sin esperarle, o se detuvo—, en su sitio puede haber otro.
			if (ws !== socket) return;
			soltarSocket();
			if (recuperacionBloqueada) {
				marcar("pausada", "Recuperación detenida: hace falta decidir cómo continuar");
				return;
			}
			marcar("reintentando", "Se perdió la conexión con la nube");
			scheduleReconnect();
		};

		socket.onerror = () => {
			try {
				socket.close();
			} catch {
				/* noop */
			}
		};
	}

	void open();

	// Drenado inmediato dirigido por evento: Rust emite `outbox:pending` al confirmar cada
	// escritura local. Drenamos al instante (sin esperar al poll de seguridad). `drainOutbox`
	// ya es no-op si no hay socket abierto/autenticado o si ya hay un drenado en curso.
	void listen("outbox:pending", () => {
		if (!cancelled && ws) void drainOutbox(ws);
	}).then((un) => {
		if (cancelled) un();
		else unlistenOutbox = un;
	});

	return {
		reconectarSiHaceFalta: reconnectNowIfNeeded,
		detener: () => {
			cancelled = true;
			if (unlistenOutbox) unlistenOutbox();
			if (retryTimer) clearTimeout(retryTimer);
			if (ws) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
			}
			soltarSocket();
		},
	};
}
