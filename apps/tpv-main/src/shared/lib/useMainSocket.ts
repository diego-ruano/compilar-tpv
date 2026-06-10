// src/shared/lib/useMainSocket.ts
//
// Mantiene el WebSocket de la Main con el worker cuando el modo de funcionamiento es "online"
// (y el dispositivo es la Main / tpv). Conectar + responder al challenge firmado registra el
// dispositivo como `tpv` en el TenantHub, lo que habilita las escrituras de la Handy (deja de
// devolver `main_offline`). En "offline" cierra el socket.
//
// Handshake (lo define el worker en durableObjects/tenantHub.ts):
//   1. El cliente abre  wss://.../ws?token=<jwt-licencia>
//   2. El DO responde   { type: "challenge", nonceB64 }
//   3. El cliente firma `${ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${nonceB64}` (ed25519, vía
//      el comando device_sign_b64) y envía { type: "helloSigned", ts, nonceB64, sigB64 }
//   4. El DO responde   { type: "hello_ok", authed: true } → la Main cuenta como conectada.

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useConnectionMode } from "../stores/useConnectionMode";
import { useMode } from "../stores/useMode";

const WS_URL = "wss://tpv-api.altarialights.workers.dev/ws";
const RECONNECT_MS = 3000;
const PING_MS = 30000;

async function loadLicense(): Promise<{ token: string; tenantId: string } | null> {
	try {
		const st = (await invoke<any>("license_read_state_for_ui")) as any;
		const token = String(st?.token ?? "");
		const tenantId = String(st?.tenant_id ?? st?.tenantId ?? "");
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
	const connMode = useConnectionMode((s) => s.mode);
	const deviceMode = useMode((s) => s.mode);

	useEffect(() => {
		// Solo la Main en modo online abre el socket. Cualquier otro caso: no hacer nada
		// (el cleanup del render anterior ya habrá cerrado lo que hubiera).
		if (deviceMode !== "tpv" || connMode !== "online") return;

		let cancelled = false;
		let ws: WebSocket | null = null;
		let retryTimer: number | null = null;
		let pingTimer: number | null = null;

		const scheduleReconnect = () => {
			if (cancelled || retryTimer) return;
			retryTimer = window.setTimeout(() => {
				retryTimer = null;
				void open();
			}, RECONNECT_MS);
		};

		async function open() {
			if (cancelled) return;

			const lic = await loadLicense();
			const deviceId = await loadDeviceId();
			if (cancelled || !lic || !deviceId) {
				scheduleReconnect();
				return;
			}

			const socket = new WebSocket(
				`${WS_URL}?token=${encodeURIComponent(lic.token)}`,
			);
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
				}
				// hello_ok / main_status / presence / apply_*: informativos por ahora.
				// (El relay de escrituras a la BD local es la fase siguiente.)
			};

			socket.onclose = () => {
				if (pingTimer) {
					clearInterval(pingTimer);
					pingTimer = null;
				}
				if (ws === socket) ws = null;
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
		};
	}, [deviceMode, connMode]);
}
