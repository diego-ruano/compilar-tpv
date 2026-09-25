// src/shared/lib/socketHandy.ts
//
// WebSocket del Handy con el worker. A diferencia de la Main (`socketMain.ts`), el Handy NO tiene BD
// local ni outbox: su fuente de datos es la nube y lee por HTTP. Por eso aquí el WebSocket sirve
// SOLO para enterarse en vivo de los cambios: al recibir un `change` (que el Durable Object difunde a
// todas las sesiones autenticadas), se invalida React Query para que las lecturas montadas se
// refresquen, y se hace `bump()` del tick para que el POS (mesas / venta-rápida, que no usan caché)
// vuelva a leer de la nube.
//
// No se aplican las sentencias del `change` (no hay SQLite local que tocar): basta refetch.
//
// Vive fuera de React por lo mismo que el de la Main: dentro de un `useEffect` sólo se podía probar
// montando el componente. El hook `useHandySocket` lo arranca y le avisa de lo que sólo sabe el
// navegador. Lo que comparte con la Main (esperas entre reintentos, latido con vigía, identidad y
// firma del saludo) está en `socketComun.ts`.
//
// Presencia de la Main (freeze): el worker nos dice si hay una Main activa (`main_status` al
// autenticarse, `main_online`/`main_offline` en vivo). Sin Main, el Handy se bloquea (AppBoot).
// También avisa (`main_volcando`) mientras la Main sube el atraso que acumuló sin conexión: la
// nube está a medio construir y el Handy espera, con otro mensaje (SYNC-18).
// Para que ese bloqueo NO parpadee en cada micro-caída del WS (muy comunes en móvil: pasar a
// segundo plano, bloqueo de pantalla, cambio de red, Doze) el cierre no bloquea de inmediato:
// hay una GRACIA (BLOCK_GRACE_MS) durante la que se conserva el último estado. Y como en móvil
// los timers se congelan en segundo plano (el backoff no dispara a tiempo → se quedaba en
// "Conectando" hasta recargar), se reconecta de inmediato al volver la app a primer plano / al
// volver la red (`visibilitychange`/`online`/`focus`), y hay un botón "Reintentar" (retryTick).
//
// REV-02: y no todo fallo es falta de red. El token de una Handy caduca (30 días), y la nube
// también puede revocarla o rechazar la licencia del negocio. Eso lo dice `pedirTicketWs` con un código del
// catálogo, y aquí se traduce a un RECHAZO (`useMainPresence.rechazo`): se deja de reintentar cada
// pocos segundos y la pantalla dice qué pasa en vez de girar bajo un "Conectando…" eterno. El
// token caducado ni llega hasta aquí —lo renueva Rust y repite la petición—; lo que llega es lo
// que renovar no arregla.

import { invoke } from "@tauri-apps/api/core";

import type { ModeStateValue } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { useMainPresence } from "../stores/useMainPresence";
import { CLOUD_WS_URL as WS_URL } from "./cloudApi";
import { queryClient } from "./queryClient";
import {
	affectedComandas,
	affectedFeatureKeys,
	tocaAjustes,
	type RawStatement,
} from "./syncStatements";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import {
	crearEsperas,
	firmarHello,
	leerIdDispositivo,
	pedirTicketWs,
	RETRY_RECHAZADO_MS,
	vigilarLatido,
} from "./socketComun";

// Gracia antes de bloquear la UI ("Conectando con la Main…") al caerse el WS. Evita que caídas
// transitorias parpadeen el bloqueo: si reconectamos y recibimos presencia (`main_status`/
// `main_online`/`main_offline`) antes de este plazo, no se llega a bloquear.
const BLOCK_GRACE_MS = 5000;

async function loadAuth(): Promise<{ token: string; tenantId: string } | null> {
	try {
		const r = (await invoke<any>("handy_get_ws_auth")) as any;
		const token = String(r?.token ?? "");
		const tenantId = String(r?.tenantId ?? r?.tenant_id ?? "");
		if (!token || !tenantId) return null;
		return { token, tenantId };
	} catch {
		return null;
	}
}

export type SocketHandy = {
	/**
	 * Reconecta ya si la conexión no está sana (socket abierto Y Main confirmada), sin esperar a que
	 * venza el backoff. Lo llama quien se entera de que conviene: vuelve la red, la app vuelve a
	 * primer plano o recupera el foco.
	 */
	reconectarSiHaceFalta: () => void;
	/** Cierra el socket, lo para todo y deja la presencia de la Main como desconocida. */
	detener: () => void;
};

/** Arranca el socket del Handy. Devuelve `null` si este dispositivo no es un Handy. */
export function iniciarSocketHandy(modo: ModeStateValue): SocketHandy | null {
	if (modo !== "handy") return null;

	let cancelled = false;
	let ws: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	// SYNC-17: el latido del socket actual, con su vigía (ver `vigilarLatido`).
	let latido: ReturnType<typeof vigilarLatido> | null = null;
	// Timer de gracia: pone mainOnline=null (bloquea) solo si NO reconectamos a tiempo.
	let blockTimer: ReturnType<typeof setTimeout> | null = null;
	// Evita dos `open()` concurrentes (p. ej. si visibility + focus disparan a la vez).
	let opening = false;

	// SYNC-09: esperas entre reintentos (vuelven a la corta al autenticarse).
	const esperas = crearEsperas();

	const clearBlockTimer = () => {
		if (blockTimer) {
			clearTimeout(blockTimer);
			blockTimer = null;
		}
	};

	// Bloqueo diferido: solo bloqueamos la UI (mainOnline=null → "Conectando") si no hemos
	// reconectado y confirmado presencia dentro de la gracia. Así una caída breve no parpadea.
	const scheduleBlock = () => {
		if (cancelled || blockTimer) return;
		blockTimer = setTimeout(() => {
			blockTimer = null;
			if (!cancelled) useMainPresence.getState().setMainOnline(null);
		}, BLOCK_GRACE_MS);
	};

	const scheduleReconnect = (espera?: number) => {
		if (cancelled || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void open();
		}, espera ?? esperas.siguiente());
	};

	/**
	 * La nube ha dicho que no. No es un corte: es una licencia que hay que renovar o un
	 * dispositivo que hay que volver a vincular, así que se cuenta tal cual (la pantalla deja de
	 * decir "Conectando…") y se espacia mucho el reintento. El botón "Reintentar" rearranca el
	 * socket entero, que es la forma manual de volver a preguntar.
	 */
	const marcarRechazo = (codigo: string, detalle: string) => {
		console.warn("[ws handy] la nube rechaza este dispositivo:", codigo, detalle);
		clearBlockTimer();
		const motivo = codigo === "device_revoked" ? "dispositivo" : "licencia";
		useMainPresence.getState().setRechazo(motivo);
		useMainPresence.getState().setMainOnline(null);
	};

	// Reconexión inmediata al volver la app a primer plano / al volver la red, SOLO si no estamos
	// ya sanos. En móvil los timers se congelan en segundo plano, así que el backoff no dispara a
	// tiempo y sin esto la Handy se quedaba clavada en "Conectando" hasta recargar.
	const reconnectNowIfNeeded = () => {
		if (cancelled || opening) return;
		// Un rechazo de la nube no lo arregla volver a primer plano: sin esto, cada vez que el
		// camarero desbloquea la tablet se pediría otro ticket con la misma licencia bloqueada.
		if (useMainPresence.getState().rechazo !== null) return;
		// Ya conectando: dejamos que termine.
		if (ws && ws.readyState === WebSocket.CONNECTING) return;
		// Ya sano (WS abierto y Main confirmada): no tocamos nada.
		const healthy =
			ws?.readyState === WebSocket.OPEN && useMainPresence.getState().mainOnline === true;
		if (healthy) return;

		esperas.reiniciar();
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		// Un WS "abierto" pero sin presencia confirmada puede estar medio-muerto (típico al
		// resumir en móvil): lo cerramos para reabrir limpio.
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.close();
			} catch {
				/* noop */
			}
		}
		// El latido del socket que se abandona se para ya: si no, su vigía seguiría corriendo hasta
		// que abriera el siguiente.
		latido?.parar();
		latido = null;
		ws = null;
		void open();
	};

	async function open() {
		if (cancelled || opening) return;
		opening = true;
		try {
			const auth = await loadAuth();
			const deviceId = await leerIdDispositivo();
			if (cancelled || !auth || !deviceId) {
				// Aún sin emparejar (no hay token) o sin identidad: reintentar más tarde.
				scheduleReconnect();
				return;
			}

			// SYNC-15: el WS se abre SOLO con un ticket efímero de un solo uso (nunca el token en
			// la URL). Si no lo obtenemos, el motivo decide cuánto esperamos —y si esperar sirve
			// de algo.
			const res = await pedirTicketWs("handy");
			if (cancelled) return;
			if (!res.ok) {
				if (res.rechazado) {
					marcarRechazo(res.codigo, res.detalle);
					scheduleReconnect(RETRY_RECHAZADO_MS);
				} else {
					scheduleReconnect();
				}
				return;
			}
			const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(res.ticket)}`);
			ws = socket;

			socket.onopen = () => {
				// SYNC-17: el latido con vigía, igual que la Main. Sin él, un TCP medio-abierto dejaba el
				// socket OPEN y la Main «confirmada» para siempre: la Handy se daba por sana, no volvía a
				// conectar ni al volver a primer plano y enseñaba datos viejos sin avisar a nadie.
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

				// SYNC-17: respuesta al latido. La contesta el edge sin despertar al DO, así que es la
				// prueba de que la ruta hasta la nube sigue viva.
				if (msg.type === "pong") {
					latido?.pong();
					return;
				}

				if (msg.type === "challenge") {
					try {
						const { ts, sigB64 } = await firmarHello(auth.tenantId, deviceId, String(msg.nonceB64 ?? ""));
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
						console.warn("WS handy hello: firma falló:", e);
					}
					return;
				}

				// Presencia de la Main: el worker nos dice si hay una Main activa. Sin Main, el
				// Handy se bloquea por completo (ver useMainPresence + AppBoot). Al recibir CUALQUIER
				// señal de presencia cancelamos la gracia: ya tenemos un estado definitivo.
				if (msg.type === "main_status") {
					esperas.reiniciar(); // SYNC-09: autenticados → vuelve a la espera corta
					clearBlockTimer();
					// Nos han dejado entrar: lo que sea que nos rechazaba está resuelto. El aviso se
					// retira solo, como el resto de avisos del producto.
					useMainPresence.getState().setRechazo(null);
					useMainPresence.getState().setMainOnline(Boolean(msg.online));
					// SYNC-18: entrar a mitad de un volcado tiene que bloquear igual; con
					// `online` a secas no nos enteraríamos.
					useMainPresence.getState().setVolcando(Boolean(msg.volcando));
					return;
				}
				// SYNC-18: la Main está subiendo su atraso (o acaba de terminar).
				if (msg.type === "main_volcando") {
					clearBlockTimer();
					useMainPresence.getState().setVolcando(Boolean(msg.volcando));
					return;
				}
				if (msg.type === "main_online") {
					clearBlockTimer();
					useMainPresence.getState().setMainOnline(true);
					return;
				}
				if (msg.type === "main_offline") {
					clearBlockTimer();
					useMainPresence.getState().setMainOnline(false);
					return;
				}

				// Cualquier cambio aplicado en la nube por otro dispositivo (típicamente la
				// Main): refrescamos. No aplicamos SQL (no hay BD local): solo refetch.
				if (msg.type === "change") {
					if (!cancelled) {
						const statements = (
							Array.isArray(msg.statements) ? msg.statements : []
						) as RawStatement[];
						// SYNC-06: invalidación selectiva por feature (fallback global si el lote
						// toca una tabla no mapeada).
						const featureKeys = affectedFeatureKeys(statements);
						if (featureKeys === null) {
							void queryClient.invalidateQueries();
						} else {
							for (const k of featureKeys) void queryClient.invalidateQueries({ queryKey: [k] });
						}
						useSyncSignal.getState().bump(affectedComandas(statements));
						// Los ajustes del negocio/ticket viven en stores que se leen al arrancar,
						// no en React Query: si los cambia la Main, hay que recargarlos aquí.
						if (tocaAjustes(statements)) {
							void useBusinessSettings.getState().init();
							void useTicketSettings.getState().init();
						}
					}
					return;
				}
			};

			socket.onclose = () => {
				// Ignora el cierre de un socket ya reemplazado por una reconexión más nueva: si no,
				// pisaría el estado de la conexión sana (carrera → "Conectando" espurio).
				if (ws !== socket) return;
				latido?.parar();
				latido = null;
				ws = null;
				// Gracia antes de bloquear: si reconectamos y confirmamos presencia antes de
				// BLOCK_GRACE_MS, no se llega a mostrar "Conectando".
				scheduleBlock();
				scheduleReconnect();
			};

			socket.onerror = () => {
				try {
					socket.close();
				} catch {
					/* noop */
				}
			};
		} finally {
			opening = false;
		}
	}

	void open();

	return {
		reconectarSiHaceFalta: reconnectNowIfNeeded,
		detener: () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			latido?.parar();
			clearBlockTimer();
			if (ws) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
				ws = null;
			}
			// Dejamos de ser Handy (o se desmonta): presencia desconocida. El rechazo se va con
			// ella, y por eso "Reintentar" —que rearranca el socket— vuelve a preguntar de verdad.
			useMainPresence.getState().setMainOnline(null);
			useMainPresence.getState().setRechazo(null);
		},
	};
}
