// src/shared/lib/useMainSocket.ts
//
// Mantiene el WebSocket de la Main con el worker y APLICA en la BD local los cambios que llegan
// de la nube (Opción 3: sentencias ya resueltas). Conectar + responder al challenge firmado
// registra el dispositivo como `tpv` en el TenantHub (habilita las escrituras de la Handy).
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

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { LicenseLocalState } from "@tpv/contracts";
import { toAppError } from "@tpv/client";

import { useEstadoSync } from "../stores/useEstadoSync";
import { useMode } from "../stores/useMode";
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

// SYNC-09: backoff exponencial con tope + jitter. Empieza en 3 s y sube hasta 30 s ante cortes
// prolongados (worker caído/sin red), en vez de martillear cada 3 s. Se resetea al autenticarse.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const PING_MS = 30000;
// SYNC-17: margen sin `pong` antes de dar el socket por muerto. Un TCP medio-abierto (la ruta se
// cae sin FIN: cambio de red, NAT que expira, suspensión del equipo) NO dispara `onclose`, así que
// sin este vigía la Main se queda con un socket que ni recibe cambios ni sube el outbox y nadie se
// entera. Dos latidos de margen: un `pong` perdido suelto no cierra nada.
const PONG_TIMEOUT_MS = PING_MS * 2 + 5000;
// SYNC-17: esperas largas para los dos casos en los que reintentar rápido no arregla nada.
// `sin_identidad` no llega ni a tocar la red (son dos `invoke` locales), pero repetirlo cada 3 s
// en un TPV recién instalado solo llena la consola; el camino rápido de verdad es el `pulso` que
// dispara AppBoot en cuanto la licencia deja pasar.
const RETRY_SIN_IDENTIDAD_MS = 60_000;
// `rechazado` lo dice el worker (licencia caducada/anulada, dispositivo desplazado). Insistir es
// pedirle lo mismo una y otra vez: se espacia y se espera al `pulso` de una licencia renovada.
const RETRY_RECHAZADO_MS = 5 * 60_000;
const OUTBOX_BATCH = 50;
const ACK_TIMEOUT_MS = 10000;
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

async function loadDeviceId(): Promise<string> {
	try {
		const r = (await invoke<any>("device_get_identity")) as any;
		return String(r?.deviceId ?? r?.device_id ?? "");
	} catch {
		return "";
	}
}

/** Resultado de pedir el ticket: hay que distinguir "no hay red" de "el worker dice que no". */
type ResultadoTicket =
	| { ok: true; ticket: string }
	| { ok: false; rechazado: boolean; detalle: string };

// SYNC-17: códigos con los que el worker nos está diciendo que este dispositivo no puede
// sincronizar. Reintentar en 3 s no cambia nada; lo que lo cambia es renovar la licencia (y eso
// llega por el `pulso`). Ver el re-chequeo de licencia en `/v1/ws/ticket` (ws.routes.ts).
const CODIGOS_RECHAZO = new Set(["license_expired", "license_not_found", "device_revoked"]);

// SYNC-15: canjea el token por un ticket efímero de un solo uso para NO exponer el JWT en la URL
// del WebSocket. Si falla NO abrimos el WS (ya no existe respaldo `?token=`: el token nunca viaja
// por la URL) y reintentamos más tarde, con la espera que corresponda al motivo.
async function loadWsTicket(mode: "tpv" | "handy"): Promise<ResultadoTicket> {
	try {
		const r = (await cloudPost<any>(mode, "/v1/ws/ticket", {})) as any;
		const t = String(r?.ticket ?? "");
		if (!t) return { ok: false, rechazado: false, detalle: "respuesta sin ticket" };
		return { ok: true, ticket: t };
	} catch (e) {
		const err = toAppError(e);
		return {
			ok: false,
			rechazado: CODIGOS_RECHAZO.has(err.code),
			detalle: err.message || err.code,
		};
	}
}

async function signWsHello(
	ts: number,
	tenantId: string,
	deviceId: string,
	nonceB64: string,
): Promise<string> {
	const payload = `${ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${nonceB64}`;
	const r = (await invoke<any>("device_sign_b64", { args: { payload } })) as any;
	return String(r?.sigB64 ?? r?.sig_b64 ?? "");
}

export function useMainSocket() {
	const preferencia = useEstadoSync((s) => s.preferencia);
	const hidratada = useEstadoSync((s) => s.hidratada);
	const deviceMode = useMode((s) => s.mode);

	useEffect(() => {
		if (deviceMode !== "tpv") return;
		// Esperamos a leer la palanca de AppData: si está en `off`, arrancar y cerrar acto seguido
		// dejaría un parpadeo de "conectando" y una conexión inútil.
		if (!hidratada) return;

		const marcar = useEstadoSync.getState().marcar;

		if (preferencia === "off") {
			marcar("pausada", "Sincronización desactivada en este dispositivo");
			return;
		}

		let cancelled = false;
		let ws: WebSocket | null = null;
		let retryTimer: number | null = null;
		let pingTimer: number | null = null;
		let unlistenOutbox: (() => void) | null = null;
		// Evita dos `open()` concurrentes: ahora la reconexión también la disparan eventos
		// (`online`/`focus`/`visibilitychange`), que pueden llegar a la vez.
		let opening = false;
		// SYNC-17: último `pong` recibido (el DO lo contesta en el edge, sin despertarse).
		let lastPongAt = 0;

		// Estado de aplicación (compartido entre reconexiones dentro de este efecto).
		let caughtUp = false;
		let buffer: ChangeArg[] = [];
		let chain: Promise<void> = Promise.resolve();

		// Estado del drenado del outbox (Main → nube).
		let authed = false;
		let draining = false;
		let drainTimer: number | null = null;
		const acks = new Map<
			string,
			(ok: boolean, error?: string, seq?: number, encolada?: boolean) => void
		>();
		// SYNC-18: sólo hay un volcado en curso a la vez (el bucle es secuencial), así que basta un
		// hueco en vez de un mapa.
		let ackVolcado: ((ok: boolean, error?: string) => void) | null = null;

		// Aplica de forma serializada (FIFO) para no solapar transacciones en la misma conexión.
		function enqueue(changes: ChangeArg[]) {
			if (!changes.length) return;
			chain = chain.then(async () => {
				if (cancelled) return;
				try {
					await invoke("sync_apply_changes", { args: { changes } });
					// Avisar al front de que los datos locales cambiaron:
					//  - React Query: invalida (solo refetchea las queries MONTADAS, es barato).
					//  - POS (mesas / venta_rápida): tick + qué comandas tocó el lote, para que
					//    recarguen el ticket solo si es la comanda abierta (no la de otro device).
					if (!cancelled) {
						const statements = changes.flatMap((c) =>
							Array.isArray(c.statements) ? c.statements : [],
						) as RawStatement[];
						// SYNC-06: invalidación selectiva por feature (fallback global si el lote toca
						// una tabla no mapeada).
						const featureKeys = affectedFeatureKeys(statements);
						if (featureKeys === null) {
							queryClient.invalidateQueries();
						} else {
							for (const k of featureKeys)
								queryClient.invalidateQueries({ queryKey: [k] });
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
				} catch (e) {
					console.warn("sync_apply_changes falló:", e);
				}
			});
		}

		// Envía una operación del outbox por el WS (mensaje `apply`) y espera su `apply_ack`.
		function sendApply(
			socket: WebSocket,
			entry: OutboxEntry,
		): Promise<{ ok: boolean; error?: string; seq?: number; encolada?: boolean }> {
			return new Promise<{
				ok: boolean;
				error?: string;
				seq?: number;
				encolada?: boolean;
			}>((resolve) => {
				if (socket.readyState !== WebSocket.OPEN) {
					resolve({ ok: false, error: "socket_not_open" });
					return;
				}
				const timer = window.setTimeout(() => {
					acks.delete(entry.op_id);
					resolve({ ok: false, error: "ack_timeout" });
				}, ACK_TIMEOUT_MS);

				acks.set(entry.op_id, (ok, error, seq, encolada) => {
					window.clearTimeout(timer);
					acks.delete(entry.op_id);
					resolve({ ok, error, seq, encolada });
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
				const timer = window.setTimeout(() => {
					ackVolcado = null;
					resolve({ ok: false, error: "bulk_ack_timeout" });
				}, VOLCADO_ACK_TIMEOUT_MS);

				ackVolcado = (ok, error) => {
					window.clearTimeout(timer);
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

		// Drena el outbox local en orden: por cada op pendiente, la envía y, si la nube confirma
		// (apply_ack ok), la marca como enviada. Si una falla/expira, para y reintenta más tarde.
		async function drainOutbox(socket: WebSocket) {
			if (draining || !authed || socket.readyState !== WebSocket.OPEN) return;
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
						const { ok, error, seq, encolada } = await sendApply(socket, entry);
						if (!ok) {
							console.warn(`[outbox] apply_ack FALLÓ op=${entry.op_id}:`, error ?? "(sin error)");
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
				await volcarOutbox(socket);
				return;
			}
			await drainOutbox(socket);
		}

		async function catchUpThenLive() {
			caughtUp = false;
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
					if (!items.length) break;
					enqueue(items.map(toChange).filter(Boolean) as ChangeArg[]);
					const next = Number(resp?.nextSince ?? since);
					if (next <= since) break;
					since = next;
				}
				// SYNC-13: si agotamos el tope de páginas, el catch-up no terminó en este ciclo
				// (Main mucho tiempo offline o Sync_Changes enorme). Reanuda al reconectar, pero lo
				// hacemos VISIBLE para no cortar la convergencia en silencio.
				if (page >= CATCHUP_MAX_PAGES && !cancelled) {
					captureException(new Error("sync_catchup_cap_reached"), {
						pages: page,
						lastSince: since,
					});
				}
			} catch (e) {
				console.warn("catch-up de sync falló:", e);
			} finally {
				// Aplica (en orden) lo recibido en vivo durante el catch-up y abre el flujo vivo.
				const pending = buffer.splice(0).sort((a, b) => a.seq - b.seq);
				caughtUp = true;
				enqueue(pending);
			}
		}

		// SYNC-09: retardo de reconexión con backoff exponencial (se resetea a base en `hello_ok`).
		let reconnectDelay = RECONNECT_BASE_MS;
		/**
		 * Programa el siguiente intento. `esperaFija` salta el backoff para los motivos que no se
		 * arreglan reintentando deprisa (sin identidad, rechazo del worker).
		 */
		const scheduleReconnect = (esperaFija?: number) => {
			if (cancelled || retryTimer) return;
			let delay: number;
			if (esperaFija != null) {
				delay = esperaFija + Math.random() * 1000;
			} else {
				delay = Math.min(reconnectDelay, RECONNECT_MAX_MS) + Math.random() * 1000;
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
			}
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				void open();
			}, delay);
		};

		// SYNC-17: reconexión inmediata cuando vuelve la red / la app recupera el foco, SOLO si no
		// estamos ya sanos. Sin esto, un equipo que despierta de suspensión se queda esperando a que
		// venza un backoff que puede ir por 30 s, con el socket ya muerto. La Handy ya lo hacía.
		const reconnectNowIfNeeded = (forzar = false) => {
			if (cancelled || opening) return;
			if (ws && ws.readyState === WebSocket.CONNECTING) return;
			// Sano = socket abierto Y autenticado (un WS abierto sin `hello_ok` no sirve de nada).
			if (ws?.readyState === WebSocket.OPEN && authed) return;
			// Un rechazo del worker no lo arregla volver a la ventana: sin esto, cada alt-tab
			// dispararía otra petición de ticket con la misma licencia bloqueada. Solo el `pulso`
			// (licencia renovada) tiene derecho a saltarse la espera larga.
			if (!forzar && useEstadoSync.getState().estado === "rechazado") return;

			reconnectDelay = RECONNECT_BASE_MS;
			if (retryTimer) {
				window.clearTimeout(retryTimer);
				retryTimer = null;
			}
			// Un WS "abierto" pero sin autenticar puede estar medio-muerto: cerrar para reabrir limpio.
			if (ws && ws.readyState === WebSocket.OPEN) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
			}
			ws = null;
			void open();
		};

		// Envoltorios con nombre: los listeners del DOM reciben el Event como primer argumento, y
		// pasárselo tal cual a `reconnectNowIfNeeded` lo leería como `forzar = true`.
		const alVolverLaRed = () => reconnectNowIfNeeded(false);
		const onVisibility = () => {
			if (document.visibilityState === "visible") reconnectNowIfNeeded(false);
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
			const deviceId = await loadDeviceId();
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
			const res = await loadWsTicket("tpv");
			if (cancelled) return;
			if (!res.ok) {
				if (res.rechazado) {
					marcar("rechazado", res.detalle);
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
				// El vigía cuenta desde la apertura: si el primer `pong` no llega, también cierra.
				lastPongAt = Date.now();
				if (pingTimer) clearInterval(pingTimer);
				pingTimer = window.setInterval(() => {
					if (socket.readyState !== WebSocket.OPEN) return;
					// SYNC-17: antes de latir, comprobamos que el latido anterior tuvo respuesta. Sin
					// esto se enviaban `ping` a un socket muerto para siempre (nadie lee el `pong`).
					// Cerrar dispara `onclose` → backoff → reconexión limpia.
					if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
						console.warn("[ws] sin pong en", PONG_TIMEOUT_MS, "ms: socket muerto, cerrando");
						try {
							socket.close();
						} catch {
							/* noop */
						}
						return;
					}
					socket.send(JSON.stringify({ type: "ping" }));
				}, PING_MS);
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
					lastPongAt = Date.now();
					return;
				}

				// Un Handy acaba de pedir el emparejamiento. El aviso viene vacío a propósito
				// (ver `/internal/pair-request` en el DO): sólo dice "vuelve a mirar", y quien
				// trae la solicitud —con la huella que hay que verificar— es el REST firmado que
				// hay detrás de esta query. Sustituye al sondeo cada 5 s del panel.
				if (msg.type === "pair_request") {
					queryClient.invalidateQueries({ queryKey: ["pairing"] });
					return;
				}

				if (msg.type === "challenge") {
					try {
						const ts = Date.now();
						const sigB64 = await signWsHello(
							ts,
							lic.tenantId,
							deviceId,
							String(msg.nonceB64 ?? ""),
						);
						if (!cancelled && socket.readyState === WebSocket.OPEN) {
							socket.send(
								JSON.stringify({
									type: "helloSigned",
									ts,
									nonceB64: msg.nonceB64,
									sigB64,
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
					reconnectDelay = RECONNECT_BASE_MS; // SYNC-09: conexión sana → resetea el backoff
					void catchUpThenLive();
					void subirLoPendiente(socket);
					void invoke<string>("images_drain_pending")
						.then((r) => { if (r && r !== "vacio" && r !== "sin_modo") console.log("[images_drain/hello_ok]", r); })
						.catch((e) => console.error("[images_drain/hello_ok] error:", e));
					// Solo el outbox: es lo que pertenece a esta conexión. La subida de imágenes a R2
					// va por HTTP y no necesita el socket, así que su red de seguridad periódica es
					// el job `imagenes` (jobs/registro.rs); aquí se queda el intento del `hello_ok`,
					// que es un evento útil ("acabamos de recuperar conectividad"), no un poll.
					if (drainTimer) clearInterval(drainTimer);
					drainTimer = window.setInterval(() => {
						void drainOutbox(socket);
					}, DRAIN_INTERVAL_MS);
					return;
				}

				if (msg.type === "bulk_ack") {
					if (ackVolcado) {
						ackVolcado(
							Boolean(msg.ok),
							msg.ok ? undefined : String(msg.error ?? "unknown"),
						);
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
						if (cbEnc) cbEnc(true, undefined, 0, true);
						return;
					}
					const cb = acks.get(opId);
					if (cb)
						cb(
							Boolean(msg.ok),
							msg.ok ? undefined : String(msg.error ?? "unknown"),
							Number(msg.seq ?? 0),
						);
					return;
				}

				if (msg.type === "change") {
					const ch = toChange(msg);
					if (!ch) return;
					if (caughtUp) enqueue([ch]);
					else buffer.push(ch);
					return;
				}
			};

			socket.onclose = () => {
				if (pingTimer) {
					clearInterval(pingTimer);
					pingTimer = null;
				}
				if (drainTimer) {
					clearInterval(drainTimer);
					drainTimer = null;
				}
				// Resolver como fallo los acks pendientes para no dejar promesas colgadas.
				for (const cb of acks.values()) cb(false);
				acks.clear();
				if (ws === socket) ws = null;
				authed = false;
				// Forzamos catch-up al reconectar: lo perdido se recupera por el endpoint.
				caughtUp = false;
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

		// SYNC-17: re-disparo de la reconexión cuando vuelve la red o la ventana recupera el foco.
		// En escritorio importa igual que en móvil: al despertar de suspensión el socket está muerto
		// y el backoff puede ir por 30 s.
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", alVolverLaRed);
		window.addEventListener("focus", alVolverLaRed);

		// SYNC-17: `pulso` es "inténtalo ya". Lo sube AppBoot en cuanto el gate de licencia deja
		// pasar (activación recién hecha, licencia renovada), que es justo cuando `sin_identidad` o
		// `rechazado` dejan de ser ciertos y su espera larga sobra. Se observa por suscripción y no
		// como dependencia del efecto para no derribar un socket que ya esté sano.
		let ultimoPulso = useEstadoSync.getState().pulso;
		const unsubPulso = useEstadoSync.subscribe((s) => {
			if (s.pulso === ultimoPulso) return;
			ultimoPulso = s.pulso;
			reconnectNowIfNeeded(true);
		});

		return () => {
			cancelled = true;
			authed = false;
			unsubPulso();
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", alVolverLaRed);
			window.removeEventListener("focus", alVolverLaRed);
			if (unlistenOutbox) unlistenOutbox();
			if (retryTimer) clearTimeout(retryTimer);
			if (pingTimer) clearInterval(pingTimer);
			if (drainTimer) clearInterval(drainTimer);
			for (const cb of acks.values()) cb(false);
			acks.clear();
			if (ws) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
				ws = null;
			}
		};
	}, [deviceMode, preferencia, hidratada]);
}
