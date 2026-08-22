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

function normalizeIds(ids: string[]): string[] {
    return (ids ?? [])
        .map((v) => String(v ?? "").trim())
        .filter((s: string) => s.length > 0)
        .sort()
        .filter(
            (s: string, i: number, arr: string[]) => i === 0 || arr[i - 1] !== s,
        );
}

/* =========================================================
   Mappers
========================================================= */

function mapTrabajador(row: any): TrabajadorUI {
    return {
        ID_Trabajador: toStr(
            pick(row, ["ID_Trabajador", "id_trabajador", "idTrabajador"]),
            "",
        ),
        ID_Usuario: toStr(
            pick(row, ["ID_Usuario", "id_usuario", "idUsuario"]),
            "",
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), ""),
        Apellido: toNullableStr(pick(row, ["Apellido", "apellido"])),
        Puesto: toNullableStr(pick(row, ["Puesto", "puesto"])),
        Email: toStr(pick(row, ["Email", "email"]), ""),
    };
}

function mapTareaAdmin(row: any): TareaAdminRow {
    return {
        ID_Tarea: toStr(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), ""),
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
        ID_Tarea: toStr(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), ""),
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
        ID_Trabajador: toStr(
            pick(row, ["ID_Trabajador", "id_trabajador", "idTrabajador"]),
            "",
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
        ID_Tarea: toStr(pick(row, ["ID_Tarea", "id_tarea", "idTarea"]), ""),
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
        idsTrabajadores: string[];
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

    async getTareaById(idTarea: string): Promise<TareaRow | null> {
        const data = await invokeClient<any | null>("tareas_get_tarea_by_id", {
            args: { id_tarea: idTarea },
        });

        return data ? mapTarea(data) : null;
    },

    async updateTarea(payload: {
        idTarea: string;
        titulo: string;
        descripcion?: string | null;
        fechaLimite?: string | null;
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_update_tarea", {
            args: {
                id_tarea: payload.idTarea,
                titulo: String(payload.titulo ?? "").trim(),
                descripcion: payload.descripcion ?? null,
                fecha_limite: payload.fechaLimite ?? null,
            },
        });
    },

    async getTareaAsignados(idTarea: string): Promise<TareaAsignadoRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_tarea_asignados", {
            args: { id_tarea: idTarea },
        });

        return (rows ?? []).map(mapTareaAsignado);
    },

    async setAsignacionesTarea(payload: {
        idTarea: string;
        idsTrabajadores: string[];
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_set_asignaciones_tarea", {
            args: {
                id_tarea: payload.idTarea,
                ids_trabajadores: normalizeIds(payload.idsTrabajadores ?? []),
            },
        });
    },

    /** TAR-05: borrar manda a la papelera (reversible), no pierde la tarea. */
    async deleteTarea(idTarea: string): Promise<boolean> {
        return await invokeClient<boolean>("tareas_delete_tarea", {
            args: { id_tarea: idTarea },
        });
    },

    async getPapelera(): Promise<TareaAdminRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_papelera");
        return (rows ?? []).map(mapTareaAdmin);
    },

    async restaurarTarea(idTarea: string): Promise<boolean> {
        return await invokeClient<boolean>("tareas_restaurar_tarea", {
            args: { id_tarea: idTarea },
        });
    },

    /** Vaciar la papelera es el único camino que borra de verdad. Devuelve cuántas se borraron. */
    async vaciarPapelera(): Promise<number> {
        const n = await invokeClient<number>("tareas_vaciar_papelera");
        return toNum(n, 0);
    },

    async getMisTareas(idTrabajador: string): Promise<MisTareasRow[]> {
        const rows = await invokeClient<any[]>("tareas_get_mis_tareas", {
            args: { id_trabajador: idTrabajador },
        });

        return (rows ?? []).map(mapMisTarea);
    },

    async marcarTareaFinalizada(payload: {
        idTarea: string;
        idTrabajador: string;
    }): Promise<boolean> {
        return await invokeClient<boolean>("tareas_marcar_tarea_finalizada", {
            args: {
                id_tarea: payload.idTarea,
                id_trabajador: payload.idTrabajador,
            },
        });
    },
};
