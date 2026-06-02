// src/components/reservas/reservasApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

/* =========================
   Tipos UI
========================= */

export type Turno = "DESAYUNO" | "COMIDA" | "CAFE" | "CENA";

export type Zona = {
    idZona: number;
    nombre: string;
};

export type Mesa = {
    idMesa: number;
    idZona: number;
    nombre: string;
    capacidad: number;
};

export type ReservaRow = {
    ID_Reserva: number;
    ID_Mesa: number;
    Dia_YMD: string;
    Hora: string;
    Turno: string | null;
    Comensales: number;
    Nota: string | null;
    Estado: string;

    Nombre_Cliente: string;
    Telefono_Cliente: string | null;
    Email_Cliente: string | null;

    ID_Zona: number;
    Numero_Mesa: string;
    Capacidad: number;
    Nombre_Zona: string;
};

export type ReservasMeta = {
    zonas: Zona[];
    mesas: Mesa[];
};

export type ReservaSaveInput = {
    idReserva?: number | null;

    diaYMD: string;
    hora: string;
    turno?: Turno | null;
    comensales: number;
    nota?: string | null;
    estado?: string | null;

    idMesa: number;

    nombreCliente: string;
    telefono?: string | null;
    email?: string | null;
    notasCliente?: string | null;
};

type CommandBody<TArgs extends Record<string, any>> = {
    op_id: string;
    command_name: string;
    args: TArgs;
};

type LocalWriteArgs<TArgs extends Record<string, any>> = TArgs & {
    op_id: string;
    enqueue_outbox?: boolean;
};

/* =========================
   Constantes
========================= */

const COMMANDS = {
    reservasSave: "reservas.save",
    reservasDelete: "reservas.delete",
} as const;

/* =========================
   Helpers
========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
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

function localWriteArgs<TArgs extends Record<string, any>>(
    opId: string,
    args: TArgs,
    enqueueOutbox = true,
): LocalWriteArgs<TArgs> {
    return {
        op_id: opId,
        ...args,
        enqueue_outbox: enqueueOutbox,
    };
}

function extractReservaIdFromRemote(raw: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(raw);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const candidates = [
        data?.id_reserva,
        data?.idReserva,
        data?.ID_Reserva,
        data?.reserva?.id_reserva,
        data?.reserva?.idReserva,
        data?.reserva?.ID_Reserva,
        data?.result?.id_reserva,
        data?.result?.idReserva,
        data?.result?.ID_Reserva,
        data?.data?.id_reserva,
        data?.data?.idReserva,
        data?.data?.ID_Reserva,
    ];

    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }

    return null;
}

function turnoPorHora(hhmm: string): Turno {
    const [hhStr, mmStr] = String(hhmm || "00:00").split(":");
    const h = Number(hhStr ?? 0);
    const m = Number(mmStr ?? 0);
    const mins = h * 60 + m;

    if (mins < 13 * 60) return "DESAYUNO";
    if (mins < 16 * 60) return "COMIDA";
    if (mins < 19 * 60) return "CAFE";
    return "CENA";
}

/* =========================
   Helpers Tauri local
========================= */

async function invokeLocalRead<T>(
    command: string,
    args?: Record<string, any>,
): Promise<T> {
    if (args === undefined) {
        return await invoke<T>(command);
    }

    return await invoke<T>(command, { args });
}

async function invokeLocalWrite<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

/* =========================
   Mappers snake_case -> TS
========================= */

function mapMeta(r: any): ReservasMeta {
    const zonasRaw = Array.isArray(r?.zonas)
        ? r.zonas
        : Array.isArray(r?.Zonas)
            ? r.Zonas
            : [];

    const mesasRaw = Array.isArray(r?.mesas)
        ? r.mesas
        : Array.isArray(r?.Mesas)
            ? r.Mesas
            : [];

    const zonas: Zona[] = zonasRaw
        .map((z: any): Zona => ({
            idZona: toNum(z?.id_zona ?? z?.ID_Zona ?? z?.idZona, 0),
            nombre: String(z?.nombre_zona ?? z?.Nombre_Zona ?? z?.nombre ?? ""),
        }))
        .filter((z: Zona) => z.idZona > 0);

    const mesas: Mesa[] = mesasRaw
        .map((m: any): Mesa => ({
            idMesa: toNum(m?.id_mesa ?? m?.ID_Mesa ?? m?.idMesa, 0),
            idZona: toNum(m?.id_zona ?? m?.ID_Zona ?? m?.idZona, 0),
            nombre: String(m?.numero_mesa ?? m?.Numero_Mesa ?? m?.nombre ?? ""),
            capacidad: toNum(m?.capacidad ?? m?.Capacidad, 0),
        }))
        .filter((m: Mesa) => m.idMesa > 0);

    return { zonas, mesas };
}

function mapReserva(r: any): ReservaRow {
    return {
        ID_Reserva: toNum(r?.id_reserva ?? r?.ID_Reserva ?? r?.idReserva, 0),
        ID_Mesa: toNum(r?.id_mesa ?? r?.ID_Mesa ?? r?.idMesa, 0),
        Dia_YMD: String(r?.dia_ymd ?? r?.Dia_YMD ?? r?.diaYMD ?? ""),
        Hora: String(r?.hora ?? r?.Hora ?? ""),
        Turno: toNullableStr(r?.turno ?? r?.Turno),
        Comensales: toNum(r?.comensales ?? r?.Comensales, 0),
        Nota: toNullableStr(r?.nota ?? r?.Nota),
        Estado: String(r?.estado ?? r?.Estado ?? "PROXIMA"),

        Nombre_Cliente: String(r?.nombre_cliente ?? r?.Nombre_Cliente ?? ""),
        Telefono_Cliente: toNullableStr(
            r?.telefono_cliente ?? r?.Telefono_Cliente,
        ),
        Email_Cliente: toNullableStr(r?.email_cliente ?? r?.Email_Cliente),

        ID_Zona: toNum(r?.id_zona ?? r?.ID_Zona ?? r?.idZona, 0),
        Numero_Mesa: String(r?.numero_mesa ?? r?.Numero_Mesa ?? ""),
        Capacidad: toNum(r?.capacidad ?? r?.Capacidad, 0),
        Nombre_Zona: String(r?.nombre_zona ?? r?.Nombre_Zona ?? ""),
    };
}

/* =========================
   API
========================= */

export async function reservasGetMeta(): Promise<ReservasMeta> {
    const raw = await dualCall<any>(
        {
            path: "/v1/reservas/meta",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any>("reservas_get_meta"),
        {
            kind: "read",
            debugTag: "reservas:getMeta",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return mapMeta(data);
}

export async function reservasGetMes(params: {
    desde: string;
    hasta: string;
}): Promise<ReservaRow[]> {
    const args = {
        desde: params.desde,
        hasta: params.hasta,
    };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/reservas/mes",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("reservas_get_mes", args),
        {
            kind: "read",
            debugTag: "reservas:getMes",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return (rows ?? []).map(mapReserva);
}

export async function reservasSave(input: ReservaSaveInput): Promise<boolean> {
    const opId = makeOpId("reservas_save");
    const turno: Turno = input.turno ?? turnoPorHora(input.hora);

    const args = {
        id_reserva: input.idReserva ?? null,
        remote_id_reserva: null as number | null,

        dia_ymd: input.diaYMD,
        hora: input.hora,
        turno,

        comensales: Number(input.comensales),
        nota: input.nota ?? null,
        estado: input.estado ?? null,

        id_mesa: Number(input.idMesa),

        nombre_cliente: input.nombreCliente,
        telefono: input.telefono ?? null,
        email: input.email ?? null,
        notas_cliente: input.notasCliente ?? null,
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/reservas/save",
            method: "POST",
            body: commandBody(opId, COMMANDS.reservasSave, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "reservas_save",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.reservasSave,
            debugTag: "reservas:save",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteRaw: any) => {
                const remoteId = extractReservaIdFromRemote(remoteRaw);
                const fallbackId = toNum(args.id_reserva, 0);
                const finalId = remoteId ?? (fallbackId > 0 ? fallbackId : null);

                if (!finalId) {
                    throw new Error("remote_id_reserva_missing");
                }

                await invokeLocalWrite<any>(
                    "reservas_save_after_remote_ok",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            remote_id_reserva: finalId,
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

export async function reservasDelete(params: {
    idReserva: number;
}): Promise<boolean> {
    const opId = makeOpId("reservas_delete");

    const args = {
        id_reserva: Number(params.idReserva),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/reservas/delete",
            method: "POST",
            body: commandBody(opId, COMMANDS.reservasDelete, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "reservas_delete",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.reservasDelete,
            debugTag: "reservas:delete",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>(
                    "reservas_delete_after_remote_ok",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}