// src/features/ventaRapida/ventaRapidaAPI.ts
//
// API de venta rápida (barra): una función por comando Tauri, con los tipos que genera ts-rs desde
// Rust. Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53): cada comando devuelve una
// forma fija, y el dinero llega y sale como `Dinero` (céntimos).
//
// El antiguo "get-or-create" se codificaba en el op_id; ahora se expresa con un flag
// explícito `get_or_create` en el comando `vr_create_comanda_barra`.

import { invokeClient } from "@tpv/client";
import type {
    CategoriaRow,
    ComandaBarraRow,
    DestinatarioInput,
    Dinero,
    IndexRow,
    LineaComandaRow,
    ProductoRow,
    VerTicketsDetalleRow,
    VrAddLineaComandaInput,
    VrCobrarFraccionadoInput,
    VrCreateComandaBarraInput,
} from "@tpv/contracts";

/* =========================================================
  Resultados
========================================================= */

export type VrAddLineaComandaResult = {
    ok: boolean;
    idDetalle: string | null;
};

export type VrCobrarFraccionadoResult = {
    ok: boolean;
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
    categorias: CategoriaRow[];
    lineas: LineaComandaRow[];
};

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
    const idComanda = await crearComandaBarra(idTrabajador, false);

    const [categorias, lineas] = await Promise.all([
        vrListCategoriasVendibles(),
        vrGetLineasComanda(idComanda),
    ]);

    return { idComanda, categorias, lineas };
}

/* =========================================================
  READS
========================================================= */

export function vrListCategoriasVendibles(): Promise<CategoriaRow[]> {
    return invokeClient<CategoriaRow[]>("vr_list_categorias_vendibles");
}

export function vrListProductosByCategoria(idCategoria: string): Promise<ProductoRow[]> {
    return invokeClient<ProductoRow[]>("vr_list_productos_by_categoria", {
        args: { id_categoria: idCategoria },
    });
}

export async function vrSearchProductos(q: string, limit = 60): Promise<ProductoRow[]> {
    const query = q.trim();
    if (!query) return [];

    return invokeClient<ProductoRow[]>("vr_search_productos", { args: { query, limit } });
}

export function vrListComandasBarra(opts: {
    includePagadas: boolean;
    limit?: number;
}): Promise<ComandaBarraRow[]> {
    return invokeClient<ComandaBarraRow[]>("vr_list_comandas_barra", {
        args: { include_pagadas: opts.includePagadas, limit: opts.limit },
    });
}

export function vrGetLineasComanda(idComanda: string): Promise<LineaComandaRow[]> {
    return invokeClient<LineaComandaRow[]>("vr_get_lineas_comanda", {
        args: { id_comanda: idComanda },
    });
}

export async function vrGetIndexRows(idsHoy: string[]): Promise<IndexRow[]> {
    const ids = idsHoy.map((v) => v.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) return [];

    return invokeClient<IndexRow[]>("vr_get_index_rows", { args: { ids } });
}

export function vrGetDetallesVerTicket(idComanda: string): Promise<VerTicketsDetalleRow[]> {
    return invokeClient<VerTicketsDetalleRow[]>("vr_get_detalles_ver_ticket", {
        args: { id_comanda: idComanda },
    });
}

/* =========================================================
  WRITES
========================================================= */

async function crearComandaBarra(
    idTrabajador: string | null,
    getOrCreate: boolean,
): Promise<string> {
    const args: VrCreateComandaBarraInput = {
        id_trabajador: idTrabajador ?? undefined,
        get_or_create: getOrCreate,
    };
    const id = await invokeClient<string>("vr_create_comanda_barra", { args });
    if (!id) throw new Error("id_comanda_missing");
    return id;
}

export function vrGetOrCreateComandaBarra(idTrabajador: string | null): Promise<string> {
    return crearComandaBarra(idTrabajador, true);
}

export function vrCreateComandaBarra(idTrabajador: string | null): Promise<string> {
    return crearComandaBarra(idTrabajador, false);
}

export async function vrAddLineaComanda(
    idComanda: string,
    idProducto: string,
    cantidad: number,
    precioUnitario: Dinero,
): Promise<VrAddLineaComandaResult> {
    const args: VrAddLineaComandaInput = {
        id_comanda: idComanda,
        id_producto: idProducto,
        cantidad,
        precio_unitario: precioUnitario,
    };
    const idDetalle = await invokeClient<string>("vr_add_linea_comanda", { args });

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
            nota,
        },
    });
}

export async function vrCobrarFraccionado(argsInput: {
    idComanda: string;
    metodo: "Tarjeta" | "Efectivo";
    importeTotal: Dinero;
    detalles: string[];
    /** El id del cobro, generado al encolarlo: repetir la llamada con él no cobra dos veces. */
    idPago: string;
    /**
     * FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe pasa
     * del límite de la simplificada y entonces no hay alternativa.
     *
     * Ausente = ticket normal (`F2`). Si el importe pasa del límite y no va, el backend rechaza el
     * cobro con `factura_completa_requerida` y la pantalla abre `DatosFiscalesModal`.
     */
    destinatario?: DestinatarioInput;
}): Promise<VrCobrarFraccionadoResult> {
    try {
        const args: VrCobrarFraccionadoInput = {
            id_pago: argsInput.idPago,
            id_comanda: argsInput.idComanda,
            metodo: argsInput.metodo,
            importe_total: argsInput.importeTotal,
            // REV-17: quién cobra ya no viaja aquí. Lo pone el backend desde la sesión, como
            // quién anula, quién cierra la caja y quién abre el cajón (SEC-01).
            detalles: argsInput.detalles.map((v) => v.trim()).filter((s) => s.length > 0),
            destinatario: argsInput.destinatario,
        };
        const numeroTicket = await invokeClient<string>("vr_cobrar_fraccionado", { args });

        return {
            ok: true,
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
                error: "insufficient_stock",
                productoId: stock.productoId,
                requested: stock.requested,
                available: stock.available,
            };
        }

        throw e;
    }
}

export async function vrDeleteComandaIfSafe(
    idComanda: string,
): Promise<boolean> {
    return await invokeClient<boolean>("vr_delete_comanda_if_safe", {
        args: { id_comanda: idComanda },
    });
}
