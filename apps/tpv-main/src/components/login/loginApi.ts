// src/components/login/loginApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

export type DbUser = {
    id_usuario: number;
    nombre: string;
    apellido: string | null;
    nombre_rol: string;
};

export type LoginOk = {
    id_usuario: number;
    id_trabajador: number | null;
    nombre: string;
    apellido: string | null;
    rol: string;
    email: string;
    requiere_setup: number;
};

export type PunchParte = {
    parte: number;
    entrada: string | null;
    salida: string | null;
    estado: string;
};

export type PunchStatus = {
    fecha: string;
    turno_partido: number;
    partes: PunchParte[];
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

/* =========================================================
   Constantes
========================================================= */

const COMMANDS = {
    punch: "login.punch",
    setTurnoPartidoHoy: "login.setTurnoPartidoHoy",
    completeInitialSetup: "login.completeInitialSetup",
} as const;

/* =========================================================
   Helpers
========================================================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function todayLocalYmd(): string {
    const d = new Date();

    return [
        d.getFullYear(),
        pad2(d.getMonth() + 1),
        pad2(d.getDate()),
    ].join("-");
}

function nowLocalSqlDateTime(): string {
    const d = new Date();

    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
        d.getDate(),
    )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
        d.getSeconds(),
    )}`;
}

function makeOpId(scope: string): string {
    const prefix = String(scope || "op").replace(/[^a-zA-Z0-9_-]/g, "_");

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

/* =========================================================
   Helpers Tauri local
========================================================= */

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

/* =========================================================
   Mappers
========================================================= */

function mapDbUser(r: any): DbUser {
    return {
        id_usuario: toNum(r?.id_usuario ?? r?.idUsuario ?? r?.ID_Usuario, 0),
        nombre: toStr(r?.nombre ?? r?.Nombre, ""),
        apellido: toNullableStr(r?.apellido ?? r?.Apellido),
        nombre_rol: toStr(r?.nombre_rol ?? r?.nombreRol ?? r?.Nombre_Rol, ""),
    };
}

function mapLoginOk(r: any): LoginOk {
    const idTrabajadorRaw =
        r?.id_trabajador ?? r?.idTrabajador ?? r?.ID_Trabajador ?? null;

    return {
        id_usuario: toNum(r?.id_usuario ?? r?.idUsuario ?? r?.ID_Usuario, 0),
        id_trabajador:
            idTrabajadorRaw == null ? null : toNum(idTrabajadorRaw, 0),
        nombre: toStr(r?.nombre ?? r?.Nombre, ""),
        apellido: toNullableStr(r?.apellido ?? r?.Apellido),
        rol: toStr(r?.rol ?? r?.Rol ?? r?.nombre_rol ?? r?.nombreRol, ""),
        email: toStr(r?.email ?? r?.Email, ""),
        requiere_setup: toNum(
            r?.requiere_setup ?? r?.requiereSetup ?? r?.Requiere_Setup,
            0,
        ),
    };
}

function mapPunchParte(r: any): PunchParte {
    return {
        parte: toNum(r?.parte ?? r?.Parte, 1),
        entrada: toNullableStr(r?.entrada ?? r?.Entrada),
        salida: toNullableStr(r?.salida ?? r?.Salida),
        estado: toStr(r?.estado ?? r?.Estado, ""),
    };
}

function mapPunchStatus(r: any): PunchStatus {
    const partesRaw = Array.isArray(r?.partes)
        ? r.partes
        : Array.isArray(r?.Partes)
            ? r.Partes
            : [];

    return {
        fecha: toStr(r?.fecha ?? r?.Fecha, ""),
        turno_partido: toNum(
            r?.turno_partido ?? r?.turnoPartido ?? r?.Turno_Partido,
            0,
        ),
        partes: partesRaw.map(mapPunchParte),
    };
}

/* =========================================================
   API
========================================================= */

export async function listLoginUsers(): Promise<DbUser[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/login/users",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("list_login_users"),
        {
            kind: "read",
            debugTag: "login:users",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return (rows ?? []).map(mapDbUser);
}

export async function loginUser(params: {
    idUsuario: number;
    pin: string;
}): Promise<LoginOk> {
    const args = {
        id_usuario: Number(params.idUsuario),
        pin: String(params.pin ?? ""),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/login/user",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any>("login_user", args),
        {
            kind: "read",
            debugTag: "login:user",
            fallbackToLocalOnAvailabilityError: true,
            allowReadRemoteDuringResync: true,
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return mapLoginOk(data);
}

export async function getTodayPunchStatus(params: {
    idUsuario: number;
}): Promise<PunchStatus> {
    const args = {
        id_usuario: Number(params.idUsuario),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/login/today_punch_status",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any>("get_today_punch_status", args),
        {
            kind: "read",
            debugTag: "login:todayPunchStatus",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return mapPunchStatus(data);
}

export async function punch(params: {
    idUsuario: number;
    pin: string;
    tipo: "entrada" | "salida";
}): Promise<PunchStatus> {
    const opId = makeOpId("login_punch");

    const domainArgs = {
        id_usuario: Number(params.idUsuario),
        pin: String(params.pin ?? ""),
        tipo: params.tipo,
        fecha: todayLocalYmd(),
        hora_evento: nowLocalSqlDateTime(),
    };

    const localArgs = localWriteArgs(opId, domainArgs, true);

    const raw = await dualCall<any>(
        {
            path: "/v1/login/punch",
            method: "POST",
            body: commandBody(opId, COMMANDS.punch, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("punch", localArgs),
        {
            kind: "write",
            commandName: COMMANDS.punch,
            debugTag: "login:punch",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>("punch", {
                    ...localArgs,
                    enqueue_outbox: false,
                });
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return mapPunchStatus(data);
}

export async function setTurnoPartidoHoy(params: {
    idUsuario: number;
    turnoPartido: boolean;
}): Promise<string> {
    const opId = makeOpId("login_set_turno_partido_hoy");

    const domainArgs = {
        id_usuario: Number(params.idUsuario),
        turno_partido: Boolean(params.turnoPartido),
        fecha: todayLocalYmd(),
    };

    const localArgs = localWriteArgs(opId, domainArgs, true);

    const raw = await dualCall<any>(
        {
            path: "/v1/login/set-turno-partido-hoy",
            method: "POST",
            body: commandBody(opId, COMMANDS.setTurnoPartidoHoy, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("set_turno_partido_hoy", localArgs),
        {
            kind: "write",
            commandName: COMMANDS.setTurnoPartidoHoy,
            debugTag: "login:setTurnoPartidoHoy",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>("set_turno_partido_hoy", {
                    ...localArgs,
                    enqueue_outbox: false,
                });
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);

    return typeof data === "string"
        ? data
        : toStr(data?.message ?? data?.status ?? "ok", "ok");
}

export async function completeInitialSetup(params: {
    idUsuario: number;
    pinActual: string;
    pinNuevo: string;
    emailNuevo: string;
}): Promise<string> {
    const opId = makeOpId("login_complete_initial_setup");

    const domainArgs = {
        id_usuario: Number(params.idUsuario),
        pin_actual: String(params.pinActual ?? ""),
        pin_nuevo: String(params.pinNuevo ?? ""),
        email_nuevo: String(params.emailNuevo ?? ""),
    };

    const localArgs = localWriteArgs(opId, domainArgs, true);

    const raw = await dualCall<any>(
        {
            path: "/v1/login/complete_initial_setup",
            method: "POST",
            body: commandBody(opId, COMMANDS.completeInitialSetup, domainArgs),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("complete_initial_setup", localArgs),
        {
            kind: "write",
            commandName: COMMANDS.completeInitialSetup,
            debugTag: "login:completeInitialSetup",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>("complete_initial_setup", {
                    ...localArgs,
                    enqueue_outbox: false,
                });
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);

    return typeof data === "string"
        ? data
        : toStr(data?.message ?? data?.status ?? "ok", "ok");
}