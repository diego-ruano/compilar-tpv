// src/net/dualCall.ts
import { invoke } from "@tauri-apps/api/core";
import { useNet } from "../zustand/useNet";
import { useSync } from "../zustand/useSync";
import { useMode } from "../zustand/useMode";
import { markLocalOperationApplied } from "./cloudSync";

export type RemoteMethod = "GET" | "POST" | "PUT" | "DELETE";

export type RemoteCommandBody<TArgs = any> = {
    op_id: string;
    command_name: string;
    args: TArgs;
};

export type RemoteSpec = {
    path: string;
    method?: RemoteMethod;
    body?: any;
    headers?: Record<string, string>;
    timeoutMs?: number;
    unwrapOkEnvelope?: boolean;
};

export type DualCallKind = "read" | "write";
export type AfterRemoteOkMode = "await" | "background";

export type DualCallOpts<T = any> = {
    kind?: DualCallKind;
    debugTag?: string;
    skipAuth?: boolean;

    /**
     * Nombre estable del comando remoto.
     * Si no se pasa, se intenta resolver por body/header/path.
     */
    commandName?: string;

    /**
     * Si estás resincronizando:
     * - reads -> por defecto intentan remoto si hay online
     * - writes -> por defecto bloqueados
     */
    allowWriteDuringResync?: boolean;
    allowReadRemoteDuringResync?: boolean;

    /**
     * Si la API deja de estar disponible:
     * - TPV main -> localFn
     * - Handy -> nunca localFn
     */
    fallbackToLocalOnAvailabilityError?: boolean;

    /**
     * Solo TPV main:
     * se ejecuta después de remote OK en escrituras.
     *
     * Importante:
     * - no debe insertar outbox
     * - solo debe dejar local igual que nube
     */
    afterRemoteOk?: (remoteResult: T) => Promise<void>;

    /**
     * En TPV main online, permite que la UI responda con el resultado remoto
     * sin esperar a aplicar localmente. Por defecto: "background".
     */
    afterRemoteOkMode?: AfterRemoteOkMode;
};

const API_BASE = "https://tpv-server.altarialights.workers.dev";
const DEFAULT_REMOTE_TIMEOUT_MS = 8_000;
const AUTH_HEADERS_CACHE_TTL_MS = 15_000;

type ApiAuthHeaders = {
    authorization: string;
    deviceTs: string;
    deviceSig: string;
};

type CachedAuthHeaders = {
    value: ApiAuthHeaders;
    expiresAt: number;
};

const authHeadersCache = new Map<string, CachedAuthHeaders>();

export function clearDualCallAuthHeadersCache(): void {
    authHeadersCache.clear();
}

/* =========================================================
    Helper recomendado para writes remotos nuevos
    Body estándar:
    {
        op_id,
        command_name,
        args
    }
========================================================= */

export function buildRemoteCommandBody<TArgs>(params: {
    opId: string;
    commandName: string;
    args: TArgs;
}): RemoteCommandBody<TArgs> {
    const op_id = String(params.opId || "").trim();
    const command_name = String(params.commandName || "").trim();

    if (!op_id) {
        throw new Error("op_id required");
    }

    if (!command_name) {
        throw new Error("command_name required");
    }

    return {
        op_id,
        command_name,
        args: params.args,
    };
}

/* =========================================================
    Helpers genéricos
========================================================= */

function normalizeErrorMessage(err: unknown): string {
    return String((err as any)?.message ?? err ?? "unknown_error");
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

function pathForSig(path: string): string {
    const p = String(path || "/");
    const q = p.indexOf("?");
    const h = p.indexOf("#");
    const cut = [q, h].filter((x) => x >= 0).sort((a, b) => a - b)[0];

    return cut == null ? p : p.slice(0, cut);
}

function unwrapOkEnvelope(x: any): any {
    if (!x || typeof x !== "object") return x;
    if (!("ok" in x)) return x;

    const ok = !!x.ok;

    if (!ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    if ("data" in x) return x.data;
    if ("result" in x) return x.result;
    if ("user" in x) return x.user;
    if ("status" in x) return x.status;

    return x;
}

function safeJsonParse(raw: string): any {
    if (!raw.trim()) return undefined;

    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

function isAvailabilityError(err: unknown): boolean {
    const msg = normalizeErrorMessage(err).toLowerCase();

    if (!msg) return false;

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

/* =========================================================
    Auth remoto
========================================================= */

async function getAuthHeadersFromTauri(args: {
    method: string;
    path: string;
}): Promise<ApiAuthHeaders> {
    const method = String(args.method || "POST").toUpperCase();
    const path = pathForSig(args.path || "/");
    const cacheKey = `${method}:${path}`;
    const now = Date.now();
    const cached = authHeadersCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const raw = await invoke<any>("api_get_auth_headers", {
        args: {
            method,
            path,
        },
    });

    const token = String(raw?.token ?? raw?.Token ?? "").trim();

    const authorization = String(
        raw?.authorization ??
        raw?.Authorization ??
        raw?.AUTHORIZATION ??
        (token ? `Bearer ${token}` : ""),
    ).trim();

    const deviceTs = String(
        raw?.deviceTs ??
        raw?.device_ts ??
        raw?.xDeviceTs ??
        raw?.x_device_ts ??
        raw?.["x-device-ts"] ??
        raw?.["X-Device-Ts"] ??
        raw?.["X-DEVICE-TS"] ??
        "",
    ).trim();

    const deviceSig = String(
        raw?.deviceSig ??
        raw?.device_sig ??
        raw?.xDeviceSig ??
        raw?.x_device_sig ??
        raw?.["x-device-sig"] ??
        raw?.["X-Device-Sig"] ??
        raw?.["X-DEVICE-SIG"] ??
        "",
    ).trim();

    if (
        !authorization ||
        authorization === "Bearer" ||
        authorization === "Bearer undefined" ||
        authorization === "Bearer null"
    ) {
        throw new Error("missing_auth_authorization");
    }

    if (!deviceTs || deviceTs === "undefined" || deviceTs === "null") {
        throw new Error("missing_auth_device_ts");
    }

    if (!deviceSig || deviceSig === "undefined" || deviceSig === "null") {
        throw new Error("missing_auth_device_sig");
    }

    const value = {
        authorization,
        deviceTs,
        deviceSig,
    };

    authHeadersCache.set(cacheKey, {
        value,
        expiresAt: now + AUTH_HEADERS_CACHE_TTL_MS,
    });

    return value;
}

/* =========================================================
    Command metadata
========================================================= */

function getOpIdFromBody(body: any): string | null {
    const opId = String(
        body?.op_id ??
        body?.opId ??
        body?.payload?.op_id ??
        body?.payload?.opId ??
        body?.args?.op_id ??
        body?.args?.opId ??
        body?.input?.op_id ??
        body?.input?.opId ??
        "",
    ).trim();

    return opId || null;
}

function getCommandNameFromBody(body: any): string | null {
    const commandName = String(
        body?.command_name ??
        body?.commandName ??
        body?.payload?.command_name ??
        body?.payload?.commandName ??
        body?.args?.command_name ??
        body?.args?.commandName ??
        body?.input?.command_name ??
        body?.input?.commandName ??
        "",
    ).trim();

    return commandName || null;
}

function getCommandNameFromHeaders(
    headers?: Record<string, string>,
): string | null {
    if (!headers) return null;

    const value = String(
        headers["X-Command-Name"] ??
        headers["x-command-name"] ??
        headers["X-Command-name"] ??
        headers["x-Command-Name"] ??
        "",
    ).trim();

    return value || null;
}

/**
 * Mapa de fallback mientras migramos todo el front.
 * El objetivo final es que los writes manden body estándar:
 * { op_id, command_name, args }
 */
const COMMAND_BY_PATH: Record<string, string> = {
    "/v1/config/business/patch": "config.patchBusinessSettings",
    "/v1/config/ticket/patch": "config.patchTicketSettings",

    "/v1/login/punch": "login.punch",
    "/v1/login/complete_initial_setup": "login.completeInitialSetup",
    "/v1/login/set-turno-partido-hoy": "login.setTurnoPartidoHoy",

    "/v1/vr/create-comanda-barra": "vr.createComandaBarra",
    "/v1/vr/add-linea-comanda": "vr.addLineaComanda",
    "/v1/vr/remove-last-unpaid-linea": "vr.removeLastUnpaidLinea",
    "/v1/vr/delete-linea-if-unpaid": "vr.deleteLineaIfUnpaid",
    "/v1/vr/update-nota-detalle": "vr.updateNotaDetalle",
    "/v1/vr/cobrar-fraccionado": "vr.cobrarFraccionado",
    "/v1/vr/restar-stock": "vr.restarStock",
    "/v1/vr/delete-comanda-if-safe": "vr.deleteComandaIfSafe",

    "/v1/inventario/categoria/create": "inventario.createCategoria",
    "/v1/inventario/producto/upsert": "inventario.upsertProducto",
    "/v1/inventario/lote/create": "inventario.createLote",
    "/v1/inventario/alergenos/set-producto": "inventario.setAlergenosProducto",
    "/v1/inventario/producto/delete": "inventario.deleteProducto",
    "/v1/inventario/lote/ajustar": "inventario.ajustarLote",

    "/v1/clients/create": "clientes.createCliente",
    "/v1/clients/update": "clientes.updateCliente",

    "/v1/trabajadores/create": "trabajadores.create",
    "/v1/trabajadores/update": "trabajadores.update",

    "/v1/horarios/asignacion/create": "horarios.createAsignacion",
    "/v1/horarios/asignacion/update": "horarios.updateAsignacion",
    "/v1/horarios/asignacion/delete": "horarios.deleteAsignacion",
    "/v1/horarios/copy-semana": "horarios.copySemanaAsignaciones",
    "/v1/horarios/set-predeterminado-desde-semana":
        "horarios.setPredeterminadoDesdeSemana",

    "/v1/reservas/save": "reservas.save",
    "/v1/reservas/delete": "reservas.delete",
    "/v1/reservas/set-estado": "reservas.setEstado",

    "/v1/mesas/layout/save": "mesas.saveLayout",

    "/v1/comandas/abrir": "comandas.abrir",
    "/v1/comandas/add-linea": "comandas.addLinea",
    "/v1/comandas/set-trabajador-if-null": "comandas.setTrabajadorIfNull",
    "/v1/comandas/cerrar": "comandas.cerrar",
    "/v1/comandas/create-barra": "comandas.createBarra",
    "/v1/comandas/delete-barra-if-safe": "comandas.deleteBarraIfSafe",
    "/v1/comandas/get-or-create-barra": "comandas.getOrCreateBarra",
    "/v1/mesas/get-or-create-mesa-barra": "mesas.getOrCreateMesaBarra",
    "/v1/venta-rapida/cobrar": "ventaRapida.cobrar",

    "/v1/ticket/remove-one-pending": "ticket.removeOnePending",
    "/v1/ticket/delete-detalle": "ticket.deleteDetalle",
    "/v1/ticket/update-detalle-notas": "ticket.updateDetalleNota",
    "/v1/ticket/cobrar-detalles": "ticket.cobrarDetalles",

    "/v1/kitchen/set-line-state": "kitchen.setLineaEstado",

    "/v1/bills/gasto/create": "cuentas.createGasto",
    "/v1/bills/gasto/update": "cuentas.updateGasto",
    "/v1/bills/gasto/delete": "cuentas.deleteGasto",
    "/v1/bills/pago/update": "cuentas.updatePago",
    "/v1/bills/pago/delete": "cuentas.deletePago",

    "/v1/proveedores/save": "proveedores.save",
    "/v1/proveedores/delete": "proveedores.delete",
    "/v1/proveedores/set-vinculos": "proveedores.setVinculos",
    "/v1/proveedores/producto/create": "proveedores.createProducto",

    "/v1/tareas/create": "tareas.createTarea",
    "/v1/tareas/update": "tareas.updateTarea",
    "/v1/tareas/set-asignaciones": "tareas.setAsignacionesTarea",
    "/v1/tareas/delete": "tareas.deleteTarea",
    "/v1/tareas/finalizar": "tareas.marcarTareaFinalizada",
};

function getCommandNameForRemote(
    remote: RemoteSpec,
    opts: DualCallOpts,
): string | null {
    const fromOpts = String(opts.commandName || "").trim();
    if (fromOpts) return fromOpts;

    const fromBody = getCommandNameFromBody(remote.body);
    if (fromBody) return fromBody;

    const fromHeaders = getCommandNameFromHeaders(remote.headers);
    if (fromHeaders) return fromHeaders;

    const cleanPath = pathForSig(remote.path);
    return COMMAND_BY_PATH[cleanPath] || null;
}

function assertWriteMetadata(
    remote: RemoteSpec,
    opts: DualCallOpts,
    opId: string | null,
    commandName: string | null,
): void {
    if ((opts.kind ?? "read") !== "write") return;

    if (!opId) {
        throw new Error(`missing_op_id_for_write:${remote.path}`);
    }

    if (!commandName) {
        throw new Error(`missing_command_name_for_write:${remote.path}`);
    }
}

/* =========================================================
    Remote fetch
========================================================= */

async function fetchJsonRemote<T>(
    remote: RemoteSpec,
    opts: DualCallOpts,
): Promise<T> {
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

    const opId = getOpIdFromBody(remote.body);
    const commandName = getCommandNameForRemote(remote, opts);

    assertWriteMetadata(remote, opts, opId, commandName);

    if (opId) {
        headers["X-Idempotency-Key"] = opId;
    }

    if (commandName) {
        headers["X-Command-Name"] = commandName;
    }

    if (!opts.skipAuth) {
        const sigPath = pathForSig(remote.path);
        const auth = await getAuthHeadersFromTauri({ method, path: sigPath });

        headers.authorization = auth.authorization;
        headers["X-Device-Ts"] = auth.deviceTs;
        headers["X-Device-Sig"] = auth.deviceSig;
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

    let parsed = safeJsonParse(txt);

    if (remote.unwrapOkEnvelope) {
        parsed = unwrapOkEnvelope(parsed);
    }

    return parsed as T;
}

/* =========================================================
    Applied local marker
========================================================= */

async function markAfterRemoteOkApplied<T>(
    remote: RemoteSpec,
    opts: DualCallOpts<T>,
    log: (...args: unknown[]) => void,
): Promise<void> {
    const opId = getOpIdFromBody(remote.body);
    const commandName = getCommandNameForRemote(remote, opts);

    if (!opId || !commandName) {
        log("skip markLocalOperationApplied", {
            opId,
            commandName,
            path: remote.path,
        });
        return;
    }

    await markLocalOperationApplied({
        opId,
        commandName,
        source: "afterRemoteOk",
    });

    log("markLocalOperationApplied ok", {
        opId,
        commandName,
        source: "afterRemoteOk",
    });
}

function buildPendingLocalApplyPayload(
    remote: RemoteSpec,
    opts: DualCallOpts,
): {
    opId: string;
    commandName: string;
    payloadJson: string;
} {
    const opId = getOpIdFromBody(remote.body);
    const commandName = getCommandNameForRemote(remote, opts);

    if (!opId || !commandName) {
        throw new Error("missing_pending_local_apply_metadata");
    }

    const body = remote.body ?? {};
    const args =
        body?.args ??
        body?.payload?.args ??
        body?.input?.args ??
        body ??
        {};

    return {
        opId,
        commandName,
        payloadJson: JSON.stringify({
            op_id: opId,
            command_name: commandName,
            args,
        }),
    };
}

async function enqueuePendingLocalApply<T>(
    remote: RemoteSpec,
    opts: DualCallOpts<T>,
    remoteResult: T,
): Promise<void> {
    const pending = buildPendingLocalApplyPayload(remote, opts);

    await invoke("sync_enqueue_pending_local_apply", {
        args: {
            op_id: pending.opId,
            command_name: pending.commandName,
            payload_json: pending.payloadJson,
            result_json: JSON.stringify(remoteResult ?? null),
        },
    });
}

/* =========================================================
    Remote only
========================================================= */

async function runRemoteOnly<T>(
    remote: RemoteSpec,
    opts: DualCallOpts<T>,
    log: (...args: unknown[]) => void,
): Promise<T> {
    try {
        log("remote-only ->", remote.method ?? "POST", remote.path, {
            kind: opts.kind ?? "read",
            hasBody: remote.body !== undefined,
            skipAuth: !!opts.skipAuth,
            unwrapOkEnvelope: !!remote.unwrapOkEnvelope,
            opId: getOpIdFromBody(remote.body),
            commandName: getCommandNameForRemote(remote, opts),
        });

        const out = await fetchJsonRemote<T>(remote, opts);

        useNet.getState().setOnline();

        log("remote-only ok");
        return out;
    } catch (e) {
        const availabilityError = isAvailabilityError(e);

        log("remote-only fail:", normalizeErrorMessage(e), {
            availabilityError,
        });

        if (availabilityError) {
            markApiUnavailableOffline();
        }

        throw e;
    }
}

/* =========================================================
    dualCall
========================================================= */

export async function dualCall<T>(
    remote: RemoteSpec,
    localFn: () => Promise<T>,
    opts: DualCallOpts<T> = {},
): Promise<T> {
    const {
        kind = "read",
        debugTag,
        skipAuth = false,
        allowWriteDuringResync = false,
        allowReadRemoteDuringResync = true,
        fallbackToLocalOnAvailabilityError = true,
        afterRemoteOk,
        afterRemoteOkMode = "background",
    } = opts;

    const mode = useMode.getState().mode;
    const isTpvMain = mode === "tpv";
    const isHandy = mode === "handy";

    const net = useNet.getState();
    const sync = useSync.getState();

    const online = net.status === "online";
    const resyncing = sync.status === "resyncing";

    const normalizedOpts: DualCallOpts<T> = {
        ...opts,
        kind,
        skipAuth,
        allowWriteDuringResync,
        allowReadRemoteDuringResync,
        fallbackToLocalOnAvailabilityError,
        afterRemoteOk,
        afterRemoteOkMode,
    };

    const log = (...args: unknown[]) => {
        if (!debugTag) return;
        console.log(`[dualCall:${debugTag}]`, ...args);
    };

    if (isHandy) {
        return await runRemoteOnly<T>(
            remote,
            {
                ...normalizedOpts,
                fallbackToLocalOnAvailabilityError: false,
            },
            log,
        );
    }

    if (!isTpvMain) {
        return await runRemoteOnly<T>(
            remote,
            {
                ...normalizedOpts,
                fallbackToLocalOnAvailabilityError: false,
            },
            log,
        );
    }

    if (resyncing) {
        if (kind === "write" && !allowWriteDuringResync) {
            log("blocked by resync");
            throw new Error("sync_locked");
        }

        if (kind === "read" && !allowReadRemoteDuringResync && !online) {
            log("local -> resyncing read without online");
            return await localFn();
        }
    }

    if (online) {
        try {
            log("remote ->", remote.method ?? "POST", remote.path, {
                kind,
                online,
                resyncing,
                hasBody: remote.body !== undefined,
                skipAuth,
                unwrapOkEnvelope: !!remote.unwrapOkEnvelope,
                hasAfterRemoteOk: !!afterRemoteOk,
                afterRemoteOkMode,
                opId: getOpIdFromBody(remote.body),
                commandName: getCommandNameForRemote(remote, normalizedOpts),
            });

            const out = await fetchJsonRemote<T>(remote, normalizedOpts);

            useNet.getState().setOnline();

            if (kind === "write" && afterRemoteOk) {
                if (afterRemoteOkMode === "background") {
                    log("afterRemoteOk -> enqueue pending local apply");

                    try {
                        await enqueuePendingLocalApply(remote, normalizedOpts, out);
                    } catch (e) {
                        const msg = normalizeErrorMessage(e);
                        log("enqueuePendingLocalApply fail, fallback to await:", msg);

                        await afterRemoteOk(out);
                        await markAfterRemoteOkApplied(remote, normalizedOpts, log);
                    }
                } else {
                    log("afterRemoteOk -> local without outbox");

                    try {
                        await afterRemoteOk(out);
                        await markAfterRemoteOkApplied(remote, normalizedOpts, log);
                    } catch (e) {
                        const msg = normalizeErrorMessage(e);
                        log("afterRemoteOk fail:", msg);
                        throw new Error(`after_remote_ok_local_apply_failed:${msg}`);
                    }
                }
            }

            log("remote ok");
            return out;
        } catch (e) {
            const availabilityError = isAvailabilityError(e);

            log("remote fail:", normalizeErrorMessage(e), {
                availabilityError,
            });

            if (!availabilityError) {
                throw e;
            }

            markApiUnavailableOffline();

            if (!fallbackToLocalOnAvailabilityError) {
                throw e;
            }

            log("switch offline -> local");
            return await localFn();
        }
    }

    log("local ->", {
        kind,
        online,
        resyncing,
        mode,
    });

    return await localFn();
}