// src/components/mesasComponents/mesasApi.ts
//
// API de mesas / comandas / ticket / cocina — Local-First puro. Sustituye dualCall
// (remoto + local + outbox + op_id + afterRemoteOk) por invocación directa del comando
// Tauri vía @tpv/client. Las firmas exportadas y los tipos NO cambian; los 5 componentes
// consumidores siguen igual. Se conservan los nombres de comando del backend hexagonal.

import { invokeClient } from "@tpv/client";
import type { Salon, MesaMeta } from "./types";

/* =========================
   DTOs que usa MesaComandaModal
========================= */

export type CategoriaDTO = {
    ID_Categoria: number;
    Nombre: string;
    Ruta_Imagen: string | null;
};

export type ProductoDTO = {
    ID_Producto: number;
    ID_Categoria: number;
    Nombre: string;
    Precio_Venta: number | null;
    Ruta_Imagen: string | null;
};

export type KitchenRow = {
    ID_Comanda: number;
    ID_Detalle: number;
    Cantidad: number;
    Nombre_Producto: string;
    Notas: string | null;
    Estado_Cocina: "PENDIENTE" | "PREPARADO" | string;
    Pagado: 0 | 1;
    Numero_Mesa: string | null;
    Fecha_Hora_Apertura: string | null;
};

/* =========================
   Helpers
========================= */

function pick(obj: any, keys: string[]): any {
    for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
    }
    return undefined;
}

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
}

function parseAnyMesaId(k: string): number | null {
    const direct = Number(k);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const m1 = String(k).match(/db-mesa-(\d+)/);
    if (m1) return Number(m1[1]);

    const m2 = String(k).match(/(\d+)(?!.*\d)/);
    if (m2) return Number(m2[1]);

    return null;
}

/* =========================
   Normalización DTO
========================= */

function normalizeCategoria(r: any): CategoriaDTO {
    return {
        ID_Categoria: toNum(
            pick(r, [
                "ID_Categoria",
                "id_categoria",
                "idCategoria",
                "IdCategoria",
                "IDcategoria",
            ]),
            0,
        ),
        Nombre: toStr(pick(r, ["Nombre", "nombre"]), ""),
        Ruta_Imagen: toNullableStr(
            pick(r, ["Ruta_Imagen", "ruta_imagen", "rutaImagen", "RutaImagen"]),
        ),
    };
}

function normalizeProducto(r: any): ProductoDTO {
    const precioRaw = pick(r, ["Precio_Venta", "precio_venta", "precioVenta"]);

    return {
        ID_Producto: toNum(
            pick(r, ["ID_Producto", "id_producto", "idProducto", "IdProducto"]),
            0,
        ),
        ID_Categoria: toNum(
            pick(r, ["ID_Categoria", "id_categoria", "idCategoria", "IdCategoria"]),
            0,
        ),
        Nombre: toStr(pick(r, ["Nombre", "nombre"]), ""),
        Precio_Venta:
            precioRaw == null || !Number.isFinite(Number(precioRaw))
                ? null
                : Number(precioRaw),
        Ruta_Imagen: toNullableStr(
            pick(r, ["Ruta_Imagen", "ruta_imagen", "rutaImagen", "RutaImagen"]),
        ),
    };
}

/* =========================
   Layout / Meta mesas
========================= */

export async function mesasLoadLayout(): Promise<Salon[]> {
    const rows = await invokeClient<Salon[]>("load_layout");
    return rows ?? [];
}

export async function mesasSaveLayout(salons: Salon[]): Promise<void> {
    await invokeClient<string>("save_layout", {
        args: { salons: Array.isArray(salons) ? salons : [] },
    });
}

export async function mesasLoadMesaMeta(): Promise<Record<any, MesaMeta>> {
    try {
        const raw = await invokeClient<Record<string, any>>("mesas_meta_all");
        const out: Record<any, any> = {};

        for (const [k, v] of Object.entries(raw ?? {})) {
            const idMesa = parseAnyMesaId(k);
            if (!idMesa) continue;

            const totalPendiente = toNum(
                pick(v, [
                    "total_pendiente",
                    "totalPendiente",
                    "Total_Pendiente",
                    "importe_pendiente",
                    "importePendiente",
                ]),
                0,
            );

            const pendientesPago = toNum(
                pick(v, ["pendientes_pago", "pendientesPago", "Pendientes_Pago"]),
                0,
            );

            const pendientesCocina = toNum(
                pick(v, [
                    "pendientes_cocina",
                    "pendientesCocina",
                    "Pendientes_Cocina",
                ]),
                0,
            );

            const meta = {
                ...(v ?? {}),
                totalPendiente,
                pendientesPago,
                pendientesCocina,
            };

            out[idMesa] = meta;
            out[String(idMesa)] = meta;
            out[`db-mesa-${idMesa}`] = meta;
        }

        return out as any;
    } catch {
        const ocupadas = await invokeClient<Record<string, boolean>>(
            "get_mesas_ocupadas",
        );
        const out: Record<any, any> = {};

        for (const [k, v] of Object.entries(ocupadas ?? {})) {
            const idMesa = parseAnyMesaId(k);
            if (!idMesa) continue;

            const meta = {
                estado: v ? "PENDIENTE" : "LIBRE",
                reserva: null,
            };

            out[idMesa] = meta;
            out[String(idMesa)] = meta;
            out[`db-mesa-${idMesa}`] = meta;
        }

        return out as any;
    }
}

/* =========================
   Reservas
========================= */

async function reservaSetEstado(
    idReserva: number,
    estado: "ACTIVA" | "FINALIZADA",
): Promise<void> {
    const id = toNum(idReserva, 0);
    if (!id) throw new Error("id_reserva inválido");

    await invokeClient<string>("set_reserva_estado", {
        args: { id_reserva: id, estado },
    });
}

export async function reservaMarcarActivaAhora(
    idReserva: number,
): Promise<void> {
    await reservaSetEstado(idReserva, "ACTIVA");
}

export async function reservaFinalizar(idReserva: number): Promise<void> {
    await reservaSetEstado(idReserva, "FINALIZADA");
}

/* =========================
   Comandas / Ticket
========================= */

export async function mesasEnsureOpenComanda(params: {
    idMesa: number;
    idUsuario: number | null;
    idReserva: number | null;
}): Promise<number> {
    const idMesa = toNum(params.idMesa, 0);
    if (!idMesa) throw new Error("id_mesa inválido");

    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    const abierta = await invokeClient<any>("get_comanda_abierta_by_mesa", {
        args: { id_mesa: idMesa },
    });

    const idAbierta = toNum(
        pick(abierta, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
        0,
    );

    if (idAbierta > 0) {
        if (idUsuario && idUsuario > 0) {
            try {
                await invokeClient<boolean>("comanda_set_trabajador_if_null", {
                    args: {
                        id_comanda: idAbierta,
                        id_usuario: idUsuario,
                        id_trabajador: null,
                    },
                });
            } catch {
                // No bloqueamos cargar/abrir la comanda por esto.
            }
        }

        return idAbierta;
    }

    const idReserva =
        params.idReserva != null ? toNum(params.idReserva, 0) : null;

    const creada = await invokeClient<any>("abrir_comanda", {
        args: {
            id_mesa: idMesa,
            id_usuario: idUsuario,
            id_trabajador: null,
            id_reserva: idReserva,
        },
    });

    const idCreada = toNum(
        pick(creada, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
        0,
    );

    if (!idCreada) throw new Error("ID_Comanda inválido");
    return idCreada;
}

export async function mesasLoadTicket(idComanda: number): Promise<any[]> {
    const id = toNum(idComanda, 0);
    if (!id) return [];

    const rows = await invokeClient<any[]>("get_lineas_comanda", {
        args: { id_comanda: id },
    });
    return rows ?? [];
}

export async function mesasAddDetalle(params: {
    idComanda: number;
    idProducto: number;
    cantidad?: number;
    precio: number;
    idUsuario?: number | null;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const idProducto = toNum(params.idProducto, 0);
    const cantidad = toNum(params.cantidad ?? 1, 1);
    const precio = Number(params.precio);
    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    if (!idComanda) throw new Error("id_comanda inválido");
    if (!idProducto) throw new Error("id_producto inválido");
    if (!Number.isFinite(precio)) throw new Error("precio inválido");

    await invokeClient<string>("add_linea_comanda", {
        args: {
            id_comanda: idComanda,
            id_producto: idProducto,
            cantidad,
            precio,
            id_usuario: idUsuario,
            id_trabajador: null,
        },
    });
}

/* =========================
   Productos / Catálogo vendible
========================= */

export async function productosListCategoriasVendibles(): Promise<
    CategoriaDTO[]
> {
    const rows = await invokeClient<any[]>("list_categorias_vendibles");
    return (rows ?? [])
        .map(normalizeCategoria)
        .filter((c) => c.ID_Categoria > 0);
}

export async function productosListByCategoria(
    idCategoria: number,
): Promise<ProductoDTO[]> {
    const idCat = toNum(idCategoria, 0);
    if (!idCat) throw new Error("id_categoria inválido");

    const rows = await invokeClient<any[]>("list_productos_by_categoria", {
        args: { id_categoria: idCat },
    });
    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto > 0);
}

export async function productosSearchByNombre(
    q: string,
): Promise<ProductoDTO[]> {
    const query = String(q ?? "").trim();
    if (!query) return [];

    const rows = await invokeClient<any[]>("search_productos_by_nombre", {
        args: { query },
    });
    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto > 0);
}

/* =========================
   Ticket / MesaComandaModal
========================= */

export async function mesasRemoveOnePendingDetalle(params: {
    idComanda: number;
    idProducto: number;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const idProducto = toNum(params.idProducto, 0);
    if (!idComanda || !idProducto) return;

    await invokeClient<string>("remove_one_pending_detalle", {
        args: { id_comanda: idComanda, id_producto: idProducto },
    });
}

export async function mesasDeleteDetalle(idDetalle: number): Promise<void> {
    const id = toNum(idDetalle, 0);
    if (!id) return;

    await invokeClient<string>("delete_detalle", {
        args: { id_detalle: id },
    });
}

export async function mesasUpdateDetalleNota(params: {
    idDetalle: number;
    nota: string | null;
}): Promise<void> {
    const id = toNum(params.idDetalle, 0);
    if (!id) return;

    await invokeClient<string>("update_detalle_nota", {
        args: { id_detalle: id, nota: params.nota },
    });
}

export async function mesasCobrarDetalles(params: {
    idComanda: number;
    metodo: "Tarjeta" | "Efectivo";
    tipo: "TOTAL" | "FRACCIONADO";
    detalleIds: number[];
    idUsuario: number | null;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const detalleIds = (params.detalleIds ?? [])
        .map((x) => toNum(x, 0))
        .filter((n) => n > 0);

    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    if (!idComanda || !detalleIds.length) return;

    await invokeClient<string>("cobrar_detalles", {
        args: {
            id_comanda: idComanda,
            metodo: params.metodo,
            tipo: params.tipo,
            detalle_ids: detalleIds,
            id_usuario: idUsuario,
        },
    });
}

/* =========================
   Cocina / KitchenBoard
========================= */

export async function cocinaListHoyPendientes(): Promise<KitchenRow[]> {
    const rows = await invokeClient<any[]>("kitchen_list_today_pending");

    return (rows ?? []).map((r: any) => ({
        ID_Comanda: toNum(pick(r, ["ID_Comanda", "id_comanda", "idComanda"]), 0),
        ID_Detalle: toNum(pick(r, ["ID_Detalle", "id_detalle", "idDetalle"]), 0),
        Cantidad: toNum(pick(r, ["Cantidad", "cantidad"]), 1),
        Nombre_Producto: toStr(
            pick(r, ["Nombre_Producto", "productoNombre", "Nombre", "nombre"]),
            "",
        ),
        Notas: toNullableStr(pick(r, ["Notas", "notas"])),
        Estado_Cocina: toStr(
            pick(r, ["Estado_Cocina", "estado_cocina", "estadoCocina"]),
            "PENDIENTE",
        ),
        Pagado: toNum(pick(r, ["Pagado", "pagado"]), 0) ? 1 : 0,
        Numero_Mesa: toNullableStr(
            pick(r, ["Numero_Mesa", "numero_mesa", "mesaNombre", "mesa"]),
        ),
        Fecha_Hora_Apertura: toNullableStr(
            pick(r, [
                "Fecha_Hora_Apertura",
                "fecha_hora_apertura",
                "fechaHora",
                "fecha_hora",
            ]),
        ),
    }));
}

export async function cocinaSetLineaEstado(params: {
    idDetalle: number;
    idUsuarioCocinero: number | null;
    estado: "PENDIENTE" | "PREPARADO";
}): Promise<void> {
    const idDetalle = toNum(params.idDetalle, 0);
    const idUsuarioCocinero =
        params.idUsuarioCocinero != null
            ? toNum(params.idUsuarioCocinero, 0)
            : 0;

    if (!idDetalle || !idUsuarioCocinero) return;

    await invokeClient<string>("kitchen_set_line_state", {
        args: {
            id_detalle: idDetalle,
            estado: params.estado,
            id_usuario_cocinero: idUsuarioCocinero,
        },
    });
}
