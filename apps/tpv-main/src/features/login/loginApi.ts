// src/features/login/loginApi.ts
//
// API de login / auth / fichaje — Local-First puro (invokeClient vía @tpv/client).
// Sustituye dualCall/op_id/outbox/afterRemoteOk. Conserva tipos, mappers y firmas.

import { invokeClient } from "@tpv/client";

export type DbUser = {
    id_usuario: string;
    nombre: string;
    apellido: string | null;
    nombre_rol: string;
};

export type LoginOk = {
    id_usuario: string;
    id_trabajador: string | null;
    nombre: string;
    apellido: string | null;
    rol: string;
    email: string;
    requiere_setup: number;
};

/** Estado del setup del primer arranque. Se consulta SIN sesion, al abrir la app. */
export type SetupPendiente = {
    pendiente: boolean;
    id_usuario: string | null;
    nombre: string | null;
    email: string | null;
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
        id_usuario: toStr(r?.id_usuario ?? r?.idUsuario ?? r?.ID_Usuario, ""),
        nombre: toStr(r?.nombre ?? r?.Nombre, ""),
        apellido: toNullableStr(r?.apellido ?? r?.Apellido),
        nombre_rol: toStr(r?.nombre_rol ?? r?.nombreRol ?? r?.Nombre_Rol, ""),
    };
}

function mapLoginOk(r: any): LoginOk {
    const idTrabajadorRaw =
        r?.id_trabajador ?? r?.idTrabajador ?? r?.ID_Trabajador ?? null;

    return {
        id_usuario: toStr(r?.id_usuario ?? r?.idUsuario ?? r?.ID_Usuario, ""),
        id_trabajador: idTrabajadorRaw == null ? null : toStr(idTrabajadorRaw, ""),
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

/**
 * ¿Queda por elegir el PIN del primer arranque? Decide si la primera pantalla es la de setup o
 * la de login, asi que se pregunta antes de tener sesion. En un Handy siempre es `false`: el
 * setup es cosa de la Main.
 */
export async function fetchSetupPendiente(): Promise<SetupPendiente> {
    const r = await invokeClient<any>("setup_pendiente");
    return {
        pendiente: !!r?.pendiente,
        id_usuario: toNullableStr(r?.id_usuario),
        nombre: toNullableStr(r?.nombre),
        email: toNullableStr(r?.email),
    };
}

export async function loginUser(params: {
    idUsuario: string;
    pin: string;
}): Promise<LoginOk> {
    const data = await invokeClient<any>("login_user", {
        args: {
            id_usuario: params.idUsuario,
            pin: String(params.pin ?? ""),
        },
    });
    return mapLoginOk(data);
}

export async function getTodayPunchStatus(params: {
    idUsuario: string;
}): Promise<PunchStatus> {
    const data = await invokeClient<any>("get_today_punch_status", {
        args: { id_usuario: params.idUsuario },
    });
    return mapPunchStatus(data);
}

export async function punch(params: {
    idUsuario: string;
    pin: string;
    tipo: "entrada" | "salida";
}): Promise<PunchStatus> {
    const data = await invokeClient<any>("punch", {
        args: {
            id_usuario: params.idUsuario,
            pin: String(params.pin ?? ""),
            tipo: params.tipo,
            fecha: todayLocalYmd(),
            hora_evento: nowLocalSqlDateTime(),
        },
    });
    return mapPunchStatus(data);
}

export async function setTurnoPartidoHoy(params: {
    idUsuario: string;
    turnoPartido: boolean;
}): Promise<string> {
    const data = await invokeClient<any>("set_turno_partido_hoy", {
        args: {
            id_usuario: params.idUsuario,
            turno_partido: Boolean(params.turnoPartido),
            fecha: todayLocalYmd(),
        },
    });
    return typeof data === "string"
        ? data
        : toStr(data?.message ?? data?.status ?? "ok", "ok");
}

/**
 * Sube a la nube el setup inicial del admin (solo Main/TPV). Se llama DESPUÉS de
 * `completeInitialSetup` local, para que el login de la Handy use el PIN/email reales en vez
 * del seed. No es local-first: invoca el comando que firma y postea al worker.
 */
export async function uploadInitialSetupToCloud(params: {
    idUsuario: string;
    email: string;
    pin: string;
}): Promise<void> {
    await invokeClient<string>("config_upload_initial_setup", {
        args: {
            id_usuario: params.idUsuario,
            email: String(params.email ?? ""),
            pin: String(params.pin ?? ""),
        },
    });
}

export async function completeInitialSetup(params: {
    idUsuario: string;
    pinNuevo: string;
    emailNuevo: string;
}): Promise<string> {
    const data = await invokeClient<any>("complete_initial_setup", {
        args: {
            id_usuario: params.idUsuario,
            pin_nuevo: String(params.pinNuevo ?? ""),
            email_nuevo: String(params.emailNuevo ?? ""),
        },
    });
    return typeof data === "string"
        ? data
        : toStr(data?.message ?? data?.status ?? "ok", "ok");
}
