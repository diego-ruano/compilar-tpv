// src/net/cloudSync.ts
import { invoke } from "@tauri-apps/api/core";
import { useMode } from "../zustand/useMode";
import { useNet } from "../zustand/useNet";
import { useSync } from "../zustand/useSync";

const API_BASE = "https://tpv-server.altarialights.workers.dev";
const SYNC_PATH = "/v1/sync/changes";

const DEFAULT_LIMIT = 250;
const DEFAULT_DEBOUNCE_MS = 800;
const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_MAX_PAGES_PER_RUN = 20;
const DEFAULT_REMOTE_TIMEOUT_MS = 12_000;

type ApiAuthHeaders = {
	token?: string;
	deviceTs?: number;
	deviceSig?: string;
	device_ts?: number;
	device_sig?: string;
};

export type CloudChange = {
	idChange: number;
	opId: string;
	commandName: string;
	commandVersion: number;
	deviceId: string | null;
	payloadJson: string;
	resultJson: string | null;
	createdAtMs: number;
};

type RustCloudChange = {
	id_change: number;
	op_id: string;
	command_name: string;
	command_version: number;
	device_id: string | null;
	payload_json: string;
	result_json: string | null;
	created_at_ms: number;
};

type SyncFetchResult = {
	changes: CloudChange[];
	hasMore: boolean;
	nextAfterId: number;
};

type ApplyCloudChangesResult = {
	ok: boolean;
	applied: number;
	skipped: number;
	lastCloudChangeId: number;
	errors: string[];
};

type CloudSyncOptions = {
	limit?: number;
	debounceMs?: number;
	minIntervalMs?: number;
	maxPagesPerRun?: number;
	debug?: boolean;
};

let options: Required<CloudSyncOptions> = {
	limit: DEFAULT_LIMIT,
	debounceMs: DEFAULT_DEBOUNCE_MS,
	minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
	maxPagesPerRun: DEFAULT_MAX_PAGES_PER_RUN,
	debug: false,
};

let initialized = false;
let syncInProgress = false;
let pendingRun = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRunStartedAt = 0;
let unsubscribers: Array<() => void> = [];

function log(...args: unknown[]): void {
	if (!options.debug) return;
	console.log("[cloudSync]", ...args);
}

function clearTimer(): void {
	if (!timer) return;

	clearTimeout(timer);
	timer = null;
}

function setSyncStatus(status: "idle" | "resyncing" | "error", error?: string | null): void {
	const syncState = useSync.getState();

	if (status === "resyncing") {
		syncState.startResync();
		return;
	}

	if (status === "error") {
		syncState.failResync(error ?? "sync_error");
		return;
	}

	syncState.finishResync();
}

function markApiUnavailableOffline(): void {
	const netState = useNet.getState() as any;

	if (typeof netState.forceOffline === "function") {
		netState.forceOffline();
		return;
	}

	if (typeof netState.setOffline === "function") {
		netState.setOffline();
	}
}

function pathForSig(path: string): string {
	const p = String(path || "/");
	const q = p.indexOf("?");
	const h = p.indexOf("#");
	const cut = [q, h].filter((x) => x >= 0).sort((a, b) => a - b)[0];

	return cut == null ? p : p.slice(0, cut);
}

function normalizeErrorMessage(err: unknown): string {
	return String((err as any)?.message ?? err ?? "sync_error");
}

function isAvailabilityError(err: unknown): boolean {
	const msg = normalizeErrorMessage(err).toLowerCase();

	return (
		msg === "timeout" ||
		msg.includes("failed to fetch") ||
		msg.includes("networkerror") ||
		msg.includes("network request failed") ||
		msg.includes("fetch failed") ||
		msg.includes("econnrefused") ||
		msg.includes("connection refused") ||
		msg.includes("connection reset") ||
		msg.includes("socket hang up") ||
		msg.includes("dns") ||
		msg.includes("tls") ||
		msg.includes("http 500") ||
		msg.includes("http 502") ||
		msg.includes("http 503") ||
		msg.includes("http 504")
	);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);

		p.then((v) => {
			clearTimeout(t);
			resolve(v);
		}).catch((e) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

function safeJsonParse(raw: string): unknown {
	if (!raw.trim()) return {};

	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(`invalid_json_response:${normalizeErrorMessage(e)}`);
	}
}

function unwrapOkEnvelope(value: unknown): any {
	if (!value || typeof value !== "object") return value;

	const obj = value as Record<string, any>;

	if ("ok" in obj && !obj.ok) {
		throw new Error(String(obj.error ?? obj.message ?? "remote_ok_false"));
	}

	if ("data" in obj) return obj.data;
	if ("result" in obj) return obj.result;

	return obj;
}

function firstNonEmptyString(...values: unknown[]): string | null {
	for (const value of values) {
		if (value === null || value === undefined) continue;

		const s = String(value).trim();
		if (s) return s;
	}

	return null;
}

function finiteNumberOr(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function normalizeAuthHeaders(raw: ApiAuthHeaders): {
	token: string;
	deviceTs: number;
	deviceSig: string;
} {
	const token = String(raw?.token ?? "").trim();
	const deviceTs = finiteNumberOr(raw?.deviceTs ?? raw?.device_ts, 0);
	const deviceSig = String(raw?.deviceSig ?? raw?.device_sig ?? "").trim();

	if (!token) {
		throw new Error("missing_auth_token");
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

function normalizeChange(raw: any): CloudChange | null {
	const idChange = finiteNumberOr(
		raw?.idChange ??
		raw?.id_change ??
		raw?.ID_Change ??
		raw?.ID_CHANGE ??
		raw?.id,
		0,
	);

	const opId = String(raw?.opId ?? raw?.op_id ?? raw?.Op_Id ?? "").trim();

	const commandName = String(
		raw?.commandName ?? raw?.command_name ?? raw?.Command_Name ?? "",
	).trim();

	const payloadJson = String(
		raw?.payloadJson ?? raw?.payload_json ?? raw?.Payload_Json ?? "",
	);

	if (!(idChange > 0) || !opId || !commandName || !payloadJson) {
		return null;
	}

	return {
		idChange,
		opId,
		commandName,
		commandVersion: finiteNumberOr(
			raw?.commandVersion ?? raw?.command_version ?? raw?.Command_Version,
			1,
		),
		deviceId: firstNonEmptyString(
			raw?.deviceId,
			raw?.device_id,
			raw?.Device_Id,
		),
		payloadJson,
		resultJson: firstNonEmptyString(
			raw?.resultJson,
			raw?.result_json,
			raw?.Result_Json,
		),
		createdAtMs: finiteNumberOr(
			raw?.createdAtMs ?? raw?.created_at_ms ?? raw?.Created_At_Ms,
			0,
		),
	};
}

function normalizeFetchResult(raw: unknown, afterId: number): SyncFetchResult {
	const data = unwrapOkEnvelope(raw);

	const rawChanges = Array.isArray(data?.changes)
		? data.changes
		: Array.isArray(data?.items)
			? data.items
			: Array.isArray(data)
				? data
				: [];

	const changes = rawChanges
		.map(normalizeChange)
		.filter(Boolean) as CloudChange[];

	const maxReceivedId = changes.reduce(
		(max, c) => Math.max(max, c.idChange),
		afterId,
	);

	const nextAfterId = finiteNumberOr(
		data?.nextAfterId ??
		data?.next_after_id ??
		data?.lastChangeId ??
		data?.last_change_id,
		maxReceivedId,
	);

	const hasMore = Boolean(
		data?.hasMore ??
		data?.has_more ??
		(changes.length >= options.limit && maxReceivedId > afterId),
	);

	return {
		changes,
		hasMore,
		nextAfterId,
	};
}

function toRustCloudChange(change: CloudChange): RustCloudChange {
	return {
		id_change: Number(change.idChange),
		op_id: String(change.opId),
		command_name: String(change.commandName),
		command_version: Number(change.commandVersion || 1),
		device_id: change.deviceId ?? null,
		payload_json: String(change.payloadJson),
		result_json: change.resultJson ?? null,
		created_at_ms: Number(change.createdAtMs || 0),
	};
}

function normalizeApplyResult(raw: any): ApplyCloudChangesResult {
	return {
		ok: Boolean(raw?.ok),
		applied: finiteNumberOr(raw?.applied, 0),
		skipped: finiteNumberOr(raw?.skipped, 0),
		lastCloudChangeId: finiteNumberOr(
			raw?.lastCloudChangeId ?? raw?.last_cloud_change_id,
			0,
		),
		errors: Array.isArray(raw?.errors) ? raw.errors.map(String) : [],
	};
}

async function getAuthHeadersFromTauri(args: {
	method: string;
	path: string;
}): Promise<{ token: string; deviceTs: number; deviceSig: string }> {
	const raw = await invoke<ApiAuthHeaders>("api_get_auth_headers", {
		args: {
			method: args.method,
			path: args.path,
		},
	});

	return normalizeAuthHeaders(raw);
}

async function fetchRemoteChanges(afterId: number): Promise<SyncFetchResult> {
	const method = "POST";

	const body = {
		afterId,
		after_id: afterId,
		limit: options.limit,
	};

	const auth = await getAuthHeadersFromTauri({
		method,
		path: pathForSig(SYNC_PATH),
	});

	const res = await withTimeout(
		fetch(API_BASE + SYNC_PATH, {
			method,
			cache: "no-store",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${auth.token}`,
				"X-Device-Ts": String(auth.deviceTs),
				"X-Device-Sig": auth.deviceSig,
			},
			body: JSON.stringify(body),
		}),
		DEFAULT_REMOTE_TIMEOUT_MS,
	);

	const txt = await res.text().catch(() => "");

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${txt}`);
	}

	return normalizeFetchResult(safeJsonParse(txt), afterId);
}

async function getLastCloudChangeId(): Promise<number> {
	const value = await invoke<number>("sync_get_last_cloud_change_id");
	const n = Number(value);

	return Number.isFinite(n) && n > 0 ? n : 0;
}

async function applyCloudChanges(
	changes: CloudChange[],
): Promise<ApplyCloudChangesResult> {
	const raw = await invoke<any>("sync_apply_cloud_changes", {
		args: {
			changes: changes.map(toRustCloudChange),
		},
	});

	const result = normalizeApplyResult(raw);

	if (!result.ok) {
		throw new Error(
			result.errors.length ? result.errors.join(" | ") : "cloud_apply_failed",
		);
	}

	return result;
}

function shouldRunInThisMode(): boolean {
	return useMode.getState().mode === "tpv";
}

export async function runCloudSyncNow(reason = "manual"): Promise<void> {
	if (!shouldRunInThisMode()) {
		log("skip: mode is not tpv", reason);
		return;
	}

	if (syncInProgress) {
		pendingRun = true;
		log("already running, marked pending", reason);
		return;
	}

	syncInProgress = true;
	pendingRun = false;
	lastRunStartedAt = Date.now();

	setSyncStatus("resyncing", null);

	try {
		let afterId = await getLastCloudChangeId();
		let pages = 0;
		let totalChanges = 0;
		let totalApplied = 0;
		let totalSkipped = 0;

		log("start", { reason, afterId });

		while (pages < options.maxPagesPerRun) {
			pages += 1;

			const fetched = await fetchRemoteChanges(afterId);

			if (fetched.changes.length === 0) {
				break;
			}

			totalChanges += fetched.changes.length;

			const applied = await applyCloudChanges(fetched.changes);

			totalApplied += Number(applied.applied || 0);
			totalSkipped += Number(applied.skipped || 0);

			afterId = Math.max(
				afterId,
				Number(applied.lastCloudChangeId || 0),
				Number(fetched.nextAfterId || 0),
			);

			if (!fetched.hasMore) {
				break;
			}
		}

		useNet.getState().setOnline();
		setSyncStatus("idle", null);

		log("done", {
			reason,
			pages,
			totalChanges,
			totalApplied,
			totalSkipped,
			lastCloudChangeId: afterId,
		});
	} catch (e) {
		const msg = normalizeErrorMessage(e);

		if (isAvailabilityError(e)) {
			markApiUnavailableOffline();
		}

		setSyncStatus("error", msg);
		log("error", msg);

		throw e;
	} finally {
		syncInProgress = false;

		if (pendingRun) {
			pendingRun = false;
			scheduleCloudSync("pending_after_run");
		}
	}
}

export function scheduleCloudSync(reason = "scheduled"): void {
	if (!shouldRunInThisMode()) {
		log("schedule skipped: mode is not tpv", reason);
		return;
	}

	const now = Date.now();
	const elapsed = now - lastRunStartedAt;

	const waitForCooldown =
		lastRunStartedAt > 0 && elapsed < options.minIntervalMs
			? options.minIntervalMs - elapsed
			: 0;

	const delay = Math.max(options.debounceMs, waitForCooldown);

	clearTimer();

	timer = setTimeout(() => {
		timer = null;

		runCloudSyncNow(reason).catch((e) => {
			log("scheduled run failed", normalizeErrorMessage(e));
		});
	}, delay);

	log("scheduled", { reason, delay });
}

export function handleCloudSyncWebSocketMessage(raw: unknown): boolean {
	let msg: any = raw;

	if (typeof raw === "string") {
		try {
			msg = JSON.parse(raw);
		} catch {
			return false;
		}
	}

	if (!msg || typeof msg !== "object") return false;

	const isDirectCloudNotice =
		msg.type === "cloud_changes_available" ||
		msg.type === "cloudChangesAvailable";

	const isEventCloudNotice =
		msg.type === "event" &&
		[
			"cloud.changes_available",
			"cloud_changes_available",
			"sync.changes_available",
			"tenant.changes_available",
		].includes(String(msg.name || ""));

	if (!isDirectCloudNotice && !isEventCloudNotice) {
		return false;
	}

	scheduleCloudSync("websocket_notice");
	return true;
}

export function bindCloudSyncToWebSocket(ws: WebSocket): () => void {
	const onMessage = (ev: MessageEvent) => {
		handleCloudSyncWebSocketMessage(ev.data);
	};

	ws.addEventListener("message", onMessage);

	return () => {
		ws.removeEventListener("message", onMessage);
	};
}

export function initCloudSyncCoordinator(opts: CloudSyncOptions = {}): void {
	options = {
		...options,
		...opts,
	};

	if (initialized) return;

	initialized = true;

	if (shouldRunInThisMode()) {
		scheduleCloudSync("startup");
	}

	const modeSubscribe = (useMode as any).subscribe;
	if (typeof modeSubscribe === "function") {
		const unsub = modeSubscribe((state: any, prevState: any) => {
			const mode = state?.mode;
			const prevMode = prevState?.mode;

			if (mode === "tpv" && prevMode !== "tpv") {
				scheduleCloudSync("mode_tpv");
			}
		});

		if (typeof unsub === "function") {
			unsubscribers.push(unsub);
		}
	}

	const netSubscribe = (useNet as any).subscribe;
	if (typeof netSubscribe === "function") {
		const unsub = netSubscribe((state: any, prevState: any) => {
			const status = state?.status;
			const prevStatus = prevState?.status;

			if (status === "online" && prevStatus !== "online") {
				scheduleCloudSync("net_online");
			}
		});

		if (typeof unsub === "function") {
			unsubscribers.push(unsub);
		}
	}
}

export function stopCloudSyncCoordinator(): void {
	clearTimer();

	pendingRun = false;
	initialized = false;

	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch {
			// noop
		}
	}

	unsubscribers = [];
}

export async function markLocalOperationApplied(params: {
	opId: string;
	commandName: string;
	source: "afterRemoteOk" | "cloudSync" | "outbox";
}): Promise<void> {
	await invoke("sync_mark_local_operation_applied", {
		args: {
			op_id: params.opId,
			command_name: params.commandName,
			source: params.source,
		},
	});
}