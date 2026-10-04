// src/features/reservas/reservasApis.ts
//
// API de reservas — Local-First puro (invokeClient, sin dualCall/op_id/outbox).
// Las firmas y tipos UI exportados no cambian; los payloads vienen de @tpv/contracts.

import { invokeClient } from "@tpv/client";
import type { ClienteCoincidente, ReservaDto, ReservasMetaDto } from "@tpv/contracts";

/* ========================= Tipos UI ========================= */

export type Turno = "DESAYUNO" | "COMIDA" | "CAFE" | "CENA";

export type Zona = {
    idZona: string;
    nombre: string;
};

export type Mesa = {
    idMesa: string;
    idZona: string;
    nombre: string;
    capacidad: number;
};

export type ReservaRow = {
    ID_Reserva: string;
    ID_Mesa: string;
    Dia_YMD: string;
    Hora: string;
    Turno: string | null;
    Comensales: number;
    /** Minutos que ocupa la mesa; `null` = la duración por defecto del negocio (RI-61). */
    Duracion_Min: number | null;
    Nota: string | null;
    Estado: string;

    /** `null` si la reserva no tiene cliente (RI-61); entonces el nombre llega vacío. */
    ID_Cliente: string | null;
    Nombre_Cliente: string;
    Telefono_Cliente: string | null;
    Email_Cliente: string | null;

    ID_Zona: string;
    Numero_Mesa: string;
    Capacidad: number;
    Nombre_Zona: string;
};

export type ReservasMeta = {
    zonas: Zona[];
    mesas: Mesa[];
};

export type ReservaSaveInput = {
    idReserva?: string | null;

    diaYMD: string;
    hora: string;
    turno?: Turno | null;
    comensales: number;
    /** RI-61: minutos que ocupa la mesa; `null` = la del negocio. */
    duracionMin?: number | null;
    /** RI-61: guardar aunque se pise con lo que ocupa la mesa (tras el aviso `reserva_solapada`). */
    forzarSolape?: boolean;
    nota?: string | null;
    estado?: string | null;

    /** `null` = reserva apuntada sin mesa asignada todavia. */
    idMesa: string | null;

    /**
     * RI-61: el cliente es opcional y explícito. `idCliente` asigna uno que ya existe (lo escrito
     * sólo rellena sus huecos); sin él, `nombreCliente` crea uno nuevo; sin nada, va sin cliente.
     */
    idCliente?: string | null;
    nombreCliente?: string | null;
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

function toId(v: unknown): string {
    return String(v ?? "").trim();
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
            idZona: toId(z.id_zona),
            nombre: String(z.nombre_zona ?? ""),
        }))
        .filter((z) => z.idZona.length > 0);

    const mesas: Mesa[] = (r.mesas ?? [])
        .map((m): Mesa => ({
            idMesa: toId(m.id_mesa),
            idZona: toId(m.id_zona),
            nombre: String(m.numero_mesa ?? ""),
            capacidad: toNum(m.capacidad, 0),
        }))
        .filter((m) => m.idMesa.length > 0);

    return { zonas, mesas };
}

function mapReserva(r: ReservaDto): ReservaRow {
    return {
        ID_Reserva: toId(r.id_reserva),
        ID_Mesa: toId(r.id_mesa),
        Dia_YMD: String(r.dia_ymd ?? ""),
        Hora: String(r.hora ?? ""),
        Turno: toNullableStr(r.turno),
        Comensales: toNum(r.comensales, 0),
        Duracion_Min: r.duracion_min ?? null,
        Nota: toNullableStr(r.nota),
        Estado: String(r.estado ?? "PROXIMA"),

        ID_Cliente: toNullableStr(r.id_cliente),
        Nombre_Cliente: String(r.nombre_cliente ?? ""),
        Telefono_Cliente: toNullableStr(r.telefono_cliente),
        Email_Cliente: toNullableStr(r.email_cliente),

        ID_Zona: toId(r.id_zona),
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
            duracion_min: input.duracionMin ?? null,
            forzar_solape: input.forzarSolape ?? false,
            nota: input.nota ?? null,
            estado: input.estado ?? null,
            id_mesa: input.idMesa,
            id_cliente: input.idCliente ?? null,
            nombre_cliente: input.nombreCliente ?? null,
            telefono: input.telefono ?? null,
            email: input.email ?? null,
            notas_cliente: input.notasCliente ?? null,
        },
    });
}

/**
 * RI-61: el cliente que ya tiene ese teléfono o ese email, para preguntar antes de asignarle la
 * reserva. `null` si no hay ninguno.
 */
export async function reservasBuscarCliente(params: {
    telefono: string | null;
    email: string | null;
}): Promise<ClienteCoincidente | null> {
    return await invokeClient<ClienteCoincidente | null>("reservas_buscar_cliente", {
        args: { telefono: params.telefono, email: params.email },
    });
}

export async function reservasDelete(params: {
    idReserva: string;
}): Promise<boolean> {
    return await invokeClient<boolean>("reservas_delete", {
        args: { id_reserva: params.idReserva },
    });
}
