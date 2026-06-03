// src/features/reservas/reservasApis.ts
//
// API de reservas — Local-First puro (invokeClient, sin dualCall/op_id/outbox).
// Las firmas y tipos UI exportados no cambian; los payloads vienen de @tpv/contracts.

import { invokeClient } from "@tpv/client";
import type { ReservaDto, ReservasMetaDto } from "@tpv/contracts";

/* ========================= Tipos UI ========================= */

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

/* ========================= Helpers ========================= */

function toNum(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableStr(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
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

/* ========================= Mappers (snake_case -> UI) ========================= */

function mapMeta(r: ReservasMetaDto): ReservasMeta {
    const zonas: Zona[] = (r.zonas ?? [])
        .map((z): Zona => ({
            idZona: toNum(z.id_zona, 0),
            nombre: String(z.nombre_zona ?? ""),
        }))
        .filter((z) => z.idZona > 0);

    const mesas: Mesa[] = (r.mesas ?? [])
        .map((m): Mesa => ({
            idMesa: toNum(m.id_mesa, 0),
            idZona: toNum(m.id_zona, 0),
            nombre: String(m.numero_mesa ?? ""),
            capacidad: toNum(m.capacidad, 0),
        }))
        .filter((m) => m.idMesa > 0);

    return { zonas, mesas };
}

function mapReserva(r: ReservaDto): ReservaRow {
    return {
        ID_Reserva: toNum(r.id_reserva, 0),
        ID_Mesa: toNum(r.id_mesa, 0),
        Dia_YMD: String(r.dia_ymd ?? ""),
        Hora: String(r.hora ?? ""),
        Turno: toNullableStr(r.turno),
        Comensales: toNum(r.comensales, 0),
        Nota: toNullableStr(r.nota),
        Estado: String(r.estado ?? "PROXIMA"),

        Nombre_Cliente: String(r.nombre_cliente ?? ""),
        Telefono_Cliente: toNullableStr(r.telefono_cliente),
        Email_Cliente: toNullableStr(r.email_cliente),

        ID_Zona: toNum(r.id_zona, 0),
        Numero_Mesa: String(r.numero_mesa ?? ""),
        Capacidad: toNum(r.capacidad, 0),
        Nombre_Zona: String(r.nombre_zona ?? ""),
    };
}

/* ========================= API ========================= */

export async function reservasGetMeta(): Promise<ReservasMeta> {
    const raw = await invokeClient<ReservasMetaDto>("reservas_get_meta");
    return mapMeta(raw);
}

export async function reservasGetMes(params: {
    desde: string;
    hasta: string;
}): Promise<ReservaRow[]> {
    const rows = await invokeClient<ReservaDto[]>("reservas_get_mes", {
        args: { desde: params.desde, hasta: params.hasta },
    });
    return (rows ?? []).map(mapReserva);
}

export async function reservasSave(input: ReservaSaveInput): Promise<boolean> {
    const turno: Turno = input.turno ?? turnoPorHora(input.hora);
    return await invokeClient<boolean>("reservas_save", {
        args: {
            id_reserva: input.idReserva ?? null,
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
        },
    });
}

export async function reservasDelete(params: {
    idReserva: number;
}): Promise<boolean> {
    return await invokeClient<boolean>("reservas_delete", {
        args: { id_reserva: Number(params.idReserva) },
    });
}
