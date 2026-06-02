// src/net/outboxSync.ts
import { invoke } from "@tauri-apps/api/core";
import { useNet } from "../zustand/useNet";
import { useSync } from "../zustand/useSync";
import { markLocalOperationApplied } from "./cloudSync";

/* =========================================================
	Tipos
========================================================= */

export type OutboxOperationRow = {
	idOutbox: number;
	opId: string;
	commandName: string;
	payloadJson: string;
	status: string;
	attemptCount: number;
	lastError: string | null;
	createdAtMs: number;
	updatedAtMs: number;
	lastAttemptAtMs: number | null;
};

type ApiAuthHeaders = {
	token?: string;
	deviceTs?: number;
	deviceSig?: string;
	device_ts?: number;
	device_sig?: string;
};

type RemoteMethod = "GET" | "POST" | "PUT" | "DELETE";

type RemoteSpec = {
	path: string;
	method?: RemoteMethod;
	body?: any;
	headers?: Record<string, string>;
	timeoutMs?: number;
	unwrapOkEnvelope?: boolean;
	skipAuth?: boolean;
};

type CommandEnvelope = {
	op_id: string;
	command_name: string;
	args: any;
};

export type OutboxSyncRoute = {
	path: string;
	method?: RemoteMethod;
	timeoutMs?: number;
	headers?: Record<string, string>;
	unwrapOkEnvelope?: boolean;
	skipAuth?: boolean;

	/**
	 * Command_Name canónico que debe llegar al backend/TenantHub.
	 * Si no se indica, se usa row.commandName.
	 */
	remoteCommandName?:
	| string
	| ((payload: any, row: OutboxOperationRow) => string | null | undefined);

	/**
	 * Escape hatch para casos especiales.
	 * Por defecto NO se usa: el body remoto será siempre:
	 * { op_id, command_name, args }
	 */
	bodyFromPayload?: (
		payload: any,
		row: OutboxOperationRow,
		remoteCommandName: string,
	) => any;
};

export type OutboxSyncRunResult = {
	ok: boolean;
	processed: number;
	failed: number;
	reason?: string;
};

/* =========================================================
	Config
========================================================= */

const API_BASE = "https://tpv-server.altarialights.workers.dev";
const DEFAULT_REMOTE_TIMEOUT_MS = 15_000;

/* =========================================================
	Estado interno módulo
========================================================= */

const routeRegistry = new Map<string, OutboxSyncRoute>();

let activeRun: Promise<OutboxSyncRunResult> | null = null;
let stopAutoSyncFn: (() => void) | null = null;
let defaultRoutesRegistered = false;

/* =========================================================
	Helpers genéricos
========================================================= */

function normalizeErrorMessage(err: unknown): string {
	return (
		String((err as any)?.message ?? err ?? "unknown_error").trim() ||
		"unknown_error"
	);
}

function pathForSig(path: string): string {
	const p = String(path || "/");
	const q = p.indexOf("?");
	const h = p.indexOf("#");
	const cut = [q, h].filter((x) => x >= 0).sort((a, b) => a - b)[0];

	return cut == null ? p : p.slice(0, cut);
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

function normalizeOutboxRow(raw: any): OutboxOperationRow {
	return {
		idOutbox: finiteNumberOr(raw?.idOutbox ?? raw?.id_outbox, 0),
		opId: String(raw?.opId ?? raw?.op_id ?? "").trim(),
		commandName: String(raw?.commandName ?? raw?.command_name ?? "").trim(),
		payloadJson: String(raw?.payloadJson ?? raw?.payload_json ?? "{}"),
		status: String(raw?.status ?? "PENDING"),
		attemptCount: finiteNumberOr(raw?.attemptCount ?? raw?.attempt_count, 0),
		lastError:
			raw?.lastError ?? raw?.last_error == null
				? null
				: String(raw?.lastError ?? raw?.last_error),
		createdAtMs: finiteNumberOr(raw?.createdAtMs ?? raw?.created_at_ms, 0),
		updatedAtMs: finiteNumberOr(raw?.updatedAtMs ?? raw?.updated_at_ms, 0),
		lastAttemptAtMs:
			raw?.lastAttemptAtMs ?? raw?.last_attempt_at_ms == null
				? null
				: finiteNumberOr(raw?.lastAttemptAtMs ?? raw?.last_attempt_at_ms, 0),
	};
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

function unwrapOkEnvelope(x: any): any {
	if (!x || typeof x !== "object") return x;
	if (!("ok" in x)) return x;

	const ok = !!(x as any).ok;

	if (!ok) {
		const msg = String(
			(x as any).error ?? (x as any).message ?? "remote_ok_false",
		);
		throw new Error(msg);
	}

	if ("result" in x) return (x as any).result;
	if ("user" in x) return (x as any).user;
	if ("status" in x) return (x as any).status;
	if ("data" in x) return (x as any).data;

	return x;
}

function safeJsonParse<T = any>(raw: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (e: any) {
		throw new Error(`invalid_payload_json:${String(e?.message || e)}`);
	}
}

function isPlainObject(value: any): value is Record<string, any> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

function cleanTransportFields(value: any): any {
	if (!isPlainObject(value)) return value;

	const {
		op_id,
		opId,
		command_name,
		commandName,
		enqueue_outbox,
		enqueueOutbox,
		...domainArgs
	} = value;

	return domainArgs;
}

function normalizeDomainArgsFromPayload(payload: any): any {
	if (!isPlainObject(payload)) return payload ?? {};

	if (isPlainObject(payload.args)) {
		return cleanTransportFields(payload.args);
	}

	if (isPlainObject(payload.payload?.args)) {
		return cleanTransportFields(payload.payload.args);
	}

	if (isPlainObject(payload.payload)) {
		return cleanTransportFields(payload.payload);
	}

	if (isPlainObject(payload.params)) {
		return cleanTransportFields(payload.params);
	}

	return cleanTransportFields(payload);
}

function resolveEnvelopeOpId(payload: any, row: OutboxOperationRow): string {
	const raw = isPlainObject(payload)
		? payload.op_id ?? payload.opId ?? payload.payload?.op_id ?? payload.payload?.opId
		: null;

	const out = String(raw || row.opId || "").trim();

	if (!out) {
		throw new Error(`missing_op_id:${row.commandName}`);
	}

	return out;
}

function buildCommandEnvelope(
	payload: any,
	row: OutboxOperationRow,
	remoteCommandName: string,
): CommandEnvelope {
	return {
		op_id: resolveEnvelopeOpId(payload, row),
		command_name: remoteCommandName,
		args: normalizeDomainArgsFromPayload(payload),
	};
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

function isAuthOrLicenseError(err: unknown): boolean {
	const msg = normalizeErrorMessage(err).toLowerCase();

	return (
		msg.includes("missing_token") ||
		msg.includes("invalid_token") ||
		msg.includes("jwt_expired") ||
		msg.includes("jwt_not_active") ||
		msg.includes("missing_device_proof") ||
		msg.includes("bad_device_ts") ||
		msg.includes("device_ts_out_of_range") ||
		msg.includes("device_pubkey_not_registered") ||
		msg.includes("bad_device_signature") ||
		msg.includes("missing_internal_auth") ||
		msg.includes("bad_internal_signature") ||
		msg.includes("license") ||
		msg.includes("not_approved") ||
		msg.includes("http 401") ||
		msg.includes("http 403")
	);
}

function isSyncRegistryError(err: unknown): boolean {
	const msg = normalizeErrorMessage(err).toLowerCase();
	return msg.startsWith("sync_handler_not_found:");
}

function shouldAbortSyncRun(err: unknown): boolean {
	return (
		isAvailabilityError(err) ||
		isAuthOrLicenseError(err) ||
		isSyncRegistryError(err)
	);
}

function forceOfflineBecauseApiFailed(): void {
	const net = useNet.getState() as any;

	if (typeof net.forceOffline === "function") {
		net.forceOffline();
		return;
	}

	if (typeof net.setOffline === "function") {
		net.setOffline();
	}
}

function registerRouteAliases(
	commandNames: string[],
	route: OutboxSyncRoute,
): void {
	for (const commandName of commandNames) {
		const k = String(commandName || "").trim();
		if (!k) continue;

		routeRegistry.set(k, route);
	}
}

function resolveRemoteCommandName(
	route: OutboxSyncRoute,
	payload: any,
	row: OutboxOperationRow,
): string {
	const raw =
		typeof route.remoteCommandName === "function"
			? route.remoteCommandName(payload, row)
			: route.remoteCommandName;

	const out = String(raw || row.commandName || "").trim();

	if (!out) {
		throw new Error(`missing_remote_command_name:${row.opId}`);
	}

	return out;
}

/* =========================================================
	Auth remoto
========================================================= */

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

async function fetchJsonRemote<T>(remote: RemoteSpec): Promise<T> {
	const url = API_BASE + remote.path;
	const method = remote.method ?? "POST";
	const timeoutMs = remote.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;

	const headers: Record<string, string> = {
		accept: "application/json",
		...(remote.headers ?? {}),
	};

	const hasBody =
		remote.body !== undefined && method !== "GET" && method !== "DELETE";

	if (hasBody) {
		headers["content-type"] = "application/json";
	}

	if (!remote.skipAuth) {
		const sigPath = pathForSig(remote.path);
		const ah = await getAuthHeadersFromTauri({ method, path: sigPath });

		headers.authorization = `Bearer ${ah.token}`;
		headers["X-Device-Ts"] = String(ah.deviceTs);
		headers["X-Device-Sig"] = ah.deviceSig;
	}

	const init: RequestInit = {
		method,
		headers,
		cache: "no-store",
	};

	if (hasBody) {
		init.body = JSON.stringify(remote.body);
	}

	const res = await withTimeout(fetch(url, init), timeoutMs);
	const txt = await res.text().catch(() => "");

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${txt}`);
	}

	if (!txt) return undefined as T;

	let parsed: any;

	try {
		parsed = JSON.parse(txt);
	} catch {
		parsed = txt;
	}

	if (remote.unwrapOkEnvelope) {
		parsed = unwrapOkEnvelope(parsed);
	}

	return parsed as T;
}

/* =========================================================
	Tauri outbox commands
========================================================= */

async function outboxRequeueSyncing(): Promise<number> {
	return await invoke<number>("fallback_local_outbox_requeue_syncing");
}

async function outboxPendingCount(): Promise<number> {
	return await invoke<number>("fallback_local_outbox_pending_count");
}

async function outboxClaimNext(): Promise<OutboxOperationRow | null> {
	const raw = await invoke<any | null>("fallback_local_outbox_claim_next");

	return raw ? normalizeOutboxRow(raw) : null;
}

async function outboxMarkApplied(opId: string): Promise<boolean> {
	return await invoke<boolean>("fallback_local_outbox_mark_applied", {
		args: {
			op_id: opId,
		},
	});
}

async function outboxMarkFailed(
	opId: string,
	lastError: string,
): Promise<boolean> {
	return await invoke<boolean>("fallback_local_outbox_mark_failed", {
		args: {
			op_id: opId,
			last_error: lastError,
		},
	});
}

/* =========================================================
	Registry
========================================================= */

export function registerOutboxSyncRoutes(
	routes: Record<string, OutboxSyncRoute>,
): void {
	for (const [commandName, route] of Object.entries(routes)) {
		routeRegistry.set(commandName, route);
	}
}

export function clearOutboxSyncRoutes(): void {
	routeRegistry.clear();
	defaultRoutesRegistered = false;
}

export function hasOutboxSyncRoute(commandName: string): boolean {
	return routeRegistry.has(commandName);
}

export function registerDefaultOutboxSyncRoutes(): void {
	if (defaultRoutesRegistered) return;

	/* =========================
		LOGIN
	========================= */

	registerRouteAliases(["login.punch", "login_punch"], {
		path: "/v1/login/punch",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "login.punch",
	});

	registerRouteAliases(
		["login.setTurnoPartidoHoy", "login.set_turno_partido_hoy"],
		{
			path: "/v1/login/set-turno-partido-hoy",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "login.setTurnoPartidoHoy",
		},
	);

	registerRouteAliases(
		["login.completeInitialSetup", "login.complete_initial_setup"],
		{
			path: "/v1/login/complete_initial_setup",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "login.completeInitialSetup",
		},
	);

	/* =========================
		INVENTARIO
	========================= */

	registerRouteAliases(
		["inventario.createCategoria", "inventario.create_categoria"],
		{
			path: "/v1/inventario/categoria/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "inventario.createCategoria",
		},
	);

	registerRouteAliases(
		["inventario.deleteProducto", "inventario.delete_producto"],
		{
			path: "/v1/inventario/producto/delete",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "inventario.deleteProducto",
		},
	);

	registerRouteAliases(
		["inventario.upsertProducto", "inventario.upsert_producto"],
		{
			path: "/v1/inventario/producto/upsert",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "inventario.upsertProducto",
		},
	);

	registerRouteAliases(
		["inventario.setAlergenosProducto", "inventario.set_alergenos_producto"],
		{
			path: "/v1/inventario/alergenos/set-producto",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "inventario.setAlergenosProducto",
		},
	);

	registerRouteAliases(["inventario.createLote", "inventario.create_lote"], {
		path: "/v1/inventario/lote/create",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "inventario.createLote",
	});

	registerRouteAliases(
		["inventario.ajustarLote", "inventario.ajustar_lote"],
		{
			path: "/v1/inventario/lote/ajustar",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "inventario.ajustarLote",
		},
	);

	/* =========================
		CLIENTES
	========================= */

	registerRouteAliases(
		["clientes.createCliente", "clientes.create_cliente", "clients.createCliente"],
		{
			path: "/v1/clients/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "clients.createCliente",
		},
	);

	registerRouteAliases(
		["clientes.updateCliente", "clientes.update_cliente", "clients.updateCliente"],
		{
			path: "/v1/clients/update",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "clients.updateCliente",
		},
	);

	/* =========================
		PROVEEDORES
	========================= */

	registerRouteAliases(["proveedores.save", "proveedores_save"], {
		path: "/v1/proveedores/save",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "proveedores.save",
	});

	registerRouteAliases(["proveedores.delete", "proveedores_delete"], {
		path: "/v1/proveedores/delete",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "proveedores.delete",
	});

	registerRouteAliases(["proveedores.setVinculos", "proveedores_set_vinculos"], {
		path: "/v1/proveedores/set-vinculos",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "proveedores.setVinculos",
	});

	registerRouteAliases(
		["proveedores.createProducto", "proveedores_create_producto"],
		{
			path: "/v1/proveedores/producto/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "proveedores.createProducto",
		},
	);

	/* =========================
		CONFIG
	========================= */

	registerRouteAliases(
		["config.patchBusinessSettings", "config.patch_business_settings"],
		{
			path: "/v1/config/business/patch",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "config.patchBusinessSettings",
		},
	);

	registerRouteAliases(
		["config.patchTicketSettings", "config.patch_ticket_settings"],
		{
			path: "/v1/config/ticket/patch",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "config.patchTicketSettings",
		},
	);

	/* =========================
		TRABAJADORES
	========================= */

	registerRouteAliases(
		["trabajadores.create", "trabajadores_create", "trabajadores.createTrabajador"],
		{
			path: "/v1/trabajadores/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "trabajadores.create",
		},
	);

	registerRouteAliases(
		["trabajadores.update", "trabajadores_update", "trabajadores.updateTrabajador"],
		{
			path: "/v1/trabajadores/update",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "trabajadores.update",
		},
	);

	/* =========================
		RESERVAS
	========================= */

	registerRouteAliases(["reservas.save", "reservas_save"], {
		path: "/v1/reservas/save",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "reservas.save",
	});

	registerRouteAliases(["reservas.delete", "reservas_delete"], {
		path: "/v1/reservas/delete",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "reservas.delete",
	});

	registerRouteAliases(
		["reservas.setEstado", "reservas_set_estado", "tables.reservasSetEstado"],
		{
			path: "/v1/reservas/set-estado",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "reservas.setEstado",
		},
	);

	/* =========================
		MESAS / COMANDAS / TICKET / COCINA
	========================= */

	registerRouteAliases(
		["mesas.saveLayout", "mesas_save_layout", "tables.mesasSaveLayout"],
		{
			path: "/v1/mesas/layout/save",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "mesas.saveLayout",
		},
	);

	registerRouteAliases(
		["mesas.getOrCreateMesaBarra", "mesas_get_or_create_mesa_barra"],
		{
			path: "/v1/mesas/get-or-create-mesa-barra",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "mesas.getOrCreateMesaBarra",
		},
	);

	registerRouteAliases(
		["comandas.abrir", "comandas_abrir", "tables.comandasAbrir"],
		{
			path: "/v1/comandas/abrir",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "comandas.abrir",
		},
	);

	registerRouteAliases(
		[
			"comandas.setTrabajadorIfNull",
			"comandas_set_trabajador_if_null",
			"tables.comandasSetTrabajadorIfNull",
		],
		{
			path: "/v1/comandas/set-trabajador-if-null",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "comandas.setTrabajadorIfNull",
		},
	);

	registerRouteAliases(
		["comandas.addLinea", "comandas_add_linea", "tables.comandasAddLinea"],
		{
			path: "/v1/comandas/add-linea",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "comandas.addLinea",
		},
	);

	registerRouteAliases(["comandas.cerrar", "comandas_cerrar"], {
		path: "/v1/comandas/cerrar",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "comandas.cerrar",
	});

	registerRouteAliases(["comandas.createBarra", "comandas_create_barra"], {
		path: "/v1/comandas/create-barra",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "comandas.createBarra",
	});

	registerRouteAliases(
		["comandas.deleteBarraIfSafe", "comandas_delete_barra_if_safe"],
		{
			path: "/v1/comandas/delete-barra-if-safe",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "comandas.deleteBarraIfSafe",
		},
	);

	registerRouteAliases(
		["comandas.getOrCreateBarra", "comandas_get_or_create_barra"],
		{
			path: "/v1/comandas/get-or-create-barra",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "comandas.getOrCreateBarra",
		},
	);

	registerRouteAliases(
		[
			"ticket.removeOnePending",
			"ticket_remove_one_pending",
			"tables.ticketRemoveOnePendingDetalle",
		],
		{
			path: "/v1/ticket/remove-one-pending",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "ticket.removeOnePending",
		},
	);

	registerRouteAliases(
		["ticket.deleteDetalle", "ticket_delete_detalle", "tables.ticketDeleteDetalle"],
		{
			path: "/v1/ticket/delete-detalle",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "ticket.deleteDetalle",
		},
	);

	registerRouteAliases(
		[
			"ticket.updateDetalleNota",
			"ticket_update_detalle_nota",
			"tables.ticketUpdateDetalleNota",
		],
		{
			path: "/v1/ticket/update-detalle-notas",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "ticket.updateDetalleNota",
		},
	);

	registerRouteAliases(
		[
			"ticket.cobrarDetalles",
			"ticket_cobrar_detalles",
			"tables.ticketCobrarDetalles",
		],
		{
			path: "/v1/ticket/cobrar-detalles",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "ticket.cobrarDetalles",
		},
	);

	registerRouteAliases(
		[
			"kitchen.setLineaEstado",
			"kitchen_set_linea_estado",
			"tables.kitchenSetLineState",
		],
		{
			path: "/v1/kitchen/set-line-state",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "kitchen.setLineaEstado",
		},
	);

	/* =========================
		CUENTAS
	========================= */

	registerRouteAliases(
		["cuentas.createGasto", "cuentas_create_gasto", "bills.createGasto"],
		{
			path: "/v1/bills/gasto/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "cuentas.createGasto",
		},
	);

	registerRouteAliases(
		["cuentas.updateGasto", "cuentas_update_gasto", "bills.updateGasto"],
		{
			path: "/v1/bills/gasto/update",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "cuentas.updateGasto",
		},
	);

	registerRouteAliases(
		["cuentas.deleteGasto", "cuentas_delete_gasto", "bills.deleteGasto"],
		{
			path: "/v1/bills/gasto/delete",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "cuentas.deleteGasto",
		},
	);

	registerRouteAliases(
		["cuentas.updatePago", "cuentas_update_pago", "bills.updatePago"],
		{
			path: "/v1/bills/pago/update",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "cuentas.updatePago",
		},
	);

	registerRouteAliases(
		["cuentas.deletePago", "cuentas_delete_pago", "bills.deletePago"],
		{
			path: "/v1/bills/pago/delete",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "cuentas.deletePago",
		},
	);

	/* =========================
		HORARIOS / TRABAJADORES
	========================= */

	registerRouteAliases(
		[
			"horarios.createAsignacion",
			"horarios_create_asignacion",
			"trabajadores.horarios.createAsignacion",
		],
		{
			path: "/v1/horarios/asignacion/create",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "horarios.createAsignacion",
		},
	);

	registerRouteAliases(
		[
			"horarios.updateAsignacion",
			"horarios_update_asignacion",
			"trabajadores.horarios.updateAsignacion",
		],
		{
			path: "/v1/horarios/asignacion/update",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "horarios.updateAsignacion",
		},
	);

	registerRouteAliases(
		[
			"horarios.deleteAsignacion",
			"horarios_delete_asignacion",
			"trabajadores.horarios.deleteAsignacion",
		],
		{
			path: "/v1/horarios/asignacion/delete",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "horarios.deleteAsignacion",
		},
	);

	registerRouteAliases(
		[
			"horarios.copySemanaAsignaciones",
			"horarios_copy_semana_asignaciones",
			"trabajadores.horarios.copySemanaAsignaciones",
		],
		{
			path: "/v1/horarios/copy-semana",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "horarios.copySemanaAsignaciones",
		},
	);

	registerRouteAliases(
		[
			"horarios.setPredeterminadoDesdeSemana",
			"horarios_set_predeterminado_desde_semana",
			"trabajadores.horarios.setPredeterminadoDesdeSemana",
		],
		{
			path: "/v1/horarios/set-predeterminado-desde-semana",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "horarios.setPredeterminadoDesdeSemana",
		},
	);

	/* =========================
		TAREAS
	========================= */

	registerRouteAliases(["tareas.createTarea", "tareas_create_tarea", "tasks.createTarea"], {
		path: "/v1/tareas/create",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "tareas.createTarea",
	});

	registerRouteAliases(["tareas.updateTarea", "tareas_update_tarea", "tasks.updateTarea"], {
		path: "/v1/tareas/update",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "tareas.updateTarea",
	});

	registerRouteAliases(
		[
			"tareas.setAsignacionesTarea",
			"tareas_set_asignaciones_tarea",
			"tasks.setAsignacionesTarea",
		],
		{
			path: "/v1/tareas/set-asignaciones",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "tareas.setAsignacionesTarea",
		},
	);

	registerRouteAliases(["tareas.deleteTarea", "tareas_delete_tarea", "tasks.deleteTarea"], {
		path: "/v1/tareas/delete",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "tareas.deleteTarea",
	});

	registerRouteAliases(
		[
			"tareas.marcarTareaFinalizada",
			"tareas_marcar_tarea_finalizada",
			"tareas.marcarFinalizada",
			"tasks.marcarFinalizada",
		],
		{
			path: "/v1/tareas/finalizar",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "tareas.marcarTareaFinalizada",
		},
	);

	/* =========================
		VENTA RÁPIDA
	========================= */

	registerRouteAliases(["ventaRapida.cobrar", "venta_rapida_cobrar"], {
		path: "/v1/venta-rapida/cobrar",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "ventaRapida.cobrar",
	});

	registerRouteAliases(["vr.createComandaBarra", "vr_create_comanda_barra"], {
		path: "/v1/vr/create-comanda-barra",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "vr.createComandaBarra",
	});

	registerRouteAliases(["vr.addLineaComanda", "vr_add_linea_comanda"], {
		path: "/v1/vr/add-linea-comanda",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "vr.addLineaComanda",
	});

	registerRouteAliases(
		["vr.removeLastUnpaidLinea", "vr_remove_last_unpaid_linea"],
		{
			path: "/v1/vr/remove-last-unpaid-linea",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "vr.removeLastUnpaidLinea",
		},
	);

	registerRouteAliases(
		["vr.deleteLineaIfUnpaid", "vr_delete_linea_if_unpaid"],
		{
			path: "/v1/vr/delete-linea-if-unpaid",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "vr.deleteLineaIfUnpaid",
		},
	);

	registerRouteAliases(["vr.updateNotaDetalle", "vr_update_nota_detalle"], {
		path: "/v1/vr/update-nota-detalle",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "vr.updateNotaDetalle",
	});

	registerRouteAliases(["vr.cobrarFraccionado", "vr_cobrar_fraccionado"], {
		path: "/v1/vr/cobrar-fraccionado",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "vr.cobrarFraccionado",
	});

	registerRouteAliases(["vr.restarStock", "vr_restar_stock"], {
		path: "/v1/vr/restar-stock",
		method: "POST",
		unwrapOkEnvelope: true,
		remoteCommandName: "vr.restarStock",
	});

	registerRouteAliases(
		["vr.deleteComandaIfSafe", "vr_delete_comanda_if_safe"],
		{
			path: "/v1/vr/delete-comanda-if-safe",
			method: "POST",
			unwrapOkEnvelope: true,
			remoteCommandName: "vr.deleteComandaIfSafe",
		},
	);

	defaultRoutesRegistered = true;
}

/* =========================================================
	Sync core
========================================================= */

async function refreshPendingCount(): Promise<number> {
	const count = await outboxPendingCount();
	useSync.getState().setPendingCount(count);
	return count;
}

type SyncClaimedRowResult = {
	remoteCommandName: string;
};

async function syncClaimedRow(row: OutboxOperationRow): Promise<SyncClaimedRowResult> {
	const route = routeRegistry.get(row.commandName);

	if (!route) {
		throw new Error(`sync_handler_not_found:${row.commandName}`);
	}

	const payload = safeJsonParse(row.payloadJson);
	const remoteCommandName = resolveRemoteCommandName(route, payload, row);

	const body = route.bodyFromPayload
		? route.bodyFromPayload(payload, row, remoteCommandName)
		: buildCommandEnvelope(payload, row, remoteCommandName);

	await fetchJsonRemote({
		path: route.path,
		method: route.method ?? "POST",
		headers: {
			...(route.headers ?? {}),
			"X-Idempotency-Key": row.opId,
			"X-Command-Name": remoteCommandName,
		},
		timeoutMs: route.timeoutMs,
		unwrapOkEnvelope: route.unwrapOkEnvelope ?? true,
		skipAuth: route.skipAuth ?? false,
		body,
	});

	return { remoteCommandName };
}

async function markOutboxLocalOperationApplied(
	row: OutboxOperationRow,
	remoteCommandName: string,
): Promise<void> {
	await markLocalOperationApplied({
		opId: row.opId,
		commandName: remoteCommandName,
		source: "outbox",
	});

	if (row.commandName !== remoteCommandName) {
		await markLocalOperationApplied({
			opId: row.opId,
			commandName: row.commandName,
			source: "outbox",
		});
	}
}

async function runOutboxResyncInternal(): Promise<OutboxSyncRunResult> {
	if (useNet.getState().status !== "online") {
		await refreshPendingCount();

		return {
			ok: false,
			processed: 0,
			failed: 0,
			reason: "offline",
		};
	}

	registerDefaultOutboxSyncRoutes();
	useSync.getState().startResync();

	let processed = 0;
	let failed = 0;
	const failedThisRun = new Set<string>();

	try {
		await outboxRequeueSyncing();
		await refreshPendingCount();

		while (true) {
			if (useNet.getState().status !== "online") {
				const reason = "offline";

				await refreshPendingCount();
				useSync.getState().failResync(reason);

				return { ok: false, processed, failed, reason };
			}

			const row = await outboxClaimNext();

			if (!row) {
				useSync.getState().finishResync();

				return { ok: true, processed, failed };
			}

			if (failedThisRun.has(row.opId)) {
				const reason = `outbox_stalled_on_failed_row:${row.commandName}:${row.opId}`;

				await refreshPendingCount();
				useSync.getState().failResync(reason);

				return { ok: false, processed, failed, reason };
			}

			await refreshPendingCount();

			try {
				const synced = await syncClaimedRow(row);

				await markOutboxLocalOperationApplied(row, synced.remoteCommandName);

				const applied = await outboxMarkApplied(row.opId);

				if (!applied) {
					throw new Error(`mark_applied_rejected:${row.opId}`);
				}

				processed += 1;
			} catch (err) {
				const message = normalizeErrorMessage(err);

				try {
					await outboxMarkFailed(row.opId, message);
				} catch {
					// Mantenemos el error original.
				}

				failed += 1;
				failedThisRun.add(row.opId);

				if (isAvailabilityError(err)) {
					forceOfflineBecauseApiFailed();
				}

				await refreshPendingCount();

				if (shouldAbortSyncRun(err)) {
					useSync.getState().failResync(message);

					return {
						ok: false,
						processed,
						failed,
						reason: message,
					};
				}
			}

			await refreshPendingCount();
		}
	} catch (err) {
		const message = normalizeErrorMessage(err);

		await refreshPendingCount();
		useSync.getState().failResync(message);

		return {
			ok: false,
			processed,
			failed,
			reason: message,
		};
	}
}

/* =========================================================
	API pública
========================================================= */

export async function refreshOutboxPendingCount(): Promise<number> {
	return await refreshPendingCount();
}

export async function runOutboxResync(): Promise<OutboxSyncRunResult> {
	registerDefaultOutboxSyncRoutes();

	if (activeRun) return await activeRun;

	activeRun = (async () => {
		try {
			return await runOutboxResyncInternal();
		} finally {
			activeRun = null;
		}
	})();

	return await activeRun;
}

export function startOutboxAutoSync(): () => void {
	registerDefaultOutboxSyncRoutes();

	if (stopAutoSyncFn) {
		return stopAutoSyncFn;
	}

	let disposed = false;

	const unsubscribe = useNet.subscribe((state: unknown, prev: unknown) => {
		if (disposed) return;

		const currentStatus = String((state as { status?: unknown })?.status ?? "");
		const prevStatus = String((prev as { status?: unknown })?.status ?? "");

		const becameOnline = prevStatus !== "online" && currentStatus === "online";

		if (becameOnline) {
			void runOutboxResync();
		}
	});

	void refreshOutboxPendingCount();

	if (useNet.getState().status === "online") {
		void runOutboxResync();
	}

	stopAutoSyncFn = () => {
		if (disposed) return;

		disposed = true;
		unsubscribe();
		stopAutoSyncFn = null;
	};

	return stopAutoSyncFn;
}

export function stopOutboxAutoSync(): void {
	if (stopAutoSyncFn) {
		stopAutoSyncFn();
	}
}