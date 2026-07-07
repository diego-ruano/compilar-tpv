// src/features/cuentas/cuentasQueries.ts
//
// Hooks TanStack Query co-locados para la feature "cuentas" (caja). Envuelven las
// funciones de cuentasApis: lecturas (entradas/salidas por rango de fechas, proveedores
// mini) como useQuery y escrituras (CRUD de gastos y pagos) como useMutation que
// invalidan la clave de la feature. No se cambia la firma de ninguna función de Apis.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    cuentasCreateGasto,
    cuentasDeleteGasto,
    cuentasDeletePago,
    cuentasGetEntradas,
    cuentasGetResumen,
    cuentasGetSalidas,
    cuentasListProveedoresMini,
    cuentasUpdateGasto,
    cuentasUpdatePago,
    CUENTAS_PAGE_SIZE,
    type CuentasListParams,
} from "./cuentasApis";

type Rango = { del?: string | null; al?: string | null; q?: string | null };
type ListParams = Rango & { page?: number };

export const cuentasKeys = {
    all: ["cuentas"] as const,
    entradas: (p: ListParams) =>
        [
            "cuentas",
            "entradas",
            p.del ?? null,
            p.al ?? null,
            p.q ?? null,
            p.page ?? 1,
        ] as const,
    salidas: (p: ListParams) =>
        [
            "cuentas",
            "salidas",
            p.del ?? null,
            p.al ?? null,
            p.q ?? null,
            p.page ?? 1,
        ] as const,
    resumen: (rango: Rango) =>
        ["cuentas", "resumen", rango.del ?? null, rango.al ?? null, rango.q ?? null] as const,
    proveedores: () => ["cuentas", "proveedores"] as const,
};

/* =========================
   Lecturas (queries)
========================= */

export function useCuentasEntradas(params: ListParams, enabled = true) {
    const page = params.page ?? 1;
    return useQuery({
        queryKey: cuentasKeys.entradas(params),
        queryFn: () =>
            cuentasGetEntradas({
                del: params.del,
                al: params.al,
                q: params.q,
                page,
                pageSize: CUENTAS_PAGE_SIZE,
            } satisfies CuentasListParams),
        enabled,
    });
}

export function useCuentasSalidas(params: ListParams, enabled = true) {
    const page = params.page ?? 1;
    return useQuery({
        queryKey: cuentasKeys.salidas(params),
        queryFn: () =>
            cuentasGetSalidas({
                del: params.del,
                al: params.al,
                q: params.q,
                page,
                pageSize: CUENTAS_PAGE_SIZE,
            } satisfies CuentasListParams),
        enabled,
    });
}

export function useCuentasResumen(rango: Rango, enabled = true) {
    return useQuery({
        queryKey: cuentasKeys.resumen(rango),
        queryFn: () => cuentasGetResumen(rango),
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
            if (ok) qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useUpdateGasto() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasUpdateGasto,
        onSuccess: (ok) => {
            if (ok) qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useDeleteGasto() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasDeleteGasto,
        onSuccess: (ok) => {
            if (ok) qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useUpdatePago() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasUpdatePago,
        onSuccess: (ok) => {
            if (ok) qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}

export function useDeletePago() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: cuentasDeletePago,
        onSuccess: (ok) => {
            if (ok) qc.invalidateQueries({ queryKey: cuentasKeys.all });
        },
    });
}
