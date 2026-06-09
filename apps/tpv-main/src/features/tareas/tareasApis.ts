// src/features/tareas/tareasApis.ts
//
// API de tareas — Local-First puro. Sustituye el antiguo dualCall (remoto + local +
// outbox + op_id + afterRemoteOk) por invocación directa del comando Tauri vía
// @tpv/client. Las firmas exportadas (objeto `tareasApi`) y los tipos de retorno NO
// cambian, así que los componentes que la consumen siguen igual.

import { invokeClient } from "@tpv/client";
import type {
    TrabajadorUI,
    TareaAdminRow,
    TareaRow,
    TareaAsignadoRow,
    MisTareasRow,
} from "@tpv/contracts";

// Tipos autogenerados desde Rust (ts-rs). Se reexportan para conservar la
// superficie pública del módulo; los mappers de abajo siguen normalizando el
// payload (snake/Pascal/camel) hacia estas formas.
export type {
    TrabajadorUI,
    TareaAdminRow,
    TareaRow,
    TareaAsignadoRow,
    MisTareasRow,
};

/* =========================================================
   Helpers de mapeo (defensivos: aceptan snake/Pascal/camelCase)
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

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
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
   API (Local-First: invoca el comando Tauri y mapea)
========================================================= */

export const tareasApi = {
    async getTrabajadores(): Promise<TrabajadorUI[]> {
        const rows = await invokeClient<any[]>("tareas_get_trabajadores");
        return (rows ?? []).map(mapTrabajador);
    },

    async createTarea(payload: {
        titulo: string;
        descripcion?: string | null;
        fechaLimite?: string | null;
        idsTrabajadores: number[];
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_create_tarea", {
            args: {
                titulo: String(payload.titulo ?? "").trim(),
                descripcion: payload.descripcion ?? null,
                fecha_limite: payload.fechaLimite ?? null,
                ids_trabajadores: normalizeIds(payload.idsTrabajadores ?? []),
            },
        });
    },

    async getTareasAdmin(): Promise<TareaAdminRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_tareas_admin");
        return (rows ?? []).map(mapTareaAdmin);
    },

    async getTareaById(idTarea: number): Promise<TareaRow | null> {
        const data = await invokeClient<any | null>("tareas_get_tarea_by_id", {
            args: { id_tarea: Number(idTarea) },
        });

        return data ? mapTarea(data) : null;
    },

    async updateTarea(payload: {
        idTarea: number;
        titulo: string;
        descripcion?: string | null;
        fechaLimite?: string | null;
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_update_tarea", {
            args: {
                id_tarea: Number(payload.idTarea),
                titulo: String(payload.titulo ?? "").trim(),
                descripcion: payload.descripcion ?? null,
                fecha_limite: payload.fechaLimite ?? null,
            },
        });
    },

    async getTareaAsignados(idTarea: number): Promise<TareaAsignadoRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_tarea_asignados", {
            args: { id_tarea: Number(idTarea) },
        });

        return (rows ?? []).map(mapTareaAsignado);
    },

    async setAsignacionesTarea(payload: {
        idTarea: number;
        idsTrabajadores: number[];
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_set_asignaciones_tarea", {
            args: {
                id_tarea: Number(payload.idTarea),
                ids_trabajadores: normalizeIds(payload.idsTrabajadores ?? []),
            },
        });
    },

    async deleteTarea(idTarea: number): Promise<boolean> {
        return await invokeClient<boolean>("tareas_delete_tarea", {
            args: { id_tarea: Number(idTarea) },
        });
    },

    async getMisTareas(idTrabajador: number): Promise<MisTareasRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_mis_tareas", {
            args: { id_trabajador: Number(idTrabajador) },
        });

        return (rows ?? []).map(mapMisTarea);
    },

    async marcarTareaFinalizada(payload: {
        idTarea: number;
        idTrabajador: number;
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_marcar_tarea_finalizada", {
            args: {
                id_tarea: Number(payload.idTarea),
                id_trabajador: Number(payload.idTrabajador),
            },
        });
    },
};
