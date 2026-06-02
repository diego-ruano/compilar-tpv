// src/components/stats/statsApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

export type StatsRange = "hoy" | "semana" | "mes" | "anio";

/* =========================
   Helpers
========================= */

function unwrapMaybeOkEnvelope<T>(x: any): T {
    if (!x || typeof x !== "object") return x as T;
    if (!("ok" in x)) return x as T;

    if (!x.ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    if ("result" in x) return x.result as T;
    if ("user" in x) return x.user as T;
    if ("status" in x) return x.status as T;
    if ("data" in x) return x.data as T;

    return x as T;
}

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
    const args = { range };

    const raw = await dualCall<MesasStatsResponse>(
        {
            path: "/v1/stats/mesas/get",
            method: "POST",
            body: { args },
            unwrapOkEnvelope: true,
        },
        () => invoke<MesasStatsResponse>("stats_mesas_get", args),
        {
            kind: "read",
            debugTag: "stats:mesasGet",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<MesasStatsResponse>(raw);
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
    const raw = await dualCall<StatsCategoriaRow[]>(
        {
            path: "/v1/stats/productos/categorias",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invoke<StatsCategoriaRow[]>("stats_productos_list_categorias"),
        {
            kind: "read",
            debugTag: "stats:productosListCategorias",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<StatsCategoriaRow[]>(raw);
}

export async function productosStatsResumen(args: {
    range: StatsRange;
    categoriaTopId: number | null;
    categoriaWorstId: number | null;
}): Promise<ProductosStatsResponse> {
    const localArgs = {
        range: args.range,
        categoria_top_id: args.categoriaTopId,
        categoria_worst_id: args.categoriaWorstId,
    };

    const raw = await dualCall<ProductosStatsResponse>(
        {
            path: "/v1/stats/productos/resumen",
            method: "POST",
            body: { args: localArgs },
            unwrapOkEnvelope: true,
        },
        () =>
            invoke<ProductosStatsResponse>("stats_productos_resumen", {
                args: localArgs,
            }),
        {
            kind: "read",
            debugTag: "stats:productosResumen",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ProductosStatsResponse>(raw);
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
    const localArgs = {
        range: args.range,
        turno: args.turno,
    };

    const raw = await dualCall<ReservasStatsResponse>(
        {
            path: "/v1/stats/reservas/resumen",
            method: "POST",
            body: { args: localArgs },
            unwrapOkEnvelope: true,
        },
        () =>
            invoke<ReservasStatsResponse>("stats_reservas_resumen", {
                args: localArgs,
            }),
        {
            kind: "read",
            debugTag: "stats:reservasResumen",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ReservasStatsResponse>(raw);
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
    const localArgs = {
        range: args.range,
    };

    const raw = await dualCall<TrabajadoresStatsResponse>(
        {
            path: "/v1/stats/trabajadores/resumen",
            method: "POST",
            body: { args: localArgs },
            unwrapOkEnvelope: true,
        },
        () =>
            invoke<TrabajadoresStatsResponse>("stats_trabajadores_resumen", {
                args: localArgs,
            }),
        {
            kind: "read",
            debugTag: "stats:trabajadoresResumen",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<TrabajadoresStatsResponse>(raw);
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
    const localArgs = {
        range: args.range,
    };

    const raw = await dualCall<ClientesStatsResponse>(
        {
            path: "/v1/stats/clientes/resumen",
            method: "POST",
            body: { args: localArgs },
            unwrapOkEnvelope: true,
        },
        () =>
            invoke<ClientesStatsResponse>("stats_clientes_resumen", {
                args: localArgs,
            }),
        {
            kind: "read",
            debugTag: "stats:clientesResumen",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ClientesStatsResponse>(raw);
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
    const localArgs = {
        range: args.range,
    };

    const raw = await dualCall<ProveedoresStatsResponse>(
        {
            path: "/v1/stats/proveedores/resumen",
            method: "POST",
            body: { args: localArgs },
            unwrapOkEnvelope: true,
        },
        () =>
            invoke<ProveedoresStatsResponse>("stats_proveedores_resumen", {
                args: localArgs,
            }),
        {
            kind: "read",
            debugTag: "stats:proveedoresResumen",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ProveedoresStatsResponse>(raw);
}

export const statsProveedoresResumen = proveedoresStatsResumen;