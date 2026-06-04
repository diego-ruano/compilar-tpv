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
    cuentasGetSalidas,
    cuentasListProveedoresMini,
    cuentasUpdateGasto,
    cuentasUpdatePago,
} from "./cuentasApis";

type Rango = { del?: string | null; al?: string | null };

export const cuentasKeys = {
    all: ["cuentas"] as const,
    entradas: (rango: Rango) =>
        ["cuentas", "entradas", rango.del ?? null, rango.al ?? null] as const,
    salidas: (rango: Rango) =>
        ["cuentas", "salidas", rango.del ?? null, rango.al ?? null] as const,
    proveedores: () => ["cuentas", "proveedores"] as const,
};

/* =========================
   Lecturas (queries)
========================= */

export function useCuentasEntradas(rango: Rango) {
    return useQuery({
        queryKey: cuentasKeys.entradas(rango),
        queryFn: () => cuentasGetEntradas(rango),
    });
}

export function useCuentasSalidas(rango: Rango) {
    return useQuery({
        queryKey: cuentasKeys.salidas(rango),
        queryFn: () => cuentasGetSalidas(rango),
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
