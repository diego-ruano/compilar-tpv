import { commands } from "@tpv/client";
// src/features/ventaRapida/ventaRapidaAPI.ts
//
// API de venta rápida (barra): una función por comando Tauri, con los tipos que genera Specta desde
// Rust. Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53): cada comando devuelve una
// forma fija, y el dinero llega y sale como `Dinero` (céntimos).
//
// El antiguo "get-or-create" se codificaba en el op_id; ahora se expresa con un flag
// explícito `get_or_create` en el comando `vr_create_comanda_barra`.


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
    VrLineaAnadida,
    VrCobrarFraccionadoInput,
    VrCreateComandaBarraInput,
} from "@tpv/contracts";

/* =========================================================
  Resultados
========================================================= */

export type VrAddLineaComandaResult = {
    ok: boolean;
    idDetalle: string | null;
    /** El precio que se le ha puesto a la línea: el del catálogo, no el de la carta en caché (RI-27). */
    precioUnitario: Dinero;
};

export type VrCobrarFraccionadoResult = {
    ok: boolean;
};

export type VrBootstrapResult = {
    idComanda: string;
    categorias: CategoriaRow[];
    lineas: LineaComandaRow[];
};

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
    return commands.vrListCategoriasVendibles();
}

export function vrListProductosByCategoria(idCategoria: string): Promise<ProductoRow[]> {
    return commands.vrListProductosByCategoria({ id_categoria: idCategoria });
}

export async function vrSearchProductos(q: string, limit = 60): Promise<ProductoRow[]> {
    const query = q.trim();
    if (!query) return [];

    return commands.vrSearchProductos({ query, limit });
}

export function vrListComandasBarra(opts: {
    includePagadas: boolean;
    limit?: number;
}): Promise<ComandaBarraRow[]> {
    return commands.vrListComandasBarra({ include_pagadas: opts.includePagadas, limit: opts.limit });
}

export function vrGetLineasComanda(idComanda: string): Promise<LineaComandaRow[]> {
    return commands.vrGetLineasComanda({ id_comanda: idComanda });
}

export async function vrGetIndexRows(idsHoy: string[]): Promise<IndexRow[]> {
    const ids = idsHoy.map((v) => v.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) return [];

    return commands.vrGetIndexRows({ ids });
}

export function vrGetDetallesVerTicket(idComanda: string): Promise<VerTicketsDetalleRow[]> {
    return commands.vrGetDetallesVerTicket({ id_comanda: idComanda });
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
    const id = await commands.vrCreateComandaBarra(args);
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
): Promise<VrAddLineaComandaResult> {
    const args: VrAddLineaComandaInput = {
        id_comanda: idComanda,
        id_producto: idProducto,
        cantidad,
    };
    const linea = await commands.vrAddLineaComanda(args);

    return {
        ok: true,
        idDetalle: linea.id_detalle || null,
        precioUnitario: linea.precio_unitario,
    };
}

export async function vrRemoveLastUnpaidLinea(
    idComanda: string,
    idProducto: string,
): Promise<boolean> {
    return await commands.vrRemoveLastUnpaidLinea({
            id_comanda: idComanda,
            id_producto: idProducto,
        });
}

export async function vrDeleteLineaIfUnpaid(
    idComanda: string,
    idDetalle: string,
): Promise<boolean> {
    return await commands.vrDeleteLineaIfUnpaid({
            id_comanda: idComanda,
            id_detalle: idDetalle,
        });
}

export async function vrUpdateNotaDetalle(
    idDetalle: string,
    nota: string,
): Promise<boolean> {
    return await commands.vrUpdateNotaDetalle({
            id_detalle: idDetalle,
            nota,
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
    // RI-52: un fallo llega tal cual a quien llama, que deshace el marcado y enseña su message.
    // Antes se buscaba «insufficient_stock» dentro del texto, y el cobro de la Main no lo
    // produce nunca: vender sin stock no se bloquea (lo que falta sale del stock suelto).
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
    // Devuelve el número del ticket, pero la pantalla no lo necesita: el ticket se pide por el
    // pago, cuyo id ya se conoce (RI-29).
    await commands.vrCobrarFraccionado(args);

    return { ok: true };
}

export async function vrDeleteComandaIfSafe(
    idComanda: string,
): Promise<boolean> {
    return await commands.vrDeleteComandaIfSafe({ id_comanda: idComanda });
}
