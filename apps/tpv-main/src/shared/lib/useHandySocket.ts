// src/shared/lib/useHandySocket.ts
//
// WebSocket del Handy con el worker. A diferencia de la Main (useMainSocket), el Handy NO
// tiene BD local ni outbox: su fuente de datos es la nube y lee por HTTP. Por eso aquí el
// WebSocket sirve SOLO para enterarse en vivo de los cambios: al recibir un `change` (que el
// Durable Object difunde a todas las sesiones autenticadas), invalidamos React Query para
// que las lecturas montadas se refresquen, y hacemos `bump()` del tick para que el POS
// (mesas / venta-rápida, que no usan caché) vuelva a leer de la nube.
//
// No aplicamos las sentencias del `change` (no hay SQLite local que tocar): basta refetch.
//
// Presencia de la Main (freeze): el worker nos dice si hay una Main activa (`main_status` al
// autenticarse, `main_online`/`main_offline` en vivo). Sin Main, el Handy se bloquea (AppBoot).
// También avisa (`main_volcando`) mientras la Main sube el atraso que acumuló sin conexión: la
// nube está a medio construir y el Handy espera, con otro mensaje (SYNC-18).
// Para que ese bloqueo NO parpadee en cada micro-caída del WS (muy comunes en móvil: pasar a
// segundo plano, bloqueo de pantalla, cambio de red, Doze) el cierre no bloquea de inmediato:
// hay una GRACIA (BLOCK_GRACE_MS) durante la que se conserva el último estado. Y como en móvil
// los timers se congelan en segundo plano (el backoff no dispara a tiempo → se quedaba en
// "Conectando" hasta recargar), reconectamos de inmediato al volver la app a primer plano / al
// volver la red (`visibilitychange`/`online`/`focus`), y hay un botón "Reintentar" (retryTick).

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useMode } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { useMainPresence } from "../stores/useMainPresence";
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

// SYNC-09: backoff exponencial con tope + jitter (se resetea al autenticarse).
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const PING_MS = 30000;
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

async function loadDeviceId(): Promise<string> {
	try {
		const r = (await invoke<any>("device_get_identity")) as any;
		return String(r?.deviceId ?? r?.device_id ?? "");
	} catch {
		return "";
	}
}

// SYNC-15: ticket efímero de un solo uso para no exponer el JWT en la URL del WebSocket. `null` si
// el endpoint falla; en ese caso NO abrimos el WS (ya no existe respaldo `?token=`: el token nunca
// viaja por la URL) y reintentamos más tarde con backoff.
async function loadWsTicket(): Promise<string | null> {
	try {
		const r = (await cloudPost<any>("handy", "/v1/ws/ticket", {})) as any;
		const t = String(r?.ticket ?? "");
		return t || null;
	} catch {
		return null;
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

export function useHandySocket() {
	const deviceMode = useMode((s) => s.mode);
	// Botón "Reintentar" (AppBoot) → bump → re-ejecuta el efecto = reconexión WS fresca (equivalente
	// a recargar la página en escritorio). Incluido en las deps del efecto de abajo.
	const retryTick = useMainPresence((s) => s.retryTick);

	useEffect(() => {
		if (deviceMode !== "handy") return;

		let cancelled = false;
		let ws: WebSocket | null = null;
		let retryTimer: number | null = null;
		let pingTimer: number | null = null;
		// Timer de gracia: pone mainOnline=null (bloquea) solo si NO reconectamos a tiempo.
		let blockTimer: number | null = null;
		// Evita dos `open()` concurrentes (p. ej. si visibility + focus disparan a la vez).
		let opening = false;

		// SYNC-09: retardo de reconexión con backoff exponencial (se resetea a base al autenticarse).
		let reconnectDelay = RECONNECT_BASE_MS;

		const clearBlockTimer = () => {
			if (blockTimer) {
				window.clearTimeout(blockTimer);
				blockTimer = null;
			}
		};

		// Bloqueo diferido: solo bloqueamos la UI (mainOnline=null → "Conectando") si no hemos
		// reconectado y confirmado presencia dentro de la gracia. Así una caída breve no parpadea.
		const scheduleBlock = () => {
			if (cancelled || blockTimer) return;
			blockTimer = window.setTimeout(() => {
				blockTimer = null;
				if (!cancelled) useMainPresence.getState().setMainOnline(null);
			}, BLOCK_GRACE_MS);
		};

		const scheduleReconnect = () => {
			if (cancelled || retryTimer) return;
			const delay = Math.min(reconnectDelay, RECONNECT_MAX_MS) + Math.random() * 1000;
			reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				void open();
			}, delay);
		};

		// Reconexión inmediata al volver la app a primer plano / al volver la red, SOLO si no estamos
		// ya sanos. En móvil los timers se congelan en segundo plano, así que el backoff no dispara a
		// tiempo y sin esto la Handy se quedaba clavada en "Conectando" hasta recargar.
		const reconnectNowIfNeeded = () => {
			if (cancelled || opening) return;
			// Ya conectando: dejamos que termine.
			if (ws && ws.readyState === WebSocket.CONNECTING) return;
			// Ya sano (WS abierto y Main confirmada): no tocamos nada.
			const healthy =
				ws?.readyState === WebSocket.OPEN &&
				useMainPresence.getState().mainOnline === true;
			if (healthy) return;

			reconnectDelay = RECONNECT_BASE_MS;
			if (retryTimer) {
				window.clearTimeout(retryTimer);
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
			ws = null;
			void open();
		};

		const onVisibility = () => {
			if (document.visibilityState === "visible") reconnectNowIfNeeded();
		};

		async function open() {
			if (cancelled || opening) return;
			opening = true;
			try {
				const auth = await loadAuth();
				const deviceId = await loadDeviceId();
				if (cancelled || !auth || !deviceId) {
					// Aún sin emparejar (no hay token) o sin identidad: reintentar más tarde.
					scheduleReconnect();
					return;
				}

				// SYNC-15: el WS se abre SOLO con un ticket efímero de un solo uso (nunca el token en
				// la URL). Si no lo obtenemos, reintentamos más tarde.
				const ticket = await loadWsTicket();
				if (cancelled) return;
				if (!ticket) {
					scheduleReconnect();
					return;
				}
				const socket = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}`);
				ws = socket;

				socket.onopen = () => {
					if (pingTimer) clearInterval(pingTimer);
					pingTimer = window.setInterval(() => {
						if (socket.readyState === WebSocket.OPEN) {
							socket.send(JSON.stringify({ type: "ping" }));
						}
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

					if (msg.type === "challenge") {
						try {
							const ts = Date.now();
							const sigB64 = await signWsHello(
								ts,
								auth.tenantId,
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
							console.warn("WS handy hello: firma falló:", e);
						}
						return;
					}

					// Presencia de la Main: el worker nos dice si hay una Main activa. Sin Main, el
					// Handy se bloquea por completo (ver useMainPresence + AppBoot). Al recibir CUALQUIER
					// señal de presencia cancelamos la gracia: ya tenemos un estado definitivo.
					if (msg.type === "main_status") {
						reconnectDelay = RECONNECT_BASE_MS; // SYNC-09: autenticados → resetea el backoff
						clearBlockTimer();
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
								for (const k of featureKeys)
									void queryClient.invalidateQueries({ queryKey: [k] });
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
					if (pingTimer) {
						clearInterval(pingTimer);
						pingTimer = null;
					}
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

		// Re-disparo de reconexión cuando la app vuelve a estar visible / vuelve la red / recupera el
		// foco. Es lo que evita quedarse en "Conectando" en móvil (donde no hay recarga).
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", reconnectNowIfNeeded);
		window.addEventListener("focus", reconnectNowIfNeeded);

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (pingTimer) clearInterval(pingTimer);
			clearBlockTimer();
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", reconnectNowIfNeeded);
			window.removeEventListener("focus", reconnectNowIfNeeded);
			if (ws) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
				ws = null;
			}
			// Dejamos de ser Handy (o se desmonta): presencia desconocida.
			useMainPresence.getState().setMainOnline(null);
		};
	}, [deviceMode, retryTick]);
}
