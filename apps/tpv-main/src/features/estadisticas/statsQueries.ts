// src/features/estadisticas/statsQueries.ts
//
// Hooks TanStack Query co-locados para la feature "estadisticas".
// Todo son LECTURAS (read-only): solo useQuery, sin mutaciones.
// El rango de fechas (y otros filtros) forma parte de la queryKey para cachear por rango/filtro.
// No cambia ninguna firma de statsApis (siguen llamando a invokeClient).

import { useQuery } from "@tanstack/react-query";
import {
    clientesStatsResumen,
    mesasStatsGet,
    productosStatsListCategorias,
    productosStatsResumen,
    proveedoresStatsResumen,
    reservasStatsResumen,
    trabajadoresStatsResumen,
    type StatsRange,
    type StatsTurno,
} from "./statsApis";

export const statsKeys = {
    all: ["stats"] as const,

    mesas: (range: StatsRange) => ["stats", "mesas", range] as const,

    productosCategorias: () => ["stats", "productos", "categorias"] as const,
    productosResumen: (
        range: StatsRange,
        categoriaTopId: number | null,
        categoriaWorstId: number | null,
    ) =>
        [
            "stats",
            "productos",
            "resumen",
            range,
            categoriaTopId,
            categoriaWorstId,
        ] as const,

    reservas: (range: StatsRange, turno: StatsTurno) =>
        ["stats", "reservas", range, turno] as const,

    trabajadores: (range: StatsRange) =>
        ["stats", "trabajadores", range] as const,

    clientes: (range: StatsRange) => ["stats", "clientes", range] as const,

    proveedores: (range: StatsRange) => ["stats", "proveedores", range] as const,
};

/* =========================
   MESAS
========================= */
export function useMesasStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.mesas(range),
        queryFn: () => mesasStatsGet(range),
    });
}

/* =========================
   PRODUCTOS
========================= */
export function useProductosCategorias() {
    return useQuery({
        queryKey: statsKeys.productosCategorias(),
        queryFn: () => productosStatsListCategorias(),
    });
}

export function useProductosResumen(
    range: StatsRange,
    categoriaTopId: number | null,
    categoriaWorstId: number | null,
) {
    return useQuery({
        queryKey: statsKeys.productosResumen(
            range,
            categoriaTopId,
            categoriaWorstId,
        ),
        queryFn: () =>
            productosStatsResumen({ range, categoriaTopId, categoriaWorstId }),
    });
}

/* =========================
   RESERVAS
========================= */
export function useReservasStats(range: StatsRange, turno: StatsTurno) {
    return useQuery({
        queryKey: statsKeys.reservas(range, turno),
        queryFn: () => reservasStatsResumen({ range, turno }),
    });
}

/* =========================
   TRABAJADORES
========================= */
export function useTrabajadoresStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.trabajadores(range),
        queryFn: () => trabajadoresStatsResumen({ range }),
    });
}

/* =========================
   CLIENTES
========================= */
export function useClientesStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.clientes(range),
        queryFn: () => clientesStatsResumen({ range }),
    });
}

/* =========================
   PROVEEDORES
========================= */
export function useProveedoresStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.proveedores(range),
        queryFn: () => proveedoresStatsResumen({ range }),
    });
}
