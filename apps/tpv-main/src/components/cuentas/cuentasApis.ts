// src/components/cuentas/cuentasApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

/* =========================
   Tipos UI
========================= */

export type Entrada = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD HH:mm"
    cliente: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
};

export type Salida = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD"
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: number | null;
};

export type ProveedorMini = {
    id: number;
    nombre: string;
};

export type Denom = {
    label: string;
    value: number;
    kind: "moneda" | "billete";
};

export type CashCount = Record<string, number>;

type CommandBody<TArgs extends Record<string, any>> = {
    op_id: string;
    command_name: string;
    args: TArgs;
};

type LocalWriteArgs<T extends Record<string, any>> = T & {
    op_id: string;
    enqueue_outbox?: boolean;
};

type CreateGastoDomainArgs = {
    id_gasto?: number;
    fecha: string;
    tipo_gasto: string;
    concepto: string;
    importe: number;
    proveedor_id: number | null;
};

type UpdateGastoDomainArgs = {
    id_gasto: number;
    fecha: string;
    tipo_gasto: string;
    concepto: string;
    importe: number;
    proveedor_id: number | null;
};

type DeleteGastoDomainArgs = {
    id_gasto: number;
};

type UpdatePagoDomainArgs = {
    id_pago: number;
    fecha_hora: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
};

type DeletePagoDomainArgs = {
    id_pago: number;
};

/* =========================
   Constantes
========================= */

const COMMAND_CREATE_GASTO = "cuentas.createGasto";
const COMMAND_UPDATE_GASTO = "cuentas.updateGasto";
const COMMAND_DELETE_GASTO = "cuentas.deleteGasto";
const COMMAND_UPDATE_PAGO = "cuentas.updatePago";
const COMMAND_DELETE_PAGO = "cuentas.deletePago";

const LS_KEY_X_FONDO = "cuentas_x_fondo_v1";

export const DEFAULT_DENOMS: Denom[] = [
    { label: "0.01€", value: 0.01, kind: "moneda" },
    { label: "0.02€", value: 0.02, kind: "moneda" },
    { label: "0.05€", value: 0.05, kind: "moneda" },
    { label: "0.10€", value: 0.1, kind: "moneda" },
    { label: "0.20€", value: 0.2, kind: "moneda" },
    { label: "0.50€", value: 0.5, kind: "moneda" },
    { label: "1€", value: 1, kind: "moneda" },
    { label: "2€", value: 2, kind: "moneda" },
    { label: "5€", value: 5, kind: "billete" },
    { label: "10€", value: 10, kind: "billete" },
    { label: "20€", value: 20, kind: "billete" },
    { label: "50€", value: 50, kind: "billete" },
    { label: "100€", value: 100, kind: "billete" },
    { label: "200€", value: 200, kind: "billete" },
];

/* =========================
   Helpers
========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function cleanString(v: any): string {
    return String(v ?? "").trim();
}

function toPositiveIntOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function makeOpId(scope: string): string {
    const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandBody<TArgs extends Record<string, any>>(
    opId: string,
    commandName: string,
    args: TArgs,
): CommandBody<TArgs> {
    return {
        op_id: opId,
        command_name: commandName,
        args,
    };
}

function localWriteArgs<T extends Record<string, any>>(
    opId: string,
    args: T,
    enqueueOutbox = true,
): LocalWriteArgs<T> {
    return {
        op_id: opId,
        ...args,
        enqueue_outbox: enqueueOutbox,
    };
}

function unwrapMaybeOkEnvelope<T>(x: any): T {
    if (!x || typeof x !== "object") return x as T;
    if (!("ok" in x)) return x as T;

    if (!x.ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    if ("result" in x) return x.result as T;
    if ("user" in x) return x.user as T;
    if ("status" in x) return x.status as T;
    if ("data" in x) return x.data as T;

    return x as T;
}

function extractGastoId(x: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(x);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const id = toNum(
        data?.id_gasto ??
        data?.idGasto ??
        data?.ID_Gasto ??
        data?.gasto?.id_gasto ??
        data?.gasto?.idGasto ??
        data?.gasto?.ID_Gasto,
        0,
    );

    return id > 0 ? id : null;
}

function mapEntrada(r: any): Entrada {
    const metodoRaw = toStr(
        r?.metodo ?? r?.Metodo_Pago ?? r?.metodo_pago,
        "Efectivo",
    );

    return {
        id: toStr(r?.id ?? r?.ID_Pago ?? r?.id_pago ?? ""),
        fechaHora: toStr(r?.fechaHora ?? r?.fecha_hora ?? r?.Fecha_Hora ?? ""),
        cliente: toStr(r?.cliente ?? r?.Cliente ?? "—"),
        metodo: metodoRaw === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe: toNum(r?.importe ?? r?.Importe_Total ?? r?.importe_total, 0),
    };
}

function mapSalida(r: any): Salida {
    return {
        id: toStr(r?.id ?? r?.ID_Gasto ?? r?.id_gasto ?? ""),
        fechaHora: toStr(
            r?.fechaHora ?? r?.fecha_hora ?? r?.fecha ?? r?.Fecha ?? "",
        ),
        tipoGasto: toStr(r?.tipoGasto ?? r?.tipo_gasto ?? r?.Tipo_Gasto ?? ""),
        concepto: toStr(r?.concepto ?? r?.Concepto ?? ""),
        importe: toNum(r?.importe ?? r?.Importe ?? 0),
        proveedorId: toPositiveIntOrNull(
            r?.proveedorId ??
            r?.proveedor_id ??
            r?.id_proveedor ??
            r?.ID_Proveedor,
        ),
    };
}

/* =========================
   Local helpers
========================= */

async function invokeLocalArgs<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

async function localCreateGasto(
    args: LocalWriteArgs<CreateGastoDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("cuentas_create_gasto", args);
}

async function localUpdateGasto(
    args: LocalWriteArgs<UpdateGastoDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("cuentas_update_gasto", args);
}

async function localDeleteGasto(
    args: LocalWriteArgs<DeleteGastoDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("cuentas_delete_gasto", args);
}

async function localUpdatePago(
    args: LocalWriteArgs<UpdatePagoDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("cuentas_update_pago", args);
}

async function localDeletePago(
    args: LocalWriteArgs<DeletePagoDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("cuentas_delete_pago", args);
}

/* =========================
   Proveedores mini
========================= */

export async function cuentasListProveedoresMini(): Promise<ProveedorMini[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/inventario/proveedores-mini",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invoke<any[]>("inventario_list_proveedores_mini"),
        {
            kind: "read",
            debugTag: "cuentas:listProveedoresMini",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);

    return (rows ?? [])
        .map((r) => ({
            id: Number(r?.id ?? r?.ID_Proveedor ?? r?.id_proveedor ?? 0),
            nombre: String(
                r?.nombre ?? r?.Nombre_Empresa ?? r?.nombre_empresa ?? "",
            ),
        }))
        .filter((p) => p.id > 0 && !!p.nombre);
}

/* =========================
   GET
========================= */

export async function cuentasGetEntradas(params: {
    del?: string | null;
    al?: string | null;
}): Promise<Entrada[]> {
    const args = {
        del: params.del ?? null,
        al: params.al ?? null,
    };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/bills/entradas",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invoke<any[]>("cuentas_get_entradas", { args }),
        {
            kind: "read",
            debugTag: "cuentas:getEntradas",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return (rows ?? []).map(mapEntrada);
}

export async function cuentasGetSalidas(params: {
    del?: string | null;
    al?: string | null;
}): Promise<Salida[]> {
    const args = {
        del: params.del ?? null,
        al: params.al ?? null,
    };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/bills/salidas",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invoke<any[]>("cuentas_get_salidas", { args }),
        {
            kind: "read",
            debugTag: "cuentas:getSalidas",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return (rows ?? []).map(mapSalida);
}

/* =========================
   CRUD GASTOS
========================= */

export async function cuentasCreateGasto(payload: {
    fecha: string;
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: number | null;
}): Promise<boolean> {
    const opId = makeOpId("cuentas_create_gasto");

    const args: CreateGastoDomainArgs = {
        fecha: cleanString(payload.fecha),
        tipo_gasto: cleanString(payload.tipoGasto),
        concepto: cleanString(payload.concepto),
        importe: Number(payload.importe ?? 0),
        proveedor_id: toPositiveIntOrNull(payload.proveedorId),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/bills/gasto/create",
            method: "POST",
            body: commandBody(opId, COMMAND_CREATE_GASTO, args),
            unwrapOkEnvelope: true,
        },
        () => localCreateGasto(localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMAND_CREATE_GASTO,
            debugTag: "cuentas:createGasto",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteId = extractGastoId(remoteResult);

                if (!remoteId) {
                    throw new Error("remote_id_gasto_missing");
                }

                await localCreateGasto(
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_gasto: remoteId,
                        },
                        false,
                    ),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function cuentasUpdateGasto(payload: {
    idGasto: number;
    fecha: string;
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: number | null;
}): Promise<boolean> {
    const opId = makeOpId("cuentas_update_gasto");

    const args: UpdateGastoDomainArgs = {
        id_gasto: Number(payload.idGasto),
        fecha: cleanString(payload.fecha),
        tipo_gasto: cleanString(payload.tipoGasto),
        concepto: cleanString(payload.concepto),
        importe: Number(payload.importe ?? 0),
        proveedor_id: toPositiveIntOrNull(payload.proveedorId),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/bills/gasto/update",
            method: "POST",
            body: commandBody(opId, COMMAND_UPDATE_GASTO, args),
            unwrapOkEnvelope: true,
        },
        () => localUpdateGasto(localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMAND_UPDATE_GASTO,
            debugTag: "cuentas:updateGasto",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localUpdateGasto(localWriteArgs(opId, args, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function cuentasDeleteGasto(idGasto: number): Promise<boolean> {
    const opId = makeOpId("cuentas_delete_gasto");

    const args: DeleteGastoDomainArgs = {
        id_gasto: Number(idGasto),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/bills/gasto/delete",
            method: "POST",
            body: commandBody(opId, COMMAND_DELETE_GASTO, args),
            unwrapOkEnvelope: true,
        },
        () => localDeleteGasto(localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMAND_DELETE_GASTO,
            debugTag: "cuentas:deleteGasto",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localDeleteGasto(localWriteArgs(opId, args, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

/* =========================
   CRUD PAGOS / ENTRADAS
========================= */

export async function cuentasUpdatePago(payload: {
    idPago: number;
    fechaHora: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
}): Promise<boolean> {
    const opId = makeOpId("cuentas_update_pago");

    const args: UpdatePagoDomainArgs = {
        id_pago: Number(payload.idPago),
        fecha_hora: cleanString(payload.fechaHora),
        metodo: payload.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe: Number(payload.importe ?? 0),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/bills/pago/update",
            method: "POST",
            body: commandBody(opId, COMMAND_UPDATE_PAGO, args),
            unwrapOkEnvelope: true,
        },
        () => localUpdatePago(localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMAND_UPDATE_PAGO,
            debugTag: "cuentas:updatePago",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localUpdatePago(localWriteArgs(opId, args, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function cuentasDeletePago(idPago: number): Promise<boolean> {
    const opId = makeOpId("cuentas_delete_pago");

    const args: DeletePagoDomainArgs = {
        id_pago: Number(idPago),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/bills/pago/delete",
            method: "POST",
            body: commandBody(opId, COMMAND_DELETE_PAGO, args),
            unwrapOkEnvelope: true,
        },
        () => localDeletePago(localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMAND_DELETE_PAGO,
            debugTag: "cuentas:deletePago",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localDeletePago(localWriteArgs(opId, args, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

/* =========================================================
   X Caja - solo frontend
========================================================= */

export function getXFondo(): CashCount {
    try {
        const raw = localStorage.getItem(LS_KEY_X_FONDO);
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};

        return parsed as CashCount;
    } catch {
        return {};
    }
}

export function setXFondo(count: CashCount): void {
    try {
        localStorage.setItem(LS_KEY_X_FONDO, JSON.stringify(count ?? {}));
    } catch {
        // noop
    }
}

export function cashTotal(denoms: Denom[], count: CashCount): number {
    let sum = 0;

    for (const d of denoms) {
        const n = Number(count?.[d.label] ?? 0);
        if (Number.isFinite(n) && n > 0) {
            sum += d.value * n;
        }
    }

    return Math.round(sum * 100) / 100;
}

export function calcDeltaToReachFondo(args: {
    denoms: Denom[];
    fondo: CashCount;
    cierre: CashCount;
}): Array<{
    label: string;
    value: number;
    delta: number;
    kind: Denom["kind"];
}> {
    const { denoms, fondo, cierre } = args;

    return denoms.map((d) => {
        const target = Number(fondo?.[d.label] ?? 0);
        const end = Number(cierre?.[d.label] ?? 0);

        const delta =
            (Number.isFinite(target) ? target : 0) -
            (Number.isFinite(end) ? end : 0);

        return {
            label: d.label,
            value: d.value,
            delta,
            kind: d.kind,
        };
    });
}

export function incCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = value + step;

    return next;
}

export function decCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = Math.max(0, value - step);

    return next;
}

export function resetCash(): CashCount {
    return {};
}