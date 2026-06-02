// src/components/clientes/clientesApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

export type FiltroRanking = "todos" | "reservas" | "gasto";

export type ClienteRow = {
    ID_Cliente: number;
    Nombre: string;
    Email: string | null;
    Telefono: string | null;

    Ultima_Reserva_Fecha: string | null;
    Ultima_Reserva_Hora: string | null;
    Ultima_Reserva_NumPersonas: number | null;
    Ultima_Reserva_Mesa: string | null;

    Total_Gastado_Calculado: number | null;
    Total_Gastado_Stored: number | null;

    Total_Reservas: number | null;
    Reservas_Pendientes: number | null;
};

export type ClienteFormRow = {
    Nombre: string;
    Email: string | null;
    Telefono: string | null;
    Notas: string | null;
};

type ClientesOverviewArgs = {
    ranking: FiltroRanking;
};

type ClienteFormArgs = {
    id_cliente: number;
};

type ClienteCreateDomainArgs = {
    id_cliente?: number;
    nombre: string;
    email: string | null;
    telefono: string | null;
    notas: string | null;
};

type ClienteUpdateDomainArgs = {
    id_cliente: number;
    nombre: string;
    email: string | null;
    telefono: string | null;
    notas: string | null;
};

type LocalWriteArgs<T extends Record<string, any>> = T & {
    op_id: string;
    enqueue_outbox?: boolean;
};

const COMMAND_CLIENTES_CREATE = "clients.createCliente";
const COMMAND_CLIENTES_UPDATE = "clients.updateCliente";

/* =========================================================
   Helpers
========================================================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
}

function makeOpId(scope: string): string {
    const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readBody<T extends Record<string, any>>(args: T): { args: T } {
    return { args };
}

function commandBody<TArgs extends Record<string, any>>(
    opId: string,
    commandName: string,
    args: TArgs,
): {
    op_id: string;
    command_name: string;
    args: TArgs;
} {
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

    if ("data" in x) return x.data as T;
    if ("result" in x) return x.result as T;
    if ("user" in x) return x.user as T;
    if ("status" in x) return x.status as T;

    return x as T;
}

function pick(obj: any, keys: string[], fallback?: any): any {
    for (const key of keys) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
            return obj[key];
        }
    }

    return fallback;
}

function extractClienteId(raw: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(raw);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const candidates = [
        data,
        data?.result,
        data?.data,
        data?.row,
        data?.item,
        data?.created,
        data?.updated,
        data?.cliente,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;

        const value = pick(candidate, [
            "id_cliente",
            "idCliente",
            "ID_Cliente",
        ]);

        const n = Number(value);

        if (Number.isFinite(n) && n > 0) {
            return Math.trunc(n);
        }
    }

    return null;
}

function mapRow(r: any): ClienteRow {
    return {
        ID_Cliente: toNum(r?.id_cliente ?? r?.idCliente ?? r?.ID_Cliente, 0),
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Email: toNullableStr(r?.email ?? r?.Email),
        Telefono: toNullableStr(r?.telefono ?? r?.Telefono),

        Ultima_Reserva_Fecha: toNullableStr(
            r?.ultima_reserva_fecha ??
            r?.ultimaReservaFecha ??
            r?.Ultima_Reserva_Fecha,
        ),
        Ultima_Reserva_Hora: toNullableStr(
            r?.ultima_reserva_hora ??
            r?.ultimaReservaHora ??
            r?.Ultima_Reserva_Hora,
        ),
        Ultima_Reserva_NumPersonas:
            r?.ultima_reserva_num_personas ??
            r?.ultimaReservaNumPersonas ??
            r?.Ultima_Reserva_NumPersonas ??
            null,
        Ultima_Reserva_Mesa: toNullableStr(
            r?.ultima_reserva_mesa ??
            r?.ultimaReservaMesa ??
            r?.Ultima_Reserva_Mesa,
        ),

        Total_Gastado_Calculado:
            r?.total_gastado_calculado ??
            r?.totalGastadoCalculado ??
            r?.Total_Gastado_Calculado ??
            0,
        Total_Gastado_Stored:
            r?.total_gastado_stored ??
            r?.totalGastadoStored ??
            r?.Total_Gastado_Stored ??
            0,

        Total_Reservas:
            r?.total_reservas ?? r?.totalReservas ?? r?.Total_Reservas ?? 0,
        Reservas_Pendientes:
            r?.reservas_pendientes ??
            r?.reservasPendientes ??
            r?.Reservas_Pendientes ??
            0,
    };
}

function mapForm(r: any): ClienteFormRow {
    return {
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Email: toNullableStr(r?.email ?? r?.Email),
        Telefono: toNullableStr(r?.telefono ?? r?.Telefono),
        Notas: toNullableStr(r?.notas ?? r?.Notas),
    };
}

/* =========================================================
   Local helpers
========================================================= */

async function invokeLocalArgs<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

async function localCreateCliente(
    args: LocalWriteArgs<ClienteCreateDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("clientes_create_cliente", args);
}

async function localUpdateCliente(
    args: LocalWriteArgs<ClienteUpdateDomainArgs>,
): Promise<any> {
    return await invokeLocalArgs<any>("clientes_update_cliente", args);
}

/* =========================================================
   API
========================================================= */

export async function clientesGetOverview(params: {
    ranking: FiltroRanking;
}): Promise<ClienteRow[]> {
    const args: ClientesOverviewArgs = {
        ranking: params.ranking,
    };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/clients/overview",
            method: "POST",
            body: readBody(args),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalArgs<any[]>("clientes_get_overview", args),
        {
            kind: "read",
            debugTag: "clients:getOverview",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return (rows ?? []).map(mapRow);
}

export async function clientesGetClienteForm(params: {
    idCliente: number;
}): Promise<ClienteFormRow | null> {
    const args: ClienteFormArgs = {
        id_cliente: Number(params.idCliente),
    };

    const raw = await dualCall<any | null>(
        {
            path: "/v1/clients/form",
            method: "POST",
            body: readBody(args),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalArgs<any | null>("clientes_get_cliente_form", args),
        {
            kind: "read",
            debugTag: "clients:getForm",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const row = unwrapMaybeOkEnvelope<any | null>(raw);
    return row ? mapForm(row) : null;
}

export async function clientesCreateCliente(params: {
    nombre: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    const opId = makeOpId("clientes_create_cliente");

    const domainArgs: ClienteCreateDomainArgs = {
        nombre: String(params.nombre ?? "").trim(),
        email: toNullableStr(params.email),
        telefono: toNullableStr(params.telefono),
        notas: toNullableStr(params.notas),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/clients/create",
            method: "POST",
            body: commandBody(opId, COMMAND_CLIENTES_CREATE, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => localCreateCliente(localWriteArgs(opId, domainArgs, true)),
        {
            kind: "write",
            debugTag: "clients:create",
            commandName: COMMAND_CLIENTES_CREATE,
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteId = extractClienteId(remoteResult);

                if (!remoteId) {
                    throw new Error("remote_id_cliente_missing");
                }

                const localArgs: ClienteCreateDomainArgs = {
                    ...domainArgs,
                    id_cliente: remoteId,
                };

                await localCreateCliente(localWriteArgs(opId, localArgs, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function clientesUpdateCliente(params: {
    idCliente: number;
    nombre: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    const opId = makeOpId("clientes_update_cliente");

    const domainArgs: ClienteUpdateDomainArgs = {
        id_cliente: Number(params.idCliente),
        nombre: String(params.nombre ?? "").trim(),
        email: toNullableStr(params.email),
        telefono: toNullableStr(params.telefono),
        notas: toNullableStr(params.notas),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/clients/update",
            method: "POST",
            body: commandBody(opId, COMMAND_CLIENTES_UPDATE, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => localUpdateCliente(localWriteArgs(opId, domainArgs, true)),
        {
            kind: "write",
            debugTag: "clients:update",
            commandName: COMMAND_CLIENTES_UPDATE,
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await localUpdateCliente(localWriteArgs(opId, domainArgs, false));
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}