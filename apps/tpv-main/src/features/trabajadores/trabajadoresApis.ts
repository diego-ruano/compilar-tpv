// src/features/trabajadores/trabajadoresApis.ts
//
// API de trabajadores / horarios — Local-First puro. Sustituye el antiguo dualCall
// (remoto + local + outbox + op_id + afterRemoteOk) por invocación directa del comando
// Tauri vía @tpv/client. Las firmas exportadas y los tipos de retorno NO cambian, así que
// los componentes que la consumen (Trabajadores.tsx) siguen igual. Los payloads que
// devuelve Rust ya vienen en PascalCase (serde rename), idénticos a estos tipos.

import { invokeClient } from "@tpv/client";
import type { TrabajadorRow, TurnoRow, AsignacionRow } from "@tpv/contracts";

// Tipos autogenerados desde Rust (ts-rs). Se reexportan con los nombres que ya
// consumían los componentes (Turno/Asignacion) para no duplicar la definición.
export type { TrabajadorRow };
export type Turno = TurnoRow;
export type Asignacion = AsignacionRow;

/* =========================================================
   Reads
========================================================= */

export async function trabajadoresGetAll(): Promise<TrabajadorRow[]> {
    const rows = await invokeClient<TrabajadorRow[]>("trabajadores_get_all");
    return rows ?? [];
}

export async function trabajadoresGetTrabajadorIdByUsuario(
    idUsuario: number,
): Promise<number | null> {
    return await invokeClient<number | null>(
        "trabajadores_get_trabajador_id_by_usuario",
        { args: { id_usuario: Number(idUsuario) } },
    );
}

export async function turnosGetAll(): Promise<Turno[]> {
    const rows = await invokeClient<Turno[]>("turnos_get_all");
    return rows ?? [];
}

export async function horariosGetAsignacionesSemana(
    fechaLunes: string,
): Promise<Asignacion[]> {
    const rows = await invokeClient<Asignacion[]>(
        "horarios_get_asignaciones_semana",
        { args: { fecha_lunes: String(fechaLunes ?? "") } },
    );
    return rows ?? [];
}

/* =========================================================
   Writes
========================================================= */

export async function horariosCreateAsignacion(payload: {
    idTrabajador: number;
    fecha: string;
    idTurno: number;
    area: string;
    horaInicio?: string | null;
    horaFin?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    const result = await invokeClient<boolean>("horarios_create_asignacion", {
        args: {
            id_trabajador: Number(payload.idTrabajador),
            fecha: String(payload.fecha ?? ""),
            id_turno: Number(payload.idTurno),
            area: String(payload.area ?? ""),
            hora_inicio: payload.horaInicio ?? null,
            hora_fin: payload.horaFin ?? null,
            notas: payload.notas ?? null,
        },
    });
    return !!result;
}

export async function horariosUpdateAsignacion(payload: {
    idAsignacion: number;
    idTurno: number;
    area: string;
    horaInicio?: string | null;
    horaFin?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    const result = await invokeClient<boolean>("horarios_update_asignacion", {
        args: {
            id_asignacion: Number(payload.idAsignacion),
            id_turno: Number(payload.idTurno),
            area: String(payload.area ?? ""),
            hora_inicio: payload.horaInicio ?? null,
            hora_fin: payload.horaFin ?? null,
            notas: payload.notas ?? null,
        },
    });
    return !!result;
}

export async function horariosDeleteAsignacion(
    idAsignacion: number,
): Promise<boolean> {
    const result = await invokeClient<boolean>("horarios_delete_asignacion", {
        args: { id_asignacion: Number(idAsignacion) },
    });
    return !!result;
}

export async function horariosCopySemanaAsignaciones(payload: {
    fromMonday: string;
    toMonday: string;
    overwrite?: boolean;
}): Promise<boolean> {
    const result = await invokeClient<boolean>(
        "horarios_copy_semana_asignaciones",
        {
            args: {
                from_monday: String(payload.fromMonday ?? ""),
                to_monday: String(payload.toMonday ?? ""),
                overwrite: payload.overwrite ?? true,
            },
        },
    );
    return !!result;
}

export async function horariosSetPredeterminadoDesdeSemana(
    fechaLunes: string,
): Promise<boolean> {
    const result = await invokeClient<boolean>(
        "horarios_set_predeterminado_desde_semana",
        { args: { fecha_lunes: String(fechaLunes ?? "") } },
    );
    return !!result;
}
