// src/features/estadisticas/statsApis.ts
//
// API de estadísticas — Local-First puro. Sustituye dualCall por invocación directa del
// comando Tauri vía @tpv/client. Solo lecturas. Las firmas exportadas y los tipos NO cambian.
// Nota: stats_mesas_get recibe `range` directo (no envuelto en `args`); el resto usa `{ args }`.

import { invokeClient } from "@tpv/client";
import type {
    StatsRange,
    StatsTurno,
    StatsCategoriaRow,
    MesasStatsResponse,
    ProductosStatsResponse,
    ReservasStatsResponse,
    TrabajadoresStatsResponse,
    ClientesStatsResponse,
    ProveedoresStatsResponse,
    TrabajadorCardStats,
    PuntualidadInfo,
} from "@tpv/contracts";

// Tipos autogenerados desde Rust (ts-rs). Se reexportan con los mismos nombres
// que ya consumían los componentes; aquí sólo viven las firmas de las llamadas.
export type {
    StatsRange,
    StatsTurno,
    StatsCategoriaRow,
    MesasStatsResponse,
    ProductosStatsResponse,
    ReservasStatsResponse,
    TrabajadoresStatsResponse,
    ClientesStatsResponse,
    ProveedoresStatsResponse,
    TrabajadorCardStats,
    PuntualidadInfo,
};

/* =========================
   MESAS
========================= */

export async function mesasStatsGet(
    range: StatsRange,
): Promise<MesasStatsResponse> {
    return await invokeClient<MesasStatsResponse>("stats_mesas_get", { range });
}

/* =========================
   PRODUCTOS
========================= */

// Helper solo-frontend (forma de las series de los gráficos de productos).
export type ProductosTop10 = {
    labels: string[];
    values: number[];
};

// Alias conservado por compatibilidad con los componentes que lo importan.
export type ProductosStatsResumen = ProductosStatsResponse;

export async function productosStatsListCategorias(): Promise<
    StatsCategoriaRow[]
> {
    return await invokeClient<StatsCategoriaRow[]>(
        "stats_productos_list_categorias",
    );
}

export async function productosStatsResumen(args: {
    range: StatsRange;
    categoriaTopId: number | null;
    categoriaWorstId: number | null;
}): Promise<ProductosStatsResponse> {
    return await invokeClient<ProductosStatsResponse>("stats_productos_resumen", {
        args: {
            range: args.range,
            categoria_top_id: args.categoriaTopId,
            categoria_worst_id: args.categoriaWorstId,
        },
    });
}

export const statsProductosListCategorias = productosStatsListCategorias;
export const statsProductosResumen = productosStatsResumen;

/* =========================
   RESERVAS
========================= */

export async function reservasStatsResumen(args: {
    range: StatsRange;
    turno: StatsTurno;
}): Promise<ReservasStatsResponse> {
    return await invokeClient<ReservasStatsResponse>("stats_reservas_resumen", {
        args: { range: args.range, turno: args.turno },
    });
}

export const statsReservasResumen = reservasStatsResumen;

/* =========================
   TRABAJADORES
========================= */

export async function trabajadoresStatsResumen(args: {
    range: StatsRange;
}): Promise<TrabajadoresStatsResponse> {
    return await invokeClient<TrabajadoresStatsResponse>(
        "stats_trabajadores_resumen",
        { args: { range: args.range } },
    );
}

export const statsTrabajadoresResumen = trabajadoresStatsResumen;

/* =========================
   CLIENTES
========================= */

export async function clientesStatsResumen(args: {
    range: StatsRange;
}): Promise<ClientesStatsResponse> {
    return await invokeClient<ClientesStatsResponse>("stats_clientes_resumen", {
        args: { range: args.range },
    });
}

export const statsClientesResumen = clientesStatsResumen;

/* =========================
   PROVEEDORES
========================= */

export async function proveedoresStatsResumen(args: {
    range: StatsRange;
}): Promise<ProveedoresStatsResponse> {
    return await invokeClient<ProveedoresStatsResponse>(
        "stats_proveedores_resumen",
        { args: { range: args.range } },
    );
}

export const statsProveedoresResumen = proveedoresStatsResumen;
