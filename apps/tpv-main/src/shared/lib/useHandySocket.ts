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

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useMode } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { useMainPresence } from "../stores/useMainPresence";
import { cloudPost, CLOUD_WS_URL as WS_URL } from "./cloudApi";
import { queryClient } from "./queryClient";
import { affectedComandas, affectedFeatureKeys, type RawStatement } from "./syncStatements";

// SYNC-09: backoff exponencial con tope + jitter (se resetea al autenticarse).
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const PING_MS = 30000;

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

	useEffect(() => {
		if (deviceMode !== "handy") return;

		let cancelled = false;
		let ws: WebSocket | null = null;
		let retryTimer: number | null = null;
		let pingTimer: number | null = null;

		// SYNC-09: retardo de reconexión con backoff exponencial (se resetea a base al autenticarse).
		let reconnectDelay = RECONNECT_BASE_MS;
		const scheduleReconnect = () => {
			if (cancelled || retryTimer) return;
			const delay = Math.min(reconnectDelay, RECONNECT_MAX_MS) + Math.random() * 1000;
			reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				void open();
			}, delay);
		};

		async function open() {
			if (cancelled) return;

			const auth = await loadAuth();
			const deviceId = await loadDeviceId();
			if (cancelled || !auth || !deviceId) {
				// Aún sin emparejar (no hay token) o sin identidad: reintentar más tarde.
				scheduleReconnect();
				return;
			}

			// SYNC-15: el WS se abre SOLO con un ticket efímero de un solo uso (nunca el token en la
			// URL). Si no lo obtenemos, reintentamos más tarde.
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
				// Handy se bloquea por completo (ver useMainPresence + AppBoot).
				if (msg.type === "main_status") {
					reconnectDelay = RECONNECT_BASE_MS; // SYNC-09: autenticados → resetea el backoff
						useMainPresence.getState().setMainOnline(Boolean(msg.online));
					return;
				}
				if (msg.type === "main_online") {
					useMainPresence.getState().setMainOnline(true);
					return;
				}
				if (msg.type === "main_offline") {
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
							queryClient.invalidateQueries();
						} else {
							for (const k of featureKeys)
								queryClient.invalidateQueries({ queryKey: [k] });
						}
						useSyncSignal.getState().bump(affectedComandas(statements));
					}
					return;
				}
			};

			socket.onclose = () => {
				if (pingTimer) {
					clearInterval(pingTimer);
					pingTimer = null;
				}
				if (ws === socket) ws = null;
				// Sin WS no podemos confirmar que haya Main: fail-closed (bloquea hasta reconectar
				// y recibir de nuevo `main_status`).
				useMainPresence.getState().setMainOnline(null);
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

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (pingTimer) clearInterval(pingTimer);
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
	}, [deviceMode]);
}
