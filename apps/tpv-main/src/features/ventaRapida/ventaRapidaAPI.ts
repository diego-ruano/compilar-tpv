// src/features/ventaRapida/ventaRapidaAPI.ts
//
// API de venta rápida (barra) — Local-First puro. Sustituye el antiguo dualCall
// (remoto + local + outbox + op_id + afterRemoteOk) por invocación directa del comando
// Tauri vía @tpv/client. Las firmas exportadas y los tipos de retorno NO cambian, así que
// los componentes que la consumen (VentaRapida.tsx, VerTicketsModal.tsx) siguen igual.
//
// El antiguo "get-or-create" se codificaba en el op_id; ahora se expresa con un flag
// explícito `get_or_create` en el comando `vr_create_comanda_barra`.

import { invokeClient } from "@tpv/client";

/* =========================================================
  Tipos
========================================================= */

export type CategoriaRow = {
    ID_Categoria: string;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
    Vendible?: number | null;
};

export type ProductoRow = {
    ID_Producto: string;
    ID_Categoria: string;
    Nombre: string;

    Precio_Venta: number | null;
    Stock_Actual: number | null;
    Stock_Minimo: number | null;

    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ComandaBarraRow = {
    ID_Comanda: string;
    Fecha_Hora_Apertura: string;
    Estado: string;

    Total_Pendiente: number;
    Total_Comanda: number;

    Pendientes_Cocina: number;
    Pendientes_Pago: number;
};

export type LineaComandaRow = {
    ID_Detalle: string;
    ID_Comanda: string;
    ID_Producto: string;
    Cantidad: number;
    Precio_Unitario: number;
    Notas: string | null;
    Estado_Cocina?: string | null;
    Pagado?: 0 | 1;
    Nombre: string;
};

export type VerTicketsDetalleRow = {
    ID_Detalle: string;
    ID_Producto: string;
    Nombre: string;
    Cantidad: number;
    Precio_Unitario: number;
    Estado_Cocina: string;
    Pagado: 0 | 1;
    Notas: string | null;
};

export type IndexRow = {
    ID_Comanda: string;
    Productos: string | null;
    NumLineas: number;
    Unidades: number;
};

export type StockItem = {
    productoId: string;
    cantidad: number;
};

export type VrAddLineaComandaResult = {
    ok: boolean;
    idDetalle: string | null;
};

export type VrCobrarFraccionadoResult = {
    ok: boolean;
    idPago: string | null;
    /** Número de ticket que reservó el cobro; es lo que se imprime a continuación. */
    numeroTicket?: string | null;

    /**
     * Presente cuando el cobro falla por stock insuficiente.
     * El cobro descuenta stock e inserta Lote_Consumos en la misma
     * transacción, así que un fallo de stock implica que NO se creó el pago.
     */
    error?: "insufficient_stock" | string;
    productoId?: string;
    requested?: number;
    available?: number;
};

export type VrBootstrapResult = {
    idComanda: string;
    id_comanda: string;
    categorias: CategoriaRow[];
    lineas: LineaComandaRow[];
};

/* =========================================================
  Helpers
========================================================= */

function normalizePositiveIds(values: string[]): string[] {
    return (values ?? [])
        .map((v) => String(v ?? "").trim())
        .filter((s) => s.length > 0);
}

/*
  Detecta el error de stock insuficiente que devuelve el backend local (Rust),
  con el formato "insufficient_stock:productoId:requested:available" (posiblemente
  con un prefijo de AppError, p. ej. "conflicto: insufficient_stock:...").
*/
function parseInsufficientStock(
    err: unknown,
): { productoId?: string; requested?: number; available?: number } | null {
    const msg = String((err as any)?.message ?? err ?? "");
    if (!msg.includes("insufficient_stock")) return null;

    const local = msg.match(/insufficient_stock:(\d+):([\d.]+):([\d.]+)/);
    if (local) {
        return {
            productoId: local[1] || undefined,
            requested: Number(local[2]) || undefined,
            available: Number(local[3]) || undefined,
        };
    }

    return {};
}

/* =========================================================
  BOOTSTRAP
========================================================= */

export async function vrBootstrap(
    idTrabajador: string | null,
): Promise<VrBootstrapResult> {
    const idComanda = await invokeClient<string>("vr_create_comanda_barra", {
        args: {
            id_trabajador: idTrabajador == null ? null : idTrabajador,
            get_or_create: false,
        },
    });

    if (!idComanda) {
        throw new Error("bootstrap_id_comanda_missing");
    }

    const [categorias, lineas] = await Promise.all([
        invokeClient<CategoriaRow[]>("vr_list_categorias_vendibles"),
        invokeClient<LineaComandaRow[]>("vr_get_lineas_comanda", {
            args: { id_comanda: idComanda },
        }),
    ]);

    return {
        idComanda,
        id_comanda: idComanda,
        categorias: categorias ?? [],
        lineas: lineas ?? [],
    };
}

/* =========================================================
  READS
========================================================= */

export async function vrListCategoriasVendibles(): Promise<CategoriaRow[]> {
    const rows = await invokeClient<CategoriaRow[]>("vr_list_categorias_vendibles");
    return rows ?? [];
}

export async function vrListProductosByCategoria(
    idCategoria: string,
): Promise<ProductoRow[]> {
    const rows = await invokeClient<ProductoRow[]>(
        "vr_list_productos_by_categoria",
        { args: { id_categoria: idCategoria } },
    );
    return rows ?? [];
}

export async function vrSearchProductos(
    q: string,
    limit = 60,
): Promise<ProductoRow[]> {
    const query = String(q ?? "").trim();
    if (!query) return [];

    const rows = await invokeClient<ProductoRow[]>("vr_search_productos", {
        args: { query, limit: Number(limit) },
    });
    return rows ?? [];
}

export async function vrListComandasBarra(opts: {
    includePagadas: boolean;
    limit?: number;
}): Promise<ComandaBarraRow[]> {
    const rows = await invokeClient<ComandaBarraRow[]>("vr_list_comandas_barra", {
        args: {
            include_pagadas: Boolean(opts.includePagadas),
            limit: opts.limit == null ? null : Number(opts.limit),
        },
    });
    return rows ?? [];
}

export async function vrGetLineasComanda(
    idComanda: string,
): Promise<LineaComandaRow[]> {
    const rows = await invokeClient<LineaComandaRow[]>("vr_get_lineas_comanda", {
        args: { id_comanda: idComanda },
    });
    return rows ?? [];
}

export async function vrGetIndexRows(idsHoy: string[]): Promise<IndexRow[]> {
    const ids = normalizePositiveIds(idsHoy);
    if (ids.length === 0) return [];

    const rows = await invokeClient<IndexRow[]>("vr_get_index_rows", {
        args: { ids },
    });
    return rows ?? [];
}

export async function vrGetDetallesVerTicket(
    idComanda: string,
): Promise<VerTicketsDetalleRow[]> {
    const rows = await invokeClient<VerTicketsDetalleRow[]>(
        "vr_get_detalles_ver_ticket",
        { args: { id_comanda: idComanda } },
    );
    return rows ?? [];
}

/* =========================================================
  WRITES
========================================================= */

export async function vrGetOrCreateComandaBarra(
    idTrabajador: string | null,
): Promise<string> {
    const id = await invokeClient<string>("vr_create_comanda_barra", {
        args: {
            id_trabajador: idTrabajador == null ? null : idTrabajador,
            get_or_create: true,
        },
    });

    if (!id) {
        throw new Error("id_comanda_missing");
    }

    return id;
}

export async function vrCreateComandaBarra(
    idTrabajador: string | null,
): Promise<string> {
    const id = await invokeClient<string>("vr_create_comanda_barra", {
        args: {
            id_trabajador: idTrabajador == null ? null : idTrabajador,
            get_or_create: false,
        },
    });

    if (!id) {
        throw new Error("id_comanda_missing");
    }

    return id;
}

export async function vrAddLineaComanda(
    idComanda: string,
    idProducto: string,
    cantidad: number,
    precioUnitario: number,
): Promise<VrAddLineaComandaResult> {
    const idDetalle = await invokeClient<string>("vr_add_linea_comanda", {
        args: {
            id_comanda: idComanda,
            id_producto: idProducto,
            cantidad: Number(cantidad),
            precio_unitario: Number(precioUnitario),
        },
    });

    return {
        ok: true,
        idDetalle: idDetalle || null,
    };
}

export async function vrRemoveLastUnpaidLinea(
    idComanda: string,
    idProducto: string,
): Promise<boolean> {
    return await invokeClient<boolean>("vr_remove_last_unpaid_linea", {
        args: {
            id_comanda: idComanda,
            id_producto: idProducto,
        },
    });
}

export async function vrDeleteLineaIfUnpaid(
    idComanda: string,
    idDetalle: string,
): Promise<boolean> {
    return await invokeClient<boolean>("vr_delete_linea_if_unpaid", {
        args: {
            id_comanda: idComanda,
            id_detalle: idDetalle,
        },
    });
}

export async function vrUpdateNotaDetalle(
    idDetalle: string,
    nota: string,
): Promise<boolean> {
    return await invokeClient<boolean>("vr_update_nota_detalle", {
        args: {
            id_detalle: idDetalle,
            nota: String(nota ?? ""),
        },
    });
}

export async function vrCobrarFraccionado(argsInput: {
    idComanda: string;
    metodo: "Tarjeta" | "Efectivo";
    importeTotal: number;
    idUsuarioCobrador: string | null;
    idTrabajadorCobrador: string | null;
    detalles: string[];
    opId?: string;
    /**
     * FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe pasa
     * del límite de la simplificada y entonces no hay alternativa.
     *
     * Ausente = ticket normal (`F2`). Si el importe pasa del límite y no va, el backend rechaza el
     * cobro con `factura_completa_requerida` y la pantalla abre `DatosFiscalesModal`.
     */
    destinatario?: {
        nombre_razon: string;
        nif: string;
        domicilio?: string | null;
    } | null;
}): Promise<VrCobrarFraccionadoResult> {
    try {
        const numeroTicket = await invokeClient<string>("vr_cobrar_fraccionado", {
            args: {
                id_comanda: argsInput.idComanda,
                metodo: argsInput.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo",
                importe_total: Number(argsInput.importeTotal),
                id_usuario_cobrador:
                    argsInput.idUsuarioCobrador == null
                        ? null
                        : argsInput.idUsuarioCobrador,
                id_trabajador_cobrador:
                    argsInput.idTrabajadorCobrador == null
                        ? null
                        : argsInput.idTrabajadorCobrador,
                detalles: normalizePositiveIds(argsInput.detalles ?? []),
                destinatario: argsInput.destinatario ?? null,
            },
        });

        return {
            ok: true,
            idPago: null,
            numeroTicket: numeroTicket || null,
        };
    } catch (e) {
        /*
          El cobro descuenta stock en la misma transacción. Si el backend
          responde insufficient_stock, devolvemos un resultado estructurado
          para que la UI no marque las líneas como cobradas.
        */
        const stock = parseInsufficientStock(e);

        if (stock) {
            return {
                ok: false,
                idPago: null,
                error: "insufficient_stock",
                productoId: stock.productoId,
                requested: stock.requested,
                available: stock.available,
            };
        }

        throw e;
    }
}

export async function vrRestarStock(
    items: StockItem[],
    _opId?: string,
): Promise<boolean> {
    const lineas = (items ?? [])
        .map((it) => ({
            producto_id: String(it.productoId ?? "").trim(),
            cantidad: Number(it.cantidad),
        }))
        .filter(
            (it) =>
                it.producto_id.length > 0 &&
                Number.isFinite(it.cantidad) &&
                it.cantidad > 0,
        );

    if (lineas.length === 0) {
        return true;
    }

    return await invokeClient<boolean>("vr_restar_stock", {
        args: { lineas },
    });
}

export async function vrDeleteComandaIfSafe(
    idComanda: string,
): Promise<boolean> {
    return await invokeClient<boolean>("vr_delete_comanda_if_safe", {
        args: { id_comanda: idComanda },
    });
}
