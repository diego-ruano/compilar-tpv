import { commands } from "@tpv/client";
// src/features/estadisticas/statsQueries.ts
//
// Hooks TanStack Query co-locados para la feature "estadisticas".
// Todo son LECTURAS (read-only): solo useQuery, sin mutaciones.
// El rango de fechas (y otros filtros) forma parte de la queryKey para cachear por rango/filtro.
// Nombre, argumentos y respuesta proceden de los comandos Rust.

import { useQuery } from "@tanstack/react-query";
import type { StatsRange, StatsTurno } from "@tpv/contracts";

export const statsKeys = {
    all: ["stats"] as const,

    mesas: (range: StatsRange) => ["stats", "mesas", range] as const,

    productosCategorias: () => ["stats", "productos", "categorias"] as const,
    productosResumen: (
        range: StatsRange,
        categoriaTopId: string | null,
        categoriaWorstId: string | null,
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
        queryFn: () => commands.statsMesasGet(range),
    });
}

/* =========================
   PRODUCTOS
========================= */
export function useProductosCategorias() {
    return useQuery({
        queryKey: statsKeys.productosCategorias(),
        queryFn: () => commands.statsProductosListCategorias(),
    });
}

export function useProductosResumen(
    range: StatsRange,
    categoriaTopId: string | null,
    categoriaWorstId: string | null,
) {
    return useQuery({
        queryKey: statsKeys.productosResumen(
            range,
            categoriaTopId,
            categoriaWorstId,
        ),
        queryFn: () =>
            commands.statsProductosResumen({ range, categoria_top_id: categoriaTopId, categoria_worst_id: categoriaWorstId }),
    });
}

/* =========================
   RESERVAS
========================= */
export function useReservasStats(range: StatsRange, turno: StatsTurno) {
    return useQuery({
        queryKey: statsKeys.reservas(range, turno),
        queryFn: () => commands.statsReservasResumen({ range, turno }),
    });
}

/* =========================
   TRABAJADORES
========================= */
export function useTrabajadoresStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.trabajadores(range),
        queryFn: () => commands.statsTrabajadoresResumen({ range }),
    });
}

/* =========================
   CLIENTES
========================= */
export function useClientesStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.clientes(range),
        queryFn: () => commands.statsClientesResumen({ range }),
    });
}

/* =========================
   PROVEEDORES
========================= */
export function useProveedoresStats(range: StatsRange) {
    return useQuery({
        queryKey: statsKeys.proveedores(range),
        queryFn: () => commands.statsProveedoresResumen({ range }),
    });
}
