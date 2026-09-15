// src/features/cuentas/cuentasApis.ts
//
// API de cuentas (caja) — Local-First puro (invokeClient vía @tpv/client). Sustituye
// dualCall/op_id/outbox/afterRemoteOk. Conserva tipos, mappers, DEFAULT_DENOMS y los
// helpers de caja (solo frontend / localStorage).

import { invokeClient } from "@tpv/client";
import type { CambioCajaInput, ImpactoCajaDto } from "@tpv/contracts";

/* =========================
   Tipos UI
========================= */

export type Entrada = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD HH:mm"
    cliente: string;
    metodo: "Tarjeta" | "Efectivo";
    importe: number;
    /** CUENTA-07: un cobro anulado NO se borra. Sale en la lista, marcado. */
    anulado: boolean;
    anuladoEn?: string | null;
    /** Nombre de quien anuló (lo resuelve el backend; la fila sólo guarda el id). */
    anuladoPor?: string | null;
    motivoAnulacion?: string | null;
};

export type Salida = {
    id: string;
    fechaHora: string; // "YYYY-MM-DD"
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: string | null;
    /** CAJA-01: el dinero salió del cajón, así que resta del esperado del arqueo. */
    pagadoConCaja: boolean;
};

export type ProveedorMini = {
    id: string;
    nombre: string;
};

export type ResumenCaja = {
    totalEntradas: number;
    totalSalidas: number;
    totalEfectivo: number;
    totalTarjeta: number;
    countEntradas: number;
    countSalidas: number;
    /** Anulaciones del rango. NO entran en los totales de arriba (CUENTA-07). */
    countAnuladas: number;
    totalAnulado: number;
};

/** Tamaño de página por defecto de los listados de caja (CUENTA-05). */
export const CUENTAS_PAGE_SIZE = 50;

export type Denom = {
    label: string;
    value: number;
    kind: "moneda" | "billete";
};

export type CashCount = Record<string, number>;

/* =========================
   Constantes
========================= */

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
        anulado: toStr(r?.estado ?? r?.Estado, "ACTIVO") === "ANULADO",
        anuladoEn: toIdOrNull(r?.anuladoEn ?? r?.anulado_en),
        anuladoPor: toIdOrNull(r?.anuladoPor ?? r?.anulado_por),
        motivoAnulacion: toIdOrNull(r?.motivoAnulacion ?? r?.motivo_anulacion),
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
        pagadoConCaja: Boolean(r?.pagadoConCaja ?? r?.pagado_con_caja),
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

/** Filtros de listado. `page`/`pageSize` omitidos ⇒ el backend devuelve TODAS las filas (PDF). */
export type CuentasListParams = {
    del?: string | null;
    al?: string | null;
    q?: string | null;
    page?: number | null;
    pageSize?: number | null;
};

function listArgs(params: CuentasListParams): Record<string, any> {
    const q = (params.q ?? "").trim();
    return {
        del: params.del ?? null,
        al: params.al ?? null,
        q: q ? q : null,
        page: params.page ?? null,
        page_size: params.pageSize ?? null,
    };
}

export async function cuentasGetEntradas(
    params: CuentasListParams,
): Promise<Entrada[]> {
    const rows = await invokeClient<any[]>("cuentas_get_entradas", {
        args: listArgs(params),
    });
    return (rows ?? []).map(mapEntrada);
}

export async function cuentasGetSalidas(
    params: CuentasListParams,
): Promise<Salida[]> {
    const rows = await invokeClient<any[]>("cuentas_get_salidas", {
        args: listArgs(params),
    });
    return (rows ?? []).map(mapSalida);
}

export async function cuentasGetResumen(params: {
    del?: string | null;
    al?: string | null;
    q?: string | null;
}): Promise<ResumenCaja> {
    const q = (params.q ?? "").trim();
    const r = await invokeClient<any>("cuentas_get_resumen", {
        args: { del: params.del ?? null, al: params.al ?? null, q: q ? q : null },
    });
    return {
        totalEntradas: toNum(r?.total_entradas ?? r?.totalEntradas, 0),
        totalSalidas: toNum(r?.total_salidas ?? r?.totalSalidas, 0),
        totalEfectivo: toNum(r?.total_efectivo ?? r?.totalEfectivo, 0),
        totalTarjeta: toNum(r?.total_tarjeta ?? r?.totalTarjeta, 0),
        countEntradas: toNum(r?.count_entradas ?? r?.countEntradas, 0),
        countSalidas: toNum(r?.count_salidas ?? r?.countSalidas, 0),
        countAnuladas: toNum(r?.count_anuladas ?? r?.countAnuladas, 0),
        totalAnulado: toNum(r?.total_anulado ?? r?.totalAnulado, 0),
    };
}

/* =========================
   CRUD GASTOS
========================= */

/**
 * El motivo de la rectificación (CAJA-01) viaja fuera de `args` porque no es un dato del apunte: es
 * de la corrección. Sólo hace falta cuando el cambio mueve el descuadre de un cierre ya hecho.
 */
export async function cuentasCreateGasto(payload: {
    fecha: string;
    tipoGasto: string;
    concepto: string;
    importe: number;
    proveedorId?: string | null;
    pagadoConCaja?: boolean;
    motivoRectificacion?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_create_gasto", {
        args: {
            fecha: cleanString(payload.fecha),
            tipo_gasto: cleanString(payload.tipoGasto),
            concepto: cleanString(payload.concepto),
            importe: Number(payload.importe ?? 0),
            proveedor_id: toIdOrNull(payload.proveedorId),
            pagado_con_caja: Boolean(payload.pagadoConCaja),
        },
        motivoRectificacion: toIdOrNull(payload.motivoRectificacion),
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
    pagadoConCaja?: boolean;
    motivoRectificacion?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_update_gasto", {
        args: {
            id_gasto: payload.idGasto,
            fecha: cleanString(payload.fecha),
            tipo_gasto: cleanString(payload.tipoGasto),
            concepto: cleanString(payload.concepto),
            importe: Number(payload.importe ?? 0),
            proveedor_id: toIdOrNull(payload.proveedorId),
            pagado_con_caja: Boolean(payload.pagadoConCaja),
        },
        motivoRectificacion: toIdOrNull(payload.motivoRectificacion),
    });
    return typeof r === "boolean" ? r : true;
}

export async function cuentasDeleteGasto(payload: {
    idGasto: string;
    motivoRectificacion?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_delete_gasto", {
        args: { id_gasto: payload.idGasto },
        motivoRectificacion: toIdOrNull(payload.motivoRectificacion),
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
    motivoRectificacion?: string | null;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_update_pago", {
        args: {
            id_pago: payload.idPago,
            fecha_hora: cleanString(payload.fechaHora),
            metodo: payload.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo",
            importe: Number(payload.importe ?? 0),
        },
        motivoRectificacion: toIdOrNull(payload.motivoRectificacion),
    });
    return typeof r === "boolean" ? r : true;
}

/**
 * Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo bajaba el esperado
 * exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
 *
 * El motivo es obligatorio; quién anula NO se manda —lo pone la sesión del backend (SEC-01)—.
 */
export async function cuentasAnularPago(payload: {
    idPago: string;
    motivo: string;
    /**
     * FISCAL-01: cuál de los dos instrumentos legales se está usando. Ausente = `"ERROR"`.
     *
     * - `"ERROR"`: la venta **no existió** (ticket de prueba, mesa equivocada). Genera un registro
     *   de anulación, devuelve el stock y las líneas vuelven a la comanda.
     * - `"DEVOLUCION"`: la venta **sí existió** y se devuelve el dinero. Genera una factura
     *   rectificativa (`R5`). El stock no vuelve y las líneas tampoco.
     */
    clase?: ClaseBaja;
}): Promise<boolean> {
    const r = await invokeClient<any>("cuentas_anular_pago", {
        args: {
            id_pago: payload.idPago,
            motivo: cleanString(payload.motivo),
            clase: payload.clase ?? "ERROR",
        },
    });
    return typeof r === "boolean" ? r : true;
}

/**
 * Los dos instrumentos de FISCAL-01. La AEAT los separa sin matices:
 *
 * - Anular es para una factura que *no responde a una operación real* (art. 11.1 RRSIF), y su FAQ
 *   dice que estos casos deben ser «MUY POCO FRECUENTES».
 * - Rectificar es para cuando la operación **sí existió**: *«todas las facturas emitidas, en la
 *   medida en que respondan a operaciones realmente efectuadas (como es el caso habitual) no pueden
 *   anularse»*.
 *
 * Y la que más se va a usar —la devolución— es justo la que no era una anulación.
 */
export type ClaseBaja = "ERROR" | "DEVOLUCION";

/**
 * A qué cierres de caja ya hechos afectaría un cambio, y cómo quedarían (CAJA-01). No toca nada:
 * la pantalla lo pide antes de guardar para avisar. Si `cierres` viene vacío, el apunte es del
 * periodo abierto y no hay nada que avisar.
 */
export function cuentasPrevisualizarCambio(cambio: CambioCajaInput): Promise<ImpactoCajaDto> {
    return invokeClient<ImpactoCajaDto>("cuentas_previsualizar_cambio", { args: cambio });
}

/* =========================================================
   Recuento de efectivo (lo usa el cierre de caja). El total no
   vive aquí: es `totalRecuento`, en `shared/lib/efectivo.ts`.
========================================================= */

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
