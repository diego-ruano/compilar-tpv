// src/features/ClientsComponents/clientesApis.ts
//
// API de clientes — Local-First puro. Sustituye el antiguo dualCall (remoto + local +
// outbox) por invocación directa del comando Tauri vía @tpv/client. Las firmas exportadas
// y los tipos de retorno NO cambian, así que los componentes que consumen esta API siguen
// igual. Los tipos de los payloads que devuelve Rust vienen autogenerados de @tpv/contracts.

import { invokeClient } from "@tpv/client";
import type { ClienteForm, ClienteOverview } from "@tpv/contracts";

export type FiltroRanking = "todos" | "reservas" | "gasto";

export type ClienteRow = {
    ID_Cliente: string;
    Nombre: string;
    Email: string | null;
    Telefono: string | null;

    Ultima_Reserva_Fecha: string | null;
    Ultima_Reserva_Hora: string | null;
    Ultima_Reserva_NumPersonas: number | null;
    Ultima_Reserva_Mesa: string | null;

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

/* =========================================================
   Helpers de mapeo (snake_case del backend -> tipos del front)
========================================================= */

function toNum(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableStr(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
}

function mapRow(r: ClienteOverview): ClienteRow {
    return {
        ID_Cliente: String(r.id_cliente ?? ""),
        Nombre: String(r.nombre ?? ""),
        Email: toNullableStr(r.email),
        Telefono: toNullableStr(r.telefono),

        Ultima_Reserva_Fecha: toNullableStr(r.ultima_reserva_fecha),
        Ultima_Reserva_Hora: toNullableStr(r.ultima_reserva_hora),
        Ultima_Reserva_NumPersonas: r.ultima_reserva_num_personas ?? null,
        Ultima_Reserva_Mesa: toNullableStr(r.ultima_reserva_mesa),

        Total_Gastado_Stored: r.total_gastado_stored ?? 0,

        Total_Reservas: r.total_reservas ?? 0,
        Reservas_Pendientes: r.reservas_pendientes ?? 0,
    };
}

function mapForm(r: ClienteForm): ClienteFormRow {
    return {
        Nombre: String(r.nombre ?? ""),
        Email: toNullableStr(r.email),
        Telefono: toNullableStr(r.telefono),
        Notas: toNullableStr(r.notas),
    };
}

/* =========================================================
   API (Local-First: invoca el comando Tauri y listo)
========================================================= */

export async function clientesGetOverview(params: {
    ranking: FiltroRanking;
}): Promise<ClienteRow[]> {
    const rows = await invokeClient<ClienteOverview[]>("clientes_get_overview", {
        args: { ranking: params.ranking },
    });

    return (rows ?? []).map(mapRow);
}

export async function clientesGetClienteForm(params: {
    idCliente: string;
}): Promise<ClienteFormRow | null> {
    const row = await invokeClient<ClienteForm | null>("clientes_get_cliente_form", {
        args: { id_cliente: params.idCliente },
    });

    return row ? mapForm(row) : null;
}

export async function clientesCreateCliente(params: {
    nombre: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    return await invokeClient<boolean>("clientes_create_cliente", {
        args: {
            nombre: String(params.nombre ?? "").trim(),
            email: toNullableStr(params.email),
            telefono: toNullableStr(params.telefono),
            notas: toNullableStr(params.notas),
        },
    });
}

/**
 * Rehace el gasto acumulado del cliente desde sus pagos (DB-14) y devuelve el valor resultante,
 * o `null` si el cliente ya no existe.
 *
 * El job de reconciliación solo AVISA de los descuadres; corregirlos es una decisión de quien
 * lleva el negocio, y esta es la llamada que la ejecuta.
 */
export async function clientesRecalcularGasto(params: {
    idCliente: string;
}): Promise<number | null> {
    const v = await invokeClient<number | null>("clientes_recalcular_gasto", {
        args: { id_cliente: params.idCliente },
    });

    return v == null ? null : Number(v);
}

export async function clientesUpdateCliente(params: {
    idCliente: string;
    nombre: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
}): Promise<boolean> {
    return await invokeClient<boolean>("clientes_update_cliente", {
        args: {
            id_cliente: params.idCliente,
            nombre: String(params.nombre ?? "").trim(),
            email: toNullableStr(params.email),
            telefono: toNullableStr(params.telefono),
            notas: toNullableStr(params.notas),
        },
    });
}
