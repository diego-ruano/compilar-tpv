// src/features/cuentas/cuentasQueries.ts
//
// Hooks TanStack Query co-locados para la feature "cuentas" (caja). Envuelven las
// funciones de cuentasApis: lecturas (entradas/salidas por rango de fechas, proveedores
// mini) como useQuery y escrituras (CRUD de gastos y pagos) como useMutation que
// invalidan la clave de la feature.

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    cuentasAnularPago,
    cuentasCreateGasto,
    cuentasDeleteGasto,
    cuentasDevolverLineas,
    cuentasGetEntradas,
    cuentasGetResumen,
    cuentasGetSalidas,
    cuentasListProveedoresMini,
    cuentasUpdateGasto,
    cuentasUpdatePago,
    CUENTAS_PAGE_SIZE,
    type CuentasListParams,
    type CursorCuentas,
} from "./cuentasApis";

type Rango = { del?: string | null; al?: string | null; q?: string | null };
/** `cursor`: dónde empieza la página (el `siguiente` de la anterior); `null` = la primera. */
type ListParams = Rango & { cursor?: CursorCuentas | null };

/** Los argumentos de una página: el tamaño y, si no es la primera, su cursor. */
function paginaArgs(p: ListParams) {
    return {
        page_size: CUENTAS_PAGE_SIZE,
        cursor_fecha: p.cursor?.fecha,
        cursor_id: p.cursor?.id,
    };
}

/**
 * Paginación por clave (RI-18): la página N empieza donde acabó la N-1, así que para volver atrás
 * hay que recordar dónde empezaba cada una. Esta pila guarda esos cursores; la página actual es la
 * que empieza en el de arriba (o la primera, si está vacía).
 */
export function usePilaDeCursores() {
    const [pila, setPila] = useState<CursorCuentas[]>([]);
    const avanzar = useCallback((c: CursorCuentas) => setPila((p) => [...p, c]), []);
    const retroceder = useCallback(() => setPila((p) => p.slice(0, -1)), []);
    const reiniciar = useCallback(() => setPila([]), []);
    return {
        pagina: pila.length + 1,
        cursor: pila.length ? pila[pila.length - 1] : null,
        avanzar,
        retroceder,
        reiniciar,
    };
}

function rangoArgs(r: Rango): CuentasListParams {
    return { del: r.del ?? undefined, al: r.al ?? undefined, q: r.q ?? undefined };
}

export const cuentasKeys = {
    all: ["cuentas"] as const,
    entradas: (p: ListParams) =>
        [
            "cuentas",
            "entradas",
            p.del ?? null,
            p.al ?? null,
            p.q ?? null,
            p.cursor?.fecha ?? null,
            p.cursor?.id ?? null,
        ] as const,
    salidas: (p: ListParams) =>
        [
            "cuentas",
            "salidas",
            p.del ?? null,
            p.al ?? null,
            p.q ?? null,
            p.cursor?.fecha ?? null,
            p.cursor?.id ?? null,
        ] as const,
    resumen: (rango: Rango) =>
        ["cuentas", "resumen", rango.del ?? null, rango.al ?? null, rango.q ?? null] as const,
    proveedores: () => ["cuentas", "proveedores"] as const,
};

/* =========================
   Lecturas (queries)
========================= */

export function useCuentasEntradas(params: ListParams, enabled = true) {
    return useQuery({
        queryKey: cuentasKeys.entradas(params),
        queryFn: () => cuentasGetEntradas({ ...rangoArgs(params), ...paginaArgs(params) }),
        enabled,
    });
}

export function useCuentasSalidas(params: ListParams, enabled = true) {
    return useQuery({
        queryKey: cuentasKeys.salidas(params),
        queryFn: () => cuentasGetSalidas({ ...rangoArgs(params), ...paginaArgs(params) }),
        enabled,
    });
}

export function useCuentasResumen(rango: Rango, enabled = true) {
    return useQuery({
        queryKey: cuentasKeys.resumen(rango),
        queryFn: () => cuentasGetResumen(rangoArgs(rango)),
        enabled,
    });
}

export function useCuentasProveedoresMini() {
    return useQuery({
        queryKey: cuentasKeys.proveedores(),
        queryFn: () => cuentasListProveedoresMini(),
    });
}

/* =========================
   Escrituras (mutations)
========================= */

export function useCreateGasto() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasCreateGasto,
        onSuccess: (ok) => {
            if (ok) void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useUpdateGasto() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasUpdateGasto,
        onSuccess: (ok) => {
            if (ok) void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useDeleteGasto() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasDeleteGasto,
        onSuccess: (ok) => {
            if (ok) void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useUpdatePago() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasUpdatePago,
        onSuccess: (ok) => {
            if (ok) void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useDevolverLineas() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasDevolverLineas,
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useAnularPago() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasAnularPago,
        onSuccess: (ok) => {
            if (ok) void qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}
