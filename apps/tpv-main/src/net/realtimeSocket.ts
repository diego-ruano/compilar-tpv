// src/net/realtimeSocket.ts
import { invoke } from "@tauri-apps/api/core";
import { useMode } from "../zustand/useMode";
import { useNet } from "../zustand/useNet";
import {
	handleCloudSyncWebSocketMessage,
	scheduleCloudSync,
} from "./cloudSync";

const API_BASE = "https://tpv-server.altarialights.workers.dev";
const WS_BASE = API_BASE.replace(/^http/i, "ws");

type DeviceRole = "tpv" | "handy" | "unknown";

type ApiAuthHeaders = {
	token?: string;
	authorization?: string;
	deviceTs?: number;
	deviceSig?: string;
	xDeviceTs?: string;
	xDeviceSig?: string;
	device_ts?: number;
	device_sig?: string;
};

type ConnectedMsg = {
	type: "connected";
	tenantId: string;
	deviceId: string;
	role: DeviceRole;
	auth: "required";
};

type ChallengeMsg = {
	type: "challenge";
	nonceB64: string;
	expiresAtMs: number;
};

type HelloOkMsg = {
	type: "hello_ok";
	role: DeviceRole;
	authed: true;
};

type RealtimeSocketOptions = {
	debug?: boolean;
	pingMs?: number;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
};

type RealtimeStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "authenticated"
	| "closed"
	| "error";

type RealtimeState = {
	status: RealtimeStatus;
	tenantId: string | null;
	deviceId: string | null;
	role: DeviceRole;
	lastError: string | null;
};

let options: Required<RealtimeSocketOptions> = {
	debug: false,
	pingMs: 25_000,
	reconnectBaseMs: 1_000,
	reconnectMaxMs: 30_000,
};

let initialized = false;
let manuallyStopped = true;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

let reconnectAttempt = 0;
let unsubscribers: Array<() => void> = [];

let state: RealtimeState = {
	status: "idle",
	tenantId: null,
	deviceId: null,
	role: "unknown",
	lastError: null,
};

const listeners = new Set<(msg: any) => void>();

function log(...args: any[]) {
	if (!options.debug) return;
	console.log("[realtimeSocket]", ...args);
}

function setState(patch: Partial<RealtimeState>) {
	state = {
		...state,
		...patch,
	};
}

export function getRealtimeSocketState(): RealtimeState {
	return { ...state };
}

export function onRealtimeMessage(fn: (msg: any) => void): () => void {
	listeners.add(fn);

	return () => {
		listeners.delete(fn);
	};
}

function emitMessage(msg: any) {
	for (const fn of listeners) {
		try {
			fn(msg);
		} catch {
			// noop
		}
	}
}

function clearReconnectTimer() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

function clearPingTimer() {
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
}

function parseBearer(raw: string | undefined | null): string {
	const h = String(raw || "").trim();
	const m = h.match(/^Bearer\s+(.+)$/i);
	return m?.[1]?.trim() || "";
}

function finiteNumberOr(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function normalizeErrorMessage(err: unknown): string {
	return String((err as any)?.message ?? err ?? "unknown_error");
}

function normalizeAuthHeaders(raw: ApiAuthHeaders): {
	token: string;
	deviceTs: number;
	deviceSig: string;
} {
	const token =
		String(raw?.token ?? "").trim() || parseBearer(raw?.authorization);

	const deviceTs = finiteNumberOr(
		raw?.deviceTs ?? raw?.device_ts ?? raw?.xDeviceTs,
		0,
	);

	const deviceSig = String(
		raw?.deviceSig ?? raw?.device_sig ?? raw?.xDeviceSig ?? "",
	).trim();

	if (!token) {
		throw new Error("missing_ws_token");
	}

	if (!deviceTs) {
		throw new Error("missing_device_ts");
	}

	if (!deviceSig) {
		throw new Error("missing_device_sig");
	}

	return {
		token,
		deviceTs,
		deviceSig,
	};
}

async function getWsToken(): Promise<string> {
	const raw = await invoke<ApiAuthHeaders>("api_get_auth_headers", {
		args: {
			method: "GET",
			path: "/ws",
		},
	});

	const auth = normalizeAuthHeaders(raw);

	return auth.token;
}

async function signWsHello(payload: string): Promise<string> {
	const res = await invoke<any>("device_sign_b64", {
		args: {
			payload,
		},
	});

	const sig = String(
		res?.sigB64 ??
		res?.sig_b64 ??
		res?.signature ??
		res ??
		"",
	).trim();

	if (!sig) {
		throw new Error("missing_ws_signature");
	}

	return sig;
}

function shouldConnectNow(): boolean {
	const mode = useMode.getState().mode;
	const netStatus = useNet.getState().status;

	if (mode !== "tpv" && mode !== "handy") return false;
	if (netStatus === "offline") return false;

	return true;
}

function isSocketOpenOrConnecting() {
	return (
		ws &&
		(ws.readyState === WebSocket.OPEN ||
			ws.readyState === WebSocket.CONNECTING)
	);
}

function closeCurrentSocket(code = 1000, reason = "client_close") {
	clearPingTimer();

	if (ws) {
		try {
			ws.close(code, reason);
		} catch {
			// noop
		}
	}

	ws = null;

	setState({
		status: "closed",
		tenantId: null,
		deviceId: null,
		role: "unknown",
	});
}

function scheduleReconnect(reason: string, forcedDelayMs?: number) {
	if (manuallyStopped) return;

	if (!shouldConnectNow()) {
		log("reconnect skipped", { reason });
		return;
	}

	clearReconnectTimer();

	const delay =
		typeof forcedDelayMs === "number"
			? forcedDelayMs
			: Math.min(
				options.reconnectMaxMs,
				options.reconnectBaseMs * Math.max(1, reconnectAttempt),
			);

	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;

		connectRealtimeSocket(`reconnect:${reason}`).catch((e) => {
			const msg = normalizeErrorMessage(e);
			setState({ status: "error", lastError: msg });
			log("connect failed", msg);
			reconnectAttempt++;
			scheduleReconnect("connect_failed");
		});
	}, delay);

	log("reconnect scheduled", { reason, delay });
}

function startPing() {
	clearPingTimer();

	pingTimer = setInterval(() => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		try {
			ws.send(JSON.stringify({ type: "ping" }));
		} catch {
			// noop
		}
	}, options.pingMs);
}

async function handleChallenge(msg: ChallengeMsg) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;

	const tenantId = state.tenantId;
	const deviceId = state.deviceId;

	if (!tenantId || !deviceId) {
		throw new Error("ws_identity_not_ready");
	}

	const ts = Date.now();
	const payload = `${ts}\nWS_HELLO\n${tenantId}\n${deviceId}\n${msg.nonceB64}`;
	const sigB64 = await signWsHello(payload);

	ws.send(
		JSON.stringify({
			type: "helloSigned",
			ts,
			nonceB64: msg.nonceB64,
			sigB64,
			role: state.role,
		}),
	);
}

function handleParsedMessage(msg: any) {
	if (!msg || typeof msg !== "object") return;

	emitMessage(msg);

	if (handleCloudSyncWebSocketMessage(msg)) {
		return;
	}

	if (msg.type === "connected") {
		const m = msg as ConnectedMsg;

		setState({
			status: "connected",
			tenantId: String(m.tenantId || "") || null,
			deviceId: String(m.deviceId || "") || null,
			role: m.role || "unknown",
			lastError: null,
		});

		log("connected", {
			tenantId: state.tenantId,
			deviceId: state.deviceId,
			role: state.role,
		});

		return;
	}

	if (msg.type === "challenge") {
		handleChallenge(msg as ChallengeMsg).catch((e) => {
			const err = normalizeErrorMessage(e);
			setState({ status: "error", lastError: err });
			log("challenge failed", err);

			try {
				ws?.close(4003, "challenge_failed");
			} catch {
				// noop
			}
		});

		return;
	}

	if (msg.type === "hello_ok") {
		const m = msg as HelloOkMsg;

		setState({
			status: "authenticated",
			role: m.role || state.role,
			lastError: null,
		});

		reconnectAttempt = 0;

		log("authenticated", {
			role: state.role,
			tenantId: state.tenantId,
			deviceId: state.deviceId,
		});

		if (useMode.getState().mode === "tpv") {
			scheduleCloudSync("ws_authenticated");
		}

		return;
	}

	if (msg.type === "error") {
		const err = String(msg.error || msg.details || "ws_error");

		setState({
			status: "error",
			lastError: err,
		});

		log("server error", msg);
	}
}

async function connectRealtimeSocket(reason = "manual") {
	if (manuallyStopped) return;
	if (!shouldConnectNow()) return;
	if (isSocketOpenOrConnecting()) return;

	setState({
		status: "connecting",
		lastError: null,
	});

	const token = await getWsToken();
	const url = `${WS_BASE}/ws?token=${encodeURIComponent(token)}`;

	log("connecting", { reason });

	const nextWs = new WebSocket(url);
	ws = nextWs;

	nextWs.addEventListener("open", () => {
		log("open");
		useNet.getState().setOnline();
		startPing();
	});

	nextWs.addEventListener("message", (ev) => {
		const raw = typeof ev.data === "string" ? ev.data : "";

		let parsed: any = null;

		try {
			parsed = JSON.parse(raw);
		} catch {
			log("bad message", raw);
			return;
		}

		handleParsedMessage(parsed);
	});

	nextWs.addEventListener("close", (ev) => {
		if (ws === nextWs) {
			ws = null;
		}

		clearPingTimer();

		const wasManual = manuallyStopped;
		const code = ev.code;
		const reasonText = ev.reason || "";

		setState({
			status: "closed",
			tenantId: null,
			deviceId: null,
			role: "unknown",
			lastError: reasonText || null,
		});

		log("closed", { code, reason: reasonText });

		if (wasManual) return;

		const shouldNotReconnect =
			code === 4001 || // revoked
			code === 4003 || // auth failed
			code === 1008; // policy

		if (shouldNotReconnect) {
			setState({
				status: "error",
				lastError: reasonText || `ws_closed_${code}`,
			});
			return;
		}

		reconnectAttempt++;
		scheduleReconnect(`closed_${code}`);
	});

	nextWs.addEventListener("error", () => {
		setState({
			status: "error",
			lastError: "ws_error",
		});

		log("error");
	});
}

export function sendRealtimeEvent(name: string, payload?: any): boolean {
	const eventName = String(name || "").trim();

	if (!eventName) return false;
	if (!ws || ws.readyState !== WebSocket.OPEN) return false;
	if (state.status !== "authenticated") return false;

	try {
		ws.send(
			JSON.stringify({
				type: "event",
				name: eventName,
				payload: payload ?? null,
			}),
		);
		return true;
	} catch {
		return false;
	}
}

export function initRealtimeSocket(opts: RealtimeSocketOptions = {}) {
	options = {
		...options,
		...opts,
	};

	manuallyStopped = false;

	if (initialized) {
		scheduleReconnect("already_initialized", 0);
		return;
	}

	initialized = true;

	scheduleReconnect("init", 0);

	const modeSubscribe = (useMode as any).subscribe;
	if (typeof modeSubscribe === "function") {
		const unsub = modeSubscribe((next: any, prev: any) => {
			const mode = next?.mode;
			const prevMode = prev?.mode;

			if (mode === prevMode) return;

			closeCurrentSocket(1000, "mode_changed");

			if (mode === "tpv" || mode === "handy") {
				reconnectAttempt = 0;
				scheduleReconnect("mode_changed", 0);
			}
		});

		if (typeof unsub === "function") {
			unsubscribers.push(unsub);
		}
	}

	const netSubscribe = (useNet as any).subscribe;
	if (typeof netSubscribe === "function") {
		const unsub = netSubscribe((next: any, prev: any) => {
			const status = next?.status;
			const prevStatus = prev?.status;

			if (status === prevStatus) return;

			if (status === "offline") {
				closeCurrentSocket(1000, "offline");
				return;
			}

			if (status === "online") {
				reconnectAttempt = 0;
				scheduleReconnect("net_online", 0);
			}
		});

		if (typeof unsub === "function") {
			unsubscribers.push(unsub);
		}
	}
}

export function stopRealtimeSocket() {
	manuallyStopped = true;
	initialized = false;
	reconnectAttempt = 0;

	clearReconnectTimer();
	clearPingTimer();
	closeCurrentSocket(1000, "stop");

	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch {
			// noop
		}
	}

	unsubscribers = [];

	setState({
		status: "idle",
		tenantId: null,
		deviceId: null,
		role: "unknown",
		lastError: null,
	});
}

export function restartRealtimeSocket(reason = "restart") {
	closeCurrentSocket(1000, reason);
	reconnectAttempt = 0;
	scheduleReconnect(reason, 0);
}