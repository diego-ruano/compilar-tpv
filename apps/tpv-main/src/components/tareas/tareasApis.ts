// src/components/tareas/tareasApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

export type TrabajadorUI = {
    ID_Trabajador: number;
    ID_Usuario: number;
    Nombre: string;
    Apellido: string | null;
    Puesto: string | null;
    Email: string;
};

export type TareaAdminRow = {
    ID_Tarea: number;
    Titulo: string;
    Descripcion: string | null;
    Fecha_Creacion: string;
    Fecha_Limite: string | null;
    Total_Asignados: number;
    Total_Finalizadas: number;
};

export type TareaRow = {
    ID_Tarea: number;
    Titulo: string;
    Descripcion: string | null;
    Fecha_Creacion: string;
    Fecha_Limite: string | null;
};

export type TareaAsignadoRow = {
    ID_Trabajador: number;
    Nombre: string;
    Apellido: string | null;
    Puesto: string | null;
    Asignada_At: string;
    Estado: string;
    Finalizada_At: string | null;
};

export type MisTareasRow = {
    ID_Tarea: number;
    Titulo: string;
    Descripcion: string | null;
    Fecha_Limite: string | null;
    Asignada_At: string;
    Estado: "PENDIENTE" | "FINALIZADA" | string;
    Finalizada_At: string | null;
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
    createTarea: "tareas.createTarea",
    updateTarea: "tareas.updateTarea",
    setAsignacionesTarea: "tareas.setAsignacionesTarea",
    deleteTarea: "tareas.deleteTarea",
    marcarTareaFinalizada: "tareas.marcarTareaFinalizada",
} as const;

/* =========================================================
   Helpers
========================================================= */

function pick<T = any>(obj: any, keys: string[], fallback?: any): T {
    for (const k of keys) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
            return obj[k] as T;
        }
    }

    return fallback as T;
}

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toPositiveIntOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
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

function normalizeIds(ids: number[]): number[] {
    return (ids ?? [])
        .map(Number)
        .filter((n: number) => Number.isFinite(n) && n > 0)
        .sort((a: number, b: number) => a - b)
        .filter(
            (n: number, i: number, arr: number[]) => i === 0 || arr[i - 1] !== n,
        );
}

function extractRemoteIdTarea(remoteResult: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(remoteResult);

    const direct =
        toPositiveIntOrNull(data?.id_tarea) ??
        toPositiveIntOrNull(data?.idTarea) ??
        toPositiveIntOrNull(data?.ID_Tarea) ??
        toPositiveIntOrNull(data?.id) ??
        toPositiveIntOrNull(data);

    if (direct) return direct;

    const candidates = [
        data?.tarea,
        data?.Tarea,
        data?.row,
        data?.item,
        data?.result,
        data?.data,
    ];

    for (const candidate of candidates) {
        const id =
            toPositiveIntOrNull(candidate?.id_tarea) ??
            toPositiveIntOrNull(candidate?.idTarea) ??
            toPositiveIntOrNull(candidate?.ID_Tarea) ??
            toPositiveIntOrNull(candidate?.id);

        if (id) return id;
    }

    return null;
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

function mapTrabajador(row: any): TrabajadorUI {
    return {
        ID_Trabajador: toNum(
            pick(row, ["ID_Trabajador", "id_trabajador", "idTrabajador"]),
            0,
        ),
        ID_Usuario: toNum(
            pick(row, ["ID_Usuario", "id_usuario", "idUsuario"]),
            0,
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), ""),
        Apellido: toNullableStr(pick(row, ["Apellido", "apellido"])),
        Puesto: toNullableStr(pick(row, ["Puesto", "puesto"])),
        Email: toStr(pick(row, ["Email", "email"]), ""),
    };
}

function mapTareaAdmin(row: any): TareaAdminRow {
    return {
        ID_Tarea: toNum(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), 0),
        Titulo: toStr(pick(row, ["Titulo", "titulo"]), ""),
        Descripcion: toNullableStr(pick(row, ["Descripcion", "descripcion"])),
        Fecha_Creacion: toStr(
            pick(row, ["Fecha_Creacion", "fecha_creacion", "fechaCreacion"]),
            "",
        ),
        Fecha_Limite: toNullableStr(
            pick(row, ["Fecha_Limite", "fecha_limite", "fechaLimite"]),
        ),
        Total_Asignados: toNum(
            pick(row, ["Total_Asignados", "total_asignados", "totalAsignados"]),
            0,
        ),
        Total_Finalizadas: toNum(
            pick(row, [
                "Total_Finalizadas",
                "total_finalizadas",
                "totalFinalizadas",
            ]),
            0,
        ),
    };
}

function mapTarea(row: any): TareaRow {
    return {
        ID_Tarea: toNum(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), 0),
        Titulo: toStr(pick(row, ["Titulo", "titulo"]), ""),
        Descripcion: toNullableStr(pick(row, ["Descripcion", "descripcion"])),
        Fecha_Creacion: toStr(
            pick(row, ["Fecha_Creacion", "fecha_creacion", "fechaCreacion"]),
            "",
        ),
        Fecha_Limite: toNullableStr(
            pick(row, ["Fecha_Limite", "fecha_limite", "fechaLimite"]),
        ),
    };
}

function mapTareaAsignado(row: any): TareaAsignadoRow {
    return {
        ID_Trabajador: toNum(
            pick(row, ["ID_Trabajador", "id_trabajador", "idTrabajador"]),
            0,
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), ""),
        Apellido: toNullableStr(pick(row, ["Apellido", "apellido"])),
        Puesto: toNullableStr(pick(row, ["Puesto", "puesto"])),
        Asignada_At: toStr(
            pick(row, ["Asignada_At", "asignada_at", "asignadaAt"]),
            "",
        ),
        Estado: toStr(pick(row, ["Estado", "estado"]), ""),
        Finalizada_At: toNullableStr(
            pick(row, ["Finalizada_At", "finalizada_at", "finalizadaAt"]),
        ),
    };
}

function mapMisTarea(row: any): MisTareasRow {
    return {
        ID_Tarea: toNum(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), 0),
        Titulo: toStr(pick(row, ["Titulo", "titulo"]), ""),
        Descripcion: toNullableStr(pick(row, ["Descripcion", "descripcion"])),
        Fecha_Limite: toNullableStr(
            pick(row, ["Fecha_Limite", "fecha_limite", "fechaLimite"]),
        ),
        Asignada_At: toStr(
            pick(row, ["Asignada_At", "asignada_at", "asignadaAt"]),
            "",
        ),
        Estado: toStr(pick(row, ["Estado", "estado"]), ""),
        Finalizada_At: toNullableStr(
            pick(row, ["Finalizada_At", "finalizada_at", "finalizadaAt"]),
        ),
    };
}

/* =========================================================
   API
========================================================= */

export const tareasApi = {
    async getTrabajadores(): Promise<TrabajadorUI[]> {
        const raw = await dualCall<any[]>(
            {
                path: "/v1/tareas/trabajadores",
                method: "GET",
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("tareas_get_trabajadores"),
            {
                kind: "read",
                debugTag: "tareas:getTrabajadores",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(mapTrabajador);
    },

    async createTarea(payload: {
        titulo: string;
        descripcion?: string | null;
        fechaLimite?: string | null;
        idsTrabajadores: number[];
    }): Promise<boolean> {
        const opId = makeOpId("tareas_create_tarea");

        const args = {
            titulo: String(payload.titulo ?? "").trim(),
            descripcion: payload.descripcion ?? null,
            fecha_limite: payload.fechaLimite ?? null,
            ids_trabajadores: normalizeIds(payload.idsTrabajadores ?? []),
        };

        const raw = await dualCall<any>(
            {
                path: "/v1/tareas/create",
                method: "POST",
                body: commandBody(opId, COMMANDS.createTarea, args),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite<any>(
                    "tareas_create_tarea",
                    localWriteArgs(opId, args, true),
                ),
            {
                kind: "write",
                commandName: COMMANDS.createTarea,
                debugTag: "tareas:createTarea",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async (remoteResult: any) => {
                    const remoteIdTarea = extractRemoteIdTarea(remoteResult);

                    if (!remoteIdTarea) {
                        throw new Error("remote_id_tarea_missing");
                    }

                    await invokeLocalWrite<any>(
                        "tareas_create_tarea_after_remote_ok",
                        localWriteArgs(
                            opId,
                            {
                                ...args,
                                remote_id_tarea: remoteIdTarea,
                            },
                            false,
                        ),
                    );
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        return typeof data === "boolean" ? data : true;
    },

    async getTareasAdmin(): Promise<TareaAdminRow[]> {
        const raw = await dualCall<any[]>(
            {
                path: "/v1/tareas/admin/list",
                method: "GET",
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("tareas_get_tareas_admin"),
            {
                kind: "read",
                debugTag: "tareas:getTareasAdmin",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(mapTareaAdmin);
    },

    async getTareaById(idTarea: number): Promise<TareaRow | null> {
        const args = {
            id_tarea: Number(idTarea),
        };

        const raw = await dualCall<any | null>(
            {
                path: "/v1/tareas/get",
                method: "POST",
                body: args,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any | null>("tareas_get_tarea_by_id", args),
            {
                kind: "read",
                debugTag: "tareas:getTareaById",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const data = unwrapMaybeOkEnvelope<any | null>(raw);
        return data ? mapTarea(data) : null;
    },

    async updateTarea(payload: {
        idTarea: number;
        titulo: string;
        descripcion?: string | null;
        fechaLimite?: string | null;
    }): Promise<boolean> {
        const opId = makeOpId("tareas_update_tarea");

        const args = {
            id_tarea: Number(payload.idTarea),
            titulo: String(payload.titulo ?? "").trim(),
            descripcion: payload.descripcion ?? null,
            fecha_limite: payload.fechaLimite ?? null,
        };

        const raw = await dualCall<any>(
            {
                path: "/v1/tareas/update",
                method: "POST",
                body: commandBody(opId, COMMANDS.updateTarea, args),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite<any>(
                    "tareas_update_tarea",
                    localWriteArgs(opId, args, true),
                ),
            {
                kind: "write",
                commandName: COMMANDS.updateTarea,
                debugTag: "tareas:updateTarea",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite<any>(
                        "tareas_update_tarea_after_remote_ok",
                        localWriteArgs(opId, args, false),
                    );
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        return typeof data === "boolean" ? data : true;
    },

    async getTareaAsignados(idTarea: number): Promise<TareaAsignadoRow[]> {
        const args = {
            id_tarea: Number(idTarea),
        };

        const raw = await dualCall<any[]>(
            {
                path: "/v1/tareas/asignados",
                method: "POST",
                body: args,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("tareas_get_tarea_asignados", args),
            {
                kind: "read",
                debugTag: "tareas:getTareaAsignados",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(mapTareaAsignado);
    },

    async setAsignacionesTarea(payload: {
        idTarea: number;
        idsTrabajadores: number[];
    }): Promise<boolean> {
        const opId = makeOpId("tareas_set_asignaciones_tarea");

        const args = {
            id_tarea: Number(payload.idTarea),
            ids_trabajadores: normalizeIds(payload.idsTrabajadores ?? []),
        };

        const raw = await dualCall<any>(
            {
                path: "/v1/tareas/set-asignaciones",
                method: "POST",
                body: commandBody(opId, COMMANDS.setAsignacionesTarea, args),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite<any>(
                    "tareas_set_asignaciones_tarea",
                    localWriteArgs(opId, args, true),
                ),
            {
                kind: "write",
                commandName: COMMANDS.setAsignacionesTarea,
                debugTag: "tareas:setAsignacionesTarea",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite<any>(
                        "tareas_set_asignaciones_tarea_after_remote_ok",
                        localWriteArgs(opId, args, false),
                    );
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        return typeof data === "boolean" ? data : true;
    },

    async deleteTarea(idTarea: number): Promise<boolean> {
        const opId = makeOpId("tareas_delete_tarea");

        const args = {
            id_tarea: Number(idTarea),
        };

        const raw = await dualCall<any>(
            {
                path: "/v1/tareas/delete",
                method: "POST",
                body: commandBody(opId, COMMANDS.deleteTarea, args),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite<any>(
                    "tareas_delete_tarea",
                    localWriteArgs(opId, args, true),
                ),
            {
                kind: "write",
                commandName: COMMANDS.deleteTarea,
                debugTag: "tareas:deleteTarea",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite<any>(
                        "tareas_delete_tarea_after_remote_ok",
                        localWriteArgs(opId, args, false),
                    );
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        return typeof data === "boolean" ? data : true;
    },

    async getMisTareas(idTrabajador: number): Promise<MisTareasRow[]> {
        const args = {
            id_trabajador: Number(idTrabajador),
        };

        const raw = await dualCall<any[]>(
            {
                path: "/v1/tareas/mis",
                method: "POST",
                body: args,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("tareas_get_mis_tareas", args),
            {
                kind: "read",
                debugTag: "tareas:getMisTareas",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(mapMisTarea);
    },

    async marcarTareaFinalizada(payload: {
        idTarea: number;
        idTrabajador: number;
    }): Promise<boolean> {
        const opId = makeOpId("tareas_marcar_tarea_finalizada");

        const args = {
            id_tarea: Number(payload.idTarea),
            id_trabajador: Number(payload.idTrabajador),
        };

        const raw = await dualCall<any>(
            {
                path: "/v1/tareas/finalizar",
                method: "POST",
                body: commandBody(opId, COMMANDS.marcarTareaFinalizada, args),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite<any>(
                    "tareas_marcar_tarea_finalizada",
                    localWriteArgs(opId, args, true),
                ),
            {
                kind: "write",
                commandName: COMMANDS.marcarTareaFinalizada,
                debugTag: "tareas:marcarTareaFinalizada",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite<any>(
                        "tareas_marcar_tarea_finalizada_after_remote_ok",
                        localWriteArgs(opId, args, false),
                    );
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        return typeof data === "boolean" ? data : true;
    },
};