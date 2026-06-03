// src/features/estadisticas/statsApis.ts
//
// API de estadísticas — Local-First puro. Sustituye dualCall por invocación directa del
// comando Tauri vía @tpv/client. Solo lecturas. Las firmas exportadas y los tipos NO cambian.
// Nota: stats_mesas_get recibe `range` directo (no envuelto en `args`); el resto usa `{ args }`.

import { invokeClient } from "@tpv/client";

export type StatsRange = "hoy" | "semana" | "mes" | "anio";

/* =========================
   MESAS
========================= */

export type MesasStatsResponse = {
    total_mesas: number;
    ocupadas: number;
    ticket_medio_por_mesa: number;
    mesa_top_comandas: null | {
        mesa: string;
        zona: string;
        comandas: number;
    };
    servicios: {
        labels: string[];
        values: number[];
    };
    top_mesas_ingresos: Array<{
        mesa: string;
        zona: string;
        total: number;
    }>;
};

export async function mesasStatsGet(
    range: StatsRange,
): Promise<MesasStatsResponse> {
    return await invokeClient<MesasStatsResponse>("stats_mesas_get", { range });
}

/* =========================
   PRODUCTOS
========================= */

export type StatsCategoriaRow = {
    ID_Categoria: number;
    Nombre: string;
};

export type ProductosTop10 = {
    labels: string[];
    values: number[];
};

export type ProductosStatsResponse = {
    mejor_producto: string | null;
    peor_producto_vendible: string | null;
    top10_mejores: ProductosTop10;
    top10_peores: ProductosTop10;
};

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

export type StatsTurno = "COMIDA" | "CENA" | "TODOS";

export type ReservasStatsResponse = {
    total_reservas: number;
    cancelaciones: number;
    mesas_turno: {
        turno: StatsTurno;
        mesas_reservadas: number;
        mesas_no_reservadas: number;
    };
    reservas_por_bucket: {
        labels: string[];
        values: number[];
    };
    estado: {
        labels: string[];
        values: number[];
    };
    franjas: {
        labels: string[];
        values: number[];
    };
};

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

export type PuntualidadInfo = {
    puntual: boolean;
    programado: string;
    entrada: string;
    minutos_retraso: number;
};

export type TrabajadorCardStats = {
    id_trabajador: number;
    nombre: string;
    rol: "Cocinero" | "Camarero" | "Limpieza";

    tareas_asignadas: number;
    tareas_finalizadas: number;
    horas_trabajadas: number;

    puntualidad?: PuntualidadInfo | null;

    comandas_preparadas?: number;
    comandas_tomadas?: number;
    cobros_realizados?: number;
    ticket_medio_eur?: number;
};

export type TrabajadoresStatsResponse = {
    cocineros: TrabajadorCardStats[];
    camareros: TrabajadorCardStats[];
    limpieza: TrabajadorCardStats[];
    ranking_ventas: {
        labels: string[];
        values: number[];
    };
};

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

export type ClientesStatsResponse = {
    nuevos: number;
    recurrentes: number;
    no_recurrentes: number;
    ticket_medio_cliente: number;
    nuevos_por_bucket: {
        labels: string[];
        values: number[];
    };
    top_clientes_gasto: {
        labels: string[];
        values: number[];
    };
};

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

export type ProveedoresStatsResponse = {
    total_gasto: number;
    num_gastos: number;
    gasto_medio: number;
    porcentaje_sobre_total_gastos: number;

    proveedor_top: null | {
        nombre: string;
        total: number;
    };

    gastos_evolucion: {
        labels: string[];
        values: number[];
    };

    gasto_por_proveedor: {
        labels: string[];
        values: number[];
    };

    ultimos_gastos?: Array<{
        fecha: string;
        proveedor: string;
        concepto: string;
        importe: number;
    }>;
};

export async function proveedoresStatsResumen(args: {
    range: StatsRange;
}): Promise<ProveedoresStatsResponse> {
    return await invokeClient<ProveedoresStatsResponse>(
        "stats_proveedores_resumen",
        { args: { range: args.range } },
    );
}

export const statsProveedoresResumen = proveedoresStatsResumen;
