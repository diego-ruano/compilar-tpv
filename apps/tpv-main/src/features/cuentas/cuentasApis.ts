// src/features/cuentas/cuentasApis.ts
//
// API de cuentas (caja) — Local-First puro (invokeClient vía @tpv/client). Sustituye
// dualCall/op_id/outbox/afterRemoteOk. Conserva tipos, mappers, DEFAULT_DENOMS y los
// helpers de caja (solo frontend / localStorage).

import { invokeClient } from "@tpv/client";

/* =========================
   Tipos UI
========================= */

export type Entrada = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD HH:mm"
    cliente: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
};

export type Salida = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD"
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: string | null;
};

export type ProveedorMini = {
    id: string;
    nombre: string;
};

export type Denom = {
    label: string;
    value: number;
    kind: "moneda" | "billete";
};

export type CashCount = Record<string, number>;

/* =========================
   Constantes
========================= */

const LS_KEY_X_FONDO = "cuentas_x_fondo_v1";

export const DEFAULT_DENOMS: Denom[] = [
    { label: "0.01€", value: 0.01, kind: "moneda" },
    { label: "0.02€", value: 0.02, kind: "moneda" },
    { label: "0.05€", value: 0.05, kind: "moneda" },
    { label: "0.10€", value: 0.1, kind: "moneda" },
    { label: "0.20€", value: 0.2, kind: "moneda" },
    { label: "0.50€", value: 0.5, kind: "moneda" },
    { label: "1€", value: 1, kind: "moneda" },
    { label: "2€", value: 2, kind: "moneda" },
    { label: "5€", value: 5, kind: "billete" },
    { label: "10€", value: 10, kind: "billete" },
    { label: "20€", value: 20, kind: "billete" },
    { label: "50€", value: 50, kind: "billete" },
    { label: "100€", value: 100, kind: "billete" },
    { label: "200€", value: 200, kind: "billete" },
];

/* =========================
   Helpers
========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function toIdOrNull(v: any): string | null {
    const t = String(v ?? "").trim();
    return t ? t : null;
}

function cleanString(v: any): string {
    return String(v ?? "").trim();
}

function toPositiveIntOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function mapEntrada(r: any): Entrada {
    const metodoRaw = toStr(
        r?.metodo ?? r?.Metodo_Pago ?? r?.metodo_pago,
        "Efectivo",
    );

    return {
        id: toStr(r?.id ?? r?.ID_Pago ?? r?.id_pago ?? ""),
        fechaHora: toStr(r?.fechaHora ?? r?.fecha_hora ?? r?.Fecha_Hora ?? ""),
        cliente: toStr(r?.cliente ?? r?.Cliente ?? "—"),
        metodo: metodoRaw === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe: toNum(r?.importe ?? r?.Importe_Total ?? r?.importe_total, 0),
    };
}

function mapSalida(r: any): Salida {
    return {
        id: toStr(r?.id ?? r?.ID_Gasto ?? r?.id_gasto ?? ""),
        fechaHora: toStr(
            r?.fechaHora ?? r?.fecha_hora ?? r?.fecha ?? r?.Fecha ?? "",
        ),
        tipoGasto: toStr(r?.tipoGasto ?? r?.tipo_gasto ?? r?.Tipo_Gasto ?? ""),
        concepto: toStr(r?.concepto ?? r?.Concepto ?? ""),
        importe: toNum(r?.importe ?? r?.Importe ?? 0),
        proveedorId: toIdOrNull(
            r?.proveedorId ?? r?.proveedor_id ?? r?.id_proveedor ?? r?.ID_Proveedor,
        ),
    };
}

/* =========================
   Proveedores mini
========================= */

export async function cuentasListProveedoresMini(): Promise<ProveedorMini[]> {
    const rows = await invokeClient<any[]>("inventario_list_proveedores_mini");

    return (rows ?? [])
        .map((r) => ({
            id: toStr(r?.id ?? r?.ID_Proveedor ?? r?.id_proveedor, ""),
            nombre: String(
                r?.nombre ?? r?.Nombre_Empresa ?? r?.nombre_empresa ?? "",
            ),
        }))
        .filter((p) => p.id.length > 0 && !!p.nombre);
}

/* =========================
   GET
========================= */

export async function cuentasGetEntradas(params: {
    del?: string | null;
    al?: string | null;
}): Promise<Entrada[]> {
    const rows = await invokeClient<any[]>("cuentas_get_entradas", {
        args: { del: params.del ?? null, al: params.al ?? null },
    });
    return (rows ?? []).map(mapEntrada);
}

export async function cuentasGetSalidas(params: {
    del?: string | null;
    al?: string | null;
}): Promise<Salida[]> {
    const rows = await invokeClient<any[]>("cuentas_get_salidas", {
        args: { del: params.del ?? null, al: params.al ?? null },
    });
    return (rows ?? []).map(mapSalida);
}

/* =========================
   CRUD GASTOS
========================= */

export async function cuentasCreateGasto(payload: {
    fecha: string;
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_create_gasto", {
        args: {
            fecha: cleanString(payload.fecha),
            tipo_gasto: cleanString(payload.tipoGasto),
            concepto: cleanString(payload.concepto),
            importe: Number(payload.importe ?? 0),
            proveedor_id: toIdOrNull(payload.proveedorId),
        },
    });
    return typeof r === "boolean" ? r : true;
}

export async function cuentasUpdateGasto(payload: {
    idGasto: string;
    fecha: string;
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_update_gasto", {
        args: {
            id_gasto: payload.idGasto,
            fecha: cleanString(payload.fecha),
            tipo_gasto: cleanString(payload.tipoGasto),
            concepto: cleanString(payload.concepto),
            importe: Number(payload.importe ?? 0),
            proveedor_id: toIdOrNull(payload.proveedorId),
        },
    });
    return typeof r === "boolean" ? r : true;
}

export async function cuentasDeleteGasto(idGasto: string): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_delete_gasto", {
        args: { id_gasto: idGasto },
    });
    return typeof r === "boolean" ? r : true;
}

/* =========================
   CRUD PAGOS / ENTRADAS
========================= */

export async function cuentasUpdatePago(payload: {
    idPago: string;
    fechaHora: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_update_pago", {
        args: {
            id_pago: payload.idPago,
            fecha_hora: cleanString(payload.fechaHora),
            metodo: payload.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo",
            importe: Number(payload.importe ?? 0),
        },
    });
    return typeof r === "boolean" ? r : true;
}

export async function cuentasDeletePago(idPago: string): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_delete_pago", {
        args: { id_pago: idPago },
    });
    return typeof r === "boolean" ? r : true;
}

/* =========================================================
   X Caja - solo frontend
========================================================= */

export function getXFondo(): CashCount {
    try {
        const raw = localStorage.getItem(LS_KEY_X_FONDO);
        if (!raw) return {};

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};

        return parsed as CashCount;
    } catch {
        return {};
    }
}

export function setXFondo(count: CashCount): void {
    try {
        localStorage.setItem(LS_KEY_X_FONDO, JSON.stringify(count ?? {}));
    } catch {
        // noop
    }
}

export function cashTotal(denoms: Denom[], count: CashCount): number {
    let sum = 0;

    for (const d of denoms) {
        const n = Number(count?.[d.label] ?? 0);
        if (Number.isFinite(n) && n > 0) {
            sum += d.value * n;
        }
    }

    return Math.round(sum * 100) / 100;
}

export function calcDeltaToReachFondo(args: {
    denoms: Denom[];
    fondo: CashCount;
    cierre: CashCount;
}): Array<{
    label: string;
    value: number;
    delta: number;
    kind: Denom["kind"];
}> {
    const { denoms, fondo, cierre } = args;

    return denoms.map((d) => {
        const target = Number(fondo?.[d.label] ?? 0);
        const end = Number(cierre?.[d.label] ?? 0);

        const delta =
            (Number.isFinite(target) ? target : 0) -
            (Number.isFinite(end) ? end : 0);

        return {
            label: d.label,
            value: d.value,
            delta,
            kind: d.kind,
        };
    });
}

export function incCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = value + step;

    return next;
}

export function decCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = Math.max(0, value - step);

    return next;
}

export function resetCash(): CashCount {
    return {};
}
