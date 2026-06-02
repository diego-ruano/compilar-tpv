// src/components/trabajadores/trabajadoresApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

export type TrabajadorRow = {
    ID_Trabajador: number;
    ID_Usuario: number;
    Nombre: string;
    Apellido: string | null;
    Email: string;
    Estado: string;
    Nombre_Rol: string;
    Telefono: string | null;
    Puesto: string | null;
};

export type Turno = {
    ID_Turno: number;
    Nombre_Turno: string;
};

export type Asignacion = {
    ID_Asignacion: number;
    ID_Trabajador: number;
    Fecha: string;
    ID_Turno: number;
    Area: string;
    Hora_Inicio: string | null;
    Hora_Fin: string | null;
    Notas: string | null;
    Nombre_Turno: string;
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
    createAsignacion: "horarios.createAsignacion",
    updateAsignacion: "horarios.updateAsignacion",
    deleteAsignacion: "horarios.deleteAsignacion",
    copySemanaAsignaciones: "horarios.copySemanaAsignaciones",
    setPredeterminadoDesdeSemana: "horarios.setPredeterminadoDesdeSemana",
} as const;

/* =========================================================
   Helpers
========================================================= */

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

function toPositiveIntOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function extractRemoteIdAsignacion(remoteResult: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(remoteResult);

    const direct =
        toPositiveIntOrNull(data?.id_asignacion) ??
        toPositiveIntOrNull(data?.idAsignacion) ??
        toPositiveIntOrNull(data?.ID_Asignacion) ??
        toPositiveIntOrNull(data?.id) ??
        toPositiveIntOrNull(data);

    if (direct) return direct;

    const candidates = [
        data?.asignacion,
        data?.Asignacion,
        data?.row,
        data?.item,
        data?.result,
        data?.data,
    ];

    for (const candidate of candidates) {
        const id =
            toPositiveIntOrNull(candidate?.id_asignacion) ??
            toPositiveIntOrNull(candidate?.idAsignacion) ??
            toPositiveIntOrNull(candidate?.ID_Asignacion) ??
            toPositiveIntOrNull(candidate?.id);

        if (id) return id;
    }

    return null;
}

function extractRemoteAsignaciones(remoteResult: any): any[] {
    const data = unwrapMaybeOkEnvelope<any>(remoteResult);

    const candidates = [
        data?.asignaciones,
        data?.Asignaciones,
        data?.rows,
        data?.items,
        data?.result,
        data?.data,
        data,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
    }

    return [];
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
   Reads
========================================================= */

export async function trabajadoresGetAll(): Promise<TrabajadorRow[]> {
    const raw = await dualCall<TrabajadorRow[]>(
        {
            path: "/v1/trabajadores/all",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<TrabajadorRow[]>("trabajadores_get_all"),
        {
            kind: "read",
            debugTag: "trabajadores:getAll",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<TrabajadorRow[]>(raw) ?? [];
}

export async function trabajadoresGetTrabajadorIdByUsuario(
    idUsuario: number,
): Promise<number | null> {
    const args = {
        id_usuario: Number(idUsuario),
    };

    const raw = await dualCall<number | null>(
        {
            path: "/v1/trabajadores/id-by-usuario",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<number | null>(
                "trabajadores_get_trabajador_id_by_usuario",
                args,
            ),
        {
            kind: "read",
            debugTag: "trabajadores:getTrabajadorIdByUsuario",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<number | null>(raw);
}

export async function turnosGetAll(): Promise<Turno[]> {
    const raw = await dualCall<Turno[]>(
        {
            path: "/v1/turnos/all",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<Turno[]>("turnos_get_all"),
        {
            kind: "read",
            debugTag: "turnos:getAll",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<Turno[]>(raw) ?? [];
}

export async function horariosGetAsignacionesSemana(
    fechaLunes: string,
): Promise<Asignacion[]> {
    const args = {
        fecha_lunes: String(fechaLunes ?? ""),
    };

    const raw = await dualCall<Asignacion[]>(
        {
            path: "/v1/horarios/asignaciones/semana",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<Asignacion[]>(
                "horarios_get_asignaciones_semana",
                args,
            ),
        {
            kind: "read",
            debugTag: "horarios:getAsignacionesSemana",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<Asignacion[]>(raw) ?? [];
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
    const opId = makeOpId("horarios_create_asignacion");

    const args = {
        id_trabajador: Number(payload.idTrabajador),
        fecha: String(payload.fecha ?? ""),
        id_turno: Number(payload.idTurno),
        area: String(payload.area ?? ""),
        hora_inicio: payload.horaInicio ?? null,
        hora_fin: payload.horaFin ?? null,
        notas: payload.notas ?? null,
    };

    const raw = await dualCall<boolean>(
        {
            path: "/v1/horarios/asignacion/create",
            method: "POST",
            body: commandBody(opId, COMMANDS.createAsignacion, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<boolean>(
                "horarios_create_asignacion",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.createAsignacion,
            debugTag: "horarios:createAsignacion",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteIdAsignacion = extractRemoteIdAsignacion(remoteResult);

                if (!remoteIdAsignacion) {
                    throw new Error("remote_id_asignacion_missing");
                }

                await invokeLocalWrite<boolean>(
                    "horarios_create_asignacion_after_remote_ok",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            remote_id_asignacion: remoteIdAsignacion,
                        },
                        false,
                    ),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : !!data;
}

export async function horariosUpdateAsignacion(payload: {
    idAsignacion: number;
    idTurno: number;
    area: string;
    horaInicio?: string | null;
    horaFin?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    const opId = makeOpId("horarios_update_asignacion");

    const args = {
        id_asignacion: Number(payload.idAsignacion),
        id_turno: Number(payload.idTurno),
        area: String(payload.area ?? ""),
        hora_inicio: payload.horaInicio ?? null,
        hora_fin: payload.horaFin ?? null,
        notas: payload.notas ?? null,
    };

    const raw = await dualCall<boolean>(
        {
            path: "/v1/horarios/asignacion/update",
            method: "POST",
            body: commandBody(opId, COMMANDS.updateAsignacion, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<boolean>(
                "horarios_update_asignacion",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.updateAsignacion,
            debugTag: "horarios:updateAsignacion",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<boolean>(
                    "horarios_update_asignacion_after_remote_ok",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : !!data;
}

export async function horariosDeleteAsignacion(
    idAsignacion: number,
): Promise<boolean> {
    const opId = makeOpId("horarios_delete_asignacion");

    const args = {
        id_asignacion: Number(idAsignacion),
    };

    const raw = await dualCall<boolean>(
        {
            path: "/v1/horarios/asignacion/delete",
            method: "POST",
            body: commandBody(opId, COMMANDS.deleteAsignacion, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<boolean>(
                "horarios_delete_asignacion",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.deleteAsignacion,
            debugTag: "horarios:deleteAsignacion",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<boolean>(
                    "horarios_delete_asignacion_after_remote_ok",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : !!data;
}

export async function horariosCopySemanaAsignaciones(payload: {
    fromMonday: string;
    toMonday: string;
    overwrite?: boolean;
}): Promise<boolean> {
    const opId = makeOpId("horarios_copy_semana_asignaciones");

    const args = {
        from_monday: String(payload.fromMonday ?? ""),
        to_monday: String(payload.toMonday ?? ""),
        overwrite: payload.overwrite ?? true,
    };

    const raw = await dualCall<boolean>(
        {
            path: "/v1/horarios/copy-semana",
            method: "POST",
            body: commandBody(opId, COMMANDS.copySemanaAsignaciones, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<boolean>(
                "horarios_copy_semana_asignaciones",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.copySemanaAsignaciones,
            debugTag: "horarios:copySemanaAsignaciones",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                await invokeLocalWrite<boolean>(
                    "horarios_copy_semana_asignaciones_after_remote_ok",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            remote_asignaciones: extractRemoteAsignaciones(remoteResult),
                        },
                        false,
                    ),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : !!data;
}

export async function horariosSetPredeterminadoDesdeSemana(
    fechaLunes: string,
): Promise<boolean> {
    const opId = makeOpId("horarios_set_predeterminado_desde_semana");

    const args = {
        fecha_lunes: String(fechaLunes ?? ""),
    };

    const raw = await dualCall<boolean>(
        {
            path: "/v1/horarios/set-predeterminado-desde-semana",
            method: "POST",
            body: commandBody(opId, COMMANDS.setPredeterminadoDesdeSemana, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<boolean>(
                "horarios_set_predeterminado_desde_semana",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.setPredeterminadoDesdeSemana,
            debugTag: "horarios:setPredeterminadoDesdeSemana",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<boolean>(
                    "horarios_set_predeterminado_desde_semana_after_remote_ok",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : !!data;
}