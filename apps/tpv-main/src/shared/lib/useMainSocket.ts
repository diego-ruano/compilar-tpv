// src/shared/lib/useMainSocket.ts
//
// Mantiene el WebSocket de la Main con el worker cuando el modo es "online" (y el dispositivo
// es la Main / tpv), y APLICA en la BD local los cambios que llegan de la nube (Opción 3:
// sentencias ya resueltas). Conectar + responder al challenge firmado registra el dispositivo
// como `tpv` en el TenantHub (habilita las escrituras de la Handy). En "offline" cierra.
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

import { useConnectionMode } from "../stores/useConnectionMode";
import { useMode } from "../stores/useMode";
import { useSyncSignal } from "../stores/useSyncSignal";
import { cloudPost } from "./cloudApi";
import { queryClient } from "./queryClient";
import { affectedComandas, type RawStatement } from "./syncStatements";

const WS_URL = "wss://tpv-api.altarialights.workers.dev/ws";
const RECONNECT_MS = 3000;
const PING_MS = 30000;
const OUTBOX_BATCH = 50;
const ACK_TIMEOUT_MS = 10000;
const DRAIN_INTERVAL_MS = 4000;

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
		if (deviceMode !== "tpv" || connMode !== "online") return;

		let cancelled = false;
		let ws: WebSocket | null = null;
		let retryTimer: number | null = null;
		let pingTimer: number | null = null;

		// Estado de aplicación (compartido entre reconexiones dentro de este efecto).
		let caughtUp = false;
		let buffer: ChangeArg[] = [];
		let chain: Promise<void> = Promise.resolve();

		// Estado del drenado del outbox (Main → nube).
		let authed = false;
		let draining = false;
		let drainTimer: number | null = null;
		const acks = new Map<string, (ok: boolean) => void>();

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
						queryClient.invalidateQueries();
						useSyncSignal.getState().bump(affectedComandas(statements));
					}
				} catch (e) {
					console.warn("sync_apply_changes falló:", e);
				}
			});
		}

		// Envía una operación del outbox por el WS (mensaje `apply`) y espera su `apply_ack`.
		function sendApply(socket: WebSocket, entry: OutboxEntry): Promise<boolean> {
			return new Promise<boolean>((resolve) => {
				if (socket.readyState !== WebSocket.OPEN) {
					resolve(false);
					return;
				}
				const timer = window.setTimeout(() => {
					acks.delete(entry.op_id);
					resolve(false);
				}, ACK_TIMEOUT_MS);

				acks.set(entry.op_id, (ok) => {
					window.clearTimeout(timer);
					acks.delete(entry.op_id);
					resolve(ok);
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

					let progressed = false;
					for (const entry of pending) {
						if (cancelled || socket.readyState !== WebSocket.OPEN) break;
						const ok = await sendApply(socket, entry);
						if (!ok) break;
						try {
							await invoke("sync_outbox_mark_sent", { op_id: entry.op_id });
							progressed = true;
						} catch (e) {
							console.warn("sync_outbox_mark_sent falló:", e);
							break;
						}
					}
					if (!progressed) break;
				}
			} catch (e) {
				console.warn("drenado del outbox falló:", e);
			} finally {
				draining = false;
			}
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

				for (let i = 0; i < 2000 && !cancelled; i++) {
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
			} catch (e) {
				console.warn("catch-up de sync falló:", e);
			} finally {
				// Aplica (en orden) lo recibido en vivo durante el catch-up y abre el flujo vivo.
				const pending = buffer.splice(0).sort((a, b) => a.seq - b.seq);
				caughtUp = true;
				enqueue(pending);
			}
		}

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
					return;
				}

				if (msg.type === "hello_ok") {
					// Autenticados: ponerse al día (nube→Main) y drenar el outbox (Main→nube).
					authed = true;
					void catchUpThenLive();
					void drainOutbox(socket);
					if (drainTimer) clearInterval(drainTimer);
					drainTimer = window.setInterval(() => {
						void drainOutbox(socket);
					}, DRAIN_INTERVAL_MS);
					return;
				}

				if (msg.type === "apply_ack") {
					const opId = String(msg.opId ?? msg.op_id ?? "");
					const cb = acks.get(opId);
					if (cb) cb(Boolean(msg.ok));
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
			authed = false;
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
	}, [deviceMode, connMode]);
}
