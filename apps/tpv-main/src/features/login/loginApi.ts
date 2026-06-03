// src/features/login/loginApi.ts
//
// API de login / auth / fichaje — Local-First puro (invokeClient vía @tpv/client).
// Sustituye dualCall/op_id/outbox/afterRemoteOk. Conserva tipos, mappers y firmas.

import { invokeClient } from "@tpv/client";

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
    return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join("-");
}

function nowLocalSqlDateTime(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
        d.getDate(),
    )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
        id_trabajador: idTrabajadorRaw == null ? null : toNum(idTrabajadorRaw, 0),
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
    const rows = await invokeClient<any[]>("list_login_users");
    return (rows ?? []).map(mapDbUser);
}

export async function loginUser(params: {
    idUsuario: number;
    pin: string;
}): Promise<LoginOk> {
    const data = await invokeClient<any>("login_user", {
        args: {
            id_usuario: Number(params.idUsuario),
            pin: String(params.pin ?? ""),
        },
    });
    return mapLoginOk(data);
}

export async function getTodayPunchStatus(params: {
    idUsuario: number;
}): Promise<PunchStatus> {
    const data = await invokeClient<any>("get_today_punch_status", {
        args: { id_usuario: Number(params.idUsuario) },
    });
    return mapPunchStatus(data);
}

export async function punch(params: {
    idUsuario: number;
    pin: string;
    tipo: "entrada" | "salida";
}): Promise<PunchStatus> {
    const data = await invokeClient<any>("punch", {
        args: {
            id_usuario: Number(params.idUsuario),
            pin: String(params.pin ?? ""),
            tipo: params.tipo,
            fecha: todayLocalYmd(),
            hora_evento: nowLocalSqlDateTime(),
        },
    });
    return mapPunchStatus(data);
}

export async function setTurnoPartidoHoy(params: {
    idUsuario: number;
    turnoPartido: boolean;
}): Promise<string> {
    const data = await invokeClient<any>("set_turno_partido_hoy", {
        args: {
            id_usuario: Number(params.idUsuario),
            turno_partido: Boolean(params.turnoPartido),
            fecha: todayLocalYmd(),
        },
    });
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
    const data = await invokeClient<any>("complete_initial_setup", {
        args: {
            id_usuario: Number(params.idUsuario),
            pin_actual: String(params.pinActual ?? ""),
            pin_nuevo: String(params.pinNuevo ?? ""),
            email_nuevo: String(params.emailNuevo ?? ""),
        },
    });
    return typeof data === "string"
        ? data
        : toStr(data?.message ?? data?.status ?? "ok", "ok");
}
